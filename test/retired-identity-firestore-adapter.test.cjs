"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const {Readable} = require("node:stream");
const {Firestore, DocumentSnapshot, Timestamp} = require("firebase-admin/firestore");
const {GoogleAuth} = require("google-auth-library");
const {classifyLoadedRetiredIdentitySnapshots: loaded,
  classifyRetiredIdentityFromEmulator: acquire} = require("../tools/retired_identity_firestore_test_adapter.cjs");
const PROJECT = "demo-life-os-d2c02r13";
const UID = "synthetic-owner";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRIVATE = "synthetic-private@example.invalid";
const HOST = "127.0.0.1:8089";
const stamp = (seconds, nanoseconds = 0) => new Timestamp(seconds, nanoseconds);
const scope = () => ({projectId: PROJECT, databaseId: "(default)", uid: UID});
const record = (origin = "PRE_AUTH") => ({version: 2, state: "RESERVED", deletionId: ID, origin});
const legacy = () => ({version: 1, state: "RESERVED", deletionId: ID, authCreatedAtMs: 1000});
const guard = (extra = {}) => ({version: 1, state: "IN_PROGRESS", deletionId: ID,
  startedAt: stamp(2), retainUntil: null, ...extra});
const db = (extra = {}) => new Firestore({projectId: PROJECT, databaseId: "(default)",
  host: HOST, ssl: false, ...extra});
let outbound = 0; let adc = 0;
test.before(() => {
  test.mock.method(net.Socket.prototype, "connect", () => {
    outbound++; throw new Error("UNIT_TEST_NETWORK_FORBIDDEN");
  });
  test.mock.method(GoogleAuth.prototype, "getApplicationDefault", () => {
    adc++; throw new Error("UNIT_TEST_ADC_FORBIDDEN");
  });
});
test.after(() => {assert.equal(outbound, 0); assert.equal(adc, 0);});

