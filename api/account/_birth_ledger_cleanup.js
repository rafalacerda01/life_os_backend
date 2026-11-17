// R5 backend adapter. Legacy metadata checks only refuse conflicts.
import {createHash, randomUUID} from "node:crypto";
import {Timestamp} from "firebase-admin/firestore";
import circles from "./_circle_cleanup.cjs";
import cleanupManifest from "./_cleanup_manifest.cjs";

import control from "./_deletion_control.cjs";
import historicalAdmission from "./_historical_admission.cjs";
import trustedAccount from "./_trusted_account.cjs";
import {buildAdmissionReceipt} from "./_terminal_receipt.js";
const KEYS = ["version", "uid", "projectId", "tenantId", "authCreatedAt",
  "sourceType", "sourceEventId", "eventAt", "cohort", "decisionId",
  "originalIdentity", "recordedAt", "status"];

/** Fail without any identity, storage or SDK details. */
function fail() {
  const error = new Error("Account cleanup state is inconsistent.");
  error.code = "ACCOUNT_STATE_CONFLICT";
  throw error;
}

/**
 * @param {*} value Value.
 * @param {Array} keys Expected fields.
 * @return {boolean} Exact record.
 */
function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

/**
 * @param {*} value UID.
 * @return {boolean} Canonical namespace, before references/IO.
 */
