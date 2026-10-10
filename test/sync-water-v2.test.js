import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// No credentials or services: every Firestore entry point used by sync is mocked.
if (!getApps().length) initializeApp({ projectId: 'water-v2-fake-only' });
const { syncHandler } = await import('../api/sync.js');
const { WATER_V2_ENABLED } = await import('../api/health/_sync_water.js');
const db = getFirestore();
const context = new AsyncLocalStorage();
const UID = 'water-owner';
const USER = `users/${UID}`;
const DAY = '2026-08-21';
const EPOCH = '11111111-1111-4111-8111-111111111111';
const OTHER_EPOCH = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STATE = `${USER}/water_state/${DAY}`;
const PROJECTION = `${USER}/health_info/${DAY}`;
const ACTIVATION = `${USER}/water_protocol/activation`;
const GUARD = `account_deletion_guards/${UID}`;
const receiptPath = id => `${USER}/water_increment_receipts/${id}`;
const increment = (id = A, overrides = {}) => ({ operation: 'increment_water', version: 2,
  mutationId: id, healthDay: DAY, deltaMl: 250, occurredAt: `${DAY}T10:00:00.000Z`,
  timeZoneOffsetMinutes: 0, ...overrides });
const reconcile = (ids = [], overrides = {}) => ({ operation: 'reconcile_water', version: 2,
  healthDay: DAY, pendingMutationIds: ids, ...overrides });