// SDK-owned objects with synthetic protobufs. Private construction is fixture-only;
// these are not RPC results and do not prove real Emulator transaction semantics.
function snapshot(database, collection, data, options = {}) {
  const ref = database.doc(`${collection}/${options.uid || UID}`);
  return new DocumentSnapshot(options.ref || ref,
      data === undefined ? undefined : database._serializer.encodeFields(data),
      Object.hasOwn(options, "readTime") ? options.readTime : stamp(5, 123),
      Object.hasOwn(options, "createTime") ? options.createTime : data === undefined ? undefined : stamp(3),
      data === undefined ? undefined : stamp(4));
}
function input(options = {}) {
  const database = options.database || db();
  return {scope: scope(),
    reservation: {snapshot: snapshot(database, "retired_auth_identities", record())},
    guard: {snapshot: snapshot(database, "account_deletion_guards", guard())},
    auth: {state: "ABSENT"}, expectedDeletionId: ID, expectedOrigin: null, now: stamp(10), ...options};
}
function withDocs(reservation, guardData, rOptions = {}, gOptions = {}) {
  if (arguments.length < 2) guardData = guard();
  const database = db();
  return input({reservation: {snapshot: snapshot(database, "retired_auth_identities", reservation, rOptions)},
    guard: {snapshot: snapshot(database, "account_deletion_guards", guardData, gOptions)}});
}
function result(value, status) {
  const c = value.classification;
  if (status) assert.equal(c.status, status);
  assert.equal(c.destructiveAuthority, false);
  assert.equal(c.admissionAuthority, false);
  assert.equal(c.provenance, "UNPROVEN");
  assert.equal(c.terminalProof, "NOT_PERFORMED");
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(c));
  assert.ok(Object.isFrozen(value.normalization)); assert.ok(Object.isFrozen(c.requiredEvidence));
  for (const secret of [UID, PROJECT, ID, OTHER, PRIVATE, HOST]) {
    assert.equal(JSON.stringify(value).includes(secret), false);
  }
}
const vectors = [
  ["reservation absent", () => withDocs(undefined), "LEGACY_OR_NEW_UNPROVEN", "ABSENT"],
  ["V1", () => withDocs(legacy()), "V1_REVIEW_REQUIRED", "V1_STRUCTURALLY_VALID"],
  ["V1 metadata missing", () => withDocs(legacy(), guard(), {createTime: undefined}), "V1_CONTEXT_INSUFFICIENT", "V1_STRUCTURALLY_VALID"],
  ...["PRE_AUTH", "AUTH_EVENT", "LEGACY_REVIEW"].map((origin) =>
    [origin, () => withDocs(record(origin)), {PRE_AUTH: "PRE_AUTH_PROCEDURE_REVALIDATION_REQUIRED",
      AUTH_EVENT: "MANAGED_AUTH_EVENT_REVALIDATION_REQUIRED", LEGACY_REVIEW: "LEGACY_REVIEW_REQUIRED"}[origin], `V2_${origin}`]),
  ["unknown version with private extra field", () => withDocs({version: 99, email: PRIVATE}), "VERSION_UNSUPPORTED", "UNKNOWN_VERSION"],
  ["malformed record", () => withDocs({...record(), email: PRIVATE}), "RECORD_INVALID", "MALFORMED"],
  ["deletion conflict", () => withDocs({...record(), deletionId: OTHER}), "DELETION_ID_CONFLICT"],
  ["IN_PROGRESS", () => withDocs(record()), "PRE_AUTH_PROCEDURE_REVALIDATION_REQUIRED"],
  ["COMPLETE retained", () => withDocs(record(), guard({state: "COMPLETE", retainUntil: stamp(20)})), "TERMINAL_PROOF_REQUIRED"],
  ["COMPLETE expired", () => withDocs(record(), guard({state: "COMPLETE", retainUntil: stamp(8)})), "TERMINAL_PROOF_REQUIRED"],
  ["COMPLETE null retention", () => withDocs(record(), guard({state: "COMPLETE", retainUntil: null})), "GUARD_INVALID"],
  ["missing guard", () => withDocs(record(), undefined), "GUARD_MISSING_REVIEW_REQUIRED"],
  ["divergent guard", () => withDocs(record(), guard({deletionId: OTHER})), "DELETION_ID_CONFLICT"],
  ["extra guard field", () => withDocs(record(), {...guard(), email: PRIVATE}), "GUARD_INVALID"],
  ["external Auth present", () => ({...withDocs(record()), auth: {state: "PRESENT"}}), "AUTH_PRESENT_RECOVERY_BLOCKED"],
];
for (const [name, make, status, reservation] of vectors) {
  test(`R13 SDK fixture: ${name}`, () => {
    const output = loaded(make()); result(output, status);
    if (reservation) assert.equal(output.classification.reservation, reservation);
    assert.equal(output.acquisition, "LOADED_ONLY");
  });
}