function uid(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= 128 && Buffer.byteLength(value, "utf8") <= 128 &&
    value.trim() === value && !value.includes("/") &&
    ![".", ".."].includes(value) && !/^__.*__$/.test(value) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * @param {*} value Time.
 * @return {boolean} Auth-era Firestore time.
 */
function time(value) {
  return value instanceof Timestamp && value.seconds >= 0;
}

/**
 * @param {Timestamp} a First time.
 * @param {Timestamp} b Second time.
 * @return {boolean} Exact ordering; never round to gain authority.
 */
function after(a, b) {
  return a.seconds > b.seconds ||
    (a.seconds === b.seconds && a.nanoseconds > b.nanoseconds);
}

/**
 * Strict UTC form delivered by the managed v1 SDK; preserve supplied fraction.
 * Unsupported time forms fail closed, never use delivery time as event time.
 * @param {*} value Event string.
 * @return {Timestamp} Parsed managed time.
 */
function eventTime(value) {
  const match = typeof value === "string" && value.match(new RegExp(
      "^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})" +
      "(?:\\.(\\d{1,9}))?Z$"));
  if (!match) fail();
  const date = new Date(`${match[1]}.000Z`);
  if (!Number.isFinite(date.getTime()) || date.getTime() < 0 ||
    date.toISOString() !== `${match[1]}.000Z`) fail();
  return new Timestamp(date.getTime() / 1000,
      Number((match[2] || "").padEnd(9, "0")));
}

/**
 * @param {*} value Metadata string, possibly absent for legacy events.
 * @return {*} Time and known precision, or null under policy A.
 */
function metadata(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail();
  if (/^\d{4}-/.test(value)) {
    return {at: eventTime(value), coarse: !value.includes(".")};
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() < 0 ||
    date.toUTCString() !== value) fail();
  return {at: Timestamp.fromMillis(date.getTime()), coarse: true};
}

/**
 * @param {*} value Persisted normalized identity field.
 * @param {number} max Bound.
 * @return {boolean} Bounded normalized text.
 */
function text(value, max) {
  return typeof value === "string" && value.length <= max &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * @param {Object} record Approved B2-A closed record.
 * @param {Object} bound Managed deletion, not HTTP/client authority.
 */
function validate(record, bound) {
  const identity = record && record.originalIdentity;
  const cohort = record && record.cohort;
  if (!exact(record, KEYS) || record.version !== 1 ||
    record.uid !== bound.uid || record.projectId !== bound.projectId ||
    record.tenantId !== null || record.sourceType !== "FIREBASE_AUTH_CREATE" ||
    record.status !== "RECORDED_COHORT_CLOSED" ||
    !text(record.sourceEventId, 512) || !record.sourceEventId ||
    !new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-" +
        "[89ab][0-9a-f]{3}-[0-9a-f]{12}$").test(record.decisionId) ||
    !time(record.authCreatedAt) || !time(record.eventAt) ||
    !time(record.recordedAt) || after(record.authCreatedAt, record.eventAt) ||
    after(record.eventAt, record.recordedAt) ||
    after(record.authCreatedAt, bound.deletedAt) ||
    !exact(cohort, ["version", "id", "policy", "state", "cutoverAt"]) ||
    cohort.version !== 1 || !uid(cohort.id) ||
    cohort.policy !== "NEW_ACCOUNT_V2_ONLY" || cohort.state !== "CLOSED" ||
    !time(cohort.cutoverAt) || after(cohort.cutoverAt, record.authCreatedAt) ||
    !exact(identity, ["uid", "email", "displayName", "photoUrl"]) ||
    identity.uid !== bound.uid || !text(identity.email, 320) ||
    !text(identity.displayName, 200) || !identity.displayName ||
    !(identity.photoUrl === null || text(identity.photoUrl, 2048))) fail();
  if (bound.created && (bound.created.coarse ?
    bound.created.at.seconds !== record.authCreatedAt.seconds :
    !bound.created.at.isEqual(record.authCreatedAt))) fail();
}

// Process-local capabilities. Neither HTTP JSON nor a copied object can resume.
const admissions = new WeakMap();

function session(db, auth, admission) {
  const value = admission && admissions.get(admission);
  if (!value || value.db !== db || value.auth !== auth ||
      db.projectId !== value.operation.projectId ||
      db.databaseId !== value.operation.databaseId) fail();
  return value;
}

function unavailable() {
  const error = new Error("Account deletion remains pending.");
  error.code = "ACCOUNT_DELETION_BLOCKED";
  error.retryable = true;
  throw error;
}

async function controlled(work) {
  try { return await work(); } catch (error) {
    if (error instanceof control.DeletionControlError) {
      if (["READ_UNAVAILABLE", "COMMIT_OUTCOME_UNKNOWN", "AUTH_UNAVAILABLE",
        "BOUNDARY_UNAVAILABLE"].includes(error.code)) unavailable();
      if (error.code === "CIRCLE_ADMIN_ACTION_REQUIRED") {
        const admin = new Error("Circle administration required.");
        admin.code = "CIRCLE_ADMIN_ACTION_REQUIRED";
        throw admin;
      }
      if (error.code === "COMPLETE") {
        const terminal = new Error("Account cleanup is terminal.");
        terminal.code = "ACCOUNT_CLEANUP_COMPLETE";
        throw terminal;
      }
      fail();
    }
    throw error;
  }
}

// An absence here is only an observation. It never admits a new operation.
async function lookup(auth, accountUid) {
  let user;
  try { user = await auth.getUser(accountUid); } catch (error) {
    if (error?.code === "auth/user-not-found") return null;
    unavailable();
  }
  if (!user || user.uid !== accountUid || user.disabled === true ||
      (user.tenantId !== undefined && user.tenantId !== null)) fail();
  metadata(user.metadata?.creationTime); // Invalid metadata is a conflict.
  return user;
}

function checkRoot(root, operation) {
  if (root.exists && root.createTime !== undefined &&
      (!time(root.createTime) ||
        after(root.createTime, operation.scope.guardStartedAt))) fail();
}

function checkUser(user, operation) {
  const created = user ? metadata(user.metadata?.creationTime) : null;
  if (created && (created.coarse ?
    created.at.seconds > operation.scope.guardStartedAt.seconds :
    after(created.at, operation.scope.guardStartedAt))) fail();
  return created;
}

// Real terminal queries: no constant attestation can substitute for these reads.
async function assertTerminal(tx, db, accountUid) {
  const binding = {projectId: db.projectId, databaseId: db.databaseId, uid: accountUid};
  const original = await tx.get(control.references(db, binding).operation);
  const operation = control.validateControl(original.data(), binding);
  if (operation.origin !== "PRE_AUTH" || !operation.scope) fail();
  const root = operation.scope.privateRoot;
  const journal = await tx.get(cleanupManifest.refs(db, operation, root).header);
  // An empty inventory and an absent Auth user cannot replace the original proof.
  if (!journal.exists) fail();
  const h = cleanupManifest.validateHeader(journal.data(), operation, root);
  if (h.state !== "COMPLETE" || h.authOutcome !== "CONFIRMED") fail();

  const hash = createHash("sha256").update(accountUid, "utf8").digest("hex");
  const billing = await tx.get(db.collection("billing_google_accounts").doc(hash));
  const tokens = await tx.get(db.collection("billing_google_tokens")
      .where("accountHash", "==", hash).limit(1));
  const runtime = await tx.get(db.collection("users").doc(accountUid)
      .collection("runtime").limit(1));
  await circles.assertEmpty(tx, db, accountUid);
  await circles.verifyReferences(db, accountUid, tx);
  if (billing.exists || tokens.docs.length || runtime.docs.length) fail();
}

// Server-only seam called by the existing verified HTTP wrapper. No endpoint
// accepts a UID, operation ID, scope or attestation from the request body.
export async function prepare({db, auth, uid: accountUid, preflight, receipt}) {
  return controlled(async () => {
    const binding = control.validateBinding({projectId: db?.projectId,
      databaseId: db?.databaseId, uid: accountUid});
    if (typeof auth?.getUser !== "function" ||
        typeof preflight !== "function") fail();
    // The unchanged bootstrap supplies Auth and Firestore from the default App.
    // Check explicit public App project configuration when supplied as well.
    if (auth.app?.options.projectId !== undefined &&
        auth.app.options.projectId !== binding.projectId) fail();
    // No supported authoritative generation/ownership source: deny before
    // Auth lookup, preflight, scope capture, Circle/Billing or Auth effects.
    let trustedProof;
    try { trustedProof = await trustedAccount.resolveDeletion(db, auth, accountUid); }
    catch (_) { await historicalAdmission.refuseUnprovenAdmission(db, binding, "PRE_AUTH"); }
    let lastUser = await lookup(auth, accountUid);
    let sawAbsent = lastUser === null;
    let controller;
    let admitted;
    let receiptOperationId;
    const ports = {
      getAuthenticatedSubject: async () => binding,
      getAuthUser: async () => {
        lastUser = await lookup(auth, accountUid);
        if (!lastUser) {
          sawAbsent = true;
          throw Object.assign(new Error("Auth absent."),
              {code: "auth/user-not-found"});
        }
        if (sawAbsent) fail();
        return lastUser;
      },
      admissionTransaction: async (tx, operation) => {
        const root = await tx.get(db.collection("users").doc(accountUid));
        const ledger = await tx.get(db.collection("account_birth_decisions")
            .doc(accountUid));
        checkRoot(root, operation);
        const created = checkUser(lastUser, operation);
        if (ledger.exists) validate(ledger.data(), {
          ...binding, created, deletedAt: operation.scope.guardStartedAt,
        });
        await preflight(tx);
      },
      authorizeCleanup: async () => {
        const current = await controller.continueOperation(admitted.handle);
        if (current.status !== "IN_PROGRESS") fail();
        const original = controller.originalOperation(admitted.handle);
        return {projectId: db.projectId, databaseId: db.databaseId,
          uid: original.uid, deletionId: original.deletionId};
      },
      terminalInventory: async (context) => {
        await circles.assertUserTreeEmpty(db, accountUid);
        await db.runTransaction(tx => assertTerminal(tx, db, accountUid));
        return {...context, privateTreeEmpty: true, externalResourcesEmpty: true};
      },
      terminalTransaction: async (tx, context) => {
        await assertTerminal(tx, db, accountUid);
        return {...context, privateTreeEmpty: true, externalResourcesEmpty: true};
      },
    };
    if (receipt !== undefined) {
      ports.admissionReceipt = async (tx, operation) => {
        const record = await buildAdmissionReceipt(tx, db, operation, receipt);
        receiptOperationId = operation.deletionId;
        return record;
      };
    }
    controller = trustedAccount.protectController(db, trustedProof, control.createController({db, binding,
      clock: () => Timestamp.now(), uuid: randomUUID, ports}));
    admitted = await controller.admitBackend();
    if (!admitted.handle) fail();
    const operation = controller.originalOperation(admitted.handle);
    if (operation.origin !== "PRE_AUTH") fail();
    if (receipt !== undefined && receiptOperationId !== operation.deletionId) unavailable();
    checkUser(lastUser, operation);
    if (admitted.status === "COMPLETE") {
      // A concurrent original executor may have completed after the first
      // lookup. Recheck Auth instead of rejecting on that stale observation.
      lastUser = await lookup(auth, accountUid);
      if (lastUser) fail();
      sawAbsent = true;
    }
    const value = {db, auth, controller, handle: admitted.handle, operation,
      sawAbsent};
    const guard = circles.bindOperation(db, accountUid, controller,
        admitted.handle, async ref => {
          await verifyStep(db, auth, admission);
          if (ref?.path === operation.scope.privateRoot) {
            await beforeRootRemoval(db, auth, admission);
          }
        }, async () => (await verifyStep(db, auth, admission)) === true);
    const admission = Object.freeze({bound: Object.freeze({...binding}), guard});
    value.guard = guard;
    admissions.set(admission, value);
    if (admitted.status !== "COMPLETE") await verifySnapshot(db, admission);
    return admission;
  });
}

export function originalOperation(db, auth, admission) {
  return session(db, auth, admission).operation;
}

export function cleanupDatabase(db, auth, admission) {
  const value = session(db, auth, admission);
  return circles.withActiveGuard(db, value.operation.uid, value.guard);
}

export async function verifySnapshot(db, admission) {
  const value = admission && admissions.get(admission);
  if (!value || value.db !== db) fail();
  return controlled(() => db.runTransaction(async tx => {
    await value.controller.assertOperationTransaction(tx, value.handle);
    const root = await tx.get(db.collection("users").doc(value.operation.uid));
    checkRoot(root, value.operation);
  }));
}

export async function verifyStep(db, auth, admission) {
  const value = session(db, auth, admission);
  const user = await lookup(auth, value.operation.uid);
  if (value.sawAbsent && user) fail();
  if (!user) value.sawAbsent = true;
  checkUser(user, value.operation);
  await verifySnapshot(db, admission);
  return user !== null;
}

export async function beforeRootRemoval(db, auth, admission) {
  if (await verifyStep(db, auth, admission)) fail();
}

export async function finish(db, auth, admission) {
  const value = session(db, auth, admission);
  return controlled(async () => {
    const current = await value.controller.continueOperation(value.handle);
    if (current.status === "COMPLETE") {
      return value.controller.verifyTerminal(value.handle);
    }
    if (current.status !== "IN_PROGRESS") fail();
    const cleanup = await value.controller.authorizeCleanup(value.handle);
    return value.controller.finalizeWithOriginalLedger(cleanup);
  });
}

export async function currentState(db, auth, admission) {
  const value = session(db, auth, admission);
  return controlled(async () =>
    (await value.controller.continueOperation(value.handle)).status);
}
