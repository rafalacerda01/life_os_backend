"use strict";

const {randomUUID} = require("node:crypto");
const {Timestamp, FieldPath} = require("firebase-admin/firestore");

const PAGE_SIZE = 200;
const GUARD_COLLECTION = "account_deletion_guards";
const ANONYMOUS_AUTHOR = "";
// Keep the guard beyond the maximum lifetime of an already-issued ID token.
const COMPLETED_GUARD_RETENTION_MS = 65 * 60 * 1000;

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
async function beginGuard(db, uid, preflight = async () => {}) {
  const ref = guardRef(db, uid);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) return validateGuard(snapshot.data());
    await preflight(tx);
    const guard = {version: 1, state: "IN_PROGRESS", deletionId: randomUUID(),
      startedAt: Timestamp.now(), retainUntil: null};
    tx.set(ref, guard);
    return guard;
  });
}
async function requireGuard(tx, db, uid, guard) {
  const snapshot = await tx.get(guardRef(db, uid));
  if (!snapshot.exists || validateGuard(snapshot.data()).deletionId !== guard.deletionId) conflict();
}
async function completeGuard(db, uid, guard) {
  await db.runTransaction(async (tx) => {
    await requireGuard(tx, db, uid, guard);
    const user = await tx.get(db.collection("users").doc(uid));
    if (user.exists) conflict();
    const snapshot = await tx.get(guardRef(db, uid));
    if (snapshot.data().state === "COMPLETE") return;
    tx.update(guardRef(db, uid), {state: "COMPLETE",
      retainUntil: Timestamp.fromMillis(Date.now() + COMPLETED_GUARD_RETENTION_MS)});
  });
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
async function scan(query, visit) {
  let cursor;
  for (;;) {
    let page = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
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
    await db.recursiveDelete(circleRef);
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
async function verifyReferences(db, uid) {
  for (const group of ["progress", "ranking", "members"]) {
    await scan(db.collectionGroup(group), async (doc) => {
      if (doc.ref.path.split("/").at(-1) === uid) conflict();
    });
  }
  await scan(db.collectionGroup("challenges"), async (doc) => {
    if (doc.data()?.createdBy === uid) conflict();
  });
  await scan(db.collection("circle_deletions"), async (doc) => {
    if (doc.data()?.initiatedBy === uid || doc.data()?.memberUids?.includes(uid)) conflict();
  });
}
module.exports = {PAGE_SIZE, storedPathSegment, guardRef, validateGuard, beginGuard, requireGuard,
  completeGuard, preflightOwned, cleanupOwned, cleanupPendingMarkers, cleanupMemberships,
  cleanupHistory, assertEmpty, verifyReferences};