for (const [name, retain, now, expected] of [
  ["exact retention boundary", stamp(10, 123), stamp(10, 123), "COMPLETE"],
  ["one nanosecond after retention", stamp(10, 123), stamp(10, 124), "COMPLETE_RETENTION_EXPIRED"],
  ["one nanosecond before retention", stamp(10, 123), stamp(10, 122), "COMPLETE"],
]) {
  test(`R13 precision: ${name}`, () => {
    const output = loaded({...withDocs(record(), guard({state: "COMPLETE", retainUntil: retain})), now});
    result(output, "TERMINAL_PROOF_REQUIRED"); assert.equal(output.classification.guard, expected);
    assert.equal(output.normalization.guard.retainUntil, "SDK_TIMESTAMP");
  });
}
test("R13 V1 context retains the one-nanosecond order", () => {
  const output = loaded(withDocs(legacy(), guard({startedAt: stamp(2, 501)}), {createTime: stamp(2, 500)}));
  result(output, "V1_CONTEXT_INCONSISTENT");
});
test("R13 normalization does not call lossy Timestamp methods", (t) => {
  let calls = 0;
  for (const key of ["toMillis", "toDate"]) t.mock.method(Timestamp.prototype, key, () => {
    calls++; throw new Error(PRIVATE);
  });
  const output = loaded(withDocs(legacy())); result(output, "V1_REVIEW_REQUIRED");
  assert.equal(calls, 0);
});
for (const [name, value, kind] of [["null", null, "NULL"], ["missing", undefined, "MISSING"],
  ["foreign timestamp", {seconds: 3, nanoseconds: 0}, "UNSUPPORTED"],
  ["numeric time", 3000, "UNSUPPORTED"],
  ["invalid SDK time", Object.assign(Object.create(Timestamp.prototype), {_seconds: NaN, _nanoseconds: 0}), "INVALID"]]) {
  test(`R13 createTime distinction: ${name}`, () => {
    const output = loaded(withDocs(legacy(), guard(), {createTime: value}));
    result(output, "V1_CONTEXT_INSUFFICIENT");
    assert.equal(output.normalization.reservation.createTime, kind);
  });
}
test("R13 non-normalizable guard retention is unknown rather than explicit null", () => {
  const output = loaded(withDocs(record(), guard({state: "COMPLETE", retainUntil: 20000})));
  result(output, "TERMINAL_PROOF_REQUIRED");
  assert.equal(output.classification.guard, "COMPLETE_RETENTION_UNKNOWN");
  assert.equal(output.normalization.guard.retainUntil, "UNSUPPORTED");
});
test("R13 Timestamp accessor cannot execute a caller callback", () => {
  let calls = 0; const created = stamp(3);
  Object.defineProperty(created, "seconds", {get() {calls++; return 3;}});
  const output = loaded(withDocs(legacy(), guard(), {createTime: created}));
  result(output, "V1_CONTEXT_INSUFFICIENT");
  assert.equal(output.normalization.reservation.createTime, "INVALID");
  assert.equal(calls, 0);
});
for (const name of ["reservation", "guard"]) {
  test(`R13 explicit read failure: ${name}`, () => {
    const output = loaded({...input(), [name]: {readError: true}});
    result(output, "READ_UNAVAILABLE");
  });
  test(`R13 partial duck snapshot never proves absence: ${name}`, () => {
    const output = loaded({...input(), [name]: {snapshot: {exists: false}}});
    result(output, name === "reservation" ? "RECORD_INVALID" : "GUARD_INVALID");
  });
  test(`R13 conflicting error envelope is malformed: ${name}`, () => {
    const output = loaded({...input(), [name]: {readError: true, snapshot: {exists: false}}});
    result(output, name === "reservation" ? "RECORD_INVALID" : "GUARD_INVALID");
  });
}
test("R13 SDK absence without readTime is not confirmed absence", () => {
  const output = loaded(withDocs(undefined, guard(), {readTime: undefined}));
  result(output, "READ_UNAVAILABLE");
  assert.equal(output.normalization.reservation.state, "READ_UNAVAILABLE");
});
test("R13 SDK deserialization error is unavailable, never absent", () => {
  const value = input(); value.reservation.snapshot._fieldsProto = {bad: {unknownValue: true}};
  const output = loaded(value); result(output, "READ_UNAVAILABLE");
  assert.equal(output.classification.reservation, "UNAVAILABLE");
});
test("R13 custom converter and duck callbacks are never called", () => {
  let calls = 0; const database = db();
  const ref = database.doc(`retired_auth_identities/${UID}`).withConverter({
    fromFirestore() {calls++; throw new Error(PRIVATE);}, toFirestore() {calls++; throw new Error(PRIVATE);},
  });
  let output = loaded(withDocs(record(), guard(), {ref})); result(output, "RECORD_INVALID");
  output = loaded({...input(), reservation: {snapshot: {exists: false, data() {calls++;}}}});
  result(output, "RECORD_INVALID"); assert.equal(calls, 0);
});
test("R13 public accessor is rejected without invoking it", () => {
  let calls = 0; const value = input();
  Object.defineProperty(value.reservation.snapshot, "exists", {get() {calls++; return false;}});
  result(loaded(value), "RECORD_INVALID"); assert.equal(calls, 0);
});
test("R13 SDK data and Timestamp objects are not modified", () => {
  const value = withDocs(legacy());
  const data = value.guard.snapshot.data(); const before = value.guard.snapshot.data();
  const created = value.reservation.snapshot.createTime;
  Object.freeze(created);
  result(loaded(value), "V1_REVIEW_REQUIRED");
  assert.deepEqual(value.guard.snapshot.data(), before);
  assert.equal(value.reservation.snapshot.createTime, created); assert.deepEqual(data, before);
});
for (const uid of ["", "../owner", "a/b", "a\\b", " owner", "owner\n", "__reserved__", "x".repeat(129), null]) {
  test(`R13 invalid UID case ${JSON.stringify(uid)}`, () => {
    result(loaded({...input(), scope: {...scope(), uid}}), "INPUT_INVALID");
  });
}
for (const [name, extra] of [["production project", {projectId: "life-os-27b92"}],
  ["foreign database", {databaseId: "other-db"}], ["arbitrary scope extras", {enabled: true}]]) {
  test(`R13 loaded scope refuses ${name}`, () => result(loaded({...input(), scope: {...scope(), ...extra}}), "INPUT_INVALID"));
}
for (const [name, database, collection, options] of [
  ["wrong UID", db(), "retired_auth_identities", {uid: "another-owner"}],
  ["wrong collection", db(), "users", {}],
  ["foreign project", db({projectId: "demo-other-project"}), "retired_auth_identities", {}],
  ["foreign database", db({databaseId: "other-db"}), "retired_auth_identities", {}],
]) {
  test(`R13 snapshot scope rejects ${name}`, () => {
    result(loaded({...input(), reservation: {snapshot: snapshot(database, collection, record(), options)}}), "RECORD_INVALID");
  });
}
test("R13 snapshots from different clients are not asserted to share a read", () => {
  const output = loaded({...input(), guard: {snapshot: snapshot(db(), "account_deletion_guards", guard())}});
  result(output, "RECORD_INVALID");
  assert.equal(output.normalization.reservation.state, "SCOPE_INVALID");
});

