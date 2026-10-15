// CLOSED ledger validation and canonical digest mirror Functions C1-R3.
import {createHash} from "node:crypto";
import {Timestamp} from "firebase-admin/firestore";
import circles from "./_circle_cleanup.cjs";

const RETENTION_MS = 65 * 60 * 1000;
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

/**
 * Canonical digest in memory only; never logs/persists identity or its digest.
 * @param {*} value Typed record.
 * @return {*} Stable data.
 */
function canonical(value) {
  if (value instanceof Timestamp) return [value.seconds, value.nanoseconds];
  if (value && typeof value === "object") {
    return Object.keys(value).sort().map((key) => [key, canonical(value[key])]);
  }
  return value;
}

/**
 * @param {Object} tx Transaction, before writes.
 * @param {Object} db Trusted Admin storage.
 * @param {Object} bound Managed deletion.
 * @return {Promise<Object>} Original ledger digest and root presence.
 */
async function inspect(tx, db, bound) {
  const root = await tx.get(db.collection("users").doc(bound.uid));
  const ledger = await tx.get(db.collection("account_birth_decisions")
      .doc(bound.uid));
  // Quarantine a later root, including a possible stale-client write.
  // A late write alone does not prove another Auth generation.
  if (root.exists && root.createTime !== undefined &&
    (!time(root.createTime) || after(root.createTime, bound.rootCutoff || bound.deletedAt))) fail();
  if (!ledger.exists) return {digest: null, rootExists: root.exists};
  const record = ledger.data(); validate(record, bound);
  return {digest: createHash("sha256").update(JSON.stringify(canonical(record)))
      .digest("hex"), rootExists: root.exists};
}


// Every range below belongs to the final transaction. A concurrent preparation
// either commits before this snapshot (and is observed), or retries against
// COMPLETE and loses its write authority.
async function assertTerminal(tx, db, accountUid) {
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

// Internal server seam. The HTTP wrapper must already have verified ID Token
// (including revocation), App Check, own UID, recent auth and rate limit.
// No client payload is accepted here as an alternative authority.
export async function prepare({db, auth, uid: accountUid, preflight}) {
  if (!uid(accountUid) || typeof db?.projectId !== "string" ||
      typeof auth?.getUser !== "function" || typeof preflight !== "function") fail();
  const deletedAt = Timestamp.now();
  let user;
  let absent = false;
  try { user = await auth.getUser(accountUid); } catch (error) {
    if (error?.code !== "auth/user-not-found") throw error;
    absent = true;
  }
  if (!absent && !user) fail();
  if (user && (user.uid !== accountUid || user.disabled === true ||
      (user.tenantId !== undefined && user.tenantId !== null))) fail();
  const created = user ? metadata(user.metadata?.creationTime) : null;
  if (created && after(created.at, deletedAt)) fail();
  const initial = Object.freeze({uid: accountUid, projectId: db.projectId,
    deletedAt, created});
  const guard = await circles.beginGuard(db, accountUid, async tx => {
    // Auth absent may only continue an existing, server-owned deletion. A new
    // HTTP request after Auth removal still fails revocation in the wrapper.
    if (!user) fail();
    await inspect(tx, db, initial);
    await preflight(tx);
  });
  if (user && (guard.state === "COMPLETE" || (created &&
      (created.coarse ? created.at.seconds > guard.startedAt.seconds :
        after(created.at, guard.startedAt))))) fail();
  // Quarantine a root created after the original deletion barrier. This is
  // conservative conflict detection, not proof of an Auth generation.
  const bound = Object.freeze({...initial, rootCutoff: guard.startedAt});
  const observation = await db.runTransaction(async (tx) => {
    await circles.requireGuard(tx, db, bound.uid, guard);
    const remaining = await inspect(tx, db, bound);
    const snapshot = await tx.get(circles.guardRef(db, bound.uid));
    const current = circles.validateGuard(snapshot.data());
    // Preserve the existing, identity-validated root/ledger recovery only.
    // An attempt admitted before COMPLETE cannot reopen a peer's finish.
    if (guard.state === "COMPLETE" && current.state === "COMPLETE" &&
        (remaining.digest !== null || remaining.rootExists)) {
      tx.update(snapshot.ref, {state: "IN_PROGRESS", retainUntil: null});
      return {digest: remaining.digest,
        guard: {...current, state: "IN_PROGRESS", retainUntil: null}};
    }
    return {digest: remaining.digest, guard: current};
  });
  return Object.freeze({bound, guard: observation.guard, digest: observation.digest});
}

async function requireAuthAbsent(auth, accountUid) {
  let absent = false;
  try { await auth.getUser(accountUid); } catch (error) {
    if (error?.code !== "auth/user-not-found") throw error;
    absent = true;
  }
  if (!absent) fail();
}

// Recheck the exact admitted snapshot before irreversible effects. Normal
// writers are fenced by the guard; explicit privileged conflicts fail closed.
export async function verifySnapshot(db, admission) {
  const {bound, guard, digest} = admission;
  if (db.projectId !== bound.projectId || !uid(bound.uid)) fail();
  await db.runTransaction(async tx => {
    await circles.requireGuard(tx, db, bound.uid, guard);
    const remaining = await inspect(tx, db, bound);
    if (remaining.digest !== null && remaining.digest !== digest) fail();
  });
}

export async function beforeRootRemoval(db, auth, admission) {
  await requireAuthAbsent(auth, admission.bound.uid);
  await verifySnapshot(db, admission);
}

export async function finish(db, auth, admission) {
  const {bound, guard, digest} = admission;
  if (db.projectId !== bound.projectId || !uid(bound.uid)) fail();
  await requireAuthAbsent(auth, bound.uid);
  await circles.assertUserTreeEmpty(db, bound.uid);
  await db.runTransaction(async tx => {
    await circles.requireGuard(tx, db, bound.uid, guard);
    const guardRef = db.collection("account_deletion_guards").doc(bound.uid);
    const currentGuard = await tx.get(guardRef);
    const root = await tx.get(db.collection("users").doc(bound.uid));
    const ledgerRef = db.collection("account_birth_decisions").doc(bound.uid);
    const ledger = await tx.get(ledgerRef);
    if (root.exists || (currentGuard.data().state === "COMPLETE" && ledger.exists)) fail();
    if (ledger.exists) {
      validate(ledger.data(), bound);
      const current = createHash("sha256").update(
        JSON.stringify(canonical(ledger.data()))).digest("hex");
      if (current !== digest) fail();
    }
    // The other legitimate cleaner may already have removed this snapshot.
    // Missing at admission + present now cannot authorize a new record.
    await assertTerminal(tx, db, bound.uid);
    if (ledger.exists) tx.delete(ledgerRef);
    if (currentGuard.data().state !== "COMPLETE") {
      tx.update(guardRef, {state: "COMPLETE",
        retainUntil: Timestamp.fromMillis(Date.now() + RETENTION_MS)});
    }
  });
}
