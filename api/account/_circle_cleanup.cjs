"use strict";

const control = require("./_deletion_control.cjs");
const {randomUUID} = require("node:crypto");
const {Timestamp, FieldPath} = require("firebase-admin/firestore");

const manifest = require("./_cleanup_manifest.cjs");
const PAGE_SIZE = 200;
const GUARD_COLLECTION = "account_deletion_guards";
const ANONYMOUS_AUTHOR = "";
// Terminal completion is exclusively owned by birthCleanup.finish().

function conflict(code = "ACCOUNT_STATE_CONFLICT") {
  const error = new Error("Account cleanup state is inconsistent.");
  error.code = code;
  throw error;
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(data, keys) {
  return object(data) && Object.keys(data).length === keys.length &&
    keys.every((key) => Object.hasOwn(data, key));
}
function safeId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !value.includes("/") && value !== "." && value !== "..";
}
// Stored Firestore paths may predate the stricter public ID contract.
function storedPathSegment(value) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 1500 && !value.includes("/") &&
    value !== "." && value !== ".." && !/^__.*__$/.test(value);
}
function time(value) {
  try {
    return object(value) && typeof value.toMillis === "function" &&
      Number.isFinite(value.toMillis());
  } catch (_) { return false; }
}
function guardRef(db, uid) {
  if (!safeId(uid)) conflict();
  return db.collection(GUARD_COLLECTION).doc(uid);
}
function validateGuard(data) {
  if (!exact(data, ["version", "state", "deletionId", "startedAt", "retainUntil"]) ||
      data.version !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.deletionId) ||
      !time(data.startedAt) ||
      !((data.state === "IN_PROGRESS" && data.retainUntil === null) ||
        (data.state === "COMPLETE" && time(data.retainUntil) &&
          data.retainUntil.toMillis() > data.startedAt.toMillis()))) conflict();
  return data;
}
// A bare legacy guard is deny-only, never a cleanup capability. This legacy
// producer remains for existing internal fixtures; new deletion uses R5 admit.
async function beginGuard(db, uid, preflight = async () => {}) {
  const ref = guardRef(db, uid);
  const operationRef = ref.collection("control").doc("operation");
  return db.runTransaction(async (tx) => {
    const operation = await tx.get(operationRef);
    const snapshot = await tx.get(ref);
    if (operation.exists) conflict();
    if (snapshot.exists) return validateGuard(snapshot.data());
    await preflight(tx);
    const guard = {version: 1, state: "IN_PROGRESS", deletionId: randomUUID(),
      startedAt: Timestamp.now(), retainUntil: null};
    tx.set(ref, guard);
    return guard;
  });
}

const guardBindings = new WeakMap();
// Server-only adapter: the supplied handle is checked by its actual controller.
function bindOperation(db, uid, controller, handle, beforeEffect, authorizeCapture = async () => false) {
  const operation = controller.originalOperation(handle);
  if (operation.uid !== uid || operation.projectId !== db.projectId ||
      operation.databaseId !== db.databaseId ||
      typeof beforeEffect !== "function") conflict();
  const guard = Object.freeze({version: 1, state: operation.state,
    deletionId: operation.deletionId, startedAt: operation.scope.guardStartedAt,
    retainUntil: operation.completedAt === null ? null :
      Timestamp.fromMillis(operation.completedAt.toMillis() + 65 * 60 * 1000)});
  guardBindings.set(guard, {db, uid, controller, handle, beforeEffect, authorizeCapture});
  return guard;
}

function binding(db, uid, guard) {
  const value = guard && guardBindings.get(guard);
  if (!value || value.uid !== uid ||
      (value.db !== db && value.wrapper !== db)) conflict();
  return value;
}

