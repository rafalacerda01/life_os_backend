"use strict";

// R13 test-only backend adapter. R11 is architectural reference, never imported.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const {createHash} = require("node:crypto");
const RELEASE_SHA256 = "fe095417e3406a5949937e1775df18924363cd91e8af9dafb4d87fce8118b310";
function verifiedReference() {
  try {
    const base = path.resolve(__dirname, "../test/retired-identity-conformance");
    const read = (part) => fs.readFileSync(base + "." + part + ".json", "utf8").replace(/\r\n/g, "\n");
    const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
    const manifestText = read("manifest");
    if (hash(manifestText) !== RELEASE_SHA256) throw new Error();
    const manifest = JSON.parse(manifestText);
    const reference = JSON.parse(read("reference"));
    if (manifest.formatVersion !== 1 || manifest.contractVersion !== "R10-FIX1" ||
        Object.keys(reference).sort().join(",") !== "contractVersion,formatVersion,source" ||
        reference.formatVersion !== 1 || reference.contractVersion !== "R10-FIX1" ||
        typeof reference.source !== "string" ||
        hash(reference.source.replace(/\r\n/g, "\n")) !== manifest.readerSha256 ||
        hash(read("vectors")) !== manifest.vectorsSha256) throw new Error();
    const local = new Module(base + "-verified.cjs");
    local.filename = local.id;
    local.require = () => {throw new Error("REFERENCE_IMPORT_FORBIDDEN");};
    local._compile(reference.source, local.filename);
    if (typeof local.exports.classifyRetiredIdentitySnapshots !== "function" ||
        Object.keys(local.exports).length !== 1) throw new Error();
    return local.exports.classifyRetiredIdentitySnapshots;
  } catch (_) { throw new Error("TEST_REFERENCE_INTEGRITY_INVALID"); }
}
const classifyRetiredIdentitySnapshots = verifiedReference();
const {Firestore, DocumentSnapshot, QueryDocumentSnapshot, DocumentReference,
  Timestamp} = require("firebase-admin/firestore");
const DATABASE = "(default)";
const COLLECTIONS = {reservation: "retired_auth_identities", guard: "account_deletion_guards"};
const CONTEXT = ["auth", "expectedDeletionId", "expectedOrigin", "now"];
const BLOCKED_ENV = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN",
  "FIREBASE_TOKEN", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG",
  "FIREBASE_EMULATOR_HUB", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "GRPC_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "grpc_proxy", "DEBUG",
  "NODE_DEBUG", "GRPC_TRACE", "GRPC_VERBOSITY", "GOOGLE_SDK_NODE_LOGGING"];

