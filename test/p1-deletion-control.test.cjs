"use strict";
/* eslint-disable require-jsdoc -- Synthetic contract fixtures. */

const test = require("node:test");
const assert = require("node:assert/strict");
const {AsyncLocalStorage} = require("node:async_hooks");
const network = {attempts: 0, adc: 0};
function noNetwork() {
  network.attempts++;
  throw new Error("NETWORK_FORBIDDEN_IN_CONTRACT_TEST");
}
for (const name of ["node:http", "node:https"]) {
  const transport = require(name);
  transport.request = noNetwork;
  transport.get = noNetwork;
}
require("node:net").Socket.prototype.connect = noNetwork;
require("node:tls").connect = noNetwork;
require("node:http2").connect = noNetwork;
global.fetch = noNetwork;
const {GoogleAuth} = require("google-auth-library");
for (const method of ["getClient", "getApplicationDefault", "getProjectId"]) {
  GoogleAuth.prototype[method] = () => {
    network.adc++;
    throw new Error("ADC_FORBIDDEN_IN_CONTRACT_TEST");
  };
}
const {Timestamp} = require("firebase-admin/firestore");
const core = require("../api/account/_deletion_control.cjs");
const transactionContext = new AsyncLocalStorage();
const BINDING = Object.freeze({projectId: "demo-life-os-p1",
  databaseId: "(default)", uid: "r6a-synthetic-user"});
const ID1 = "10000000-0000-4000-8000-000000000001";
const ID2 = "10000000-0000-4000-8000-000000000002";
const BIRTH_ID = "20000000-0000-4000-8000-000000000001";
const START = 1760000000000;
const atTime = (offset = 0) => Timestamp.fromMillis(START + offset);

function clone(value) {
  if (value instanceof Timestamp) {
    return new Timestamp(value.seconds, value.nanoseconds);
  }
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value)) result[key] = clone(value[key]);
    return result;
  }
  return value;
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return {promise, resolve};
}
function rawFailure() {
  return Object.assign(new Error("synthetic-private-details-must-not-escape"),
      {code: "PERMISSION_DENIED"});
}