async function requireActiveGuard(tx, db, uid, guard) {
  const value = binding(db, uid, guard);
  try {
    await value.controller.assertOperationTransaction(tx, value.handle);
    const original = value.controller.originalOperation(value.handle);
    const headerRef = manifest.refs(db, original, original.scope.privateRoot).header;
    const snapshot = await tx.get(headerRef);
    if (snapshot.exists) {
      const h = snapshot.data();
      if (h.deletionId !== original.deletionId || h.state === "QUARANTINED" ||
          h.authOutcome === "UNKNOWN") conflict("ACCOUNT_CLEANUP_REVIEW_REQUIRED");
      if (h.billingVersion !== null) {
        const account = await tx.get(db.doc("billing_google_accounts/" + original.scope.billingAccountHash));
        if (account.exists && (!account.updateTime || !h.billingVersion.isEqual(account.updateTime))) {
          conflict("ACCOUNT_CLEANUP_REVIEW_REQUIRED");
        }
      }
    }
  } catch (error) {
    if (error instanceof control.DeletionControlError) {
      if (error.code === "COMPLETE") conflict("ACCOUNT_CLEANUP_COMPLETE");
      conflict();
    }
    throw error;
  }
}
async function requireGuard(tx, db, uid, guard) {
  return requireActiveGuard(tx, db, uid, guard);
}

// Every preparation/deletion transaction is fenced by the original operation.
// Existing ownership and durable Circle closure claims remain in the cleaners.
async function requireRecursiveScope(tx, db, uid, ref) {
  if (ref?.path === "users/" + uid) return;
  const parts = typeof ref?.path === "string" ? ref.path.split("/") : [];
  if (parts.length !== 2 || parts[0] !== "circles" ||
      !storedPathSegment(parts[1])) conflict();
  const circleId = parts[1];
  const root = await tx.get(ref);
  const closure = await tx.get(db.collection("circle_cleanup_guards").doc(circleId));
  const marker = await tx.get(db.collection("circle_deletions").doc(circleId));
  const user = await tx.get(db.collection("users").doc(uid));
  if (!closure.exists ||
      !exact(closure.data(), ["version", "state", "createdAt"]) ||
      closure.data().version !== 1 || closure.data().state !== "SERVER_DELETING" ||
      !time(closure.data().createdAt)) conflict();
  if (marker.exists) {
    const claim = validatePendingMarker(marker);
    if (!claim.memberUids.includes(uid)) conflict();
    if (root.exists && (root.data().adminId !== claim.initiatedBy ||
        root.data().deletionState !== "SERVER_DELETING")) conflict();
    if (root.exists) validateCircle(root.data());
    return;
  }
  const claim = user.data()?._serverAccountDeletion;
  if (root.exists || claim?.version !== 1 || claim.mode !== "SOLE_ADMIN_CIRCLE" ||
      claim.circleId !== circleId || !time(claim.startedAt)) conflict();
}