function plain(value) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((k) => typeof k !== "string" ||
      !Object.hasOwn(descriptors[k], "value"))) return null;
  return Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.value]));
}
function keys(value, expected) {
  return value && Object.keys(value).length === expected.length &&
    expected.every((k) => Object.hasOwn(value, k));
}
function scopeValue(value) {
  const s = plain(value);
  return keys(s, ["projectId", "databaseId", "uid"]) &&
    typeof s.projectId === "string" && /^demo-[a-z0-9][a-z0-9-]{0,48}$/.test(s.projectId) &&
    s.databaseId === DATABASE && typeof s.uid === "string" &&
    s.uid.length > 0 && s.uid.length <= 128 && Buffer.byteLength(s.uid, "utf8") <= 128 &&
    s.uid.trim() === s.uid && !/[\/\\\u0000-\u001f\u007f]/.test(s.uid) &&
    ![".", ".."].includes(s.uid) && !/^__.*__$/.test(s.uid) ? Object.freeze(s) : null;
}
function time(value) {
  if (value === null) return {kind: "NULL", value: null};
  if (value === undefined) return {kind: "MISSING", value: undefined};
  if (Object.getPrototypeOf(value) !== Timestamp.prototype) {
    return {kind: "UNSUPPORTED", value: undefined};
  }
  if (Object.values(Object.getOwnPropertyDescriptors(value))
      .some((d) => !Object.hasOwn(d, "value"))) return {kind: "INVALID", value: undefined};
  const seconds = Object.getOwnPropertyDescriptor(Timestamp.prototype, "seconds").get.call(value);
  const nanoseconds = Object.getOwnPropertyDescriptor(Timestamp.prototype, "nanoseconds").get.call(value);
  if (!Number.isSafeInteger(seconds) || seconds < -62135596800 || seconds > 253402300799 ||
      !Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds >= 1000000000) {
    return {kind: "INVALID", value: undefined};
  }
  return {kind: "SDK_TIMESTAMP", value: Object.freeze({seconds, nanoseconds})};
}
function primitive(value) {
  return value === null || ["string", "number", "boolean", "undefined"].includes(typeof value) ?
    value : undefined;
}
function invalid(kind = "SNAPSHOT_INVALID") { return {frame: {}, meta: Object.freeze({state: kind})}; }
function unavailable() {
  return {frame: {readError: true}, meta: Object.freeze({state: "READ_UNAVAILABLE"})};
}
function sdkGet(snapshot, key) {
  return Object.getOwnPropertyDescriptor(DocumentSnapshot.prototype, key).get.call(snapshot);
}
function snapshotValue(envelope, scope, name) {
  try {
    const loaded = plain(envelope);
    if (keys(loaded, ["readError"]) && loaded.readError === true) return unavailable();
    if (!keys(loaded, ["snapshot"])) return invalid();
    const snapshot = loaded.snapshot;
    if (!snapshot || ![DocumentSnapshot.prototype, QueryDocumentSnapshot.prototype]
        .includes(Object.getPrototypeOf(snapshot)) ||
        ["exists", "ref", "data", "createTime", "readTime", "updateTime"]
            .some((key) => Object.hasOwn(snapshot, key))) return invalid();
    const ref = sdkGet(snapshot, "ref");
    if (!ref || Object.getPrototypeOf(ref) !== DocumentReference.prototype ||
        ["firestore", "path", "withConverter", "isEqual"].some((key) => Object.hasOwn(ref, key)) ||
        ref.firestore.projectId !== scope.projectId || ref.firestore.databaseId !== scope.databaseId ||
        ref.path !== `${COLLECTIONS[name]}/${scope.uid}` ||
        !ref.isEqual(ref.withConverter(null))) return invalid("SCOPE_INVALID");
    const exists = sdkGet(snapshot, "exists");
    const read = time(sdkGet(snapshot, "readTime"));
    const created = time(sdkGet(snapshot, "createTime"));
    const raw = plain(DocumentSnapshot.prototype.data.call(snapshot));
    if (exists === false) {
      if (read.kind !== "SDK_TIMESTAMP") return invalid("METADATA_INSUFFICIENT");
      if (raw !== null || created.kind !== "MISSING" || sdkGet(snapshot, "updateTime") !== undefined) {
        return invalid();
      }
      return {frame: {exists: false}, db: ref.firestore, read: read.value,
        meta: Object.freeze({state: "ABSENT", createTime: "MISSING", readTime: read.kind})};
    }
    if (exists !== true || !raw) return invalid();
    let data = {};
    const meta = {state: "PRESENT", createTime: created.kind, readTime: read.kind};
    if (name === "reservation") {
      if (Number.isSafeInteger(raw.version) && raw.version > 0 && ![1, 2].includes(raw.version)) {
        data = {version: raw.version};
      } else if (keys(raw, ["version", "state", "deletionId",
        raw.version === 1 ? "authCreatedAtMs" : "origin"])) {
        data = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, primitive(v)]));
      }
    } else if (keys(raw, ["version", "state", "deletionId", "startedAt", "retainUntil"])) {
      const start = time(raw.startedAt); const retain = time(raw.retainUntil);
      meta.startedAt = start.kind; meta.retainUntil = retain.kind;
      data = {version: primitive(raw.version), state: primitive(raw.state),
        deletionId: primitive(raw.deletionId), startedAt: start.value, retainUntil: retain.value};
    }
    const frame = {exists: true, data};
    if (created.kind !== "MISSING") frame.createTime = created.value;
    return {frame, db: ref.firestore, read: read.value, meta: Object.freeze(meta)};
  } catch (_) { return unavailable(); }
}
function response(classification, normalization, acquisition) {
  return Object.freeze({classification, normalization: Object.freeze(normalization), acquisition});
}
function refused() {
  return response(classifyRetiredIdentitySnapshots({}),
      {state: "INPUT_OR_CONFIGURATION_INVALID"}, "NOT_PERFORMED");
}
function classifyPair(input, reservation, guard, clock, acquisition) {
  if (reservation.db && guard.db && reservation.db !== guard.db) {
    reservation = invalid("SCOPE_INVALID"); guard = invalid("SCOPE_INVALID");
  }
  const classification = classifyRetiredIdentitySnapshots({reservation: reservation.frame,
    guard: guard.frame, auth: plain(input.auth), expectedDeletionId: primitive(input.expectedDeletionId),
    expectedOrigin: primitive(input.expectedOrigin), now: clock.value});
  return response(classification, {reservation: reservation.meta, guard: guard.meta, now: clock.kind}, acquisition);
}