/** Optimistic MVCC fixture: atomic commit, retries and lost-reply injection. */
class MemoryDb {
  constructor() {
    this.projectId = BINDING.projectId;
    this.databaseId = BINDING.databaseId;
    this.data = new Map();
    this.versions = new Map();
    this.writes = [];
    this.transactions = 0;
    this.reads = 0;
    this.retries = 0;
    this.failReads = false;
    this.denyCommit = false;
    this.loseCommitReply = false;
    this.unknownWithoutCommit = false;
    this.afterLost = null;
    this.beforeCommit = null;
    this.destructiveCalls = 0;
  }
  doc(path) {
    return Object.freeze({path});
  }
  version(path) {
    return this.versions.get(path) || 0;
  }
  put(path, value) {
    this.data.set(path, clone(value));
    this.versions.set(path, this.version(path) + 1);
  }
  erase(path) {
    this.data.delete(path);
    this.versions.set(path, this.version(path) + 1);
  }
  recursiveDelete() {
    this.destructiveCalls++;
    throw new Error("DESTRUCTIVE_METHOD_FORBIDDEN");
  }
  async runTransaction(callback) {
    this.transactions++;
    for (let attempt = 0; attempt < 10; attempt++) {
      const readVersions = new Map();
      const writes = [];
      const tx = {
        get: async (ref) => {
          this.reads++;
          if (this.failReads) throw rawFailure();
          if (writes.length) throw new Error("READ_AFTER_WRITE");
          readVersions.set(ref.path, this.version(ref.path));
          const value = clone(this.data.get(ref.path));
          return {ref, exists: this.data.has(ref.path), data: () => value};
        },
        create: (ref, value) => writes.push({kind: "create", ref,
          value: clone(value)}),
        update: (ref, value) => writes.push({kind: "update", ref,
          value: clone(value)}),
        delete: () => {
          this.destructiveCalls++;
          throw new Error("DESTRUCTIVE_METHOD_FORBIDDEN");
        },
      };
      const result = await transactionContext.run(true, () => callback(tx));
      if (writes.length && this.beforeCommit) await this.beforeCommit();
      if ([...readVersions].some(([path, version]) =>
        this.version(path) !== version)) {
        this.retries++;
        continue;
      }
      if (writes.length && (this.denyCommit || this.unknownWithoutCommit)) {
        throw rawFailure();
      }
      for (const write of writes) {
        if ((write.kind === "create" && this.data.has(write.ref.path)) ||
            (write.kind === "update" && !this.data.has(write.ref.path))) {
          throw rawFailure();
        }
      }
      for (const write of writes) {
        this.put(write.ref.path, write.kind === "create" ? write.value :
          Object.assign({}, this.data.get(write.ref.path), write.value));
        this.writes.push(clone(write));
      }
      if (writes.length && this.loseCommitReply) {
        this.loseCommitReply = false;
        if (this.afterLost) this.afterLost();
        throw rawFailure();
      }
      return result;
    }
    throw rawFailure();
  }
}
function birth() {
  return {version: 1, uid: BINDING.uid, projectId: BINDING.projectId,
    tenantId: null, authCreatedAt: atTime(-3000),
    sourceType: "FIREBASE_AUTH_CREATE", sourceEventId: "synthetic-birth",
    eventAt: atTime(-2000), cohort: {version: 1, id: "synthetic-cohort",
      policy: "NEW_ACCOUNT_V2_ONLY", state: "CLOSED", cutoverAt: atTime(-4000)},
    decisionId: BIRTH_ID,
    originalIdentity: {uid: BINDING.uid, email: "fixture@example.test",
      displayName: "Synthetic", photoUrl: null},
    recordedAt: atTime(-1000), status: "RECORDED_COHORT_CLOSED"};
}
function fixture(withBirth = false) {
  const db = new MemoryDb();
  const refs = core.references(db, BINDING);
  if (withBirth) db.put(refs.birth.path, birth());
  const calls = {uuid: 0, boundaries: 0, terminalReads: 0};
  let millis = START;
  let auth = "PRESENT";
  let event = {eventId: "synthetic-delete", association: "NEW_POLICY",
    deletionId: null};
  function outside() {
    assert.notEqual(transactionContext.getStore(), true,
        "External port was called from a transaction");
    calls.boundaries++;
  }
  const ports = {
    getAuthenticatedSubject: async () => {
      outside();
      return clone(BINDING);
    },
    getManagedEvent: async () => {
      outside();
      return Object.assign({}, BINDING, clone(event));
    },
    getContinuation: async () => {
      outside();
      return Object.assign({}, BINDING,
          {deletionId: db.data.get(refs.operation.path).deletionId});
    },
    getAuthUser: async () => {
      outside();
      if (auth === "ABSENT") {
        throw Object.assign(new Error("synthetic"),
            {code: "auth/user-not-found"});
      }
      if (auth instanceof Error) throw auth;
      if (auth === "NULL") return null;
      return {uid: BINDING.uid};
    },
    authorizeCleanup: async (context) => {
      outside();
      return clone(context);
    },
    terminalInventory: async (context) => {
      outside();
      return Object.assign({}, context, {
        privateTreeEmpty: !db.data.has(refs.privateRoot.path + "/notes/orphan"),
        externalResourcesEmpty: !db.data.has("synthetic_external/pending"),
      });
    },
    terminalTransaction: async (reader, context) => {
      assert.equal(transactionContext.getStore(), true);
      assert.deepEqual(Object.keys(reader), ["get"]);
      calls.terminalReads++;
      const orphan = await reader.get(
          db.doc(refs.privateRoot.path + "/notes/orphan"));
      const external = await reader.get(db.doc("synthetic_external/pending"));
      return Object.assign({}, context, {privateTreeEmpty: !orphan.exists,
        externalResourcesEmpty: !external.exists});
    },
  };
  const options = {db, binding: clone(BINDING), clock: () =>
    Timestamp.fromMillis(millis), uuid: () => {
    assert.notEqual(transactionContext.getStore(), true);
    calls.uuid++;
    return calls.uuid === 1 ? ID1 : ID2;
  }, ports};
  const controller = core.createController(options);
  return {db, refs, calls, ports, options, controller,
    auth: (value) => {
      auth = value;
    },
    event: (value) => {
      event = value;
    },
    clock: (value) => {
      millis = value;
    }};
}
async function admitted(withBirth = false) {
  const f = fixture(withBirth);
  f.operation = await f.controller.admitBackend();
  return f;
}
async function cleanable(withBirth = false) {
  const f = await admitted(withBirth);
  f.auth("ABSENT");
  f.cleanup = await f.controller.authorizeCleanup(f.operation.handle);
  return f;
}
async function completed() {
  const f = await cleanable();
  f.clock(START + 1000);
  assert.equal((await f.controller.finalize(f.cleanup)).status, "COMPLETE");
  return f;
}
function readsOf(f) {
  const result = {};
  for (const name of ["reservation", "guard", "birth", "operation"]) {
    result[name] = f.db.data.has(f.refs[name].path) ?
      {state: "PRESENT", value: clone(f.db.data.get(f.refs[name].path))} :
      {state: "ABSENT"};
  }
  return result;
}
function reject(code) {
  return (error) => {
    assert(error instanceof core.DeletionControlError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, true);
    assert.equal(error.message,
        "Deletion control is unavailable or inconsistent.");
    assert(!error.message.includes(BINDING.uid));
    assert(!error.message.includes("synthetic-private-details"));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("T01 exact references and no database fallback", () => {
  const f = fixture();
  assert.equal(f.refs.operation.path,
      "account_deletion_guards/" + BINDING.uid + "/control/operation");
  assert.equal(f.refs.reservation.path,
      "retired_auth_identities/" + BINDING.uid);
  assert.equal(f.refs.birth.path, "account_birth_decisions/" + BINDING.uid);
  assert.throws(() => core.references(f.db,
      {...BINDING, databaseId: "other"}), reject("INVALID_BINDING"));
  assert.throws(() => core.references({...f.db, projectId: "life-os-27b92"},
      BINDING), reject("STORE_BINDING_CONFLICT"));
  assert.throws(() => core.createController({...f.options, db: null}),
      reject("INVALID_CONFIG"));
});
test("T01 legacy formats preserved byte-equivalent and non-authoritative",
    () => {
      const v1 = {version: 1, state: "RESERVED", deletionId: ID1,
        authCreatedAtMs: START};
      const v2 = {version: 2, state: "RESERVED", deletionId: ID1,
        origin: "PRE_AUTH"};
      for (const value of [v1, v2]) {
        const before = JSON.stringify(value);
        assert.deepEqual(core.validateReservation(value), value);
        assert.equal(JSON.stringify(value), before);
        const f = fixture();
        f.db.put(f.refs.reservation.path, value);
        assert.deepEqual(core.classify(BINDING, readsOf(f)),
            {status: "LEGACY_RESERVATION", destructiveAuthority: false});
      }
      const f = fixture(true);
      assert.deepEqual(core.validateBirth(birth(), BINDING), birth());
      assert.deepEqual(core.classify(BINDING, readsOf(f)),
          {status: "ABSENT", destructiveAuthority: false});
    });
test("T01 strict values reject coercion, extras and timestamp substitutes",
    () => {
      for (const id of [[ID1], {toString: () => ID1}, null, 1]) {
        assert.throws(() => core.validateReservation({version: 2,
          state: "RESERVED", deletionId: id, origin: "PRE_AUTH"}),
        reject("INVALID_FORMAT"));
      }
      assert.throws(() => core.validateReservation({version: 3}),
          reject("UNSUPPORTED_FORMAT"));
      assert.throws(() => core.validateGuard({version: 1, state: "IN_PROGRESS",
        deletionId: ID1, startedAt: {seconds: 1, nanoseconds: 0},
        retainUntil: null}),
      reject("INVALID_FORMAT"));
      assert.throws(() => core.validateBirth(
          {...birth(), verified: true}, BINDING),
      reject("INVALID_FORMAT"));
      assert.throws(() => core.validateBirth({...birth(), uid: "different"},
          BINDING),
      reject("BINDING_CONFLICT"));
    });
test("T01 missing/ambiguous/failed snapshots do not become absence", () => {
  const f = fixture();
  const reads = readsOf(f);
  assert.equal(core.classify(BINDING, {...reads,
    guard: {state: "UNAVAILABLE"}}).status, "READ_UNAVAILABLE");
  for (const value of [undefined, null, {state: "ABSENT", value: {}},
    {state: "PRESENT", value: null}]) {
    assert.equal(core.classify(BINDING, {...reads, guard: value}).status,
        "READ_AMBIGUOUS");
  }
});
test("T01 canonical decisions, shared oracle across independent repositories",
    async (t) => {
      const f = await admitted();
      const active = readsOf(f);
      const terminal = await completed();
      const done = readsOf(terminal);
      const review = fixture();
      review.auth("ABSENT");
      review.event({eventId: "synthetic-review", association: "REVIEW",
        deletionId: null});
      await review.controller.admitManagedEvent();
      const cases = [
        ["absent", readsOf(fixture()), "ABSENT"],
        ["active", active, "IN_PROGRESS"],
        ["complete", done, "COMPLETE"],
        ["complete-parent-absent", {...done, guard: {state: "ABSENT"}},
          "COMPLETE"],
        ["review", readsOf(review), "REVIEW_REQUIRED"],
        ["active-parent-absent", {...active, guard: {state: "ABSENT"}},
          "ACTIVE_GUARD_MISSING"],
        ["active-reservation-absent", {...active,
          reservation: {state: "ABSENT"}},
        "ACTIVE_RESERVATION_MISSING"],
        ["legacy", {...active, operation: {state: "ABSENT"}}, "LEGACY_GUARD"],
        ["read-failure", {...active, birth: {state: "UNAVAILABLE"}},
          "READ_UNAVAILABLE"],
      ];
      for (const [name, field, value, expected] of [
        ["project", "projectId", "demo-wrong-project", "BINDING_CONFLICT"],
        ["uid", "uid", "different", "BINDING_CONFLICT"],
        ["database", "databaseId", "other", "BINDING_CONFLICT"],
        ["version", "version", 3, "UNSUPPORTED_FORMAT"],
        ["extra", "verified", true, "INVALID_FORMAT"],
        ["origin", "origin", "CLIENT", "INVALID_FORMAT"],
        ["premature-time", "completedAt", atTime(1000), "INVALID_FORMAT"],
      ]) {
        const reads = clone(active);
        reads.operation.value[field] = value;
        cases.push([name, reads, expected]);
      }
      const badId = clone(active);
      badId.reservation.value.deletionId = ID2;
      cases.push(["id-conflict", badId, "OPERATION_CONFLICT"]);
      const badScope = clone(active);
      badScope.operation.value.scope.privateRoot = "users/other";
      cases.push(["scope-conflict", badScope, "SCOPE_CONFLICT"]);
      const badOrigin = clone(active);
      badOrigin.reservation.value.origin = "AUTH_EVENT";
      cases.push(["origin-conflict", badOrigin, "OPERATION_CONFLICT"]);
      const decisions = cases.map(([name, reads, expected]) => {
        const decision = core.classify(BINDING, reads);
        assert.equal(decision.status, expected, name);
        assert.equal(decision.destructiveAuthority, false);
        return {name, ...decision};
      });
      t.diagnostic("CANONICAL=" + JSON.stringify(decisions));
    });
test("T01 immutable scope rejects later changes, not just malformed paths",
    async () => {
      const f = await admitted();
      const original = clone(f.db.data.get(f.refs.operation.path));
      const mutated = clone(original);
      mutated.scope.birthDecisionId = BIRTH_ID;
      mutated.scope.birthDigest = "a".repeat(64);
      f.db.put(f.refs.operation.path, mutated);
      assert.equal(core.classify(BINDING, readsOf(f), original).status,
          "OPERATION_CONFLICT");
      await assert.rejects(f.controller.continueOperation(f.operation.handle),
          reject("OPERATION_CONFLICT"));
    });
test("T01 port errors named user-not-found do not attest Auth absence",
    async () => {
      const f = fixture();
      f.ports.getAuthenticatedSubject = async () => {
        throw Object.assign(new Error("synthetic-private-details"),
            {code: "auth/user-not-found"});
      };
      const c = core.createController(f.options);
      await assert.rejects(c.admitBackend(), reject("BOUNDARY_UNAVAILABLE"));
      assert.equal(f.db.data.size, 0);
    });
test("T02 first admission atomically creates only the three controls",
    async () => {
      const f = await admitted(true);
      assert.equal(f.operation.status, "ADMITTED");
      assert.equal(f.operation.destructiveAuthority, false);
      assert.equal(f.calls.uuid, 1);
      const stored = f.db.data.get(f.refs.operation.path);
      assert.equal(stored.deletionId, ID1);
      assert.equal(stored.scope.birthDecisionId, BIRTH_ID);
      assert.match(stored.scope.birthDigest, /^[a-f0-9]{64}$/);
      assert.equal(stored.origin, "PRE_AUTH");
      assert.equal(stored.sourceEventId, null);
      assert.deepEqual(new Set(f.db.writes.map((w) => w.ref.path)),
          new Set([f.refs.guard.path, f.refs.reservation.path,
            f.refs.operation.path]));
      assert.deepEqual(f.db.data.get(f.refs.birth.path), birth());
      assert.equal(f.db.data.has(f.refs.privateRoot.path), false);
    });
test("T02 handle does not escape before the commit is confirmed", async () => {
  const f = fixture();
  const reached = deferred();
  const release = deferred();
  f.db.beforeCommit = async () => {
    reached.resolve();
    await release.promise;
  };
  let resolved = false;
  const promise = f.controller.admitBackend().then((result) => {
    resolved = true;
    return result;
  });
  await reached.promise;
  assert.equal(resolved, false);
  assert.equal(f.db.data.size, 0);
  release.resolve();
  assert.equal((await promise).status, "ADMITTED");
  assert.equal(f.db.data.size, 3);
});
test("T02 repeat preserves original snapshot and does not generate another ID",
    async () => {
      const f = await admitted(true);
      const stored = clone(f.db.data.get(f.refs.operation.path));
      const count = f.db.writes.length;
      f.clock(START + 5000);
      assert.equal((await f.controller.admitBackend()).status, "RESUMED");
      assert.equal(f.calls.uuid, 1);
      assert.equal(f.db.writes.length, count);
      assert.deepEqual(f.db.data.get(f.refs.operation.path), stored);
    });
test("T02 two concurrent requests commit a single operation", async () => {
  const f = fixture();
  const peer = core.createController(f.options);
  const results = await Promise.all([
    f.controller.admitBackend(), peer.admitBackend(),
  ]);
  assert(results.every((r) => ["ADMITTED", "RESUMED"].includes(r.status)));
  assert.equal(f.db.data.size, 3);
  assert.equal(f.db.writes.length, 3);
  const stored = f.db.data.get(f.refs.operation.path);
  assert.equal(f.db.data.get(f.refs.guard.path).deletionId, stored.deletionId);
  assert.equal(f.db.data.get(f.refs.reservation.path).deletionId,
      stored.deletionId);
  assert(f.db.retries >= 1);
});
test("T02 denied commit leaves all original data intact and no authority",
    async () => {
      const f = fixture(true);
      const original = clone(f.db.data.get(f.refs.birth.path));
      f.db.denyCommit = true;
      await assert.rejects(f.controller.admitBackend(),
          reject("COMMIT_OUTCOME_UNKNOWN"));
      assert.equal(f.db.writes.length, 0);
      assert.equal(f.db.data.size, 1);
      assert.deepEqual(f.db.data.get(f.refs.birth.path), original);
      await assert.rejects(f.controller.admitBackend(),
          reject("COMMIT_OUTCOME_UNKNOWN"));
      assert.equal(f.calls.uuid, 1);
    });
test("T02 lost commit reply is resolved by read, no second reservation",
    async () => {
      const f = fixture();
      f.db.loseCommitReply = true;
      assert.equal((await f.controller.admitBackend()).status,
          "ADMITTED_RECHECKED");
      assert.equal(f.db.writes.length, 3);
      assert.equal(f.calls.uuid, 1);
      assert.equal(f.db.data.get(f.refs.operation.path).deletionId, ID1);
    });
test("T02 ambiguous commit plus unavailable read stays closed until reread",
    async () => {
      const f = fixture();
      f.db.loseCommitReply = true;
      f.db.afterLost = () => {
        f.db.failReads = true;
      };
      await assert.rejects(f.controller.admitBackend(),
          reject("COMMIT_OUTCOME_UNKNOWN"));
      assert.equal(f.db.writes.length, 3);
      f.db.failReads = false;
      assert.equal((await f.controller.admitBackend()).status,
          "ADMITTED_RECHECKED");
      assert.equal(f.calls.uuid, 1);
      assert.equal(f.db.writes.length, 3);
    });
test("T02 ambiguous uncommitted outcome never auto-reserves again",
    async () => {
      const f = fixture();
      f.db.unknownWithoutCommit = true;
      await assert.rejects(f.controller.admitBackend(),
          reject("COMMIT_OUTCOME_UNKNOWN"));
      f.db.unknownWithoutCommit = false;
      await assert.rejects(f.controller.admitBackend(),
          reject("COMMIT_OUTCOME_UNKNOWN"));
      assert.equal(f.db.data.size, 0);
      assert.equal(f.calls.uuid, 1);
    });
test("T02 read failure cannot create controls or report COMPLETE", async () => {
  const f = fixture();
  f.db.failReads = true;
  await assert.rejects(f.controller.admitBackend(), reject("READ_UNAVAILABLE"));
  await assert.rejects(f.controller.inspect(), reject("READ_UNAVAILABLE"));
  assert.equal(f.db.writes.length, 0);
  assert.equal(f.calls.uuid, 0);
});
test("T02 changed birth snapshot on retry is not silently re-admitted",
    async () => {
      const f = fixture(true);
      let changed = false;
      f.db.beforeCommit = async () => {
        if (!changed) {
          changed = true;
          f.db.put(f.refs.birth.path, {...birth(), decisionId: ID2});
        }
      };
      await assert.rejects(f.controller.admitBackend(),
          reject("SCOPE_CONFLICT"));
      assert.equal(f.db.writes.length, 0);
      assert.equal(f.calls.uuid, 1);
    });
test("T02 arbitrary request fields and copied capabilities are refused",
    async () => {
      const f = await admitted();
      await assert.rejects(f.controller.admitBackend({verified: true,
        origin: "PRE_AUTH", deletionId: ID2}), reject("UNEXPECTED_INPUT"));
      for (const value of [{verified: true}, clone(f.operation.handle),
        core.classify(BINDING, readsOf(f))]) {
        await assert.rejects(f.controller.authorizeCleanup(value),
            reject("INVALID_CAPABILITY"));
      }
      const peer = core.createController(f.options);
      await assert.rejects(peer.continueOperation(f.operation.handle),
          reject("INVALID_CAPABILITY"));
    });
test("T02 boundary schema rejects client-shaped attestation", async () => {
  const f = fixture();
  f.ports.getAuthenticatedSubject = async () => ({...BINDING, verified: true});
  await assert.rejects(core.createController(f.options).admitBackend(),
      reject("BOUNDARY_REFUSED"));
  assert.equal(f.db.data.size, 0);
});
test("T02 absence Auth alone cannot reserve PRE_AUTH", async () => {
  const f = fixture();
  f.auth("ABSENT");
  await assert.rejects(f.controller.admitBackend(),
      reject("AUTH_STATE_CONFLICT"));
  assert.equal(f.db.writes.length, 0);
});
test("Core managed-event seam creates AUTH_EVENT, not PRE_AUTH", async () => {
  const f = fixture();
  f.auth("ABSENT");
  const result = await f.controller.admitManagedEvent();
  assert.equal(result.status, "ADMITTED");
  assert.equal(f.db.data.get(f.refs.reservation.path).origin, "AUTH_EVENT");
  assert.equal(f.db.data.get(f.refs.operation.path).sourceEventId,
      "synthetic-delete");
  assert.equal((await f.controller.admitManagedEvent()).status, "RESUMED");
  f.event({eventId: "different-event", association: "NEW_POLICY",
    deletionId: null});
  await assert.rejects(f.controller.admitManagedEvent(),
      reject("EVENT_CONFLICT"));
});
test("Core event association requires the original operation, never creates it",
    async () => {
      const f = fixture();
      f.auth("ABSENT");
      f.event({eventId: "synthetic-delete", association: "ORIGINAL_OPERATION",
        deletionId: ID1});
      await assert.rejects(f.controller.admitManagedEvent(),
          reject("OPERATION_MISSING"));
      assert.equal(f.db.writes.length, 0);
    });
test("Core event association preserves PRE_AUTH and checks exact deletionId",
    async () => {
      const f = await admitted();
      f.auth("ABSENT");
      f.event({eventId: "synthetic-delete", association: "ORIGINAL_OPERATION",
        deletionId: ID1});
      assert.equal((await f.controller.admitManagedEvent()).status, "RESUMED");
      assert.equal(f.db.data.get(f.refs.operation.path).origin, "PRE_AUTH");
      f.event({eventId: "synthetic-delete", association: "ORIGINAL_OPERATION",
        deletionId: ID2});
      await assert.rejects(f.controller.admitManagedEvent(),
          reject("EVENT_CONFLICT"));
    });
test("Core event ID match cannot hide a conflicting associated deletionId",
    async () => {
      const f = fixture();
      f.auth("ABSENT");
      await f.controller.admitManagedEvent();
      f.event({eventId: "synthetic-delete", association: "ORIGINAL_OPERATION",
        deletionId: ID2});
      await assert.rejects(f.controller.admitManagedEvent(),
          reject("EVENT_CONFLICT"));
    });
test("T07 REVIEW_REQUIRED is deny-only and never automatically promoted",
    async () => {
      const f = fixture();
      f.auth("ABSENT");
      f.event({eventId: "synthetic-review", association: "REVIEW",
        deletionId: null});
      assert.equal((await f.controller.admitManagedEvent()).status,
          "REVIEW_REQUIRED");
      assert.equal(f.db.data.has(f.refs.guard.path), false);
      const original = clone(f.db.data.get(f.refs.operation.path));
      f.event({eventId: "synthetic-review", association: "NEW_POLICY",
        deletionId: null});
      assert.equal((await f.controller.admitManagedEvent()).status,
          "REVIEW_REQUIRED");
      assert.deepEqual(f.db.data.get(f.refs.operation.path), original);
      assert.equal(f.db.writes.length, 2);
    });
test("T07 legacy controls block rather than being adopted", async () => {
  for (const kind of ["reservation", "guard"]) {
    const f = fixture();
    const value = kind === "reservation" ?
      {version: 2, state: "RESERVED", deletionId: ID1, origin: "PRE_AUTH"} :
      {version: 1, state: "COMPLETE", deletionId: ID1,
        startedAt: atTime(-10000),
        retainUntil: atTime(-1)};
    f.db.put(f.refs[kind].path, value);
    await assert.rejects(f.controller.admitBackend(),
        reject(kind === "guard" ? "LEGACY_GUARD" : "LEGACY_RESERVATION"));
    assert.equal(f.db.writes.length, 0);
    assert.deepEqual(f.db.data.get(f.refs[kind].path), value);
  }
});
test("T07 active operation with missing guard never recreates it", async () => {
  const f = await admitted();
  f.db.erase(f.refs.guard.path);
  const writes = f.db.writes.length;
  await assert.rejects(f.controller.continueOperation(f.operation.handle),
      reject("ACTIVE_GUARD_MISSING"));
  await assert.rejects(f.controller.admitBackend(),
      reject("ACTIVE_GUARD_MISSING"));
  assert.equal(f.db.data.has(f.refs.guard.path), false);
  assert.equal(f.db.writes.length, writes);
  assert.equal(f.calls.uuid, 1);
});
test("Core continuation port resumes original ID after factory recreation",
    async () => {
      const f = await admitted(true);
      const original = clone(f.db.data.get(f.refs.operation.path));
      f.clock(START + 10000);
      const peer = core.createController(f.options);
      assert.equal((await peer.resumeOriginal()).status, "RESUMED");
      assert.deepEqual(f.db.data.get(f.refs.operation.path), original);
      assert.equal(f.calls.uuid, 1);
      f.ports.getContinuation = async () => ({...BINDING, deletionId: ID2});
      await assert.rejects(core.createController(f.options).resumeOriginal(),
          reject("OPERATION_CONFLICT"));
    });
test("Core cleanup requires original handle, trusted port and Auth absence",
    async () => {
      const f = await admitted();
      await assert.rejects(f.controller.authorizeCleanup(f.operation.handle),
          reject("AUTH_STATE_CONFLICT"));
      for (const state of ["NULL", new Error("synthetic-timeout"),
        Object.assign(new Error("synthetic"), {code: "auth/internal-error"})]) {
        f.auth(state);
        await assert.rejects(f.controller.authorizeCleanup(f.operation.handle),
            reject(state === "NULL" ? "AUTH_AMBIGUOUS" : "AUTH_UNAVAILABLE"));
      }
      f.auth("ABSENT");
      const cleanup = await f.controller.authorizeCleanup(f.operation.handle);
      assert.equal((await f.db.runTransaction((tx) =>
        f.controller.assertCleanupTransaction(tx, cleanup))).status,
      "CLEANUP_SCOPE_REVALIDATED");
      assert.equal(f.db.destructiveCalls, 0);
    });
test("Core cleanup transactional check revalidates state after authorization",
    async () => {
      const f = await cleanable();
      f.db.erase(f.refs.reservation.path);
      await assert.rejects(f.db.runTransaction((tx) =>
        f.controller.assertCleanupTransaction(tx, f.cleanup)),
      reject("ACTIVE_RESERVATION_MISSING"));
    });
test("Core finalization writes only guard/receipt after independent evidence",
    async () => {
      const f = await cleanable();
      f.clock(START + 1000);
      assert.equal((await f.controller.finalize(f.cleanup)).status, "COMPLETE");
      const operation = f.db.data.get(f.refs.operation.path);
      const guard = f.db.data.get(f.refs.guard.path);
      assert.equal(operation.state, "COMPLETE");
      assert.equal(operation.deletionId, ID1);
      assert.equal(guard.state, "COMPLETE");
      assert.equal(guard.retainUntil.toMillis(),
          START + 1000 + 65 * 60 * 1000);
      assert.equal(f.db.writes.length, 5);
      assert(f.calls.terminalReads > 0);
      assert.equal(f.db.destructiveCalls, 0);
    });
test("Core terminal guards require injected evidence, not empty data alone",
    async () => {
      const f = await admitted();
      f.auth("ABSENT");
      const ports = {...f.ports};
      delete ports.terminalInventory;
      const peer = core.createController({...f.options, ports});
      const resumed = await peer.resumeOriginal();
      const cleanup = await peer.authorizeCleanup(resumed.handle);
      await assert.rejects(peer.finalize(cleanup),
          reject("BOUNDARY_UNAVAILABLE"));
      assert.equal(f.db.data.get(f.refs.operation.path).state, "IN_PROGRESS");
    });
test("Core incomplete terminal evidence is denied without partial COMPLETE",
    async () => {
      for (const path of ["privateRoot", "orphan", "external", "birth"]) {
        const f = await cleanable(path === "birth");
        if (path === "privateRoot") f.db.put(f.refs.privateRoot.path, {x: 1});
        if (path === "orphan") {
          f.db.put(f.refs.privateRoot.path + "/notes/orphan", {x: 1});
        }
        if (path === "external") f.db.put("synthetic_external/pending", {x: 1});
        await assert.rejects(f.controller.finalize(f.cleanup),
            reject(path === "privateRoot" ? "TERMINAL_RESIDUE" :
              path === "birth" ?
                "BIRTH_REMOVAL_REQUIRED" : "TERMINAL_NOT_PROVEN"));
        assert.equal(f.db.data.get(f.refs.guard.path).state, "IN_PROGRESS");
        assert.equal(f.db.data.get(f.refs.operation.path).state, "IN_PROGRESS");
      }
    });
test("Core terminal transaction proof is mandatory and read-only", async () => {
  const f = await admitted();
  f.auth("ABSENT");
  f.ports.terminalTransaction = async () => {
    throw new Error("synthetic-private-details");
  };
  const peer = core.createController(f.options);
  const resumed = await peer.resumeOriginal();
  const cleanup = await peer.authorizeCleanup(resumed.handle);
  await assert.rejects(peer.finalize(cleanup), reject("TERMINAL_NOT_PROVEN"));
  assert.equal(f.db.data.get(f.refs.operation.path).state, "IN_PROGRESS");
});
test("Core denied final commit preserves active state and original scope",
    async () => {
      const f = await cleanable();
      const original = clone(f.db.data.get(f.refs.operation.path));
      f.db.denyCommit = true;
      await assert.rejects(f.controller.finalize(f.cleanup),
          reject("COMMIT_OUTCOME_UNKNOWN"));
      assert.deepEqual(f.db.data.get(f.refs.operation.path), original);
      assert.equal(f.db.data.get(f.refs.guard.path).state, "IN_PROGRESS");
    });
test("Core lost final reply rereads terminal evidence without writing twice",
    async () => {
      const f = await cleanable();
      f.db.loseCommitReply = true;
      assert.equal((await f.controller.finalize(f.cleanup)).status,
          "COMPLETE_RECHECKED");
      assert.equal(f.db.writes.length, 5);
      assert.equal(f.calls.uuid, 1);
    });
for (const parent of ["present", "expired", "missing"]) {
  test("T07 COMPLETE remains terminal with parent " + parent, async () => {
    const f = await completed();
    if (parent === "expired") f.clock(START + 70 * 60 * 1000);
    if (parent === "missing") f.db.erase(f.refs.guard.path);
    const original = clone(f.db.data.get(f.refs.operation.path));
    const writes = f.db.writes.length;
    assert.equal((await f.controller.inspect()).status, "COMPLETE");
    assert.equal((await f.controller.admitBackend()).status, "COMPLETE");
    assert.equal((await f.controller.resumeOriginal()).status, "COMPLETE");
    assert.equal(
        (await f.controller.continueOperation(f.operation.handle)).status,
        "COMPLETE");
    assert.equal((await f.controller.finalize(f.cleanup)).status,
        "COMPLETE_RECHECKED");
    await assert.rejects(f.controller.authorizeCleanup(f.operation.handle),
        reject("COMPLETE"));
    assert.deepEqual(f.db.data.get(f.refs.operation.path), original);
    assert.equal(f.db.writes.length, writes);
    assert.equal(f.calls.uuid, 1);
    assert.equal(f.db.destructiveCalls, 0);
    if (parent === "missing") assert(!f.db.data.has(f.refs.guard.path));
  });
}
test("T07 terminal residue reports failure without reopening historic receipt",
    async () => {
      const f = await completed();
      const original = clone(f.db.data.get(f.refs.operation.path));
      f.db.put(f.refs.privateRoot.path, {synthetic: "late"});
      await assert.rejects(f.controller.finalize(f.cleanup),
          reject("TERMINAL_RESIDUE"));
      assert.deepEqual(f.db.data.get(f.refs.operation.path), original);
      assert.equal(f.db.writes.length, 5);
    });
test("T07 inconsistent terminal parent is not used to restart", async () => {
  const f = await completed();
  f.db.put(f.refs.guard.path, {...f.db.data.get(f.refs.guard.path),
    state: "IN_PROGRESS", retainUntil: null});
  await assert.rejects(f.controller.admitBackend(),
      reject("OPERATION_CONFLICT"));
  assert.equal(f.db.data.get(f.refs.operation.path).state, "COMPLETE");
});
test("Controller captures its binding and suppliers against later mutation",
    async () => {
      const f = fixture();
      f.options.binding.uid = "client-changed";
      f.options.uuid = () => ID2;
      f.options.clock = () => atTime(10000);
      await f.controller.admitBackend();
      assert.equal(f.db.data.get(f.refs.operation.path).uid, BINDING.uid);
      assert.equal(f.db.data.get(f.refs.operation.path).deletionId, ID1);
      assert.equal(f.db.data.get(f.refs.guard.path).startedAt.toMillis(),
          START);
    });
test.after(() => {
  assert.equal(network.attempts, 0, "Unexpected network call");
  assert.equal(network.adc, 0, "Unexpected ADC lookup");
});


test("T02 private root participates in admission transaction retries",
    async () => {
      const f = fixture();
      let changed = false;
      f.db.beforeCommit = () => {
        if (!changed) {
          changed = true;
          f.db.put(f.refs.privateRoot.path, {synthetic: "concurrent-writer"});
        }
      };
      const result = await f.controller.admitBackend();
      assert.equal(result.status, "ADMITTED");
      assert.equal(f.db.retries, 1);
      assert.equal(f.calls.uuid, 1);
      assert.equal(f.db.writes.length, 3);
      assert.deepEqual(f.db.data.get(f.refs.privateRoot.path),
          {synthetic: "concurrent-writer"});
      assert.equal(f.db.destructiveCalls, 0);
    });