function treeOptions(db, uid, guard, ref) {
  const value = binding(db, uid, guard);
  const operation = value.controller.originalOperation(value.handle);
  if (ref?.path !== operation.scope.privateRoot &&
      !(typeof ref?.path === "string" && /^circles\/[^/]+$/.test(ref.path))) conflict();
  return {db: value.db, operation, partitionedCapture: true,
    ref, authorizeCapture: value.authorizeCapture,
    assertOriginalOperation: tx => value.controller.assertOperationTransaction(tx, value.handle),
    beforeEffect: () => value.beforeEffect(ref),
    assertOperation: async tx => {
      await requireActiveGuard(tx, value.db, uid, guard);
      await requireRecursiveScope(tx, value.db, uid, ref);
    }};
}
async function captureTree(db, uid, guard, ref, circleDeleted = false) {
  const options = {...treeOptions(db, uid, guard, ref), circleDeleted};
  try {
    await db.runTransaction(tx => options.assertOperation(tx));
    return await manifest.captureTree(options);
  }
  catch (error) {
    if (["ACCOUNT_CLEANUP_REVIEW_REQUIRED", "ACCOUNT_CLEANUP_LIMIT"].includes(error?.code)) {
      await manifest.quarantine(options, "CAPTURE_UNPROVEN");
    }
    throw error;
  }
}
function treeState(db, uid, guard, ref, optional = false) {
  return manifest.state(treeOptions(db, uid, guard, ref), optional);
}
function setAuthOutcome(db, uid, guard, ref, expected, next) {
  return manifest.authOutcome(treeOptions(db, uid, guard, ref), expected, next);
}
async function capturePermitted(db, uid, guard) {
  return (await binding(db, uid, guard).authorizeCapture()) === true;
}
function withActiveGuard(db, uid, guard) {
  const value = binding(db, uid, guard);
  if (value.wrapper) return value.wrapper;
  value.wrapper = Object.freeze({projectId: db.projectId,
    databaseId: db.databaseId, doc: db.doc.bind(db),
    collection: db.collection.bind(db), collectionGroup: db.collectionGroup.bind(db),
    runTransaction: (callback, ...options) => db.runTransaction(async (tx) => {
      await requireActiveGuard(tx, db, uid, guard);
      return callback(tx);
    }, ...options),
    // Convert delete-only batches to one fenced transaction. No native commit
    // can cross COMPLETE after a detached read of the guard.
    batch: () => {
      const refs = [];
      const writer = {delete: ref => {refs.push(ref); return writer;},
        commit: async () => {
          await value.beforeEffect();
          return db.runTransaction(async tx => {
            await requireActiveGuard(tx, db, uid, guard);
            for (const ref of refs) tx.delete(ref);
          });
        }};
      return writer;
    },
    recursiveDelete: ref => value.wrapper.deleteTree(ref),
    deleteTree: async ref => {
      await captureTree(db, uid, guard, ref);
      return manifest.removeTree(treeOptions(db, uid, guard, ref));
    }});
  return value.wrapper;
}

// listDocuments includes missing parent documents with existing descendants.
// Querying only existing documents would miss an orphaned nested subcollection.
// This inventory is outside the transaction. The only cleanup writer able to
// add private descendants is runtime, whose range is read again in finish().
async function assertUserTreeEmpty(db, uid) {
  const collections = await db.collection("users").doc(uid).listCollections();
  for (const collection of collections) {
    if ((await collection.listDocuments()).length) conflict();
  }
}