function emulator(t, options = {}) {
  const previous = process.env;
  process.env = {FIRESTORE_EMULATOR_HOST: HOST, GCLOUD_PROJECT: PROJECT, GOOGLE_CLOUD_PROJECT: PROJECT};
  t.after(() => {process.env = previous;});
  const count = {transactions: 0, reads: 0, terminated: 0};
  const state = {reservation: record(), guard: guard()};
  t.mock.method(Firestore.prototype, "terminate", async () => {count.terminated++;});
  t.mock.method(Firestore.prototype, "runTransaction", async function(fn, opts) {
    count.transactions++; assert.deepEqual(opts, {readOnly: true});
    assert.equal(this.projectId, PROJECT); assert.equal(this.databaseId, "(default)");
    assert.equal(this._settings.servicePath, "127.0.0.1"); assert.equal(this._settings.port, 8089);
    assert.equal(this._settings.ssl, false);
    assert.equal(this._settings.auth.cachedCredential.credentials.access_token, "owner");
    if (options.fail) throw new Error(PRIVATE);
    const snapshots = await fn({getAll: async (...refs) => {
      count.reads += refs.length;
      if (options.readError) throw Object.assign(new Error(PRIVATE), {code: options.readError});
      assert.deepEqual(refs.map((ref) => ref.path), [`retired_auth_identities/${UID}`, `account_deletion_guards/${UID}`]);
      const values = [snapshot(this, "retired_auth_identities", state.reservation),
        snapshot(this, "account_deletion_guards", state.guard,
            options.differentReadTime ? {readTime: stamp(5, 124)} : {})];
      if (options.hook) await options.hook(values);
      return options.partial ? values.slice(0, 1) : values;
    }, create() {assert.fail("WRITE_FORBIDDEN");}, delete() {assert.fail("WRITE_FORBIDDEN");},
    set() {assert.fail("WRITE_FORBIDDEN");}, update() {assert.fail("WRITE_FORBIDDEN");}});
    return snapshots;
  });
  return {count, state, request: () => ({scope: scope(), emulatorHost: HOST,
    auth: {state: "ABSENT"}, expectedDeletionId: ID, expectedOrigin: null, now: stamp(10)})};
}
test("R13 B uses one read-only transaction and exactly two bound references", async (t) => {
  const f = emulator(t); const output = await acquire(f.request());
  result(output, "PRE_AUTH_PROCEDURE_REVALIDATION_REQUIRED");
  assert.equal(output.acquisition, "READ_ONLY_TRANSACTION");
  assert.deepEqual(f.count, {transactions: 1, reads: 2, terminated: 1});
});
for (const [name, options] of [["connection/transaction unavailable", {fail: true}],
  ["read deadline", {readError: 4}], ["permission denied", {readError: 7}],
  ["partial result", {partial: true}], ["inconsistent read times", {differentReadTime: true}]]) {
  test(`R13 B fails closed on ${name}`, async (t) => {
    const f = emulator(t, options); const output = await acquire(f.request());
    result(output, "READ_UNAVAILABLE"); assert.equal(output.classification.reservation, "UNAVAILABLE");
    assert.equal(f.count.transactions, 1); assert.equal(f.count.terminated, 1);
  });
}
test("R13 B guard changes between operations without reopening or writing", async (t) => {
  const f = emulator(t);
  result(await acquire(f.request()), "PRE_AUTH_PROCEDURE_REVALIDATION_REQUIRED");
  f.state.guard = guard({state: "COMPLETE", retainUntil: stamp(20)});
  const before = f.state.guard;
  result(await acquire(f.request()), "TERMINAL_PROOF_REQUIRED");
  assert.equal(f.state.guard, before); assert.equal(f.count.reads, 4);
});
test("R13 B captures scope and context before pending acquisition", async (t) => {
  let release; let acquired;
  const pending = new Promise((resolve) => {release = resolve;});
  const arrived = new Promise((resolve) => {acquired = resolve;});
  const f = emulator(t, {hook: async () => {acquired(); await pending;}});
  f.state.guard = guard({state: "COMPLETE", retainUntil: stamp(10)});
  const request = f.request(); const work = acquire(request); await arrived;
  request.scope.uid = "another-owner"; request.expectedDeletionId = OTHER;
  request.auth.state = "PRESENT"; request.now._seconds = 11;
  release(); const output = await work; result(output, "TERMINAL_PROOF_REQUIRED");
  assert.equal(output.classification.guard, "COMPLETE"); assert.equal(output.classification.auth, "ABSENT");
});
test("R13 B configuration change during read invalidates result", async (t) => {
  const f = emulator(t, {hook: async () => {process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:9090";}});
  result(await acquire(f.request()), "INPUT_INVALID"); assert.equal(f.count.terminated, 1);
});
test("R13 installed SDK builds readOnly wire request and never commits (mock RPC)", async (t) => {
  const previous = process.env;
  process.env = {FIRESTORE_EMULATOR_HOST: HOST, GCLOUD_PROJECT: PROJECT, GOOGLE_CLOUD_PROJECT: PROJECT};
  t.after(() => {process.env = previous;});
  let reads = 0; let writes = 0;
  t.mock.method(Firestore.prototype, "request", () => {writes++; throw new Error("RPC_FORBIDDEN");});
  t.mock.method(Firestore.prototype, "requestStream", async function(method, bidirectional, request) {
    assert.equal(method, "batchGetDocuments"); assert.equal(bidirectional, false);
    assert.deepEqual(request.newTransaction, {readOnly: {}});
    assert.equal(request.database, `projects/${PROJECT}/databases/(default)`);
    assert.deepEqual(request.documents, [`${request.database}/documents/retired_auth_identities/${UID}`,
      `${request.database}/documents/account_deletion_guards/${UID}`]);
    reads += request.documents.length;
    const documents = [record(), guard()];
    return Readable.from(documents.map((data, i) => ({
      found: {name: request.documents[i], fields: this._serializer.encodeFields(data),
        createTime: {seconds: "3", nanos: 500}, updateTime: {seconds: "4", nanos: 0}},
      readTime: {seconds: "5", nanos: 123}, transaction: Buffer.from("synthetic-read-only"),
    })));
  });
  const output = await acquire({scope: scope(), emulatorHost: HOST, auth: {state: "ABSENT"},
    expectedDeletionId: ID, expectedOrigin: null, now: stamp(10)});
  result(output, "PRE_AUTH_PROCEDURE_REVALIDATION_REQUIRED");
  assert.equal(output.acquisition, "READ_ONLY_TRANSACTION");
  assert.equal(output.normalization.reservation.createTime, "SDK_TIMESTAMP");
  assert.equal(reads, 2); assert.equal(writes, 0);
});
for (const [name, change] of [
  ["no emulator env", (v) => {delete process.env.FIRESTORE_EMULATOR_HOST;}],
  ["foreign host", (v) => {v.emulatorHost = "remote.invalid:8089";}],
  ["port overflow", (v) => {v.emulatorHost = "127.0.0.1:65536";}],
  ["host mismatch", (v) => {v.emulatorHost = "127.0.0.1:8090";}],
  ["production project", (v) => {v.scope.projectId = "life-os-27b92";}],
  ["foreign configured project", () => {process.env.GCLOUD_PROJECT = "life-os-27b92";}],
  ["wrong database", (v) => {v.scope.databaseId = "other-db";}],
  ["arbitrary reference", (v) => {v.reference = {};}],
  ["destructive callback", (v) => {v.write = () => assert.fail("CALLBACK_FORBIDDEN");}],
  ["invalid UID", (v) => {v.scope.uid = "../escape";}],
]) {
  test(`R13 B refuses ${name} before any transaction`, async (t) => {
    const f = emulator(t); const request = f.request(); change(request);
    result(await acquire(request), "INPUT_INVALID"); assert.equal(f.count.transactions, 0);
    assert.equal(f.count.terminated, 0);
  });
}
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_CONFIG", "HTTPS_PROXY",
  "https_proxy", "grpc_proxy", "DEBUG", "GRPC_TRACE"]) {
  test(`R13 B rejects external configuration ${key}`, async (t) => {
    const f = emulator(t); process.env[key] = "synthetic-do-not-use";
    result(await acquire(f.request()), "INPUT_INVALID"); assert.equal(f.count.transactions, 0);
  });
}
test("R13 module has no production import, Auth operation, writer or outside repository dependency", () => {
  const root = path.resolve(__dirname, "..");
  for (const name of ["api/account/delete.js", "api/account/_circle_cleanup.cjs", "api/account/_birth_ledger_cleanup.js", "api/sync.js"]) {
    assert.equal(fs.readFileSync(path.join(root, name), "utf8").includes("retired_identity_firestore_test_adapter"), false);
  }
  const source = fs.readFileSync(path.join(root, "tools/retired_identity_firestore_test_adapter.cjs"), "utf8");
  assert.doesNotMatch(source, /\.deleteUser\(|\.deleteUsers\(|\.set\(|\.create\(|\.delete\(|\b(?:db|tx|transaction)\.update\(/);
  assert.doesNotMatch(source, /console\.|getAuth|initializeApp|Timestamp\.now\(|toMillis\(|toDate\(/);
  assert.doesNotMatch(source, /require\(["'][^"']*functions|import[^;]*functions/);
});

// Convert only explicit synthetic test times. This codec is not an acquisition
// or an identity algorithm; malformed frames remain malformed SDK inputs.
const approvedVectors = JSON.parse(fs.readFileSync(path.join(__dirname,
    "retired-identity-conformance.vectors.json"), "utf8")).cases;
function sdkInput(vector) {
  const data = structuredClone(vector.input); const database = db();
  let calls = 0;
  const decorated = new Set(vector.decorations.map((d) => d.path));
  class ForeignTimestamp {
    constructor(pair) {this.seconds = pair.seconds; this.nanoseconds = pair.nanoseconds;}
    toMillis() {calls++; throw new Error(PRIVATE);}
    toDate() {calls++; throw new Error(PRIVATE);}
    toJSON() {calls++; throw new Error(PRIVATE);}
  }
  function sdkTime(value) {
    return value && Object.keys(value).sort().join(",") === "nanoseconds,seconds" ?
      stamp(value.seconds, value.nanoseconds) : value;
  }
  function envelope(frame, name) {
    if (frame && Object.keys(frame).join(",") === "readError" && frame.readError === true) {
      return {readError: true};
    }
    const fields = frame && Object.keys(frame).sort().join(",");
    const validAbsent = fields === "exists" && frame.exists === false;
    const validPresent = ["data,exists", "createTime,data,exists"].includes(fields) && frame.exists === true;
    if (!validAbsent && !validPresent) return {snapshot: frame};
    let document = frame.data;
    if (validPresent && name === "guard") {
      document = {...document};
      for (const field of ["startedAt", "retainUntil"]) {
        if (Object.hasOwn(document, field) && !decorated.has(`guard.data.${field}`)) {
          document[field] = sdkTime(document[field]);
        }
        // Unsupported guard timestamps are stored as a Firestore map fixture,
        // never silently turned into a valid SDK Timestamp.
      }
    }
    const createTime = decorated.has(`${name}.createTime`) ?
      new ForeignTimestamp(frame.createTime) : sdkTime(frame.createTime);
    return {snapshot: snapshot(database, name === "guard" ? "account_deletion_guards" :
      "retired_auth_identities", document, {createTime})};
  }
  return {value: {...data, scope: scope(), reservation: envelope(data.reservation, "reservation"),
    guard: envelope(data.guard, "guard"), now: sdkTime(data.now)}, calls: () => calls};
}
for (const vector of approvedVectors) {
  test(`R13 full R12 result through SDK boundary: ${vector.id}`, () => {
    const fixture = sdkInput(vector); const output = loaded(fixture.value);
    result(output);
    assert.deepEqual(output.classification, vector.expected);
    assert.equal(fixture.calls(), 0);
  });
}

const Module = require("node:module");
const adapterFile = path.resolve(__dirname, "../tools/retired_identity_firestore_test_adapter.cjs");
const adapterSource = fs.readFileSync(adapterFile, "utf8");
function freshAdapter() {
  const fresh = new Module(adapterFile, module);
  fresh.filename = adapterFile; fresh.paths = Module._nodeModulePaths(path.dirname(adapterFile));
  fresh._compile(adapterSource, adapterFile);
  return fresh.exports;
}
for (const part of ["manifest", "vectors", "reference"]) {
  test(`R13 refuses changed local R12 ${part} before using its classifier`, (t) => {
    const filename = path.join(__dirname, `retired-identity-conformance.${part}.json`);
    const originalRead = fs.readFileSync;
    t.mock.method(fs, "readFileSync", function(file, ...args) {
      const text = originalRead.call(this, file, ...args);
      return String(file) === filename ? text + "\n " : text;
    });
    // Reference whitespace is semantically irrelevant; change the hashed source
    // for that case so refusal cannot be attributed only to JSON formatting.
    if (part === "reference") {
      fs.readFileSync.mock.restore();
      t.mock.method(fs, "readFileSync", function(file, ...args) {
        const text = originalRead.call(this, file, ...args);
        if (String(file) !== filename) return text;
        const value = JSON.parse(text); value.source += "\nthrow new Error('must not execute');";
        return JSON.stringify(value);
      });
    }
    assert.throws(() => freshAdapter(), (error) => {
      assert.equal(error.message, "TEST_REFERENCE_INTEGRITY_INVALID");
      assert.equal(error.message.includes(PRIVATE), false); return true;
    });
  });
}
test("R13 reference wrapper version is checked without changing approved artifacts", (t) => {
  const filename = path.join(__dirname, "retired-identity-conformance.reference.json");
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function(file, ...args) {
    const text = originalRead.call(this, file, ...args);
    if (String(file) !== filename) return text;
    const value = JSON.parse(text); value.formatVersion++;
    return JSON.stringify(value);
  });
  assert.throws(() => freshAdapter(), /TEST_REFERENCE_INTEGRITY_INVALID/);
});
