"use strict";
const {createHash} = require("node:crypto");
const {Timestamp} = require("firebase-admin/firestore");

// Bounded snapshots, never UID discovery during a retry. This is object-version
// fencing, NOT proof of Auth generation. Admission and effective R8 remain gates.
const PAGE = 40, MAX_DOCUMENTS = 4000, MAX_BYTES = 4 * 1024 * 1024;
function fail(code = "ACCOUNT_CLEANUP_REVIEW_REQUIRED") {
  const error = new Error("Account cleanup requires review.");
  error.code = code;
  throw error;
}
function stamp(value) {
  if (!(value instanceof Timestamp) || !Number.isSafeInteger(value.seconds) ||
      !Number.isInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds >= 1000000000) fail();
  return value;
}
function same(a, b) {
  return a === null ? b === null :
    b instanceof Timestamp && a.isEqual(b);
}
function digest(entries) {
  return createHash("sha256").update(JSON.stringify(entries.map(e =>
    [e.path, e.version.seconds, e.version.nanoseconds]))).digest("hex");
}
function refs(db, operation, root) {
  if (root !== operation.scope.privateRoot && !/^circles\/[^/]+$/.test(root)) fail();
  const id = createHash("sha256").update(root).digest("hex");
  const header = db.doc("account_deletion_guards/" + operation.uid +
    "/cleanup_manifests/" + id);
  return {header, page: i => header.collection("pages").doc(String(i))};
}
function header(value, operation, root) {
  if (!value || value.version !== 2 || value.uid !== operation.uid ||
      value.projectId !== operation.projectId ||
      value.databaseId !== operation.databaseId ||
      value.deletionId !== operation.deletionId || value.root !== root ||
      !["SEALED", "COMPLETE", "QUARANTINED"].includes(value.state) ||
      !Array.isArray(value.pageHashes) || value.pageHashes.length > 101 ||
      value.pageHashes.some(h => !/^[a-f0-9]{64}$/.test(h)) ||
      !["NOT_REQUESTED", "DISPATCHED", "CONFIRMED", "UNKNOWN"].includes(value.authOutcome)) fail();
  if (value.rootVersion !== null) stamp(value.rootVersion);
  if (value.state === "QUARANTINED" || value.authOutcome === "UNKNOWN") fail();
  return value;
}
function page(value, h, index) {
  if (!value || value.version !== 2 || value.index !== index ||
      typeof value.done !== "boolean" || !Array.isArray(value.entries) ||
      value.entries.length > PAGE || digest(value.entries) !== h.pageHashes[index]) fail();
  for (const e of value.entries) {
    if (typeof e.path !== "string" ||
        !(e.path === h.root || e.path.startsWith(h.root + "/"))) fail();
    stamp(e.version);
  }
  return value;
}
async function inventory(ref) {
  const entries = [];
  let bytes = 0;
  async function walk(current, depth) {
    if (depth > 64) fail("ACCOUNT_CLEANUP_LIMIT");
    const snapshot = await current.get();
    if (snapshot.exists) {
      const entry = {path: current.path, version: stamp(snapshot.updateTime)};
      entries.push(entry);
      bytes += Buffer.byteLength(JSON.stringify(entry));
      if (entries.length > MAX_DOCUMENTS || bytes > MAX_BYTES) fail("ACCOUNT_CLEANUP_LIMIT");
    }
    for (const collection of await current.listCollections()) {
      if (!collection.path.startsWith(current.path + "/") ||
          collection.path.split("/").length !== current.path.split("/").length + 1) fail();
      for (const child of await collection.listDocuments()) {
        if (!child.path.startsWith(collection.path + "/") ||
            child.path.split("/").length !== collection.path.split("/").length + 1) fail();
        await walk(child, depth + 1);
      }
    }
  }
  await walk(ref, 0);
  entries.sort((a, b) => b.path.split("/").length - a.path.split("/").length ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}
async function quarantine(argumentsForQuarantine, reason) {
  const {db, operation, ref, assertOperation} = argumentsForQuarantine;
  const target = refs(db, operation, ref.path);
  const account = refs(db, operation, operation.scope.privateRoot);
  await db.runTransaction(async tx => {
    await (argumentsForQuarantine.assertOriginalOperation || assertOperation)(tx);
    const current = await tx.get(target.header);
    const original = target.header.path === account.header.path ?
      current : await tx.get(account.header);
    if ([current, original].some(s => s.exists &&
        s.data().deletionId !== operation.deletionId)) fail();
    function mark(reference, snapshot, root) {
      if (!snapshot.exists) {
        tx.create(reference, {version: 2, uid: operation.uid,
          projectId: operation.projectId, databaseId: operation.databaseId,
          deletionId: operation.deletionId, root, rootVersion: null,
          state: "QUARANTINED", pageHashes: [], billingVersion: null,
          circleDeleted: false, authOutcome: "NOT_REQUESTED", reason});
      } else if (snapshot.data().state !== "QUARANTINED") {
        // Original R5 must still be active. Tree COMPLETE is a receipt, not
        // account terminality; quarantine never grants another delete.
        tx.update(reference, {state: "QUARANTINED", reason});
      }
    }
    mark(target.header, current, ref.path);
    if (target.header.path !== account.header.path) {
      mark(account.header, original, operation.scope.privateRoot);
    }
  });
}
async function captureTree(options) {
  const {db, operation, ref, assertOperation, authorizeCapture} = options;
  const r = refs(db, operation, ref.path);
  const prior = await r.header.get();
  if (prior.exists) return header(prior.data(), operation, ref.path);
  if (await authorizeCapture() !== true) {
    await quarantine(options, "PRE_AUTH_CAPTURE_REQUIRED");
    fail();
  }
  const entries = await inventory(ref);
  const rootVersion = entries.find(e => e.path === ref.path)?.version || null;
  const pages = [];
  // Keep the root in its own final chunk so every descendant chunk reads its
  // original version. No wide delete and no target version refresh on retry.
  const descendants = entries.filter(e => e.path !== ref.path);
  for (let i = 0; i < descendants.length; i += PAGE) pages.push(descendants.slice(i, i + PAGE));
  if (rootVersion !== null) pages.push([{path: ref.path, version: rootVersion}]);
  const h = {version: 2, uid: operation.uid, projectId: operation.projectId,
    databaseId: operation.databaseId, deletionId: operation.deletionId,
    root: ref.path, rootVersion, state: "SEALED", pageHashes: pages.map(digest),
    billingVersion: null, circleDeleted: options.circleDeleted === true,
    authOutcome: "NOT_REQUESTED", reason: null};
  return db.runTransaction(async tx => {
    await assertOperation(tx);
    const existing = await tx.get(r.header);
    const root = await tx.get(ref);
    if (existing.exists) return header(existing.data(), operation, ref.path);
    if (ref.path === operation.scope.privateRoot) {
      const billing = await tx.get(db.doc("billing_google_accounts/" + operation.scope.billingAccountHash));
      h.billingVersion = billing.exists ? stamp(billing.updateTime) : null;
    }
    if (!same(rootVersion, root.exists ? stamp(root.updateTime) : null)) fail();
    tx.create(r.header, h);
    pages.forEach((entries, index) => tx.create(r.page(index),
      {version: 2, index, entries, done: false}));
    return h;
  });
}
async function removeTree(options) {
  const {db, operation, ref, assertOperation, beforeEffect} = options;
  const r = refs(db, operation, ref.path);
  const read = await r.header.get();
  if (!read.exists) {await quarantine(options, "MANIFEST_MISSING"); fail();}
  const h = header(read.data(), operation, ref.path);
  if (h.state === "COMPLETE") return;
  try {
    for (let i = 0; i < h.pageHashes.length; i++) {
      await beforeEffect();
      await db.runTransaction(async tx => {
        await assertOperation(tx);
        const current = header((await tx.get(r.header)).data(), operation, ref.path);
        const p = page((await tx.get(r.page(i))).data(), current, i);
        if (p.done) return;
        if (current.state !== "SEALED") fail();
        const root = await tx.get(ref);
        if (!same(h.rootVersion, root.exists ? stamp(root.updateTime) : null)) fail();
        const snapshots = [];
        for (const e of p.entries) snapshots.push(await tx.get(db.doc(e.path)));
        if (snapshots.some((s, k) => !s.exists ||
            !same(p.entries[k].version, stamp(s.updateTime)))) fail();
        snapshots.forEach(s => tx.delete(s.ref));
        tx.update(r.page(i), {done: true});
      });
    }
    // An unknown/new descendant is an incident, never adopted by a new scan.
    if ((await inventory(ref)).length) fail();
    await db.runTransaction(async tx => {
      await assertOperation(tx);
      const current = header((await tx.get(r.header)).data(), operation, ref.path);
      if (current.state === "COMPLETE") return;
      for (let i = 0; i < current.pageHashes.length; i++) {
        if (!page((await tx.get(r.page(i))).data(), current, i).done) fail();
      }
      if ((await tx.get(ref)).exists) fail();
      tx.update(r.header, {state: "COMPLETE"});
    });
  } catch (error) {
    // A transport error keeps the same sealed pages/atomic receipts for retry.
    // Version/ownership conflict permanently quarantines this original scope.
    if (error?.code === "ACCOUNT_CLEANUP_REVIEW_REQUIRED" ||
        error?.code === "ACCOUNT_CLEANUP_LIMIT") {
      await quarantine(options, "RESOURCE_VERSION_CONFLICT");
    }
    throw error;
  }
}
async function authOutcome(options, expected, next) {
  if (!((expected === "NOT_REQUESTED" && next === "DISPATCHED") ||
      (expected === "DISPATCHED" && ["CONFIRMED", "UNKNOWN"].includes(next)))) {
    fail("ACCOUNT_AUTH_OUTCOME_UNKNOWN");
  }
  const {db, operation, ref, assertOperation} = options;
  const r = refs(db, operation, ref.path);
  return db.runTransaction(async tx => {
    await assertOperation(tx);
    const h = header((await tx.get(r.header)).data(), operation, ref.path);
    if (h.authOutcome !== expected) fail("ACCOUNT_AUTH_OUTCOME_UNKNOWN");
    tx.update(r.header, {authOutcome: next});
  });
}
async function state(options, optional = false) {
  const r = refs(options.db, options.operation, options.ref.path);
  const read = await r.header.get();
  if (!read.exists) {if (optional) return null; fail();}
  return header(read.data(), options.operation, options.ref.path);
}
module.exports = {captureTree, removeTree, quarantine, authOutcome, state,
  inventory, refs, PAGE, MAX_DOCUMENTS};