function pathParts(snapshot, group) {
  const parts = snapshot.ref.path.split("/");
  const expected = ["members", "ranking", "challenges"].includes(group) ? 4 : 6;
  if (parts.length !== expected || parts[0] !== "circles" ||
      parts.at(-2) !== group || (expected === 6 && parts[2] !== "challenges") ||
      !parts.every(storedPathSegment)) conflict();
  return parts;
}
function validateHistory(snapshot, group, uid) {
  const parts = pathParts(snapshot, group);
  const data = snapshot.data();
  if (!object(data) || data.uid !== uid) conflict();
  if (group !== "processed_events" && parts.at(-1) !== uid) conflict();
  if (group === "progress") {
    const allowed = ["uid", "value", "updatedAt", "lastEventAt"];
    // Published writers also accept legacy progress without timestamp fields.
    if (Object.keys(data).some((key) => !allowed.includes(key)) ||
        !Number.isSafeInteger(data.value) || data.value < 0 ||
        (Object.hasOwn(data, "updatedAt") && !time(data.updatedAt)) ||
        (Object.hasOwn(data, "lastEventAt") && !time(data.lastEventAt)) ||
        (time(data.updatedAt) && time(data.lastEventAt) &&
          data.lastEventAt.toMillis() > data.updatedAt.toMillis())) conflict();
  } else if (group === "ranking") {
    const allowed = ["uid", "name", "totalXp", "photoUrl", "updatedAt"];
    if (Object.keys(data).some((key) => !allowed.includes(key)) ||
        typeof data.name !== "string" || !Number.isSafeInteger(data.totalXp) ||
        data.totalXp < 0 || !(data.photoUrl === null || typeof data.photoUrl === "string") ||
        (Object.hasOwn(data, "updatedAt") && !time(data.updatedAt))) conflict();
  } else {
    const focus = data.source === "VERIFIED_FOCUS";
    const keys = focus
      ? ["source", "sessionId", "uid", "challengeType", "contributionValue",
        "sessionStartedAt", "sessionCompletedAt", "processedAt", "schemaVersion"]
      : ["source", "activityEventId", "uid", "activityType", "challengeType", "resourceId",
        "contributionValue", "eventOccurredAt", "processedAt", "schemaVersion"];
    if (!exact(data, keys) || data.schemaVersion !== 1 || !time(data.processedAt) ||
        !Number.isSafeInteger(data.contributionValue) || data.contributionValue < 1) conflict();
    if (focus) {
      if (!safeId(data.sessionId) || parts.at(-1) !== data.sessionId ||
          !["FOCUS_MINUTES", "STUDY_MINUTES"].includes(data.challengeType) ||
          !time(data.sessionStartedAt) || !time(data.sessionCompletedAt) ||
          data.sessionStartedAt.toMillis() > data.sessionCompletedAt.toMillis()) conflict();
    } else {
      if (data.source !== "VERIFIED_ACTIVITY" ||
          !["TASK_COMPLETION", "HABIT_COMPLETION"].includes(data.activityType) ||
          data.challengeType !== (data.activityType === "TASK_COMPLETION" ? "TASK_COMPLETIONS" : "HABIT_COMPLETIONS") ||
          !safeId(data.resourceId) || data.activityEventId !== parts.at(-1) ||
          data.contributionValue !== 1 || !time(data.eventOccurredAt)) conflict();
    }
  }
}
async function scan(query, visit, tx) {
  let cursor;
  for (;;) {
    let page = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await (tx ? tx.get(page) : page.get());
    if (!snapshot || !Array.isArray(snapshot.docs)) conflict();
    if (snapshot.docs.length === 0) return;
    for (const doc of snapshot.docs) await visit(doc);
    cursor = snapshot.docs.at(-1);
  }
}
function validateCircle(circle) {
  if (!object(circle) || circle.schemaVersion !== 2 || !safeId(circle.adminId) ||
      !Number.isInteger(circle.memberCount) || circle.memberCount < 1 ||
      ![3, 10, 30].includes(circle.memberLimit) || circle.memberCount > circle.memberLimit ||
      ![undefined, "SERVER_DELETING"].includes(circle.deletionState)) conflict();
}
async function preflightOwned(tx, db, uid) {
  const owned = await tx.get(db.collection("circles").where("adminId", "==", uid).limit(PAGE_SIZE + 1));
  if (owned.docs.length > PAGE_SIZE) conflict();
  for (const snapshot of owned.docs) {
    validateCircle(snapshot.data());
    if (snapshot.data().memberCount > 1) conflict("CIRCLE_ADMIN_ACTION_REQUIRED");
    const members = await tx.get(snapshot.ref.collection("members").limit(31));
    if (members.docs.length !== 1 || members.docs[0].ref.path.split("/").at(-1) !== uid ||
        members.docs[0].data()?.role !== "admin") conflict();
  }
}
async function cleanupOwned(db, uid, guard, allowShared) {
  let removed = false;
  for (;;) {
    const owned = await db.collection("circles").where("adminId", "==", uid).limit(1).get();
    if (!owned.docs.length) return removed;
    const circleRef = owned.docs[0].ref;
    const circleId = circleRef.path.split("/").at(-1);
    const markerRef = db.collection("circle_deletions").doc(circleId);
    const members = await db.runTransaction(async (tx) => {
      await requireGuard(tx, db, uid, guard);
      const root = await tx.get(circleRef);
      const marker = await tx.get(markerRef);
      const list = await tx.get(circleRef.collection("members").limit(31));
      if (!root.exists) return null;
      const data = root.data();
      validateCircle(data);
      if (data.adminId !== uid || list.docs.length > 30 ||
          list.docs.length !== data.memberCount) conflict();
      if (!allowShared && data.memberCount > 1) conflict("CIRCLE_ADMIN_ACTION_REQUIRED");
      for (const member of list.docs) {
        const id = pathParts(member, "members").at(-1);
        if (!safeId(id) || member.data()?.role !== (id === uid ? "admin" : "member")) conflict();
      }
      if (!list.docs.some((doc) => doc.ref.path.split("/").at(-1) === uid)) conflict();
      if (marker.exists) {
        const value = marker.data();
        if (!exact(value, ["version", "state", "circleId", "createdAt"]) ||
            value.version !== 1 || value.state !== "AUTH_DELETE_ORPHAN_CLEANUP" ||
            value.circleId !== circleId || !time(value.createdAt)) conflict();
      }
      // Retain the UID/member context until recursiveDelete is confirmed.
      // cleanupPendingMarkers replaces it with a UID-free closure reservation.
      tx.set(markerRef, {version: 1, state: "SERVER_DELETING", circleId,
        initiatedBy: uid, memberUids: list.docs.map((doc) => doc.ref.path.split("/").at(-1)),
        createdAt: Timestamp.now()});
      tx.update(circleRef, {deletionState: "SERVER_DELETING"});
      return list.docs;
    });
    if (members === null) continue;
    await cleanupPendingMarkers(db, uid, guard);
    removed = true;
  }
}
async function clearLink(db, uid, circleId) {
  await db.runTransaction(async (tx) => {
    const ref = db.collection("users").doc(uid);
    const user = await tx.get(ref);
    if (user.exists && user.data().activeCircleId === circleId) tx.update(ref, {activeCircleId: null});
  });
}
function validatePendingMarker(snapshot) {
  const value = snapshot.data();
  const circleId = snapshot.ref.path.split("/").at(-1);
  if (snapshot.ref.path.split('/').length !== 2 ||
      snapshot.ref.path.split('/')[0] !== "circle_deletions" ||
      !storedPathSegment(circleId)) conflict();
  if (!exact(value, ["version", "state", "circleId", "initiatedBy", "memberUids", "createdAt"]) ||
      value.version !== 1 || value.state !== "SERVER_DELETING" || value.circleId !== circleId ||
      !safeId(value.initiatedBy) || !Array.isArray(value.memberUids) ||
      value.memberUids.length < 1 || value.memberUids.length > 30 ||
      !value.memberUids.every(safeId) || new Set(value.memberUids).size !== value.memberUids.length ||
      !value.memberUids.includes(value.initiatedBy) || !time(value.createdAt)) conflict();
  return value;
}
async function cleanupPendingMarkers(db, uid, guard) {
  let removed = false;
  await scan(db.collection("circle_deletions"), async (doc) => {
    const data = doc.data();
    if (data?.initiatedBy !== uid && !data?.memberUids?.includes(uid)) return;
    const marker = validatePendingMarker(doc);
    const circleRef = db.collection("circles").doc(marker.circleId);
    const claimed = await db.runTransaction(async (tx) => {
      await requireGuard(tx, db, uid, guard);
      const current = await tx.get(doc.ref);
      const root = await tx.get(circleRef);
      const closureRef = db.collection('circle_cleanup_guards').doc(marker.circleId);
      const closure = await tx.get(closureRef);
      if (!current.exists) return false;
      const latest = validatePendingMarker(current);
      if (JSON.stringify(latest) !== JSON.stringify(marker)) conflict();
      if (root.exists && (root.data().adminId !== marker.initiatedBy ||
          root.data().deletionState !== "SERVER_DELETING")) conflict();
      if (root.exists) validateCircle(root.data());
      if (closure.exists) {
        if (!exact(closure.data(), ['version', 'state', 'createdAt']) ||
            closure.data().version !== 1 || closure.data().state !== 'SERVER_DELETING' ||
            !time(closure.data().createdAt)) conflict();
      } else {
        tx.set(closureRef, {version: 1, state: 'SERVER_DELETING', createdAt: Timestamp.now()});
      }
      return true;
    });
    if (!claimed) return;
    for (const memberUid of marker.memberUids) await clearLink(db, memberUid, marker.circleId);
    await db.deleteTree(circleRef);
    await db.runTransaction(async (tx) => {
      await requireGuard(tx, db, uid, guard);
      const current = await tx.get(doc.ref);
      if (!current.exists) return;
      if (JSON.stringify(validatePendingMarker(current)) !== JSON.stringify(marker)) conflict();
      tx.delete(doc.ref);
    });
    removed = true;
  });
  return removed;
}
async function cleanupMemberships(db, uid, guard) {
  await scan(db.collectionGroup("members"), async (doc) => {
    if (doc.ref.path.split("/").at(-1) !== uid) return;
    const parts = pathParts(doc, "members");
    const circleRef = db.collection("circles").doc(parts[1]);
    await db.runTransaction(async (tx) => {
      await requireGuard(tx, db, uid, guard);
      const current = await tx.get(doc.ref);
      const root = await tx.get(circleRef);
      const members = await tx.get(circleRef.collection("members").limit(31));
      if (!current.exists) return;
      if (!["member", "admin"].includes(current.data()?.role)) conflict();
      if (root.exists) {
        validateCircle(root.data());
        if (root.data().adminId === uid) conflict("CIRCLE_ADMIN_ACTION_REQUIRED");
        if (current.data().role !== "member" || members.docs.length !== root.data().memberCount ||
            members.docs.length > 30 || !members.docs.some((member) =>
              member.ref.path.split("/").at(-1) === root.data().adminId && member.data()?.role === "admin")) conflict();
        tx.update(circleRef, {memberCount: members.docs.length - 1, updatedAt: Timestamp.now()});
      }
      tx.delete(doc.ref);
    });
  });
}
async function cleanupHistory(db, uid, guard) {
  for (const group of ["processed_events", "progress", "ranking"]) {
    const query = db.collectionGroup(group).where("uid", "==", uid).limit(PAGE_SIZE);
    for (;;) {
      const page = await query.get();
      if (!page.docs.length) break;
      for (const doc of page.docs) validateHistory(doc, group, uid);
      await db.runTransaction(async (tx) => {
        await requireGuard(tx, db, uid, guard);
        const current = await Promise.all(page.docs.map((doc) => tx.get(doc.ref)));
        for (const doc of current) if (doc.exists) validateHistory(doc, group, uid);
        for (const doc of current) if (doc.exists) tx.delete(doc.ref);
      });
    }
  }
  await scan(db.collectionGroup("challenges"), async (doc) => {
    if (doc.data()?.createdBy !== uid) return;
    pathParts(doc, "challenges");
    await db.runTransaction(async (tx) => {
      await requireGuard(tx, db, uid, guard);
      const current = await tx.get(doc.ref);
      if (current.exists && current.data()?.createdBy === uid) tx.update(doc.ref, {createdBy: ANONYMOUS_AUTHOR});
    });
  });
}
async function assertEmpty(tx, db, uid) {
  for (const group of ["processed_events", "progress", "ranking"]) {
    const page = await tx.get(db.collectionGroup(group).where("uid", "==", uid).limit(1));
    if (page.docs.length) conflict();
  }
  const owned = await tx.get(db.collection("circles").where("adminId", "==", uid).limit(1));
  if (owned.docs.length) conflict();
}
async function verifyReferences(db, uid, tx) {
  for (const group of ["progress", "ranking", "members"]) {
    await scan(db.collectionGroup(group), async (doc) => {
      if (doc.ref.path.split("/").at(-1) === uid) conflict();
    }, tx);
  }
  await scan(db.collectionGroup("challenges"), async (doc) => {
    if (doc.data()?.createdBy === uid) conflict();
  }, tx);
  await scan(db.collection("circle_deletions"), async (doc) => {
    if (doc.data()?.initiatedBy === uid || doc.data()?.memberUids?.includes(uid)) conflict();
  }, tx);
}
module.exports = {capturePermitted, captureTree, treeState, setAuthOutcome, PAGE_SIZE, storedPathSegment, guardRef, validateGuard, beginGuard, bindOperation, requireGuard, requireActiveGuard, withActiveGuard,
  assertUserTreeEmpty, preflightOwned, cleanupOwned, cleanupPendingMarkers, cleanupMemberships,
  cleanupHistory, assertEmpty, verifyReferences};
