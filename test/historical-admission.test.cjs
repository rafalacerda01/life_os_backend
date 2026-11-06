"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {Timestamp} = require("firebase-admin/firestore");
const {createHash} = require("node:crypto");
const {MemoryFirestore} = require("./account-cleanup-memory.cjs");
const admission = require("../api/account/_historical_admission.cjs");
const control = require("../api/account/_deletion_control.cjs");
const manifest = require("../api/account/_cleanup_manifest.cjs");
const {validateEvidenceV2} = require("../api/account/_proof_validator_v2.cjs");
const UID = "historical-A", ROOT = "users/" + UID, BASE = "account_deletion_guards/" + UID;
const REVIEW = BASE + "/control/admission_review", OP = BASE + "/control/operation";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BORN = Timestamp.fromMillis(1700000000000);
function ledger(db) {
  return {version: 1, uid: UID, projectId: db.projectId, tenantId: null,
    authCreatedAt: BORN, sourceType: "FIREBASE_AUTH_CREATE", sourceEventId: "birth-original",
    eventAt: BORN, recordedAt: BORN, decisionId: ID, status: "RECORDED_COHORT_CLOSED",
    originalIdentity: {uid: UID, email: "synthetic@example.invalid", displayName: "Synthetic", photoUrl: null},
    cohort: {version: 1, id: "synthetic-cohort", policy: "NEW_ACCOUNT_V2_ONLY", state: "CLOSED", cutoverAt: BORN}};
}
function fixture() {
  const db = new MemoryFirestore(), calls = {lookup: 0, authDelete: 0, preflight: 0};
  const hash = createHash("sha256").update(UID).digest("hex");
  for (const [path, data] of [
    [ROOT, {activeCircleId: "old-circle", email: "synthetic@example.invalid"}],
    [ROOT + "/notes/old", {owner: "old-A"}], [ROOT + "/missing/parent/deeper/orphan", {old: true}],
    ["users/independent-B", {owner: "B"}], ["users/independent-B/notes/private", {keep: true}],
    ["circles/old-circle", {owner: "old-A"}], ["circles/old-circle/members/" + UID, {role: "admin"}],
    ["billing_google_accounts/" + hash, {uid: UID, state: "ACTIVE"}],
    ["billing_google_tokens/synthetic", {accountHash: hash}],
  ]) db.put(path, data);
  const auth = {getUser: async () => {calls.lookup++; throw Error("UNKNOWN_AUTH_LOOKUP");},
    deleteUser: async () => {calls.authDelete++; throw Error("MUST_NOT_DISPATCH");}};
  const binding = {projectId: db.projectId, databaseId: db.databaseId, uid: UID};
  return {db, auth, calls, binding};
}
const frozen = db => JSON.stringify([...db.docs]);
function preserved(db, before) {
  for (const [p, v] of before) assert.deepEqual(db.docs.get(p), v, p);
}
async function denied(p) {
  await assert.rejects(p, e => ["ACCOUNT_CLEANUP_REVIEW_REQUIRED", "ACCOUNT_DELETION_BLOCKED", "USER_DATA_CLEANUP_FAILED"].includes(e.code || e.message));
}
async function effectDenied(f) {
  const before = new Map(f.db.docs);
  await denied((await import("../api/account/delete.js")).deleteAccount({db:f.db, auth:f.auth, uid:UID, cleanupAuthorized:true}));
  preserved(f.db, before);
  assert.deepEqual(f.calls, {lookup: 0, authDelete: 0, preflight: 0});
  assert.equal(f.db.docs.has(OP), false);
  assert.equal(f.db.docs.get(REVIEW).state, "REVIEW_REQUIRED");
  assert.equal(f.db.docs.get(REVIEW).reason, "AUTHORITATIVE_GENERATION_OWNERSHIP_UNAVAILABLE");
  assert.equal([...f.db.docs].some(([p]) => p.includes("/cleanup_manifests/")), false);
  // A review request is not destructive admission. Existing controls are
  // tested separately and still deny; no new guard grants cleanup authority.
  await f.db.runTransaction(tx => control.assertNormalWriterTransaction(tx, f.db, UID));
}