/** A: Loaded SDK objects only; returns no frames, document data or identifiers. */
function classifyLoadedRetiredIdentitySnapshots(value) {
  try {
    const input = plain(value);
    if (!keys(input, ["scope", "reservation", "guard", ...CONTEXT])) return refused();
    const scope = scopeValue(input.scope);
    if (!scope) return refused();
    const reservation = snapshotValue(input.reservation, scope, "reservation");
    const guard = snapshotValue(input.guard, scope, "guard");
    return classifyPair(input, reservation, guard, time(input.now), "LOADED_ONLY");
  } catch (_) { return refused(); }
}
function emulatorAllowed(input) {
  return keys(input, ["scope", "emulatorHost", ...CONTEXT]) && scopeValue(input.scope) &&
    typeof input.emulatorHost === "string" && /^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(input.emulatorHost) &&
    Number(input.emulatorHost.split(":")[1]) <= 65535 &&
    process.env.FIRESTORE_EMULATOR_HOST === input.emulatorHost &&
    ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].every((k) =>
      process.env[k] === undefined || process.env[k] === input.scope.projectId) &&
    BLOCKED_ENV.every((k) => process.env[k] === undefined);
}

/** B: Optional test-only acquisition. Own client, no supplied references/callbacks. */
async function classifyRetiredIdentityFromEmulator(value) {
  let db;
  try {
    const input = plain(value);
    if (!input) return refused();
    input.scope = scopeValue(input.scope);
    if (!emulatorAllowed(input)) return refused();
    // Capture context before awaiting; no mutable caller object can rebind reads.
    const clock = time(input.now);
    const context = {auth: plain(input.auth), expectedDeletionId: primitive(input.expectedDeletionId),
      expectedOrigin: primitive(input.expectedOrigin)};
    const {GoogleAuth, OAuth2Client} = require("google-auth-library");
    const localAuth = new OAuth2Client();
    localAuth.setCredentials({access_token: "owner", expiry_date: Number.MAX_SAFE_INTEGER});
    db = new Firestore({projectId: input.scope.projectId, databaseId: DATABASE,
      host: input.emulatorHost, ssl: false, preferRest: false,
      auth: new GoogleAuth({projectId: input.scope.projectId, authClient: localAuth}),
      clientConfig: {interfaces: {"google.firestore.v1.Firestore": {methods: {
        BatchGetDocuments: {timeout_millis: 5000, retry_codes_name: "non_idempotent"},
      }}}}});
    if (!emulatorAllowed(input) || db.projectId !== input.scope.projectId || db.databaseId !== DATABASE) {
      return refused();
    }
    const snapshots = await db.runTransaction(async (tx) => {
      if (!emulatorAllowed(input)) throw new Error("EMULATOR_CONFIGURATION_CHANGED");
      return tx.getAll(db.doc(`${COLLECTIONS.reservation}/${input.scope.uid}`),
          db.doc(`${COLLECTIONS.guard}/${input.scope.uid}`));
    }, {readOnly: true});
    if (!emulatorAllowed(input)) return refused();
    if (!Array.isArray(snapshots) || snapshots.length !== 2) throw new Error("READ_INCOMPLETE");
    const r = snapshotValue({snapshot: snapshots[0]}, input.scope, "reservation");
    const g = snapshotValue({snapshot: snapshots[1]}, input.scope, "guard");
    if (r.db !== db || g.db !== db || !r.read || !g.read ||
        r.read.seconds !== g.read.seconds || r.read.nanoseconds !== g.read.nanoseconds) {
      throw new Error("READ_INCONSISTENT");
    }
    return classifyPair(context, r, g, clock, "READ_ONLY_TRANSACTION");
  } catch (_) {
    return response(classifyRetiredIdentitySnapshots({reservation: {readError: true},
      guard: {readError: true}, auth: {state: "UNAVAILABLE"}, expectedDeletionId: null,
      expectedOrigin: null, now: null}), {state: "READ_UNAVAILABLE"}, "UNAVAILABLE");
  } finally {
    if (db) await db.terminate().catch(() => {});
  }
}

module.exports = {classifyLoadedRetiredIdentitySnapshots, classifyRetiredIdentityFromEmulator};
