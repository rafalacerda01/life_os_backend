"use strict";
// Auth-blocking genesis. Production is CLOSED until the isolated deployment,
// Identity Platform hook and R8 custody have independent evidence.
const {randomUUID, createHash} = require("node:crypto");
const {AsyncLocalStorage} = require("node:async_hooks");
const {Timestamp} = require("firebase-admin/firestore");
const manifest = require("./_cleanup_manifest.cjs");
const environmentConfiguration = require("../../config/trusted_account_environments.json");
const subjects = new AsyncLocalStorage();
const CLAIM = "lifeos_generation";
const POLICY = "AUTH_BLOCKING_GENESIS_V1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANON = /^[^/\x00-\x1f\x7f]{1,128}$/;
const REGISTRY = "trusted_account_origins";
function fail(code = "TRUSTED_ACCOUNT_REVIEW_REQUIRED") {
  const error = new Error("Account origin or ownership requires review.");
  error.code = code; throw error;
}
function environment(db) {
  const project = require("../../config/local_homologation_environment.cjs").selectedProject();
  for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN"]) {
    if (process.env[key] !== undefined) fail("TRUSTED_ACCOUNT_CREDENTIAL_MIX_REFUSED");
  }
  const loopback = v => /^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(v || "") && Number(v.split(":")[1]) < 65536;
  if (environmentConfiguration.production.state !== "CLOSED" || environmentConfiguration.production.projectId !== null ||
      environmentConfiguration.development.projectId !== "demo-life-os" || db?.projectId !== project || db?.databaseId !== "(default)" ||
      process.env.GCLOUD_PROJECT !== project ||
      ["GOOGLE_CLOUD_PROJECT", "FIREBASE_PROJECT_ID"].some(k => process.env[k] !== undefined && process.env[k] !== project) ||
      !loopback(process.env.FIRESTORE_EMULATOR_HOST) ||
      !loopback(process.env.FIREBASE_AUTH_EMULATOR_HOST)) fail("TRUSTED_ACCOUNT_CLOSED");
}
function ref(db, uid) {
  if (typeof uid !== "string" || !CANON.test(uid) || uid.trim() !== uid || Buffer.byteLength(uid, "utf8") > 128 || uid === "." || uid === ".." || /^__.*__$/.test(uid)) fail();
  return typeof db.doc === "function" ? db.doc(REGISTRY + "/" + uid) : db.collection(REGISTRY).doc(uid);
}
function validate(r, db, uid) {
  if (!r || r.version !== 1 || r.projectId !== db.projectId || r.databaseId !== db.databaseId ||
      r.uid !== uid || r.policy !== POLICY || !UUID.test(r.generation) ||
      !["RESERVED", "ACTIVE", "DELETING", "RETIRED", "REVIEW_REQUIRED"].includes(r.state) ||
      typeof r.eventId !== "string" || !r.eventId || r.eventId.length > 512) fail();
  return r;
}
async function controls(tx, db, uid) {
  for (const p of ["retired_auth_identities/" + uid, "account_deletion_guards/" + uid,
    "account_deletion_guards/" + uid + "/control/operation"]) {
    if ((await tx.get(db.doc(p))).exists) fail("ACCOUNT_DELETION_BLOCKED");
  }
}
// Negative namespace precondition only. The positive origin is the provider's
// blocking-create event plus the claim committed by Auth, never emptiness.
async function namespaceEmpty(db, uid) {
  if ((await manifest.inventory(db.doc("users/" + uid))).length) fail();
  const hash = createHash("sha256").update(uid).digest("hex");
  for (const p of ["billing_google_accounts/" + hash, "account_birth_decisions/" + uid]) {
    if ((await db.doc(p).get()).exists) fail();
  }
  const queries = [db.collection("billing_google_accounts").where("uid", "==", uid), db.collection("billing_google_tokens").where("accountHash", "==", hash),
    db.collection("circles").where("adminId", "==", uid)];
  for (const q of queries) if (!(await q.limit(1).get()).empty) fail();
  // Legacy member/ranking documents may identify their owner ONLY in the ID.
  // Bound the complete scan; never sample and declare the namespace clean.
  for (const name of ["members", "progress", "processed_events", "ranking"]) {
    const docs = (await db.collectionGroup(name).limit(4001).get()).docs;
    if (docs.length > 4000) fail("TRUSTED_ACCOUNT_INVENTORY_LIMIT");
    if (docs.some(s => s.id === uid || ["uid", "userId", "ownerUid", "createdBy"].some(k => s.data()[k] === uid))) fail();
  }
}
async function beforeCreate(db, user, context) {
  environment(db);
  if (!context || typeof context.eventId !== "string" || !context.eventId ||
      !context.eventType?.startsWith("providers/cloud.auth/eventTypes/user.beforeCreate:") ||
      context.resource?.name !== "projects/" + db.projectId || user?.tenantId != null ||
      !["password", "google.com"].includes(context.eventType.split(":").at(-1)) ||
      user.customClaims?.[CLAIM] !== undefined) fail();
  const origin = ref(db, user.uid), generation = randomUUID();
  await namespaceEmpty(db, user.uid);
  const result = await db.runTransaction(async tx => {
    await controls(tx, db, user.uid);
    const existing = await tx.get(origin);
    if (existing.exists) {
      const r = validate(existing.data(), db, user.uid);
      if (r.eventId !== context.eventId || r.state !== "RESERVED") fail();
      return r.generation;
    }
    // Fence ordinary writers before the token exists. Provisioning repeats the
    // namespace check after this reservation, while clients remain denied.
    if ((await tx.get(db.doc("users/" + user.uid))).exists) fail();
    tx.create(origin, {version: 1, projectId: db.projectId, databaseId: db.databaseId,
      uid: user.uid, generation, policy: POLICY, eventId: context.eventId,
      state: "RESERVED", deletionId: null, createdAt: Timestamp.now()});
    return generation;
  });
  return {customClaims: {[CLAIM]: result}};
}
async function provision(db, auth, decoded) {
  environment(db);
  const uid = decoded?.uid, generation = decoded?.[CLAIM];
  if (!UUID.test(generation || "") || decoded.firebase?.tenant != null) fail();
  if (auth?.app?.options?.projectId !== db.projectId || decoded.aud !== db.projectId ||
      decoded.iss !== "https://securetoken.google.com/" + db.projectId) fail();
  return provisionGeneration(db, auth, uid, generation);
}
async function provisionCreatedUser(db, auth, user, context) {
  environment(db);
  if (context?.eventType !== "google.firebase.auth.user.create" ||
      context.resource?.name !== "projects/" + db.projectId ||
      context.resource?.service !== "firebaseauth.googleapis.com" || user?.tenantId != null) fail();
  return provisionGeneration(db, auth, user.uid, user.customClaims?.[CLAIM]);
}
async function provisionGeneration(db, auth, uid, generation) {
  const origin = ref(db, uid);
  if (!UUID.test(generation || "") || auth?.app?.options?.projectId !== db.projectId) fail();
  const user = await auth.getUser(uid);
  if (user.tenantId != null || user.customClaims?.[CLAIM] !== generation) fail();
  const initial = await origin.get();
  if (!initial.exists) fail();
  const r = validate(initial.data(), db, uid);
  if (r.generation !== generation) fail();
  if (r.state === "RESERVED") {
    try { await namespaceEmpty(db, uid); }
    catch (error) {
      if (["TRUSTED_ACCOUNT_REVIEW_REQUIRED", "TRUSTED_ACCOUNT_INVENTORY_LIMIT"].includes(error?.code)) {
        await db.runTransaction(async tx => {
          const current = await tx.get(origin);
          const value = validate(current.data(), db, uid);
          if (value.state === "RESERVED" && value.generation === generation) {
            tx.update(origin, {state: "REVIEW_REQUIRED", reason: "NAMESPACE_RESIDUE_OR_LIMIT"});
          }
        });
      }
      throw error;
    }
  }
  return db.runTransaction(async tx => {
    await controls(tx, db, uid);
    const record = await tx.get(origin), root = await tx.get(db.doc("users/" + uid));
    const current = validate(record.data(), db, uid);
    if (current.generation !== generation) fail();
    if (current.state === "ACTIVE") {
      if (!root.exists || root.data()._lifeosGeneration !== generation) fail();
      return {state: "READY", generation};
    }
    if (current.state !== "RESERVED" || root.exists) fail();
    const clean = value => typeof value === "string" ? value.slice(0, 200) : "";
    tx.create(db.doc("users/" + uid), {uid, email: clean(user.email),
      displayName: clean(user.displayName) || "Novo Usuário", photoUrl: null,
      isPremium: false, xp: 0, level: 1, streak: 0,
      habitsCount: 0, tasksCount: 0, goalsCount: 0, subjectsCount: 0,
      medicationsCount: 0, transactionsCount: 0, _lifeosGeneration: generation});
    tx.update(origin, {state: "ACTIVE"});
    return {state: "READY", generation};
  });
}
function runAuthenticated(decoded, work) {
  return subjects.run(Object.freeze({uid: decoded?.uid || decoded?.sub,
    generation: decoded?.[CLAIM], projectId: decoded?.aud, tenant: decoded?.firebase?.tenant}), work);
}
async function assertWriterTransaction(tx, db, uid) {
  ref(db, uid); // Canonical binding validation.
  const doc = await tx.get(db.collection(REGISTRY).doc(uid));
  if (!doc || typeof doc.exists !== "boolean" || typeof doc.data !== "function" ||
      (!doc.exists && doc.data() !== undefined)) fail();
  const subject = subjects.getStore();
  if (!doc.exists) {
    if (subject?.generation !== undefined || db.projectId === "demo-life-os" ||
        (subject?.projectId && subject.projectId !== "life-os-27b92")) fail();
    return; // Legacy compatibility is not a trusted-account admission.
  }
  environment(db);
  const r = validate(doc.data(), db, uid);
  if (r.state !== "ACTIVE" || subject?.uid !== uid || subject.generation !== r.generation || subject.projectId !== db.projectId || subject.tenant != null) fail("ACCOUNT_DELETION_BLOCKED");
}
// Opaque, process-local evidence; no HTTP JSON can construct this capability.
const deletionProofs = new WeakMap();
async function resolveDeletion(db, auth, uid) {
  environment(db);
  const snapshot = await ref(db, uid).get();
  if (!snapshot.exists) fail();
  const r = validate(snapshot.data(), db, uid);
  const caller = subjects.getStore();
  if (caller && (caller.uid !== uid || caller.generation !== r.generation || caller.projectId !== db.projectId)) fail();
  if (!["ACTIVE", "DELETING", "RETIRED"].includes(r.state) ||
      auth?.app?.options?.projectId !== db.projectId) fail();
  let user;
  try { user = await auth.getUser(uid); }
  catch (error) { if (error?.code !== "auth/user-not-found") fail("TRUSTED_ACCOUNT_AUTH_UNKNOWN"); }
  if (user && (user.uid !== uid || user.tenantId != null || user.customClaims?.[CLAIM] !== r.generation)) fail();
  if (!user && r.state === "ACTIVE") fail();
  if (r.state === "ACTIVE") {
    const root = await db.doc("users/" + uid).get();
    if (!root.exists || root.data()._lifeosGeneration !== r.generation) fail();
  }
  return proofFor(db, r);
}
async function resolveDeletionEvent(db, user, context) {
  environment(db);
  if (context?.eventType !== "google.firebase.auth.user.delete" ||
      context.resource?.name !== "projects/" + db.projectId || user?.tenantId != null) fail();
  const snapshot = await ref(db, user.uid).get();
  if (!snapshot.exists) fail();
  const r = validate(snapshot.data(), db, user.uid);
  if (!["DELETING", "RETIRED"].includes(r.state) ||
      !UUID.test(r.deletionId || "") || user.customClaims?.[CLAIM] !== r.generation) fail();
  return proofFor(db, r);
}
function proofFor(db, r) {
  const proof = Object.freeze({kind: "ORIGINAL_GENESIS_SCOPE"});
  deletionProofs.set(proof, {db, uid: r.uid, generation: r.generation, deletionId: r.deletionId});
  return proof;
}
function proofValue(db, proof) {
  const p = proof && deletionProofs.get(proof);
  if (!p || p.db !== db) fail();
  return p;
}
async function assertDeletionTransaction(tx, db, proof, deletionId) {
  const p = proofValue(db, proof), snapshot = await tx.get(ref(db, p.uid));
  const r = validate(snapshot.data(), db, p.uid);
  if (r.state !== "DELETING" || r.generation !== p.generation ||
      r.deletionId !== deletionId || p.deletionId !== deletionId) fail();
}
async function bindDeletion(db, proof, base, result) {
  if (!result.handle) fail();
  const p = proofValue(db, proof), operation = base.originalOperation(result.handle);
  if (operation.uid !== p.uid) fail();
  if (operation.state === "COMPLETE") {
    if (p.deletionId !== operation.deletionId) fail();
    return result;
  }
  await db.runTransaction(async tx => {
    await base.assertOperationTransaction(tx, result.handle);
    const record = await tx.get(ref(db, p.uid)), r = validate(record.data(), db, p.uid);
    if (r.generation !== p.generation) fail();
    if (r.state === "DELETING" && r.deletionId === operation.deletionId) return;
    if (r.state !== "ACTIVE" || r.deletionId !== null) fail();
    tx.update(ref(db, p.uid), {state: "DELETING", deletionId: operation.deletionId});
  });
  p.deletionId = operation.deletionId;
  return result;
}
async function retire(db, proof) {
  const p = proofValue(db, proof);
  await db.runTransaction(async tx => {
    const op = await tx.get(db.doc("account_deletion_guards/" + p.uid + "/control/operation"));
    const record = await tx.get(ref(db, p.uid)), r = validate(record.data(), db, p.uid);
    if (op.data()?.state !== "COMPLETE" || op.data()?.deletionId !== p.deletionId ||
        r.generation !== p.generation || r.deletionId !== p.deletionId) fail();
    if (r.state === "RETIRED") return;
    if (r.state !== "DELETING") fail();
    tx.update(ref(db, p.uid), {state: "RETIRED"});
  });
}
function protectController(db, proof, base) {
  proofValue(db, proof);
  const wrapped = {...base};
  for (const name of ["admitBackend", "admitManagedEvent"]) {
    wrapped[name] = async (...args) => bindDeletion(db, proof, base, await base[name](...args));
  }
  wrapped.assertOperationTransaction = async (tx, handle) => {
    await base.assertOperationTransaction(tx, handle);
    await assertDeletionTransaction(tx, db, proof, base.originalOperation(handle).deletionId);
  };
  wrapped.assertCleanupTransaction = async (tx, cleanup) => {
    await base.assertCleanupTransaction(tx, cleanup);
    await assertDeletionTransaction(tx, db, proof, proofValue(db, proof).deletionId);
  };
  for (const name of ["finalizeWithOriginalLedger", "finalize", "verifyTerminal"]) {
    wrapped[name] = async (...args) => { const result = await base[name](...args); await retire(db, proof); return result; };
  }
  return Object.freeze(wrapped);
}

module.exports = Object.freeze({beforeCreate, provision, provisionCreatedUser, runAuthenticated,
  assertWriterTransaction, resolveDeletion, resolveDeletionEvent, protectController, assertEnvironment: environment, CLAIM, REGISTRY});