function collection(path) { return { doc: id => document(`${path}/${id}`) }; }
function document(path) { return { path, collection: name => collection(`${path}/${name}`) }; }
function clone(value) {
  if (value instanceof Timestamp || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, clone(val)]));
  return value;
}
function gate() {
  const reached = Promise.withResolvers();
  const released = Promise.withResolvers();
  return { reached: reached.promise, release: released.resolve,
    async hold() { reached.resolve(); await released.promise; } };
}
function fixture(t, total = 1000) {
  const docs = new Map([
    [USER, { tasksCount: 0 }],
    [ACTIVATION, { protocolVersion: 2, epoch: EPOCH, status: 'ACTIVE', legacyWritesBlocked: true }],
    [STATE, { protocolVersion: 2, epoch: EPOCH, waterIntakeMl: total, revision: 0 }],
    [PROJECTION, { waterIntakeMl: total, mood: 'happy', hasTakenPillToday: true,
      menstrualCycle: 'follicular', date: `${DAY}T00:00:00.000Z` }],
  ]);
  const versions = new Map();
  const writes = [];
  const attempts = [];
  const conflicts = [];
  const hooks = {};
  const checks = [];
  function put(path, value) {
    if (value === undefined) docs.delete(path);
    else docs.set(path, clone(value));
    versions.set(path, (versions.get(path) ?? 0) + 1);
  }
  t.mock.method(db, 'collection', collection);
  // Each callback receives a stable snapshot, including absence versions. Writes
  // are buffered and committed atomically only if ALL read versions still match.
  // Both writing and read-only transactions retry the actual production callback.
  t.mock.method(db, 'runTransaction', async callback => {
    const label = context.getStore();
    for (let attempt = 1; attempt <= 10; attempt++) {
      const state = new Map([...docs].map(([path, value]) => [path, clone(value)]));
      const startVersions = new Map(versions);
      const reads = new Map();
      const pending = [];
      const record = { label, attempt, reads, pending };
      attempts.push(record);
      const result = await callback({
        async get(ref) {
          assert.equal(pending.length, 0, 'read after write is forbidden');
          reads.set(ref.path, startVersions.get(ref.path) ?? 0);
          await hooks.onRead?.({ label, attempt, path: ref.path });
          return { exists: state.has(ref.path), data: () => clone(state.get(ref.path)) };
        },
        set: (ref, data) => pending.push({ path: ref.path, data, type: 'set' }),
        update: (ref, data) => pending.push({ path: ref.path, data, type: 'update' }),
      });
      await hooks.beforeCommit?.(record);
      const changed = [...reads].filter(([path, version]) => (versions.get(path) ?? 0) !== version).map(([path]) => path);
      if (changed.length) { conflicts.push({ label, attempt, paths: changed }); continue; }
      // No await between writes: none can become visible without the others.
      for (const write of pending) {
        if (write.type === 'update') assert.ok(docs.has(write.path));
        const data = Object.fromEntries(Object.entries(write.data).map(([key, val]) =>
          [key, val?.constructor?.name === 'ServerTimestampTransform' ? Timestamp.fromMillis(1_800_000_000_000) : val]));
        put(write.path, write.type === 'update' ? { ...docs.get(write.path), ...data } : data);
        writes.push(write);
      }
      record.result = result;
      await hooks.afterCommit?.(record);
      return result;
    }
    throw new Error('MVCC retry limit');
  });
  async function invoke(body = increment(), { label = 'request', runtime = {}, headers = {}, method = 'POST', disabled = false } = {}) {
    const response = { statusCode: 200, setHeader() {}, end() { return this; },
      status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    const baseRuntime = {
      verifyAppCheckToken: async token => { assert.equal(token, 'fake-app-check'); checks.push('app-check'); return { appId: 'fake' }; },
      verifyIdToken: async (token, revoked) => { assert.equal(token, 'fake-id-token'); assert.equal(revoked, true); checks.push('auth-revoked'); return { uid: UID }; },
      checkRateLimit: async params => { assert.deepEqual(params, { scope: 'sync', uid: UID, limit: 30, windowMs: 60_000 }); checks.push('rate-limit'); return true; },
      ...(!disabled ? { waterV2Enabled: true } : {}), ...runtime,
    };
    await context.run(label, () => syncHandler({ method, body, headers: {
      authorization: 'Bearer fake-id-token', 'x-firebase-appcheck': 'fake-app-check', ...headers,
    } }, response, baseRuntime));
    return response;
  }
  return { docs, writes, attempts, conflicts, hooks, checks, put, invoke,
    total: () => docs.get(STATE)?.waterIntakeMl, revision: () => docs.get(STATE)?.revision };
}
function success(res) { assert.equal(res.statusCode, 200); assert.equal(res.body.success, true); return res.body; }
function rejected(res, status, code) { assert.equal(res.statusCode, status); if (code) assert.equal(res.body.code, code); }
function unchanged(f, before) { assert.deepEqual([...f.docs], before); assert.equal(f.writes.length, 0); }
const check = (name, fn) => test(name, { timeout: 5000 }, fn);

check('first 250ml increment commits state, projection and durable receipt only', async t => {
  const f = fixture(t, 0);
  const result = success(await f.invoke());
  assert.deepEqual(result, { success: true, operation: 'increment_water', version: 2,
    healthDay: DAY, epoch: EPOCH, revision: 1, waterIntakeMl: 250,
    alreadyApplied: false, effectiveCreditMl: 250, appliedRevision: 1 });
  assert.equal(f.writes.length, 3);
  assert.deepEqual([...f.attempts[0].reads.keys()], [USER, GUARD, ACTIVATION, STATE, receiptPath(A), PROJECTION]);
  const receipt = f.docs.get(receiptPath(A));
  assert.equal(receipt.mutationId, A); assert.equal(receipt.protocolVersion, 2);
  assert.equal(receipt.deltaMl, 250); assert.equal(receipt.healthDay, DAY);
  assert.equal(receipt.occurredAt, increment().occurredAt); assert.equal(receipt.timeZoneOffsetMinutes, 0);
  assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(receipt.appliedAt instanceof Timestamp); assert.equal(Object.hasOwn(receipt, 'expireAt'), false);
  assert.deepEqual(f.docs.get(PROJECTION), { waterIntakeMl: 250, mood: 'happy',
    hasTakenPillToday: true, menstrualCycle: 'follicular', date: `${DAY}T00:00:00.000Z` });
});

for (const ids of [[A, B], [B, A]]) check(`two stale devices independently starting at 1000: order ${ids[0][0]}→${ids[1][0]}`, async t => {
  const f = fixture(t);
  assert.equal(success(await f.invoke(increment(ids[0]))).waterIntakeMl, 1250);
  assert.equal(success(await f.invoke(increment(ids[1]))).waterIntakeMl, 1500);
  assert.equal(f.total(), 1500); assert.equal(f.revision(), 2); assert.equal(f.writes.length, 6);
});
check('offline delay and two independent intentions from the same device preserve all credits', async t => {
  const f = fixture(t);
  await f.invoke(increment(A)); await f.invoke(increment(C)); await f.invoke(increment(B));
  assert.equal(f.total(), 1750); assert.equal(f.revision(), 3);
});
check('lost response after commit and replay after relogin credit once', async t => {
  const f = fixture(t);
  f.hooks.afterCommit = async () => { throw new Error('lost response: secret-token stack users/third-party'); };
  rejected(await f.invoke(), 503, 'WATER_FIRESTORE_UNAVAILABLE');
  assert.equal(f.total(), 1250); assert.equal(f.writes.length, 3);
  delete f.hooks.afterCommit;
  await f.invoke(increment(B));
  const res = success(await f.invoke(increment(A), { label: 'relogin' }));
  assert.equal(res.alreadyApplied, true); assert.equal(res.waterIntakeMl, 1500);
  assert.equal(res.appliedRevision, 1); assert.equal(res.revision, 2);
  assert.equal(f.writes.length, 6);
});
for (const sameId of [false, true]) check(`concurrent ${sameId ? 'same UUID' : 'distinct UUIDs'} retries actual callback optimistically`, async t => {
  const f = fixture(t);
  const hold = gate();
  f.hooks.beforeCommit = async record => { if (record.label === 'A' && record.attempt === 1) await hold.hold(); };
  const pending = f.invoke(increment(A), { label: 'A' });
  await hold.reached;
  success(await f.invoke(increment(sameId ? A : B), { label: 'B' }));
  hold.release();
  const res = success(await pending);
  assert.equal(f.conflicts.length, 1); assert.equal(f.attempts.filter(r => r.label === 'A').length, 2);
  assert.equal(f.total(), sameId ? 1250 : 1500); assert.equal(f.revision(), sameId ? 1 : 2);
  assert.equal(f.writes.length, sameId ? 3 : 6); assert.equal(res.alreadyApplied, sameId);
});
check('UUID collision with divergent immutable payload fails without writes', async t => {
  const f = fixture(t);
  await f.invoke();
  const before = [...f.docs]; const count = f.writes.length;
  rejected(await f.invoke(increment(A, { occurredAt: `${DAY}T11:00:00.000Z` })), 409, 'WATER_MUTATION_CONFLICT');
  assert.deepEqual([...f.docs], before); assert.equal(f.writes.length, count);
});
check('UUID divergent reuse conflicts across days even when new day is unprepared', async t => {
  const f = fixture(t); await f.invoke(); const before = [...f.docs];
  rejected(await f.invoke(increment(A, { healthDay: '2026-08-22', occurredAt: '2026-08-22T10:00:00.000Z' })), 409, 'WATER_MUTATION_CONFLICT');
  assert.deepEqual([...f.docs], before); assert.equal(f.writes.length, 3);
});
for (const [start, credit] of [[999750, 250], [999900, 100], [1000000, 0]]) {
  check(`saturation ${start} grants ${credit}, preserves zero/partial receipt on replay`, async t => {
    const f = fixture(t, start);
    assert.equal(success(await f.invoke()).effectiveCreditMl, credit);
    assert.equal(f.total(), 1000000); assert.equal(f.revision(), 1);
    const receipt = f.docs.get(receiptPath(A));
    assert.equal(receipt.effectiveCreditMl, credit);
    assert.equal(success(await f.invoke()).effectiveCreditMl, credit);
    assert.deepEqual(f.docs.get(receiptPath(A)), receipt); assert.equal(f.writes.length, 3);
    await f.invoke(increment(B)); assert.equal(f.revision(), 2);
    assert.equal(success(await f.invoke()).effectiveCreditMl, credit); assert.equal(f.writes.length, 6);
  });
}
check('zero-credit receipt never earns new credit after incompatible epoch change', async t => {
  const f = fixture(t, 1000000); await f.invoke();
  f.put(ACTIVATION, { ...f.docs.get(ACTIVATION), epoch: OTHER_EPOCH });
  f.put(STATE, { ...f.docs.get(STATE), epoch: OTHER_EPOCH, waterIntakeMl: 0, revision: 0 });
  f.put(PROJECTION, { ...f.docs.get(PROJECTION), waterIntakeMl: 0 });
  rejected(await f.invoke(), 409, 'WATER_SNAPSHOT_MISMATCH'); assert.equal(f.total(), 0); assert.equal(f.writes.length, 3);
});
check('reconcile returns applied memberships and missing IDs from a read-only snapshot', async t => {
  const f = fixture(t); await f.invoke(); await f.invoke(increment(B));
  const result = success(await f.invoke(reconcile([A, C, B], { expectedEpoch: EPOCH, expectedRevision: 2 })));
  assert.deepEqual(result, { success: true, operation: 'reconcile_water', version: 2,
    healthDay: DAY, epoch: EPOCH, revision: 2, waterIntakeMl: 1500, complete: true,
    recognized: [{ mutationId: A, effectiveCreditMl: 250, appliedRevision: 1 },
      { mutationId: B, effectiveCreditMl: 250, appliedRevision: 2 }], unrecognizedMutationIds: [C] });
  assert.equal(f.writes.length, 6); assert.equal(f.attempts.at(-1).pending.length, 0);
});
check('reconcile retries if a concurrent increment changes its snapshot', async t => {
  const f = fixture(t); const hold = gate();
  f.hooks.beforeCommit = async r => { if (r.label === 'read' && r.attempt === 1) await hold.hold(); };
  const pending = f.invoke(reconcile([A]), { label: 'read' });
  await hold.reached; await f.invoke(); hold.release();
  const result = success(await pending);
  assert.equal(result.waterIntakeMl, 1250); assert.equal(result.recognized.length, 1);
  assert.equal(f.conflicts.length, 1); assert.equal(f.writes.length, 3);
});
check('reconcile empty list returns the complete snapshot without writes', async t => {
  const f = fixture(t); const before = [...f.docs];
  assert.deepEqual(success(await f.invoke(reconcile())).recognized, []); unchanged(f, before);
});
check('reconcile accepts exactly 100 distinct UUIDs with bounded reads', async t => {
  const f = fixture(t);
  const ids = Array.from({ length: 100 }, (_, i) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`);
  const result = success(await f.invoke(reconcile(ids)));
  assert.equal(result.unrecognizedMutationIds.length, 100); assert.equal(f.attempts[0].reads.size, 105);
  assert.equal(f.writes.length, 0);
});
for (const overrides of [{ expectedEpoch: OTHER_EPOCH }, { expectedRevision: 1 }]) {
  check(`reconcile expected snapshot mismatch ${JSON.stringify(overrides)}`, async t => {
    const f = fixture(t); const before = [...f.docs];
    rejected(await f.invoke(reconcile([A], overrides)), 409, 'WATER_SNAPSHOT_MISMATCH'); unchanged(f, before);
  });
}
for (const change of [{ epoch: OTHER_EPOCH }, { revision: 2 }, { healthDay: '2026-08-22', occurredAt: '2026-08-22T10:00:00.000Z' }]) {
  check(`reconcile rejects incompatible receipt ${JSON.stringify(change)}`, async t => {
    const f = fixture(t); await f.invoke();
    const old = f.docs.get(receiptPath(A));
    if (change.healthDay) {
      // Obtain an authentic receipt with a matching fingerprint for another day.
      f.put(`${USER}/water_state/2026-08-22`, { protocolVersion: 2, epoch: EPOCH, waterIntakeMl: 0, revision: 0 });
      f.put(`${USER}/health_info/2026-08-22`, { waterIntakeMl: 0 });
      await f.invoke(increment(B, change));
      const other = f.docs.get(receiptPath(B));
      rejected(await f.invoke(reconcile([B])), 409, 'WATER_SNAPSHOT_MISMATCH');
      assert.deepEqual(f.docs.get(receiptPath(B)), other);
    } else {
      f.put(receiptPath(A), { ...old, ...change });
      rejected(await f.invoke(reconcile([A])), 409, 'WATER_SNAPSHOT_MISMATCH'); assert.equal(f.writes.length, 3);
    }
  });
}
check('failure after reads and buffered writes but before commit is atomic and sanitized', async t => {
  const f = fixture(t); const before = [...f.docs];
  f.hooks.beforeCommit = async () => { throw Object.assign(new Error('secret-token users/third-party internal-stack'), { code: 'WATER_MUTATION_CONFLICT', statusCode: 200 }); };
  const res = await f.invoke(); rejected(res, 503, 'WATER_FIRESTORE_UNAVAILABLE');
  assert.equal(res.body.retryable, true); assert.doesNotMatch(JSON.stringify(res.body), /secret|third-party|stack/);
  unchanged(f, before); assert.equal(f.attempts[0].pending.length, 3);
});
for (const operation of [increment, reconcile]) check(`${operation.name}: guard read failure fails closed`, async t => {
  const f = fixture(t); const before = [...f.docs];
  f.hooks.onRead = async ({ path }) => { if (path === GUARD) throw new Error('guard storage failure secret'); };
  rejected(await f.invoke(operation()), 503, 'WATER_FIRESTORE_UNAVAILABLE'); unchanged(f, before);
});
for (const operation of [increment, reconcile]) {
  for (const [name, guard] of [
    ['IN_PROGRESS', { version: 1, state: 'IN_PROGRESS', deletionId: A, startedAt: Timestamp.fromMillis(1), retainUntil: null }],
    ['malformed', { state: '??' }],
    ['COMPLETE even expired', { version: 1, state: 'COMPLETE', deletionId: A, startedAt: Timestamp.fromMillis(1), retainUntil: Timestamp.fromMillis(2) }],
  ]) check(`${operation.name}: existing deletion guard ${name} blocks`, async t => {
    const f = fixture(t); f.put(GUARD, guard); const before = [...f.docs];
    rejected(await f.invoke(operation()), 403, 'WATER_ACCOUNT_DELETING'); unchanged(f, before);
  });
  check(`${operation.name}: guard created between read and commit forces retry then rejection`, async t => {
    const f = fixture(t);
    const hold = gate(); f.hooks.beforeCommit = async r => { if (r.attempt === 1) await hold.hold(); };
    const pending = f.invoke(operation()); await hold.reached;
    f.put(GUARD, { state: 'IN_PROGRESS' }); hold.release();
    rejected(await pending, 403, 'WATER_ACCOUNT_DELETING');
    assert.deepEqual(f.conflicts[0].paths, [GUARD]); assert.equal(f.writes.length, 0);
    assert.equal(f.total(), 1000); assert.equal(f.docs.has(receiptPath(A)), false);
  });
}
check('existing receipt cannot authorize replay or reconcile after deletion begins', async t => {
  const f = fixture(t); await f.invoke(); const receipt = f.docs.get(receiptPath(A));
  f.put(GUARD, { state: 'IN_PROGRESS' });
  rejected(await f.invoke(), 403, 'WATER_ACCOUNT_DELETING');
  rejected(await f.invoke(reconcile([A])), 403, 'WATER_ACCOUNT_DELETING');
  f.put(USER, undefined);
  rejected(await f.invoke(), 404, 'WATER_USER_NOT_FOUND');
  assert.deepEqual(f.docs.get(receiptPath(A)), receipt); assert.equal(f.writes.length, 3);
  assert.equal(f.docs.has(USER), false);
});
check('user removed concurrently is never recreated by retried increment', async t => {
  const f = fixture(t); const hold = gate();
  f.hooks.beforeCommit = async r => { if (r.attempt === 1) await hold.hold(); };
  const pending = f.invoke(); await hold.reached; f.put(USER, undefined); hold.release();
  rejected(await pending, 404, 'WATER_USER_NOT_FOUND'); assert.equal(f.writes.length, 0); assert.equal(f.docs.has(USER), false);
});
for (const operation of [increment, reconcile]) check(`${operation.name}: absent user rejected`, async t => {
  const f = fixture(t); f.put(USER, undefined); const before = [...f.docs];
  rejected(await f.invoke(operation()), 404, 'WATER_USER_NOT_FOUND'); unchanged(f, before);
});
for (const operation of [increment, reconcile]) check(`${operation.name}: server gate disabled by default, no transaction`, async t => {
  assert.equal(WATER_V2_ENABLED, false);
  const f = fixture(t); const before = [...f.docs];
  const res = await f.invoke(operation(), { disabled: true });
  rejected(res, 503, 'WATER_V2_DISABLED'); assert.equal(res.body.retryable, true);
  unchanged(f, before); assert.equal(f.attempts.length, 0);
  assert.deepEqual(f.checks, ['app-check', 'auth-revoked', 'rate-limit']);
});
for (const missing of [ACTIVATION, STATE, PROJECTION]) check(`missing ${missing} never bootstraps ambiguous legacy water`, async t => {
  const f = fixture(t); f.put(missing, undefined); const before = [...f.docs];
  const res = await f.invoke(); rejected(res, 503, 'WATER_MIGRATION_NOT_READY'); assert.equal(res.body.retryable, true); unchanged(f, before);
  rejected(await f.invoke(reconcile()), 503, 'WATER_MIGRATION_NOT_READY'); unchanged(f, before);
});
for (const active of [{}, { protocolVersion: 1 }, { status: 'INACTIVE' }, { legacyWritesBlocked: false }, { epoch: 'legacy' }, { unexpected: true }]) {
  check(`invalid activation ${JSON.stringify(active)} fails closed`, async t => {
    const f = fixture(t); f.put(ACTIVATION, Object.keys(active).length ? { ...f.docs.get(ACTIVATION), ...active } : {});
    const before = [...f.docs]; rejected(await f.invoke(), 503, 'WATER_MIGRATION_NOT_READY'); unchanged(f, before);
  });
}
check('activation revoked concurrently forces retry and no water writes', async t => {
  const f = fixture(t); const hold = gate();
  f.hooks.beforeCommit = async r => { if (r.attempt === 1) await hold.hold(); };
  const pending = f.invoke(); await hold.reached; f.put(ACTIVATION, undefined); hold.release();
  rejected(await pending, 503, 'WATER_MIGRATION_NOT_READY'); assert.equal(f.writes.length, 0); assert.equal(f.conflicts.length, 1);
});
for (const bad of [{ waterIntakeMl: -1 }, { waterIntakeMl: 1000001 }, { waterIntakeMl: 2.5 },
  { waterIntakeMl: '1000' }, { revision: -1 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER },
  { protocolVersion: 1 }, { epoch: OTHER_EPOCH }, { unexpected: true }]) {
  check(`invalid authoritative state ${JSON.stringify(bad)} produces no writes`, async t => {
    const f = fixture(t); f.put(STATE, { ...f.docs.get(STATE), ...bad }); const before = [...f.docs];
    rejected(await f.invoke(), 409, 'WATER_INVALID_REMOTE_STATE'); unchanged(f, before);
  });
}
check('legacy projection diverging from V2 total is never silently absorbed', async t => {
  const f = fixture(t); f.put(PROJECTION, { ...f.docs.get(PROJECTION), waterIntakeMl: 1250 }); const before = [...f.docs];
  rejected(await f.invoke(), 409, 'WATER_INVALID_REMOTE_STATE');
  rejected(await f.invoke(reconcile()), 409, 'WATER_INVALID_REMOTE_STATE'); unchanged(f, before);
});
for (const change of [{ fingerprint: 'tampered' }, { deltaMl: 500 }, { effectiveCreditMl: -1 },
  { effectiveCreditMl: 251 }, { revision: 0 }, { appliedAt: 'not-timestamp' }, { protocolVersion: 1 }]) {
  check(`malformed receipt ${JSON.stringify(change)} rejected by reconcile`, async t => {
    const f = fixture(t); await f.invoke(); f.put(receiptPath(A), { ...f.docs.get(receiptPath(A)), ...change });
    rejected(await f.invoke(reconcile([A])), 409, 'WATER_INVALID_REMOTE_STATE'); assert.equal(f.writes.length, 3);
    rejected(await f.invoke(), 409, 'WATER_INVALID_REMOTE_STATE'); assert.equal(f.writes.length, 3);
  });
}

const badIncrement = [
  { version: '2' }, { version: 1 }, { deltaMl: 0 }, { deltaMl: 500 }, { deltaMl: '250' },
  { mutationId: 'local-id-1' }, { mutationId: A.toUpperCase() }, { mutationId: '../foreign' },
  { mutationId: 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa' }, { mutationId: 'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa' },
  { healthDay: '2026-02-30' }, { healthDay: '2026-8-21' }, { healthDay: '0000-01-01' },
  { occurredAt: '2026-02-30T10:00:00.000Z' }, { occurredAt: `${DAY}T24:00:00.000Z` },
  { occurredAt: `${DAY}T10:00:00Z` }, { occurredAt: `${DAY}T10:00:00.000+00:00` },
  { healthDay: '2026-08-20' }, { timeZoneOffsetMinutes: 841 }, { timeZoneOffsetMinutes: -841 },
  { timeZoneOffsetMinutes: '0' }, { timeZoneOffsetMinutes: 0.5 }, { uid: 'victim' },
  { waterV2Enabled: true }, { enabled: true }, { epoch: EPOCH }, { revision: 0 },
];
for (const bad of badIncrement) check(`strict increment rejects ${JSON.stringify(bad)}`, async t => {
  const f = fixture(t); const before = [...f.docs];
  rejected(await f.invoke(increment(A, bad), { disabled: true }), 400, 'WATER_INVALID_PAYLOAD');
  unchanged(f, before); assert.equal(f.attempts.length, 0);
});
check('strict increment rejects missing immutable field', async t => {
  const f = fixture(t); const body = increment(); delete body.occurredAt;
  rejected(await f.invoke(body), 400, 'WATER_INVALID_PAYLOAD'); assert.equal(f.attempts.length, 0);
});
for (const [instant, offset] of [['2026-08-22T01:00:00.000Z', -180], ['2026-08-20T23:00:00.000Z', 120]]) {
  check(`local day captured coherently across UTC midnight ${offset}`, async t => {
    const f = fixture(t); const body = increment(A, { occurredAt: instant, timeZoneOffsetMinutes: offset });
    success(await f.invoke(body)); assert.equal(success(await f.invoke(body)).alreadyApplied, true);
    assert.equal(f.docs.get(receiptPath(A)).occurredAt, instant); assert.equal(f.docs.get(receiptPath(A)).timeZoneOffsetMinutes, offset);
  });
}
check('valid leap day is accepted, non-leap day is rejected', async t => {
  const f = fixture(t);
  f.put(`${USER}/water_state/2024-02-29`, { protocolVersion: 2, epoch: EPOCH, revision: 0, waterIntakeMl: 0 });
  f.put(`${USER}/health_info/2024-02-29`, { waterIntakeMl: 0 });
  success(await f.invoke(increment(A, { healthDay: '2024-02-29', occurredAt: '2024-02-29T12:00:00.000Z' })));
  rejected(await f.invoke(increment(B, { healthDay: '2026-02-29', occurredAt: '2026-02-29T12:00:00.000Z' })), 400, 'WATER_INVALID_PAYLOAD');
});
const badReconcile = [{ pendingMutationIds: [A, A] }, { pendingMutationIds: Array(101).fill(A) },
  { pendingMutationIds: 'not-array' }, { pendingMutationIds: ['local1'] }, { version: '2' },
  { expectedEpoch: 'legacy' }, { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: '0' },
  { pageToken: 'next' }, { uid: 'victim' }, { limit: 101 }];
for (const bad of badReconcile) check(`strict reconcile rejects ${JSON.stringify(bad).slice(0, 100)}`, async t => {
  const f = fixture(t); rejected(await f.invoke(reconcile([], bad)), 400, 'WATER_INVALID_PAYLOAD');
  assert.equal(f.attempts.length, 0); assert.equal(f.writes.length, 0);
});
for (const reason of ['invalid token', 'revoked ID token']) check(`shared Auth rejects ${reason} with checkRevoked=true`, async t => {
  const f = fixture(t);
  const res = await f.invoke(increment(), { runtime: { verifyIdToken: async (_, revoked) => {
    assert.equal(revoked, true); throw new Error(`${reason} sensitive-token`);
  } } });
  rejected(res, 401); assert.doesNotMatch(JSON.stringify(res.body), /sensitive|revoked/);
  assert.equal(f.attempts.length, 0); assert.equal(f.writes.length, 0);
});
for (const header of [undefined, '', '   ']) check(`App Check missing ${JSON.stringify(header)} blocks`, async t => {
  const f = fixture(t); rejected(await f.invoke(increment(), { headers: { 'x-firebase-appcheck': header } }), 401, 'APP_CHECK_REQUIRED');
  assert.equal(f.attempts.length, 0); assert.equal(f.writes.length, 0);
});
check('invalid App Check blocks before Auth and no internal errors leak', async t => {
  const f = fixture(t);
  const res = await f.invoke(increment(), { runtime: { verifyAppCheckToken: async () => { throw new Error('app-check secret'); } } });
  rejected(res, 401, 'APP_CHECK_INVALID'); assert.doesNotMatch(JSON.stringify(res.body), /secret/);
  assert.equal(f.checks.length, 0); assert.equal(f.attempts.length, 0);
});
for (const unavailable of [false, true]) check(`shared rate limiter ${unavailable ? 'unavailable' : 'denies'} blocks transactions`, async t => {
  const f = fixture(t);
  const res = await f.invoke(increment(), { runtime: { checkRateLimit: async params => {
    assert.equal(params.uid, UID); assert.equal(params.limit, 30);
    if (unavailable) throw new Error('redis secret'); return false;
  } } });
  rejected(res, unavailable ? 503 : 429); assert.doesNotMatch(JSON.stringify(res.body), /redis|secret/);
  assert.equal(f.attempts.length, 0); assert.equal(f.writes.length, 0);
});
check('existing 512 KiB body guard blocks before verification', async t => {
  const f = fixture(t);
  rejected(await f.invoke(increment(), { headers: { 'content-length': String(512 * 1024 + 1) } }), 413);
  assert.equal(f.checks.length, 0); assert.equal(f.attempts.length, 0);
});
check('disabled protocol preserves real limiter bookkeeping but never writes user data', async t => {
  const f = fixture(t); const before = [...f.docs];
  // Exercise the existing rate limiter against the SAME MVCC fake, no service.
  rejected(await f.invoke(increment(), { disabled: true, runtime: { checkRateLimit: undefined } }), 503, 'WATER_V2_DISABLED');
  assert.equal(f.writes.length, 1); assert.match(f.writes[0].path, /^server_rate_limits\/sync_/);
  assert.deepEqual([...f.docs].filter(([path]) => !path.startsWith('server_rate_limits/')), before);
});
check('HTTP method and missing Auth retain existing contracts', async t => {
  const f = fixture(t); rejected(await f.invoke(increment(), { method: 'GET' }), 405);
  const options = await f.invoke(increment(), { method: 'OPTIONS' }); assert.equal(options.statusCode, 204);
  rejected(await f.invoke(increment(), { headers: { authorization: undefined } }), 401);
  assert.equal(f.attempts.length, 0);
});
check('different verified UID cannot replay or reconcile another account UUID', async t => {
  const f = fixture(t); await f.invoke();
  const other = 'other-owner';
  f.put(`users/${other}`, {});
  f.put(`users/${other}/water_protocol/activation`, f.docs.get(ACTIVATION));
  f.put(`users/${other}/water_state/${DAY}`, { protocolVersion: 2, epoch: EPOCH, waterIntakeMl: 0, revision: 0 });
  f.put(`users/${other}/health_info/${DAY}`, { waterIntakeMl: 0 });
  const runtime = { verifyIdToken: async (_, revoked) => { assert.equal(revoked, true); return { uid: other }; },
    checkRateLimit: async params => { assert.equal(params.uid, other); return true; } };
  const result = success(await f.invoke(reconcile([A]), { runtime })); assert.deepEqual(result.recognized, []);
  assert.equal(success(await f.invoke(increment(A), { runtime })).waterIntakeMl, 250);
  assert.equal(f.total(), 1250); assert.equal(f.docs.has(`users/${other}/water_increment_receipts/${A}`), true);
});
for (const uid of [undefined, '', '../victim', 'victim/water_state/2026-08-21', '.', '__reserved__']) {
  check(`malformed verified UID cannot become a cross-account path: ${JSON.stringify(uid)}`, async t => {
    const f = fixture(t);
    rejected(await f.invoke(increment(), { runtime: { verifyIdToken: async () => ({ uid }), checkRateLimit: async () => true } }), 404, 'WATER_USER_NOT_FOUND');
    assert.equal(f.attempts.length, 0); assert.equal(f.writes.length, 0);
  });
}
check('V1 create/replay keeps its existing response, writes and quota with V2 disabled', async t => {
  const f = fixture(t); const body = { operation: 'create_task', taskId: 'task1', title: 'Task', priority: 'high', date: `${DAY}T10:00:00.000Z` };
  const waterBefore = [f.docs.get(STATE), f.docs.get(PROJECTION), f.docs.get(ACTIVATION)];
  assert.deepEqual(success(await f.invoke(body, { disabled: true })), { success: true, operation: 'create_task' });
  assert.equal(f.docs.get(USER).tasksCount, 1); assert.equal(f.writes.length, 2);
  success(await f.invoke(body, { disabled: true })); assert.equal(f.docs.get(USER).tasksCount, 1); assert.equal(f.writes.length, 2);
  assert.deepEqual([f.docs.get(STATE), f.docs.get(PROJECTION), f.docs.get(ACTIVATION)], waterBefore);
});