test("B1 no ledger: entry refuses before Auth/Circle/Billing without manufacturing destructive controls", async () => {
  const f = fixture(); await effectDenied(f);
  assert.equal(f.db.docs.has(BASE), false);
  assert.equal(f.db.docs.has("retired_auth_identities/" + UID), false);
});
test("B1 structurally valid birth ledger alone never authorizes historical ownership", async () => {
  const f = fixture(), record = ledger(f.db);
  control.validateBirth(record, f.binding);
  f.db.put("account_birth_decisions/" + UID, record);
  await effectDenied(f);
});
test("B1 contradictory ledger, equal timestamp, email and caller proof claims are not authority", async () => {
  const f = fixture(); f.db.put("account_birth_decisions/" + UID, {...ledger(f.db), uid: "other-generation"});
  f.db.put(ROOT, {uid: UID, email: "synthetic@example.invalid", createdAt: BORN,
    originalIdentity: true, cleanupAuthorized: true});
  await effectDenied(f);
});
test("B1 structurally valid V2 envelope without authority is refused", async () => {
  const f = fixture();
  const evidence = {version: 2, binding: {...f.binding, tenantId: null}, sources: [], claims: []};
  const result = validateEvidenceV2(evidence, evidence.binding);
  assert.equal(result.structurallyValid, true);
  assert.equal(result.authority, "NONE"); assert.equal(result.cleanupAuthorized, false);
  f.db.put(ROOT + "/runtime/client-proof", evidence); await effectDenied(f);
});
test("B1 repeated and concurrent refusals preserve original review operation", async () => {
  const f = fixture(); const reject = () => denied(admission.refuseUnprovenAdmission(f.db, f.binding, "PRE_AUTH"));
  await Promise.all([reject(), reject()]);
  const original = frozen(f.db); await reject(); assert.equal(frozen(f.db), original);
  assert.ok(f.db.conflicts > 0);
});
test("B1 unknown commit after durable refusal never grants admission or reopens controls", async () => {
  const f = fixture(); let lost = false;
  f.db.hooks.afterCommit = async ({writes}) => {if (!lost && writes.length) {lost = true; throw Error("LOST_COMMIT_RESPONSE");}};
  await denied(admission.refuseUnprovenAdmission(f.db, f.binding, "PRE_AUTH"));
  assert.equal(lost, true); const before = frozen(f.db); delete f.db.hooks.afterCommit;
  await denied(admission.refuseUnprovenAdmission(f.db, f.binding, "PRE_AUTH"));
  assert.equal(frozen(f.db), before); assert.equal(f.db.docs.get(REVIEW).state, "REVIEW_REQUIRED");
});
test("B1 unavailable or ambiguous control reads refuse without writing any outcome", async () => {
  for (const ambiguous of [false, true]) {
    const f = fixture(), before = frozen(f.db);
    f.db.runTransaction = async fn => {
      if (!ambiguous) throw Error("UNKNOWN_STORAGE_RESULT");
      return fn({get: async () => ({exists: undefined, data: () => undefined}), create: () => assert.fail("unknown reads must not write")});
    };
    await denied(admission.refuseUnprovenAdmission(f.db, f.binding, "PRE_AUTH"));
    assert.equal(frozen(f.db), before);
  }
});
test("B1 contradictory preexisting review is preserved, never normalized to acceptance", async () => {
  const f = fixture(); f.db.put(REVIEW, {state: "APPROVED", proof: true}); const before = frozen(f.db);
  await denied(admission.refuseUnprovenAdmission(f.db, f.binding, "PRE_AUTH"));
  assert.equal(frozen(f.db), before);
});
for (const partial of ["retired_auth_identities/" + UID, BASE, OP]) {
  test("B1 partial/contradictory control is retained without manufacturing missing controls: " + partial, async () => {
    const f = fixture(); f.db.put(partial, {legacy: true}); const before = new Map(f.db.docs);
    await denied(admission.refuseUnprovenAdmission(f.db, f.binding, "PRE_AUTH")); preserved(f.db, before);
    assert.equal(f.db.docs.size, before.size + 1); assert.equal(f.db.docs.get(REVIEW).state, "REVIEW_REQUIRED");
  });
}
test("B1 preserves valid sealed manifests and atomic chunk receipts; callback cannot adopt them", async () => {
  const f = fixture(); const c = control.createController({db: f.db, binding: f.binding,
    clock: () => BORN, uuid: () => ID, ports: {getAuthenticatedSubject: async () => f.binding, getAuthUser: async () => ({uid: UID})}});
  const a = await c.admitBackend(), operation = c.originalOperation(a.handle);
  await manifest.captureTree({db: f.db, operation, ref: f.db.doc(ROOT),
    assertOperation: tx => c.assertOperationTransaction(tx, a.handle), authorizeCapture: async () => true, beforeEffect: async () => {}});
  const before = new Map(f.db.docs);
  await denied(admission.refuseUnprovenAdmission(f.db, f.binding, "PRE_AUTH"));
  await denied(admission.refuseUnprovenAdmission(f.db, f.binding, "AUTH_EVENT", "late-event"));
  preserved(f.db, before); assert.equal(f.db.docs.get(OP).state, "IN_PROGRESS");
});
test("B1 COMPLETE remains terminal and unchanged on a new refusal", async () => {
  const f = fixture(); const scope = {policyVersion: "ACCOUNT_DELETE_SCOPE_V1", privateRoot: ROOT,
    guardStartedAt: BORN, billingAccountHash: createHash("sha256").update(UID).digest("hex"), birthDecisionId: null, birthDigest: null};
  const operation = {...f.binding, version: 1, deletionId: ID, state: "COMPLETE", origin: "PRE_AUTH", sourceEventId: null, scope, completedAt: BORN};
  control.validateControl(operation, f.binding); f.db.put(OP, operation); const before = new Map(f.db.docs);
  await denied(admission.refuseUnprovenAdmission(f.db, f.binding, "PRE_AUTH"));
  preserved(f.db, before); assert.equal(f.db.docs.get(OP).state, "COMPLETE");
});
test("B1 mismatched project/database is refused before any decision write", async () => {
  const f = fixture(), before = frozen(f.db);
  await assert.rejects(admission.refuseUnprovenAdmission(f.db, {...f.binding, projectId: "demo-wrong-project"}, "PRE_AUTH"));
  await assert.rejects(admission.refuseUnprovenAdmission(f.db, {...f.binding, databaseId: "foreign"}, "PRE_AUTH"));
  assert.equal(frozen(f.db), before);
});

test("B1 backend adapter never invokes read-only preflight or unknown Auth port when authority is absent", async () => {
  const f = fixture(), before = new Map(f.db.docs);
  const {prepare} = await import("../api/account/_birth_ledger_cleanup.js");
  await denied(prepare({db:f.db,auth:f.auth,uid:UID,preflight:async()=>{f.calls.preflight++;throw Error("MUST_NOT_ENTER_PREFLIGHT");}}));
  assert.deepEqual(f.calls,{lookup:0,authDelete:0,preflight:0}); preserved(f.db,before);
  assert.equal(f.db.docs.get(REVIEW).state,"REVIEW_REQUIRED");
});
