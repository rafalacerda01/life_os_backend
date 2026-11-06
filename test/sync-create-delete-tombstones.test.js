import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import deletionControl from '../api/account/_deletion_control.cjs';

if (!getApps().length) initializeApp({ projectId: 'sync-tombstones-test' });
const { syncHandler } = await import('../api/sync.js');
const firestore = getFirestore();
const requestContext = new AsyncLocalStorage();
const UID = 'tombstone-user';
const USER = `users/${UID}`;
const GUARD = `account_deletion_guards/${UID}`;
const RETIRED = `retired_auth_identities/${UID}`;
const RECEIPT = `${GUARD}/control/operation`;
const DELETION_ID = '12345678-1234-4234-8234-123456789abc';
const ID = 'entity-1';
const DATE = '2026-01-01T12:00:00.000Z';
const operations = [
  { entity: 'task', collection: 'tasks', counter: 'tasksCount', idField: 'taskId',
    payload: { title: 'Task', priority: 'high', date: DATE } },
  { entity: 'habit', collection: 'habits', counter: 'habitsCount', idField: 'habitId',
    payload: { title: 'Habit', completedDates: [] } },
  { entity: 'goal', collection: 'goals', counter: 'goalsCount', idField: 'goalId',
    payload: { title: 'Goal', period: 'MENSAL', targetValue: 5, createdAt: DATE } },
  { entity: 'subject', collection: 'subjects', counter: 'subjectsCount', idField: 'subjectId',
    payload: { title: 'Subject', hasExam: false, examDate: null } },
  { entity: 'medication', collection: 'medications', counter: 'medicationsCount', idField: 'medicationId',
    payload: { name: 'Medication', startDate: DATE, durationDays: null, endDate: null } },
  { entity: 'transaction', collection: 'transactions', counter: 'transactionsCount', idField: 'transactionId',
    payload: { title: 'Transaction', amount: 10, type: 'expense', category: 'Outros', date: DATE } },
];

function collection(path) {
  return {
    doc: id => document(`${path}/${id}`),
    where: (field, operator, value) => {
      assert.ok(['==', '>'].includes(operator));
      return { path, query: true, field, operator, value,
        limit(size) { return { ...this, limitCount: size }; } };
    },
  };
}
function document(path) {
  return { path, collection: name => collection(`${path}/${name}`) };
}
function gate() {
  const reached = Promise.withResolvers();
  const released = Promise.withResolvers();
  return { reached: reached.promise, release: released.resolve,
    async hold() { reached.resolve(); await released.promise; } };
}

// Optimistic MVCC model: each attempt has a stable snapshot, tracks document
// versions (including missing documents) and query revisions, buffers writes,
// and retries the real callback after a conflict. It also rejects reads after
// writes. Controlled hooks model in-flight requests without timers or sleeps.
function fixture(t, config, count = 0) {
  const docs = new Map([[USER, { [config.counter]: count }]]);
  const versions = new Map();
  const collectionVersions = new Map();
  const writes = [];
  const attempts = [];
  const conflicts = [];
  const commits = [];
  const identities = [];
  const hooks = {};
  // Synthetic storage costs are test metadata, never fields read by production.
  // Deletes charge the snapshot's document AND affected index entries; other
  // writes charge their payload plus a fixed envelope. Enforce before commit.
  const storageBytes = new Map();
  const rejectedSizes = [];
  const target = `${USER}/${config.collection}/${ID}`;
  const marker = `${USER}/sync_tombstones/${config.collection}__${ID}`;
  const snapshot = (path, state) => ({
    exists: state.has(path), data: () => state.get(path), ref: document(path),
  });

  t.mock.method(firestore, 'collection', collection);
  t.mock.method(firestore, 'runTransaction', async callback => {
    const label = requestContext.getStore();
    for (let attempt = 1; attempt <= 10; attempt++) {
      await hooks.beforeAttempt?.({ label, attempt });
      const state = new Map(docs);
      const startVersions = new Map(versions);
      const startCollectionVersions = new Map(collectionVersions);
      const startStorageBytes = new Map(storageBytes);
      const reads = new Map();
      const queryReads = new Map();
      const pending = [];
      const attemptRecord = { label, attempt, testName: t.name, reads, queryReads, querySnapshots: [], pending, io: [], applied: false };
      attempts.push(attemptRecord);
      const result = await callback({
        async get(ref) {
          assert.equal(pending.length, 0, 'Firestore requires all reads before writes');
          attemptRecord.io.push({ type: 'read', path: ref.path });
          let value;
          if (ref.query) {
            queryReads.set(ref.path, startCollectionVersions.get(ref.path) ?? 0);
            const matches = [...state.keys()].filter(path =>
              path.slice(0, path.lastIndexOf('/')) === ref.path &&
              (ref.operator === '>' ? state.get(path)[ref.field] > ref.value : state.get(path)[ref.field] === ref.value));
            const selected = matches.slice(0, ref.limitCount ?? Infinity);
            value = { size: selected.length, docs: selected.map(path => snapshot(path, state)) };
            attemptRecord.querySnapshots.push({ ref, snapshot: value });
          } else {
            reads.set(ref.path, startVersions.get(ref.path) ?? 0);
            value = snapshot(ref.path, state);
          }
          await hooks.afterRead?.({ label, attempt, ref, snapshot: value });
          return value;
        },
        create: (ref, data) => { attemptRecord.io.push({ type: 'write', path: ref.path }); pending.push({ type: 'create', path: ref.path, data }); },
        set: (ref, data, options) => { attemptRecord.io.push({ type: 'write', path: ref.path }); pending.push({ type: 'set', path: ref.path, data, options }); },
        update: (ref, data) => { attemptRecord.io.push({ type: 'write', path: ref.path }); pending.push({ type: 'update', path: ref.path, data }); },
        delete: ref => { attemptRecord.io.push({ type: 'write', path: ref.path }); pending.push({ type: 'delete', path: ref.path }); },
      });
      await hooks.beforeCommit?.({ label, attempt, record: attemptRecord });
      const changed = [...reads].filter(([path, version]) => (versions.get(path) ?? 0) !== version)
        .map(([path]) => path);
      changed.push(...[...queryReads].filter(([path, version]) =>
        (collectionVersions.get(path) ?? 0) !== version).map(([path]) => path));
      if (changed.length) {
        conflicts.push({ label, attempt, paths: changed });
        continue;
      }
      // Conservative legacy write budget; Firestore removed the 500-write cap.
      assert.ok(pending.length <= (queryReads.size ? 201 : 500), 'bounded transaction write budget');
      const transactionBytes = pending.reduce((total, write) => {
        const cost = startStorageBytes.get(write.path);
        return total + 128 + (write.type === 'delete'
          ? (cost?.documentBytes ?? Buffer.byteLength(JSON.stringify(state.get(write.path) ?? {}))) +
            (cost?.indexBytes ?? 0)
          : Buffer.byteLength(JSON.stringify(write.data)));
      }, 1024);
      attemptRecord.transactionBytes = transactionBytes;
      if (transactionBytes > 10 * 1024 * 1024) {
        rejectedSizes.push(attemptRecord);
        await hooks.afterSizeRejection?.(attemptRecord);
        throw Object.assign(new Error('3 INVALID_ARGUMENT: Transaction too big. Decrease transaction size.'), {
          code: 3, details: 'Transaction too big. Decrease transaction size.',
        });
      }
      // Validate preconditions before applying any write, including R5 creates.
      for (const write of pending) {
        if (write.type === 'create') assert.equal(docs.has(write.path), false, 'create cannot overwrite');
        if (write.type === 'update') assert.equal(docs.has(write.path), true, 'update cannot recreate');
      }
      // No await during commit: all writes become visible atomically.
      for (const write of pending) {
        writes.push(write);
        if (write.type === 'delete') docs.delete(write.path);
        else {
          if (write.type === 'update') assert.ok(docs.has(write.path));
          const data = Object.fromEntries(Object.entries(write.data).map(([key, value]) =>
            [key, value?.constructor?.name === 'ServerTimestampTransform' ? (write.path.includes('/study_card_create_receipts/') ? Timestamp.fromDate(new Date(DATE)) : new Date(DATE)) : value]));
          docs.set(write.path, write.type === 'update' || write.options?.merge
            ? { ...docs.get(write.path), ...data } : data);
        }
        versions.set(write.path, (versions.get(write.path) ?? 0) + 1);
        const parent = write.path.slice(0, write.path.lastIndexOf('/'));
        collectionVersions.set(parent, (collectionVersions.get(parent) ?? 0) + 1);
      }
      attemptRecord.applied = true;
      commits.push(attemptRecord);
      attemptRecord.result = result;
      await hooks.afterCommit?.(attemptRecord);
      return result;
    }
    throw new Error('Exceeded conflict retry limit');
  });

  function put(path, data) {
    if (data === undefined) docs.delete(path);
    else docs.set(path, data);
    versions.set(path, (versions.get(path) ?? 0) + 1);
  }
  async function invoke(action = 'create', label = action, body = {}, { exactBody = false, uid = UID } = {}) {
    const res = { statusCode: 200, setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; } };
    await requestContext.run(label, () => syncHandler({
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'x-firebase-appcheck': 'test-app-check' },
      body: exactBody ? body : { operation: `${action}_${config.entity}`, [config.idField]: ID,
        ...(action === 'create' ? config.payload : {}), ...body },
    }, res, {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async (_, checkRevoked) => {
        assert.equal(checkRevoked, true);
        identities.push({ label, uid });
        return { uid };
      },
      checkRateLimit: async parameters => {
        assert.equal(parameters.uid, uid);
        return true;
      },
    }));
    return res;
  }
  const db = { projectId: firestore.projectId, databaseId: '(default)', doc: document, collection,
    runTransaction: callback => firestore.runTransaction(callback) };
  return { db, docs, writes, attempts, conflicts, commits, identities, hooks, storageBytes, rejectedSizes, target, marker, invoke, put,
    count: () => docs.get(USER)[config.counter] };
}

function success(response, config, action) {
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { success: true, operation: `${action}_${config.entity}` });
}
function deleted(f, config, count = 0) {
  assert.equal(f.docs.has(f.target), false);
  assert.equal(f.count(), count);
  const marker = f.docs.get(f.marker);
  assert.deepEqual(Object.keys(marker).sort(), ['deletedAt', 'entityId', 'entityType', 'schemaVersion']);
  assert.equal(marker.entityType, config.collection);
  assert.equal(marker.entityId, ID);
  assert.equal(marker.schemaVersion, 1);
  assert.ok(marker.deletedAt instanceof Date);
}

function deletionGuard(overrides = {}) {
  return { version: 1, state: 'IN_PROGRESS',
    deletionId: '12345678-1234-4234-8234-123456789abc',
    startedAt: Timestamp.fromMillis(1), retainUntil: null, ...overrides };
}
function assertDeletionBlocked(response) {
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { code: 'ACCOUNT_DELETION_BLOCKED',
    error: 'Conta indisponível para sincronização.' });
  assert.notEqual(response.body.success, true, 'a rejected operation never emits a success ACK');
}

function retiredRecord(overrides = {}) {
  return { version: 1, state: 'RESERVED',
    deletionId: '12345678-1234-4234-8234-123456789abc',
    authCreatedAtMs: 1, ...overrides };
}

for (const config of operations) {
  test(`${config.entity}: retired UID blocks create and delete without modifying any document`, async t => {
    const f = fixture(t, config, 1);
    f.put(f.target, config.payload);
    f.put(RETIRED, retiredRecord());
    const before = new Map(f.docs);
    assertDeletionBlocked(await f.invoke());
    assertDeletionBlocked(await f.invoke('delete'));
    assert.deepEqual(f.docs, before);
    assert.equal(f.docs.has(GUARD), false, 'sync never bootstraps a deletion guard');
    assert.equal(f.writes.length, 0);
  });
}

for (const action of ['create', 'delete']) {
  test(`retired UID: marker created before ${action} commit causes conflict then retry refuses all writes`, async t => {
    const f = fixture(t, operations[0], action === 'delete' ? 1 : 0);
    if (action === 'delete') f.put(f.target, operations[0].payload);
    const before = new Map(f.docs);
    f.hooks.beforeCommit = ({ attempt }) => {
      if (attempt === 1) f.put(RETIRED, retiredRecord());
    };
    assertDeletionBlocked(await f.invoke(action));
    assert.deepEqual(f.conflicts, [{ label: action, attempt: 1, paths: [RETIRED] }]);
    assert.equal(f.attempts.length, 2);
    assert.equal(f.attempts[0].reads.get(RETIRED), 0, 'absence is part of the first read set');
    assert.equal(f.attempts[1].reads.get(RETIRED), 1, 'retry reads the newly committed marker');
    assert.equal(f.attempts[1].pending.length, 0);
    before.set(RETIRED, retiredRecord());
    assert.deepEqual(f.docs, before);
    assert.equal(f.writes.length, 0);
  });
}

for (const [label, record] of [
  ['V1', retiredRecord()],
  ...['PRE_AUTH', 'AUTH_EVENT', 'LEGACY_REVIEW'].map(origin =>
    [`V2 ${origin}`, { version: 2, state: 'RESERVED',
      deletionId: '12345678-1234-4234-8234-123456789abc', origin }]),
  ['empty document', {}],
  ['unknown version/state', { version: 99, state: 'UNKNOWN' }],
  ['expired-looking data', { state: 'COMPLETE', retainUntil: Timestamp.fromMillis(2) }],
]) {
  test(`retired UID: presence of ${label} blocks without reading record data`, async t => {
    const f = fixture(t, operations[0]);
    f.put(RETIRED, record);
    f.hooks.afterRead = ({ ref, snapshot }) => {
      if (ref.path === RETIRED) snapshot.data = () => { throw new Error('record data must not grant authority'); };
    };
    assertDeletionBlocked(await f.invoke());
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.docs.get(RETIRED), record);
  });
}

test('retired UID: expired COMPLETE cannot override a durable marker', async t => {
  const f = fixture(t, operations[0]);
  f.put(GUARD, deletionGuard({ state: 'COMPLETE', retainUntil: Timestamp.fromMillis(2) }));
  f.put(RETIRED, retiredRecord());
  const before = new Map(f.docs);
  assertDeletionBlocked(await f.invoke());
  assert.deepEqual(f.docs, before);
  assert.equal(f.writes.length, 0);
});

test('retired UID: passage of time and offline replays never clear the marker or acknowledge the payload', async t => {
  const f = fixture(t, operations[0]);
  f.put(RETIRED, retiredRecord());
  const payload = { operation: 'create_task', taskId: ID, ...operations[0].payload };
  const before = structuredClone(payload);
  assertDeletionBlocked(await f.invoke('create', 'offline-first', payload, { exactBody: true }));
  t.mock.method(Date, 'now', () => 8_000_000_000_000);
  assertDeletionBlocked(await f.invoke('create', 'offline-later', payload, { exactBody: true }));
  assert.deepEqual(payload, before);
  assert.deepEqual(f.docs.get(RETIRED), retiredRecord());
  assert.equal(f.writes.length, 0);
});

test('retired UID: marker read failure is retryable and sanitized without writes', async t => {
  const f = fixture(t, operations[0]);
  const logs = [];
  t.mock.method(console, 'error', (...values) => logs.push(values.join(' ')));
  f.hooks.afterRead = ({ ref }) => {
    if (ref.path === RETIRED) throw new Error('PRIVATE-RETIRED-READ-ERROR');
  };
  const response = await f.invoke();
  assert.ok(response.statusCode >= 500);
  assert.notEqual(response.body.success, true);
  assert.equal(f.writes.length, 0);
  assert.doesNotMatch(JSON.stringify({ response, logs }), /PRIVATE-RETIRED-READ-ERROR/);
});

test('retired UID: another UID marker does not block sync or get modified', async t => {
  const f = fixture(t, operations[0]);
  const other = 'retired_auth_identities/other-user';
  f.put(other, retiredRecord());
  success(await f.invoke(), operations[0], 'create');
  assert.deepEqual(f.docs.get(other), retiredRecord());
  assert.equal(f.docs.has(RETIRED), false, 'normal sync never creates a reservation');
  assert.ok(f.writes.every(write => write.path.startsWith(`${USER}/`) || write.path === USER));
});

for (const config of operations) {
  test(`${config.entity}: deletion guard blocks create and delete without writes`, async t => {
    const f = fixture(t, config, 1);
    f.put(f.target, config.payload);
    f.put(GUARD, deletionGuard());
    const before = new Map(f.docs);
    assertDeletionBlocked(await f.invoke());
    assertDeletionBlocked(await f.invoke('delete'));
    assert.deepEqual(f.docs, before);
    assert.equal(f.writes.length, 0);
  });

  test(`${config.entity}: guard created before commit invalidates the transaction and retry blocks`, async t => {
    const f = fixture(t, config);
    f.hooks.beforeCommit = ({ attempt }) => {
      if (attempt === 1) f.put(GUARD, deletionGuard());
    };
    assertDeletionBlocked(await f.invoke());
    assert.ok(f.conflicts.some(conflict => conflict.paths.includes(GUARD)));
    assert.equal(f.writes.length, 0);
    assert.equal(f.docs.has(f.target), false);
    assert.equal(f.count(), 0);
  });
}

test('deletion guard: offline replay remains retryable and the identical request succeeds after unblocking', async t => {
  const config = operations[0];
  const f = fixture(t, config);
  const pendingPayload = { operation: 'create_task', taskId: ID, ...config.payload };
  const originalPayload = structuredClone(pendingPayload);
  f.put(GUARD, deletionGuard());
  for (let attempt = 0; attempt < 2; attempt++) {
    assertDeletionBlocked(await f.invoke('create', 'offline', pendingPayload, { exactBody: true }));
  }
  assert.deepEqual(pendingPayload, originalPayload);
  assert.equal(f.writes.length, 0);
  // Synthetic state transition only; the endpoint never removes a guard.
  f.put(GUARD, undefined);
  success(await f.invoke('create', 'replay', pendingPayload, { exactBody: true }), config, 'create');
  success(await f.invoke('create', 'replay-again', pendingPayload, { exactBody: true }), config, 'create');
  assert.equal(f.count(), 1);
  assert.equal(f.writes.length, 2);
});

for (const [label, guard] of [
  ['COMPLETE retained', deletionGuard({ state: 'COMPLETE', retainUntil: Timestamp.fromMillis(8_000_000_000_000) })],
  ['malformed COMPLETE null', deletionGuard({ state: 'COMPLETE' })],
  ['legacy malformed record', { state: 'IN_PROGRESS' }],
  ['unknown version', deletionGuard({ version: 2 })],
  ['unexpected field', deletionGuard({ privateDetail: 'PRIVATE-GUARD-CONTENT' })],
]) {
  test(`deletion guard: ${label} fails closed without exposing contents`, async t => {
    const f = fixture(t, operations[0]);
    f.put(GUARD, guard);
    const logs = [];
    t.mock.method(console, 'error', (...values) => logs.push(values.join(' ')));
    assertDeletionBlocked(await f.invoke());
    assert.equal(f.writes.length, 0);
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE-GUARD-CONTENT|12345678-1234/);
    assert.deepEqual(f.docs.get(GUARD), guard);
  });
}

// Historical title retained; R5 supersedes its former permission expectation.
test('deletion guard: expired valid COMPLETE preserves normal sync and its metadata', async t => {
  const f = fixture(t, operations[0], 1);
  const guard = deletionGuard({ state: 'COMPLETE', retainUntil: Timestamp.fromMillis(2) });
  f.put(GUARD, guard);
  f.put(f.target, operations[0].payload);
  f.put(f.marker, { entityType: 'tasks', entityId: ID, schemaVersion: 1, deletedAt: new Date(DATE) });
  const before = new Map(f.docs);
  assertDeletionBlocked(await f.invoke());
  assertDeletionBlocked(await f.invoke('delete'));
  assert.deepEqual(f.docs.get(GUARD), guard);
  assert.ok(f.writes.every(write => write.path !== GUARD));
  assert.deepEqual(f.docs, before, 'private data, tombstone and every control remain unchanged');
  assert.equal(f.writes.length, 0);
  assert.equal(f.docs.has(RETIRED), false, 'no reservation or deletionId is fabricated');
  assert.equal(f.docs.has(RECEIPT), false, 'no receipt is fabricated');
  assert.equal(f.attempts.length, 2);
  for (const attempt of f.attempts) {
    assert.deepEqual([...attempt.reads.keys()], [GUARD]);
    assert.equal(attempt.pending.length, 0);
    assert.equal(attempt.applied, false);
  }
  t.diagnostic(JSON.stringify({historicalEvidence: 'expired-complete-denied', actions: 2,
    reads: f.attempts.map(a => [...a.reads.keys()]), writes: f.writes.length, controlsUnchanged: true}));
});

// Scenario A: retain the original hook; the expired guard denies before it.
test('deletion guard: expired COMPLETE changed to active before commit blocks the retry', async t => {
  const f = fixture(t, operations[0]);
  f.put(GUARD, deletionGuard({ state: 'COMPLETE', retainUntil: Timestamp.fromMillis(2) }));
  const before = new Map(f.docs);
  let hookReached = 0;
  f.hooks.beforeCommit = ({ attempt }) => {
    hookReached++;
    if (attempt === 1) f.put(GUARD, deletionGuard());
  };
  assertDeletionBlocked(await f.invoke());
  assert.equal(hookReached, 0, 'R5 refuses before the former injection point');
  assert.equal(f.conflicts.length, 0, 'no commit attempt is reached for an already retired account');
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.docs, before);
  assert.equal(f.attempts.length, 1);
  assert.deepEqual([...f.attempts[0].reads.keys()], [GUARD]);
  assert.equal(f.attempts[0].pending.length, 0);
  assert.equal(f.attempts[0].applied, false);
  t.diagnostic(JSON.stringify({historicalEvidence: 'original-hook-preserved', hookReached,
    attempts: f.attempts.length, writes: f.writes.length, conflicts: f.conflicts.length}));
});

test('deletion guard: read failure is sanitized, retryable and never confirms writes', async t => {
  const f = fixture(t, operations[0]);
  const logs = [];
  t.mock.method(console, 'error', (...values) => logs.push(values.join(' ')));
  f.hooks.afterRead = ({ ref }) => {
    if (ref.path === GUARD) throw new Error('PRIVATE-FIRESTORE-ERROR');
  };
  const response = await f.invoke();
  assert.ok(response.statusCode >= 500);
  assert.notEqual(response.body.success, true);
  assert.equal(f.writes.length, 0);
  assert.doesNotMatch(JSON.stringify({ response, logs }), /PRIVATE-FIRESTORE-ERROR/);
});

test('deletion guard: another UID does not block this user or change its guard', async t => {
  const f = fixture(t, operations[0]);
  const otherGuard = 'account_deletion_guards/other-user';
  f.put(otherGuard, deletionGuard());
  success(await f.invoke(), operations[0], 'create');
  assert.deepEqual(f.docs.get(otherGuard), deletionGuard());
  assert.ok(f.writes.every(write => write.path.startsWith(`${USER}/`) || write.path === USER));
});

const delegatedPayloads = [
  { operation: 'update_task', taskId: ID, isCompleted: true },
  { operation: 'update_habit', habitId: ID, completedDates: [] },
  { operation: 'update_habit_completion', habitId: ID, completedDates: [],
    competitiveCompletionId: '12345678-1234-4234-8234-123456789abc' },
  { operation: 'apply_study_activity', mutationId: '12345678-1234-4234-8234-123456789abc',
    subjectId: null, progressDelta: 0.1, occurredAt: DATE, timeZoneOffsetMinutes: 0 },
  { operation: 'apply_study_progress_reset', mutationId: '12345678-1234-4234-8234-123456789abc', occurredAt: DATE },
  { operation: 'apply_study_review', cardId: ID, subjectId: ID, occurredAt: DATE, timeZoneOffsetMinutes: 0 },
];
for (const body of delegatedPayloads) {
  test(`retired UID: delegated ${body.operation} refuses without writes or success`, async t => {
    const f = fixture(t, operations[0]);
    f.put(RETIRED, retiredRecord());
    const before = new Map(f.docs);
    assertDeletionBlocked(await f.invoke('create', body.operation, body, { exactBody: true }));
    assert.ok(f.attempts[0].reads.has(RETIRED));
    assert.deepEqual(f.docs, before);
    assert.equal(f.writes.length, 0);
  });

  test(`deletion guard: delegated ${body.operation} uses the transactional barrier`, async t => {
    const f = fixture(t, operations[0]);
    f.put(GUARD, deletionGuard());
    assertDeletionBlocked(await f.invoke('create', body.operation, body, { exactBody: true }));
    assert.equal(f.writes.length, 0);
    assert.ok(f.attempts[0].reads.has(GUARD));
  });
}

for (const operation of ['update_habit', 'apply_study_progress_reset']) {
  test(`retired UID: delegated ${operation} revalidates concurrent reservation on retry`, async t => {
    const f = fixture(t, operations[0]);
    f.put(`${USER}/habits/${ID}`, { title: 'Habit', completedDates: [] });
    const before = new Map(f.docs);
    f.hooks.beforeCommit = ({ attempt }) => {
      if (attempt === 1) f.put(RETIRED, retiredRecord());
    };
    const body = delegatedPayloads.find(payload => payload.operation === operation);
    assertDeletionBlocked(await f.invoke('create', operation, body, { exactBody: true }));
    assert.equal(f.conflicts.length, 1);
    assert.deepEqual(f.conflicts[0].paths, [RETIRED]);
    before.set(RETIRED, retiredRecord());
    assert.deepEqual(f.docs, before);
    assert.equal(f.writes.length, 0);
  });

  for (const activateDuringCommit of [false, true]) {
    test(`deletion guard: delegated ${operation}, normal/racing commit (race=${activateDuringCommit})`, async t => {
      const f = fixture(t, operations[0]);
      f.put(`${USER}/habits/${ID}`, { title: 'Habit', completedDates: [] });
      const before = new Map(f.docs);
      if (activateDuringCommit) f.hooks.beforeCommit = ({ attempt }) => {
        if (attempt === 1) f.put(GUARD, deletionGuard());
      };
      const body = delegatedPayloads.find(payload => payload.operation === operation);
      const response = await f.invoke('create', operation, body, { exactBody: true });
      if (activateDuringCommit) {
        assertDeletionBlocked(response);
        assert.ok(f.conflicts.some(conflict => conflict.paths.includes(GUARD)));
        assert.equal(f.writes.length, 0);
        before.set(GUARD, deletionGuard());
        assert.deepEqual(f.docs, before);
      } else {
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.success, true);
        assert.equal(f.writes.length, operation === 'update_habit' ? 1 : 3);
      }
    });
  }
}

for (const active of [false, true]) {
  test(`deletion guard: missing root is never recreated (active=${active})`, async t => {
    const f = fixture(t, operations[0]);
    f.put(USER, undefined);
    if (active) f.put(GUARD, deletionGuard());
    const response = await f.invoke();
    if (active) assertDeletionBlocked(response);
    else assert.equal(response.statusCode, 404);
    assert.equal(f.docs.has(USER), false);
    assert.equal(f.writes.length, 0);
  });
}

for (const config of operations) {
  const check = (name, fn) => test(`${config.entity}: ${name}`, { timeout: 5000 }, fn);

  check('normal create increments once and reads the marker within the transaction', async t => {
    const f = fixture(t, config);
    success(await f.invoke(), config, 'create');
    assert.equal(f.docs.has(f.target), true);
    assert.equal(f.count(), 1);
    assert.equal(f.docs.has(f.marker), false);
    assert.deepEqual([...f.attempts[0].reads.keys()], [GUARD, RETIRED, RECEIPT, `trusted_account_origins/${UID}`, USER, f.target, f.marker]);
    assertControlReadsBeforeWrites(f.attempts[0]);
    assert.equal(f.writes.length, 2);
  });

  check('repeated create does not increment again', async t => {
    const f = fixture(t, config);
    success(await f.invoke(), config, 'create');
    const entity = f.docs.get(f.target);
    success(await f.invoke(), config, 'create');
    assert.deepEqual(f.docs.get(f.target), entity);
    assert.equal(f.count(), 1);
    assert.equal(f.writes.length, 2);
  });

  check('normal delete removes the entity, decrements once and commits the marker', async t => {
    const f = fixture(t, config);
    await f.invoke();
    success(await f.invoke('delete'), config, 'delete');
    deleted(f, config);
    const pending = f.attempts.find(attempt => attempt.pending.some(write =>
      write.path === f.target && write.type === 'delete')).pending;
    assert.ok(pending.some(write => write.path === f.marker && write.type === 'set'));
    assert.ok(pending.some(write => write.path === f.target && write.type === 'delete'));
    assert.ok(pending.some(write => write.path === USER && write.type === 'update'));
  });

  check('delete retry preserves the original marker without another decrement or write', async t => {
    const f = fixture(t, config);
    await f.invoke();
    await f.invoke('delete');
    const marker = f.docs.get(f.marker);
    const committed = f.writes.length;
    success(await f.invoke('delete'), config, 'delete');
    deleted(f, config);
    assert.deepEqual(f.docs.get(f.marker), marker);
    assert.equal(f.writes.length, committed);
  });

  check('delete of never-created identity writes only the marker and preserves the counter', async t => {
    const f = fixture(t, config, 2);
    success(await f.invoke('delete'), config, 'delete');
    deleted(f, config, 2);
    assert.deepEqual(f.writes.map(write => write.path), [f.marker]);
  });

  check('create after deletion returns logical success even at quota, without any writes', async t => {
    const f = fixture(t, config, 3);
    await f.invoke('delete');
    success(await f.invoke(), config, 'create');
    deleted(f, config, 3);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.attempts.at(-1).result, { skippedAsDeleted: true });
  });

  check('late C1 after client timeout, successful C2 and delete cannot resurrect', async t => {
    const f = fixture(t, config);
    const stalled = gate();
    t.after(stalled.release);
    f.hooks.beforeAttempt = async ({ label, attempt }) => {
      if (label === 'C1' && attempt === 1) await stalled.hold();
    };
    const c1 = f.invoke('create', 'C1');
    await stalled.reached;
    // The client abandons waiting; C1 continues on the server. No cancellation.
    success(await f.invoke('create', 'C2'), config, 'create');
    assert.equal(f.count(), 1);
    success(await f.invoke('delete'), config, 'delete');
    deleted(f, config);
    const committed = f.writes.length;
    stalled.release();
    success(await c1, config, 'create');
    deleted(f, config);
    assert.equal(f.writes.length, committed);
    assert.deepEqual(f.attempts.at(-1).result, { skippedAsDeleted: true });
  });

  check('marker-only concurrent delete forces stale create to conflict and retry', async t => {
    const f = fixture(t, config);
    const stale = gate();
    t.after(stale.release);
    f.hooks.afterRead = async ({ label, attempt, ref, snapshot }) => {
      if (label === 'C1' && attempt === 1 && ref.path === f.marker) {
        assert.equal(snapshot.exists, false);
        await stale.hold();
      }
    };
    const c1 = f.invoke('create', 'C1');
    await stale.reached;
    success(await f.invoke('delete'), config, 'delete');
    deleted(f, config);
    stale.release();
    success(await c1, config, 'create');
    deleted(f, config);
    assert.deepEqual(f.conflicts, [{ label: 'C1', attempt: 1, paths: [f.marker] }]);
    assert.equal(f.attempts.filter(attempt => attempt.label === 'C1').length, 2);
    assert.deepEqual(f.attempts.at(-1).result, { skippedAsDeleted: true });
    assert.deepEqual(f.writes.map(write => write.path), [f.marker]);
  });

  check('create committing before a stale delete forces delete retry and leaves absent', async t => {
    const f = fixture(t, config);
    const stale = gate();
    t.after(stale.release);
    f.hooks.beforeCommit = async ({ label, attempt }) => {
      if (label === 'D1' && attempt === 1) await stale.hold();
    };
    const d1 = f.invoke('delete', 'D1');
    await stale.reached;
    success(await f.invoke(), config, 'create');
    assert.equal(f.count(), 1);
    stale.release();
    success(await d1, config, 'delete');
    deleted(f, config);
    assert.equal(f.conflicts.length, 1);
    assert.equal(f.conflicts[0].label, 'D1');
  });

  check('existing entity with zero counter deletes without a negative counter', async t => {
    const f = fixture(t, config);
    f.docs.set(f.target, config.payload);
    success(await f.invoke('delete'), config, 'delete');
    deleted(f, config);
  });

  check('invalid existing counter aborts deletion and marker atomically', async t => {
    const f = fixture(t, config, -1);
    f.docs.set(f.target, config.payload);
    assert.equal((await f.invoke('delete')).statusCode, 412);
    assert.equal(f.docs.has(f.target), true);
    assert.equal(f.docs.has(f.marker), false);
    assert.equal(f.writes.length, 0);
  });

  check('missing user is rejected before treating a marker as success', async t => {
    const f = fixture(t, config);
    f.docs.delete(USER);
    f.docs.set(f.marker, { entityType: config.collection, entityId: ID });
    assert.equal((await f.invoke()).statusCode, 404);
    assert.equal((await f.invoke('delete')).statusCode, 404);
    assert.equal(f.writes.length, 0);
  });

  check('path traversal IDs are rejected before any transaction for create and delete', async t => {
    const f = fixture(t, config);
    for (const action of ['create', 'delete']) {
      assert.equal((await f.invoke(action, action, { [config.idField]: 'entity/other' })).statusCode, 400);
    }
    assert.equal(f.attempts.length, 0);
    assert.equal(f.writes.length, 0);
  });
}

test('authenticated UID owns the marker; payload UID is ignored', async t => {
  const config = operations[0];
  const f = fixture(t, config);
  success(await f.invoke('delete', 'delete', { userId: 'victim', uid: 'victim' }), config, 'delete');
  deleted(f, config);
  assert.deepEqual([...f.docs.keys()].sort(), [USER, f.marker].sort());
});

test('markers isolate entity type and identity', async t => {
  const config = operations[0];
  const f = fixture(t, config);
  f.docs.set(`${USER}/sync_tombstones/habits__${ID}`, { entityType: 'habits', entityId: ID });
  f.docs.set(`${USER}/sync_tombstones/tasks__other-id`, { entityType: 'tasks', entityId: 'other-id' });
  success(await f.invoke(), config, 'create');
  assert.equal(f.docs.has(f.target), true);
  assert.equal(f.count(), 1);
});

for (const [entity, notifications] of [
  ['habit', [ID, `habit_${ID}`]],
  ['medication', [`health_med_${ID}`]],
]) {
  test(`${entity}: existing auxiliary notification deletion is preserved`, async t => {
    const config = operations.find(config => config.entity === entity);
    const f = fixture(t, config);
    await f.invoke();
    for (const id of [...notifications, 'unrelated']) f.docs.set(`${USER}/notifications/${id}`, { title: id });
    await f.invoke('delete');
    for (const id of notifications) assert.equal(f.docs.has(`${USER}/notifications/${id}`), false);
    assert.equal(f.docs.has(`${USER}/notifications/unrelated`), true);
    deleted(f, config);
  });
}

// Subject deletion uses the same MVCC harness as the six-family tombstone tests.
const subjectConfig = operations.find(config => config.entity === 'subject');
const STUDY = `${USER}/study_info/main`;
const CARDS = `${USER}/review_queue`;
const CHUNK_SIZE = 200;

function subjectFixture(t, size, { subjectExists = true, markerExists = false,
  subjectsCount = 3, reviewQueue = size + 7 } = {}) {
  const f = fixture(t, subjectConfig, subjectsCount);
  if (subjectExists) f.docs.set(f.target, subjectConfig.payload);
  if (markerExists) f.docs.set(f.marker, { entityType: 'subjects', entityId: ID,
    deletedAt: new Date(DATE), schemaVersion: 1 });
  f.docs.set(STUDY, { reviewQueue, unrelated: 'preserved' });
  for (let i = 0; i < size; i++) f.docs.set(`${CARDS}/card-${i}`, { subjectId: ID });
  f.docs.set(`${CARDS}/other-subject-card`, { subjectId: 'other-subject' });
  f.remaining = () => [...f.docs.values()].filter(data => data.subjectId === ID).length;
  f.reviewQueue = () => f.docs.get(STUDY)?.reviewQueue;
  f.chunks = () => f.attempts.filter(attempt => attempt.queryReads.size && attempt.result?.deleted > 0);
  return f;
}

function assertSubjectCleanup(f, expectedSubjects = 2, expectedReviewQueue = 7, adaptive = false) {
  deleted(f, subjectConfig, expectedSubjects);
  assert.equal(f.remaining(), 0);
  assert.equal(f.reviewQueue(), expectedReviewQueue);
  assert.equal(f.docs.has(`${CARDS}/other-subject-card`), true);
  assert.equal(f.docs.get(STUDY).unrelated, 'preserved');
  const cardDeletes = f.writes.filter(write => write.type === 'delete' && write.path.startsWith(`${CARDS}/`));
  assert.equal(new Set(cardDeletes.map(write => write.path)).size, cardDeletes.length,
    'no card is deleted or counted twice');
  for (const attempt of f.attempts.filter(attempt => attempt.queryReads.size)) {
    assert.deepEqual([...attempt.reads.keys()], [GUARD, RETIRED, RECEIPT, `trusted_account_origins/${UID}`, USER, STUDY]);
    assertControlReadsBeforeWrites(attempt);
    const limit = attempt.querySnapshots[0].ref.limitCount;
    if (adaptive) assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= CHUNK_SIZE);
    else assert.equal(limit, CHUNK_SIZE);
    assert.ok(attempt.querySnapshots[0].snapshot.size <= CHUNK_SIZE);
    assert.ok(attempt.pending.length <= CHUNK_SIZE + 1);
    if (attempt.result?.deleted > 0) {
      assert.equal(attempt.pending.filter(write => write.type === 'delete').length, attempt.result.deleted);
      assert.equal(attempt.pending.filter(write => write.path === STUDY).length, 1);
    }
  }
}

for (const duringCommit of [false, true]) {
  test(`retired UID: subject cleanup chunk cannot write after reservation (duringCommit=${duringCommit})`, async t => {
    const f = subjectFixture(t, 1);
    if (duringCommit) {
      f.hooks.beforeCommit = ({ record }) => {
        if (record.queryReads.size) f.put(RETIRED, retiredRecord());
      };
    } else {
      f.hooks.afterCommit = record => {
        if (record.pending.some(write => write.path === f.target && write.type === 'delete')) {
          f.put(RETIRED, retiredRecord());
          f.put(STUDY, undefined);
        }
      };
    }
    assertDeletionBlocked(await f.invoke('delete'));
    assert.equal(f.remaining(), 1);
    assert.ok(f.writes.every(write => write.path !== STUDY));
    assert.deepEqual(f.docs.get(RETIRED), retiredRecord());
    if (duringCommit) assert.ok(f.conflicts.some(conflict => conflict.paths.includes(RETIRED)));
    else assert.equal(f.docs.has(STUDY), false);
  });
}

for (const removeRoot of [false, true]) {
  test(`subject chunks: account deletion between phases prevents study_info recreation (removeRoot=${removeRoot})`, async t => {
    const f = subjectFixture(t, 1);
    f.hooks.afterCommit = record => {
      if (record.pending.some(write => write.path === f.target && write.type === 'delete')) {
        f.put(GUARD, deletionGuard());
        if (removeRoot) f.put(USER, undefined);
        f.put(STUDY, undefined);
      }
    };
    assertDeletionBlocked(await f.invoke('delete'));
    assert.equal(f.docs.has(STUDY), false);
    assert.equal(f.remaining(), 1);
    assert.ok(f.writes.every(write => write.path !== STUDY));
  });
}

test('subject chunks: guard activation during a chunk conflicts before any card or study_info write', async t => {
  const f = subjectFixture(t, 1);
  f.hooks.beforeCommit = record => {
    if (record.record.queryReads.size) f.put(GUARD, deletionGuard());
  };
  assertDeletionBlocked(await f.invoke('delete'));
  assert.equal(f.remaining(), 1);
  assert.ok(f.conflicts.some(conflict => conflict.paths.includes(GUARD)));
  assert.ok(f.writes.every(write => write.path !== STUDY));
});

test('subject chunks: missing root after phase 1 cannot recreate study_info even without a guard', async t => {
  const f = subjectFixture(t, 1);
  f.hooks.afterCommit = record => {
    if (record.pending.some(write => write.path === f.target && write.type === 'delete')) {
      f.put(USER, undefined);
      f.put(STUDY, undefined);
    }
  };
  const response = await f.invoke('delete');
  assert.equal(response.statusCode, 404);
  assert.equal(f.docs.has(USER), false);
  assert.equal(f.docs.has(STUDY), false);
  assert.equal(f.remaining(), 1);
});

for (const size of [0, 1, CHUNK_SIZE, CHUNK_SIZE + 1, 450, 451, 1001]) {
  test(`subject chunks: ${size} cards succeed without a total-size rejection`, async t => {
    const f = subjectFixture(t, size);
    success(await f.invoke('delete'), subjectConfig, 'delete');
    assertSubjectCleanup(f);
    assert.equal(f.chunks().length, Math.ceil(size / CHUNK_SIZE));
    assert.equal(f.chunks().reduce((total, chunk) => total + chunk.result.deleted, 0), size);
    const seal = f.attempts[0];
    assert.deepEqual([...seal.reads.keys()], [GUARD, RETIRED, RECEIPT, `trusted_account_origins/${UID}`, USER, f.target, f.marker]);
    assertControlReadsBeforeWrites(seal);
    assert.equal(seal.queryReads.size, 0, 'phase 1 does not read study_info or query cards');
    assert.equal(seal.pending.length, 3);
    assert.equal(f.attempts.at(-1).result.deleted, 0);
    assert.equal(f.attempts.at(-1).pending.length, 0);
  });
}

for (const afterChunk of [false, true]) {
  test(`subject chunks: interruption after ${afterChunk ? 'one chunk' : 'phase 1'} resumes on another invocation`, async t => {
    const f = subjectFixture(t, 451);
    let interrupted = false;
    f.hooks.afterCommit = async attempt => {
      const isPhase1 = attempt.pending.some(write => write.path === f.target && write.type === 'delete');
      const isChunk = attempt.queryReads.size && attempt.result.deleted > 0;
      if (!interrupted && (afterChunk ? isChunk : isPhase1)) {
        interrupted = true;
        throw new Error('simulated process interruption after committed transaction');
      }
    };
    assert.equal((await f.invoke('delete', 'first-request')).statusCode, 500);
    assert.equal(interrupted, true);
    deleted(f, subjectConfig, 2);
    assert.equal(f.remaining(), afterChunk ? 251 : 451);
    assert.equal(f.reviewQueue(), afterChunk ? 258 : 458);
    const originalMarker = f.docs.get(f.marker);
    const committedDeletes = f.writes.filter(write => write.type === 'delete').map(write => write.path);
    f.hooks.afterCommit = undefined;
    success(await f.invoke('delete', 'retry-request'), subjectConfig, 'delete');
    assertSubjectCleanup(f);
    assert.deepEqual(f.docs.get(f.marker), originalMarker);
    assert.equal(f.writes.filter(write => write.path === USER).length, 1);
    assert.equal(f.writes.filter(write => write.path === f.marker).length, 1);
    const retried = f.chunks().filter(chunk => chunk.label === 'retry-request');
    assert.equal(retried.reduce((total, chunk) => total + chunk.result.deleted, 0), afterChunk ? 251 : 451);
    for (const chunk of retried) for (const write of chunk.pending.filter(write => write.type === 'delete')) {
      assert.equal(committedDeletes.includes(write.path), false);
    }
    const committed = f.writes.length;
    success(await f.invoke('delete', 'completed-retry'), subjectConfig, 'delete');
    assert.equal(f.writes.length, committed);
  });
}

for (const markerExists of [false, true]) {
  test(`subject chunks: absent subject and ${markerExists ? 'existing' : 'missing'} tombstone still clean orphan cards`, async t => {
    const f = subjectFixture(t, 451, { subjectExists: false, markerExists });
    success(await f.invoke('delete'), subjectConfig, 'delete');
    assertSubjectCleanup(f, 3);
    assert.equal(f.writes.some(write => write.path === USER), false);
    assert.equal(f.writes.filter(write => write.path === f.marker).length, markerExists ? 0 : 1);
  });
}

test('subject chunks: two overlapping deletes retry phase 1 and the same chunk without double decrement', { timeout: 5000 }, async t => {
  const f = subjectFixture(t, 451);
  const phase1 = gate();
  const chunk1 = gate();
  const chunk2 = gate();
  for (const held of [phase1, chunk1, chunk2]) t.after(held.release);
  f.hooks.afterRead = async ({ label, attempt, ref }) => {
    if (label === 'D1' && attempt === 1 && ref.path === f.marker) await phase1.hold();
    if (attempt === 1 && ref.query) await (label === 'D1' ? chunk1 : chunk2).hold();
  };
  const d1 = f.invoke('delete', 'D1');
  await phase1.reached;
  const d2 = f.invoke('delete', 'D2');
  await chunk2.reached;
  phase1.release();
  await chunk1.reached;
  chunk2.release();
  success(await d2, subjectConfig, 'delete');
  chunk1.release();
  success(await d1, subjectConfig, 'delete');
  assertSubjectCleanup(f);
  assert.equal(f.writes.filter(write => write.path === USER).length, 1);
  assert.equal(f.writes.filter(write => write.path === f.marker).length, 1);
  assert.ok(f.conflicts.some(conflict => conflict.label === 'D1' && conflict.paths.includes(f.target)));
  assert.ok(f.conflicts.some(conflict => conflict.label === 'D1' &&
    conflict.paths.includes(STUDY) && conflict.paths.includes(CARDS)));
  const staleChunk = f.attempts.find(attempt => attempt.label === 'D1' && attempt.queryReads.size && attempt.attempt === 1);
  const retryChunk = f.attempts.find(attempt => attempt.label === 'D1' && attempt.queryReads.size && attempt.attempt === 2);
  assert.equal(staleChunk.querySnapshots[0].snapshot.size, CHUNK_SIZE);
  assert.equal(staleChunk.result, undefined, 'conflicting buffered writes were discarded');
  assert.equal(retryChunk.querySnapshots[0].snapshot.size, 0, 'retry rereads the current query');
  assert.equal(retryChunk.result.deleted, 0);
  assert.equal(retryChunk.pending.length, 0);
});

test('subject chunks: conflicting chunk discards its counter adjustment and rereads study_info', { timeout: 5000 }, async t => {
  const f = subjectFixture(t, 201);
  const held = gate();
  t.after(held.release);
  f.hooks.afterRead = async ({ label, attempt, ref }) => {
    if (label === 'stale-request' && attempt === 1 && ref.query) await held.hold();
  };
  const stale = f.invoke('delete', 'stale-request');
  await held.reached;
  success(await f.invoke('delete', 'other-request'), subjectConfig, 'delete');
  held.release();
  success(await stale, subjectConfig, 'delete');
  assertSubjectCleanup(f);
  assert.deepEqual(f.conflicts, [{ label: 'stale-request', attempt: 1, paths: [STUDY, CARDS] }]);
  const chunks = f.attempts.filter(attempt => attempt.label === 'stale-request' && attempt.queryReads.size);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1].reads.get(STUDY) > chunks[0].reads.get(STUDY));
  assert.ok(chunks[1].queryReads.get(CARDS) > chunks[0].queryReads.get(CARDS));
  assert.equal(f.writes.filter(write => write.path === STUDY).length, 2);
});

test('subject chunks: invalid subjectsCount aborts sealing before any cleanup', async t => {
  const f = subjectFixture(t, 451, { subjectsCount: -1 });
  assert.equal((await f.invoke('delete')).statusCode, 412);
  assert.equal(f.docs.has(f.target), true);
  assert.equal(f.docs.has(f.marker), false);
  assert.equal(f.remaining(), 451);
  assert.equal(f.reviewQueue(), 458);
  assert.equal(f.writes.length, 0);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attempts[0].queryReads.size, 0);
});

test('subject chunks: missing user retains USER_NOT_FOUND and starts no cleanup', async t => {
  const f = subjectFixture(t, 451);
  f.docs.delete(USER);
  const response = await f.invoke('delete');
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.code, 'USER_NOT_FOUND');
  assert.equal(f.docs.has(f.target), true);
  assert.equal(f.remaining(), 451);
  assert.equal(f.writes.length, 0);
  assert.equal(f.attempts.length, 1);
});

test('subject chunks: late subject CREATE stays blocked even during interrupted cleanup', async t => {
  const f = subjectFixture(t, 451);
  f.hooks.afterCommit = async attempt => {
    if (attempt.pending.some(write => write.path === f.target && write.type === 'delete')) {
      throw new Error('simulated interruption after sealing');
    }
  };
  assert.equal((await f.invoke('delete')).statusCode, 500);
  f.hooks.afterCommit = undefined;
  const committed = f.writes.length;
  success(await f.invoke('create', 'late-create'), subjectConfig, 'create');
  deleted(f, subjectConfig, 2);
  assert.equal(f.remaining(), 451);
  assert.equal(f.writes.length, committed);
  assert.deepEqual(f.attempts.at(-1).result, { skippedAsDeleted: true });
  success(await f.invoke('delete', 'cleanup-retry'), subjectConfig, 'delete');
  assertSubjectCleanup(f);
});

for (const initial of [1, -1, 'invalid', undefined]) {
  test(`subject chunks: reviewQueue ${String(initial)} keeps valid floor or fails closed (F01)`, async t => {
    const f = subjectFixture(t, 201);
    f.docs.set(STUDY, { reviewQueue: initial, unrelated: 'preserved' });
    if (!Number.isInteger(initial) || initial < 0) {
      assertReviewQueueUnavailable(await f.invoke('delete'));
      assert.equal(f.remaining(), 201);
      assert.deepEqual(f.docs.get(STUDY), { reviewQueue: initial, unrelated: 'preserved' });
      assert.equal(f.chunks().length, 0);
      assert.ok(f.writes.every(write => write.path !== STUDY && !write.path.startsWith(CARDS + '/')));
      deleted(f, subjectConfig, 2);
      return;
    }
    success(await f.invoke('delete'), subjectConfig, 'delete');
    assertSubjectCleanup(f, 2, 0);
  });
}

function largeCards(f, documentBytes = 32 * 1024, indexBytes = 32 * 1024, start = 0) {
  for (const path of f.docs.keys()) {
    if (path.startsWith(`${CARDS}/card-`) && Number(path.split('card-')[1]) >= start) {
      f.storageBytes.set(path, { documentBytes, indexBytes });
    }
  }
}

function assertSingleSeal(f) {
  assert.equal(f.writes.filter(write => write.path === USER).length, 1);
  assert.equal(f.writes.filter(write => write.path === f.marker).length, 1);
  assert.equal(f.writes.filter(write => write.path === f.target && write.type === 'delete').length, 1);
}

test('H1: 200 small cards fit the independent 10 MiB budget', async t => {
  const f = subjectFixture(t, 200);
  largeCards(f, 1024, 1024);
  success(await f.invoke('delete'), subjectConfig, 'delete');
  assertSubjectCleanup(f);
  assert.equal(f.rejectedSizes.length, 0);
  assert.equal(f.chunks().length, 1);
  assert.ok(f.chunks()[0].transactionBytes < 10 * 1024 * 1024);
  assertSingleSeal(f);
});

test('H1: fake rejects oversized deletes atomically including index bytes', async t => {
  const f = subjectFixture(t, 200);
  largeCards(f);
  const originalStudy = f.docs.get(STUDY);
  await assert.rejects(firestore.runTransaction(async transaction => {
    await transaction.get(document(STUDY));
    const cards = await transaction.get(collection(CARDS).where('subjectId', '==', ID).limit(200));
    for (const card of cards.docs) transaction.delete(card.ref);
    transaction.set(document(STUDY), { reviewQueue: 7 }, { merge: true });
  }), error => error.code === 3 && error.details === 'Transaction too big. Decrease transaction size.');
  assert.equal(f.remaining(), 200);
  assert.equal(f.docs.get(STUDY), originalStudy);
  assert.equal(f.writes.length, 0);
  assert.equal(f.rejectedSizes.length, 1);
  assert.ok(f.rejectedSizes[0].transactionBytes > 10 * 1024 * 1024);
  assert.ok(200 * 32 * 1024 < 10 * 1024 * 1024, 'documents alone fit; index entries cause overflow');
});

for (const size of [200, 451, 1001]) {
  test(`H1: ${size} large cards recover after an atomic size rejection`, async t => {
    const f = subjectFixture(t, size);
    largeCards(f);
    let marker;
    f.hooks.afterSizeRejection = attempt => {
      assert.equal(f.remaining(), size);
      assert.equal(f.reviewQueue(), size + 7);
      assert.equal(f.writes.filter(write => write.path.startsWith(`${CARDS}/`)).length, 0);
      assert.equal(attempt.result, undefined);
      marker = f.docs.get(f.marker);
    };
    success(await f.invoke('delete'), subjectConfig, 'delete');
    assertSubjectCleanup(f, 2, 7, true);
    assertSingleSeal(f);
    assert.equal(f.docs.get(f.marker), marker);
    assert.equal(f.rejectedSizes.length, 1);
    assert.equal(f.rejectedSizes[0].querySnapshots[0].snapshot.size, 200);
    assert.ok(f.chunks().every(chunk => chunk.querySnapshots[0].ref.limitCount === 100));
    assert.ok(f.chunks().every(chunk => chunk.transactionBytes <= 10 * 1024 * 1024));
    const committed = f.writes.length;
    success(await f.invoke('delete', 'idempotent-retry'), subjectConfig, 'delete');
    assert.equal(f.writes.length, committed);
    assert.equal(f.docs.get(f.marker), marker);
  });
}

test('H1: size failure after a committed chunk rereads current cards and counter', async t => {
  const f = subjectFixture(t, 451);
  largeCards(f, 32 * 1024, 32 * 1024, 200);
  f.hooks.afterSizeRejection = () => {
    assert.equal(f.remaining(), 251);
    assert.equal(f.reviewQueue(), 258);
    assert.equal(f.chunks().length, 1);
  };
  success(await f.invoke('delete'), subjectConfig, 'delete');
  assertSubjectCleanup(f, 2, 7, true);
  assertSingleSeal(f);
  assert.equal(f.rejectedSizes.length, 1);
  assert.deepEqual(f.chunks().map(chunk => chunk.result.deleted), [200, 100, 100, 51]);
});

function failure(response) {
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    error: 'Não foi possível excluir a matéria.', code: 'SUBJECT_DELETE_FAILED',
  });
}

test('H1: interruption after adaptive progress resumes with the identical tombstone', async t => {
  const f = subjectFixture(t, 451);
  largeCards(f);
  f.hooks.beforeCommit = ({ record }) => {
    if (record.queryReads.size && f.chunks().length === 1) {
      throw Object.assign(new Error('secret timeout diagnostic'), { code: 4 });
    }
  };
  failure(await f.invoke('delete', 'interrupted'));
  deleted(f, subjectConfig, 2);
  assert.equal(f.remaining(), 351);
  assert.equal(f.reviewQueue(), 358);
  const marker = f.docs.get(f.marker);
  const priorDeletes = new Set(f.writes.filter(write => write.type === 'delete').map(write => write.path));
  f.hooks.beforeCommit = undefined;
  success(await f.invoke('delete', 'resumed'), subjectConfig, 'delete');
  assertSubjectCleanup(f, 2, 7, true);
  assertSingleSeal(f);
  assert.equal(f.docs.get(f.marker), marker);
  const resumed = f.chunks().filter(chunk => chunk.label === 'resumed');
  assert.equal(resumed.reduce((sum, chunk) => sum + chunk.result.deleted, 0), 351);
  for (const chunk of resumed) for (const write of chunk.pending.filter(write => write.type === 'delete')) {
    assert.equal(priorDeletes.has(write.path), false);
  }
  assert.equal(f.rejectedSizes.length, 2, 'new invocation starts at 200 and adapts independently');
});

test('H1: concurrent deletes after size reduction retry optimistically with fresh reads', { timeout: 5000 }, async t => {
  const f = subjectFixture(t, 451);
  largeCards(f);
  const held = gate();
  t.after(held.release);
  f.hooks.afterRead = async ({ label, attempt, ref }) => {
    if (label === 'D1' && attempt === 1 && ref.query && ref.limitCount === 100) await held.hold();
  };
  const first = f.invoke('delete', 'D1');
  await held.reached;
  // Also models an HTTP client abandoning D1 while its server request continues.
  success(await f.invoke('delete', 'D2'), subjectConfig, 'delete');
  const marker = f.docs.get(f.marker);
  const writes = f.writes.length;
  held.release();
  success(await first, subjectConfig, 'delete');
  assertSubjectCleanup(f, 2, 7, true);
  assertSingleSeal(f);
  assert.equal(f.docs.get(f.marker), marker);
  assert.equal(f.writes.length, writes);
  assert.equal(f.rejectedSizes.length, 2);
  assert.deepEqual(f.conflicts, [{ label: 'D1', attempt: 1, paths: [STUDY, CARDS] }]);
  const retry = f.attempts.at(-1);
  assert.equal(retry.attempt, 2);
  assert.equal(retry.querySnapshots[0].snapshot.size, 0);
  assert.equal(retry.pending.length, 0);
});

test('H1: a size rejection is followed by a new transaction, never a reused snapshot', { timeout: 5000 }, async t => {
  const f = subjectFixture(t, 200);
  largeCards(f);
  const held = gate();
  t.after(held.release);
  f.hooks.afterSizeRejection = async record => {
    if (record.label === 'stale') await held.hold();
  };
  const first = f.invoke('delete', 'stale');
  await held.reached;
  success(await f.invoke('delete', 'other'), subjectConfig, 'delete');
  const committed = f.writes.length;
  held.release();
  success(await first, subjectConfig, 'delete');
  assertSubjectCleanup(f, 2, 7, true);
  assertSingleSeal(f);
  assert.equal(f.writes.length, committed);
  const stale = f.attempts.filter(record => record.label === 'stale' && record.queryReads.size);
  assert.equal(stale.length, 2);
  assert.equal(stale[0].querySnapshots[0].snapshot.size, 200);
  assert.equal(stale[0].result, undefined);
  assert.equal(stale[1].querySnapshots[0].snapshot.size, 0);
  assert.ok(stale[1].reads.get(STUDY) > stale[0].reads.get(STUDY));
  assert.equal(stale[1].result.deleted, 0);
});

test('H1: an oversized unit stops after seven reductions without partial ACK or infinite retry', async t => {
  const f = subjectFixture(t, 1);
  // Synthetic pathological unit is deliberately above Firestore's other limits.
  largeCards(f, 32 * 1024, 11 * 1024 * 1024);
  failure(await f.invoke('delete', 'first'));
  assert.deepEqual(f.rejectedSizes.map(record => record.querySnapshots[0].ref.limitCount),
    [200, 100, 50, 25, 12, 6, 3, 1]);
  deleted(f, subjectConfig, 2);
  assert.equal(f.remaining(), 1);
  assert.equal(f.reviewQueue(), 8);
  assert.equal(f.writes.length, 3);
  const marker = f.docs.get(f.marker);
  failure(await f.invoke('delete', 'still-too-big'));
  assert.equal(f.rejectedSizes.length, 16);
  assert.equal(f.docs.get(f.marker), marker);
  assert.equal(f.remaining(), 1);
  assert.equal(f.reviewQueue(), 8);
  assertSingleSeal(f);
  // Repairing only test storage metadata permits a later explicit retry.
  largeCards(f, 1024, 1024);
  success(await f.invoke('delete', 'repaired'), subjectConfig, 'delete');
  assertSubjectCleanup(f, 2, 7, true);
  assert.equal(f.docs.get(f.marker), marker);
});

test('H1: total transaction budget bounds unit chunks and allows a later invocation to resume', async t => {
  const f = subjectFixture(t, 100);
  largeCards(f, 32 * 1024, 6 * 1024 * 1024);
  failure(await f.invoke('delete', 'bounded'));
  assert.equal(f.attempts.filter(record => record.label === 'bounded' && record.queryReads.size).length, 64);
  assert.equal(f.rejectedSizes.length, 7);
  assert.equal(f.chunks().length, 57);
  assert.equal(f.remaining(), 43);
  assert.equal(f.reviewQueue(), 50);
  const marker = f.docs.get(f.marker);
  success(await f.invoke('delete', 'resumed'), subjectConfig, 'delete');
  assertSubjectCleanup(f, 2, 7, true);
  assert.equal(f.docs.get(f.marker), marker);
  assertSingleSeal(f);
});

for (const [name, error] of [
  ['permission-denied', { code: 7, details: 'Transaction too big. Decrease transaction size.' }],
  ['unauthenticated', { code: 16 }],
  ['conflict', { code: 10 }],
  ['quota', { code: 8, details: 'Transaction too big. Decrease transaction size.' }],
  ['timeout', { code: 4 }],
  ['unavailable', { code: 14 }],
  ['unknown', { code: 2 }],
  ['invalid query', { code: 3, details: 'Invalid query.' }],
  ['expired transaction', { code: 3, details: 'The transaction has expired.' }],
  ['generic maximum', { code: 3, details: 'Maximum transaction size exceeded.' }],
  ['message only without code', { message: 'Transaction too big. Decrease transaction size.' }],
  ['string code', { code: 'INVALID_ARGUMENT', details: 'Transaction too big. Decrease transaction size.' }],
  ['unrelated authoritative details', { code: 3, details: 'Invalid query.',
    message: '3 INVALID_ARGUMENT: Transaction too big. Decrease transaction size.' }],
]) {
  test(`H1: ${name} is sanitized and does not trigger adaptive retries`, async t => {
    const f = subjectFixture(t, 200);
    f.hooks.beforeCommit = ({ record }) => {
      if (record.queryReads.size) throw Object.assign(new Error('secret diagnostic /users/private'), error);
    };
    failure(await f.invoke('delete'));
    assert.equal(f.attempts.filter(record => record.queryReads.size).length, 1);
    assert.equal(f.remaining(), 200);
    assert.equal(f.reviewQueue(), 207);
    deleted(f, subjectConfig, 2);
    assertSingleSeal(f);
  });
}

for (const message of ['Transaction too big. Decrease transaction size.',
  '3 INVALID_ARGUMENT: Transaction too big. Decrease transaction size.']) {
  test(`H1: SDK error without details recognizes exact message ${message}`, async t => {
    const f = subjectFixture(t, 200);
    largeCards(f);
    f.hooks.afterSizeRejection = record => {
      // Rethrow the same independent budget failure in another SDK representation.
      assert.ok(record.transactionBytes > 10 * 1024 * 1024);
      throw Object.assign(new Error(message), { code: 3 });
    };
    success(await f.invoke('delete'), subjectConfig, 'delete');
    assertSubjectCleanup(f, 2, 7, true);
    assert.equal(f.rejectedSizes.length, 1);
    assertSingleSeal(f);
  });
}

for (const markerExists of [false, true]) {
  test(`H1: adaptive cleanup of orphan cards preserves ${markerExists ? 'existing' : 'new'} tombstone`, async t => {
    const f = subjectFixture(t, 451, { subjectExists: false, markerExists });
    largeCards(f);
    let marker = f.docs.get(f.marker);
    f.hooks.afterSizeRejection = () => { marker ??= f.docs.get(f.marker); };
    success(await f.invoke('delete'), subjectConfig, 'delete');
    assertSubjectCleanup(f, 3, 7, true);
    assert.equal(f.docs.get(f.marker), marker);
    assert.equal(f.writes.filter(write => write.path === USER).length, 0);
    assert.equal(f.writes.filter(write => write.path === f.marker).length, markerExists ? 0 : 1);
  });
}

for (const initial of [1, -1, 'invalid', undefined]) {
  test(`H1: adaptive cleanup keeps valid reviewQueue or fails closed for ${String(initial)} (F01)`, async t => {
    const f = subjectFixture(t, 451);
    f.docs.set(STUDY, { reviewQueue: initial, unrelated: 'preserved' });
    largeCards(f);
    if (!Number.isInteger(initial) || initial < 0) {
      assertReviewQueueUnavailable(await f.invoke('delete'));
      assert.equal(f.remaining(), 451);
      assert.deepEqual(f.docs.get(STUDY), { reviewQueue: initial, unrelated: 'preserved' });
      assert.equal(f.rejectedSizes.length, 0, 'invalid counter is rejected before buffering any chunk');
      assert.equal(f.chunks().length, 0);
      assert.ok(f.writes.every(write => write.path !== STUDY && !write.path.startsWith(CARDS + '/')));
      assertSingleSeal(f);
      return;
    }
    success(await f.invoke('delete'), subjectConfig, 'delete');
    assertSubjectCleanup(f, 2, 0, true);
    assertSingleSeal(f);
  });
}

test('H1: phase 1 size error propagates without reducing chunks or sealing partially', async t => {
  const f = subjectFixture(t, 200);
  f.hooks.beforeCommit = () => {
    throw Object.assign(new Error('secret phase 1 diagnostic'), {
      code: 3, details: 'Transaction too big. Decrease transaction size.',
    });
  };
  failure(await f.invoke('delete'));
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attempts[0].queryReads.size, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.docs.has(f.target), true);
  assert.equal(f.docs.has(f.marker), false);
  assert.equal(f.count(), 3);
  assert.equal(f.remaining(), 200);
  assert.equal(f.reviewQueue(), 207);
});

// Exact read sets above remain exact. This additional trace proves the control
// reads precede every buffered business write in the very same transaction.
function assertControlReadsBeforeWrites(attempt) {
  assert.deepEqual([...attempt.reads.keys()].slice(0, 4), [GUARD, RETIRED, RECEIPT, `trusted_account_origins/${UID}`]);
  assert.deepEqual(attempt.io.slice(0, 4), [GUARD, RETIRED, RECEIPT, `trusted_account_origins/${UID}`].map(path => ({ type: 'read', path })));
  assert.deepEqual(attempt.io.filter(row => row.type === 'read').map(row => row.path),
    [...attempt.reads.keys(), ...attempt.queryReads.keys()], 'no hidden duplicate or additional reads');
  assert.deepEqual(attempt.io.filter(row => row.type === 'write').map(row => row.path),
    attempt.pending.map(row => row.path), 'every business write belongs to this transaction');
  const firstWrite = attempt.io.findIndex(row => row.type === 'write');
  assert.ok(firstWrite === -1 || firstWrite >= 4);
  assert.equal(attempt.io.some((row, i) => row.type === 'read' && firstWrite !== -1 && i > firstWrite), false);
  console.log(JSON.stringify({ historicalEvidence: 'exact-read-set', test: attempt.testName,
    label: attempt.label, attempt: attempt.attempt, reads: [...attempt.reads.keys()],
    controlReadsBeforeWrites: true, pendingWrites: attempt.pending.length }));
}

async function admitRealRetirement(f) {
  const binding = { projectId: f.db.projectId, databaseId: f.db.databaseId, uid: UID };
  const calls = { subject: 0, auth: [], uuid: 0 };
  const controller = deletionControl.createController({ db: f.db, binding,
    clock: () => Timestamp.fromDate(new Date(DATE)),
    uuid: () => { calls.uuid++; return DELETION_ID; },
    ports: {
      getAuthenticatedSubject: async () => { calls.subject++; return binding; },
      getAuthUser: async uid => { calls.auth.push(uid); return { uid }; },
    } });
  const admission = await requestContext.run('retirement', () => controller.admitBackend());
  assert.equal(admission.status, 'ADMITTED');
  assert.equal(admission.destructiveAuthority, false);
  assert.deepEqual(calls, { subject: 1, auth: [UID], uuid: 1 });
  assert.equal(f.docs.get(RETIRED).origin, 'PRE_AUTH');
  assert.equal(f.docs.get(RECEIPT).state, 'IN_PROGRESS');
  assert.equal(f.docs.get(RECEIPT).scope.privateRoot, USER);
  assert.equal(f.docs.get(RECEIPT).uid, UID);
  for (const path of [RETIRED, GUARD, RECEIPT]) assert.equal(f.docs.get(path).deletionId, DELETION_ID);
  assert.deepEqual(f.commits.filter(row => row.label === 'retirement' && row.pending.length)
    .map(row => row.pending.map(w => w.path)), [[RETIRED, GUARD, RECEIPT]]);
  return { controller, admission };
}

for (const config of operations) {
  for (const action of ['create', 'delete']) {
    test(`R6C1 ${config.entity} ${action}: real R5 retirement commits before writer and retry denies`, { timeout: 5000 }, async t => {
      const f = fixture(t, config, action === 'delete' ? 1 : 0);
      if (action === 'delete') f.put(f.target, config.payload);
      const otherUid = 'unrelated-active-user';
      const otherRoot = `users/${otherUid}`;
      const otherTarget = `${otherRoot}/${config.collection}/${ID}`;
      f.put(otherRoot, { [config.counter]: 0 });
      const otherBefore = f.docs.get(otherRoot);
      const oldMarker = `${USER}/sync_tombstones/${config.collection}__unrelated`;
      f.put(oldMarker, { schemaVersion: 1, entityType: config.collection, entityId: 'unrelated', deletedAt: new Date(DATE) });
      const originalMarker = f.docs.get(oldMarker);
      const before = new Map(f.docs);
      const held = gate();
      t.after(held.release);
      let injectionReached = 0;
      f.hooks.beforeCommit = async ({ label, attempt, record }) => {
        if (label === 'writer' && attempt === 1) {
          injectionReached++;
          assertControlReadsBeforeWrites(record);
          assert.ok(record.pending.length > 0, 'real Sync business writes are buffered');
          assert.equal(record.applied, false);
          await held.hold();
        }
      };
      // Client body cannot select the account to fence or mutate.
      const execution = f.invoke(action, 'writer', { uid: otherUid, userId: otherUid });
      await Promise.race([held.reached, execution.then(() => assert.fail('writer did not reach the real commit hook'))]);
      assert.equal(injectionReached, 1);
      assert.deepEqual(f.docs, before, 'paused writer has not applied any data');
      await admitRealRetirement(f);
      const barrier = new Map(f.docs);
      held.release();
      assertDeletionBlocked(await execution);
      assert.deepEqual(f.docs, barrier, 'no writer mutation follows the retirement commit');
      const attempts = f.attempts.filter(row => row.label === 'writer');
      assert.equal(attempts.length, 2);
      assert.deepEqual([...attempts[0].reads.keys()], [GUARD, RETIRED, RECEIPT, `trusted_account_origins/${UID}`, USER, f.target, f.marker]);
      assert.deepEqual([...attempts[1].reads.keys()], [GUARD]);
      assert.equal(attempts[1].pending.length, 0);
      assert.ok(attempts.every(row => row.applied === false));
      assert.deepEqual(f.conflicts, [{ label: 'writer', attempt: 1, paths: [GUARD, RETIRED, RECEIPT] }]);
      assert.equal(f.commits.some(row => row.label === 'writer'), false);
      assert.equal(f.writes.length, 3, 'only the three real R5 controls were committed');
      assert.deepEqual(f.identities, [{ label: 'writer', uid: UID }]);
      assert.equal(f.docs.get(oldMarker), originalMarker, 'no silent loss of existing tombstones');
      assert.deepEqual(f.docs.get(otherRoot), otherBefore);
      success(await f.invoke('create', 'other-user', {}, { uid: otherUid }), config, 'create');
      assert.equal(f.docs.get(otherRoot)[config.counter], 1);
      assert.equal(f.docs.has(otherTarget), true);
      for (const [path, data] of barrier) if (path !== otherRoot) assert.deepEqual(f.docs.get(path), data);
      for (const row of f.commits.filter(row => row.label === 'other-user')) {
        assert.deepEqual([...row.reads.keys()], [
          `account_deletion_guards/${otherUid}`, `retired_auth_identities/${otherUid}`,
          `account_deletion_guards/${otherUid}/control/operation`, `trusted_account_origins/${otherUid}`, otherRoot, otherTarget,
          `${otherRoot}/sync_tombstones/${config.collection}__${ID}`,
        ]);
        assert.deepEqual(row.pending.map(w => w.path), [otherTarget, otherRoot]);
      }
      assert.deepEqual(f.identities, [{ label: 'writer', uid: UID }, { label: 'other-user', uid: otherUid }]);
      t.diagnostic(JSON.stringify({ historicalEvidence: 'real-retirement-wins', entity: config.entity, action,
        injectionReached, conflicts: f.conflicts, writerAttempts: attempts.map(a => ({
          uid: UID, attempt: a.attempt, reads: [...a.reads.keys()], pending: a.pending.map(w => w.path), applied: a.applied })),
        barrierWrites: [RETIRED, GUARD, RECEIPT], deletionId: DELETION_ID,
        writerCommits: 0, otherUserSuccess: true, tombstonePreserved: true }));
    });

    test(`R6C1 ${config.entity} ${action}: writer serialized before R5 retirement stays in the original scope`, async t => {
      const f = fixture(t, config, action === 'delete' ? 1 : 0);
      if (action === 'delete') f.put(f.target, config.payload);
      success(await f.invoke(action, 'writer-before'), config, action);
      const business = new Map(f.docs);
      const businessCommits = f.commits.filter(row => row.label === 'writer-before');
      assert.ok(businessCommits.some(row => row.pending.length > 0));
      for (const row of businessCommits) assertControlReadsBeforeWrites(row);
      if (action === 'create') {
        assert.equal(f.docs.has(f.target), true);
        assert.equal(f.count(), 1);
      } else deleted(f, config);
      const marker = f.docs.get(f.marker);
      const admitted = await admitRealRetirement(f);
      for (const [path, data] of business) assert.deepEqual(f.docs.get(path), data);
      const originalReceipt = f.docs.get(RECEIPT);
      assert.equal(originalReceipt.scope.privateRoot, USER);
      assert.equal(originalReceipt.scope.policyVersion, 'ACCOUNT_DELETE_SCOPE_V1');
      const barrier = new Map(f.docs);
      const writes = f.writes.length;
      assertDeletionBlocked(await f.invoke(action, 'writer-after'));
      assert.deepEqual(f.docs, barrier);
      assert.equal(f.writes.length, writes);
      assert.equal(f.docs.get(f.marker), marker);
      const resumed = await requestContext.run('retirement-resume', () => admitted.controller.admitBackend());
      assert.equal(resumed.status, 'RESUMED');
      assert.equal(f.docs.get(RECEIPT), originalReceipt, 'resume retains the same operation and scope');
      assert.deepEqual(f.docs, barrier);
      assert.equal(f.writes.length, writes);
      t.diagnostic(JSON.stringify({ historicalEvidence: 'writer-before-retirement', entity: config.entity, action,
        businessCommits: businessCommits.length, privateRoot: originalReceipt.scope.privateRoot,
        deletionId: originalReceipt.deletionId, noPostBarrierWrites: true, scopePreserved: true }));
    });
  }
}

test('R6C1 expired COMPLETE: another authenticated UID remains independent', async t => {
  const config = operations[0], f = fixture(t, config);
  f.put(GUARD, deletionGuard({ state: 'COMPLETE', retainUntil: Timestamp.fromMillis(2) }));
  const before = new Map(f.docs);
  assertDeletionBlocked(await f.invoke());
  const other = 'expired-guard-other-user', root = `users/${other}`;
  f.put(root, { tasksCount: 0 });
  success(await f.invoke('create', 'other', {}, { uid: other }), config, 'create');
  assert.equal(f.docs.get(root).tasksCount, 1);
  assert.equal(f.docs.has(`${root}/tasks/${ID}`), true);
  for (const [path, data] of before) assert.deepEqual(f.docs.get(path), data);
  assert.equal(f.docs.has(f.target), false);
  assert.equal(f.docs.has(RETIRED), false);
  assert.equal(f.docs.has(RECEIPT), false);
  assert.deepEqual(f.writes.map(w => w.path), [`${root}/tasks/${ID}`, root]);
});

// R6C4-A: reuse the existing Subject deletion MVCC model and actual Sync route.
const cardCreatePayload = (cardId='created-card') => ({operation:'create_review_card',version:1,cardId,subjectId:ID,
  question:'Synthetic question',answer:'Synthetic answer',createdAt:'2026-10-28T12:34:56.123456Z'});
function cardFixture(t){const f=fixture(t,operations.find(c=>c.entity==='subject'),1);
  f.put(f.target,{title:'Subject',cardsToReview:0});f.put(USER+'/study_info/main',{reviewQueue:0});return f;}
const newReceiptPath=USER+'/study_card_create_receipts/created-card';
function createdCard(response,outcome='APPLIED'){assert.equal(response.statusCode,200);assert.equal(response.body.operation,'create_review_card');assert.equal(response.body.outcome,outcome);assert.equal(response.body.effectsCommitted,true);}
test('R6C4-A Subject deletion removes card/counter effects but retains immutable creation receipt for replay',async t=>{
  const f=cardFixture(t);createdCard(await f.invoke('create','card-create',cardCreatePayload(),{exactBody:true}));
  const receiptBefore=f.docs.get(newReceiptPath);assert.ok(receiptBefore.appliedAt instanceof Timestamp);
  assert.equal((await f.invoke('delete','subject-delete')).statusCode,200);
  assert.equal(f.docs.has(USER+'/review_queue/created-card'),false);assert.equal(f.docs.has(f.target),false);
  assert.equal(f.docs.get(USER+'/study_info/main').reviewQueue,0);assert.deepEqual(f.docs.get(newReceiptPath),receiptBefore);
  const count=f.writes.length;createdCard(await f.invoke('create','card-replay',cardCreatePayload(),{exactBody:true}),'REPLAYED');assert.equal(f.writes.length,count);
  f.put(f.target,{title:'Reappeared',cardsToReview:0});const before=new Map(f.docs);
  const blocked=await f.invoke('create','new-card-after-delete',cardCreatePayload('created-card-2'),{exactBody:true});
  assert.equal(blocked.statusCode,409);assert.equal(blocked.body.code,'REVIEW_CREATE_SUBJECT_TOMBSTONED');assert.deepEqual(f.docs,before);
});
test('R6C4-A Subject delete wins while card creation is pending; retry cannot resurrect or mint receipt',async t=>{
  const f=cardFixture(t),hold=gate();t.after(hold.release);let paused=false;
  f.hooks.beforeCommit=async({label,record})=>{if(!paused&&label==='card-create'&&record.pending.length){paused=true;assert.equal(record.pending.length,4);await hold.hold();}};
  const creation=f.invoke('create','card-create',cardCreatePayload(),{exactBody:true});
  await Promise.race([hold.reached,creation.then(()=>assert.fail('creation did not pause'))]);
  assert.equal((await f.invoke('delete','subject-delete')).statusCode,200);const before=new Map(f.docs);hold.release();
  const response=await creation;assert.equal(response.statusCode,409);assert.equal(response.body.code,'REVIEW_CREATE_SUBJECT_TOMBSTONED');assert.deepEqual(f.docs,before);
  assert.equal(f.docs.has(newReceiptPath),false);assert.equal(f.commits.some(tx=>tx.label==='card-create'),false);assert.ok(f.conflicts.some(tx=>tx.label==='card-create'));
});
test('R6C4-A card create wins while Subject delete is pending; delete retries and accounts for the committed card',async t=>{
  const f=cardFixture(t),hold=gate();t.after(hold.release);let paused=false;
  f.hooks.beforeCommit=async({label,record})=>{if(!paused&&label==='subject-delete'&&record.pending.some(w=>w.path===f.marker)){paused=true;await hold.hold();}};
  const deletion=f.invoke('delete','subject-delete');await Promise.race([hold.reached,deletion.then(()=>assert.fail('deletion did not pause'))]);
  createdCard(await f.invoke('create','card-create',cardCreatePayload(),{exactBody:true}));const receipt=f.docs.get(newReceiptPath);hold.release();
  assert.equal((await deletion).statusCode,200);assert.ok(f.conflicts.some(tx=>tx.label==='subject-delete'));
  assert.equal(f.docs.get(USER+'/study_info/main').reviewQueue,0);assert.equal(f.docs.has(USER+'/review_queue/created-card'),false);assert.deepEqual(f.docs.get(newReceiptPath),receipt);
  createdCard(await f.invoke('create','card-replay',cardCreatePayload(),{exactBody:true}),'REPLAYED');
});

function assertReviewQueueUnavailable(response) {
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, { code: 'STUDY_REVIEW_QUEUE_STATE_INVALID',
    error: 'O contador remoto da fila de revisão está indisponível.' });
  assert.equal(response.body.success, undefined, 'unknown counter never produces a final ACK');
  assert.equal(JSON.stringify(response.body).includes('private-state'), false);
}

for (const [name, info] of [
  ['document missing', undefined], ['partial document', { progress: .2 }],
  ...[null, false, 'private-state', '3', -1, NaN, Infinity, 1.5, 2 ** 53, 2 ** 54, {}, []]
    .map(value => ['malformed ' + String(value), { reviewQueue: value, unrelated: 'preserved' }]),
]) {
  test('F01 subject: ' + name + ' blocks every unapplied chunk and repeat without false ACK', async t => {
    const f = subjectFixture(t, 201);
    f.put(STUDY, info);
    const other = 'users/other-uid/study_info/main';
    f.put(other, { reviewQueue: 81, privateDetail: 'other-user' });
    const otherBefore = f.docs.get(other);
    assertReviewQueueUnavailable(await f.invoke('delete', 'first'));
    deleted(f, subjectConfig, 2); // Existing independent phase 1 remains committed.
    assert.equal(f.remaining(), 201);
    assert.deepEqual(f.docs.get(STUDY), info);
    assert.equal(f.docs.has(STUDY), info !== undefined);
    assert.equal(f.chunks().length, 0);
    assert.ok(f.attempts.filter(a => a.queryReads.size).every(a => a.pending.length === 0));
    assert.ok(f.writes.every(w => w.path !== STUDY && !w.path.startsWith(CARDS + '/')));
    const sealed = new Map(f.docs), writes = f.writes.length;
    assertReviewQueueUnavailable(await f.invoke('delete', 'repeat'));
    assert.deepEqual(f.docs, sealed);
    assert.equal(f.writes.length, writes);
    assert.equal(f.docs.get(other), otherBefore);
    assert.equal(f.identities.every(i => i.uid === UID), true);
  });
}

test('F01 subject: counter corruption before commit conflicts and discards the buffered chunk', async t => {
  const f = subjectFixture(t, 201);
  let raced = false;
  f.hooks.beforeCommit = ({ record }) => {
    if (!raced && record.queryReads.size) {
      raced = true;
      f.put(STUDY, { privateDetail: 'private-state' });
    }
  };
  assertReviewQueueUnavailable(await f.invoke('delete'));
  assert.equal(f.remaining(), 201);
  assert.deepEqual(f.docs.get(STUDY), { privateDetail: 'private-state' });
  assert.ok(f.conflicts.some(c => c.paths.includes(STUDY)));
  assert.equal(f.chunks().length, 0);
  assert.ok(f.writes.every(w => w.path !== STUDY && !w.path.startsWith(CARDS + '/')));
  deleted(f, subjectConfig, 2);
});

for (const loseResponse of [false, true]) {
  test('F01 subject: missing counter after confirmed chunk preserves progress (timeout=' + loseResponse + ')', async t => {
    const f = subjectFixture(t, 451);
    let confirmed = false;
    f.hooks.afterCommit = record => {
      if (!confirmed && record.result?.deleted > 0) {
        confirmed = true;
        assert.equal(record.result.reviewQueue, 258);
        f.put(STUDY, undefined);
        if (loseResponse) throw Object.assign(new Error('private-state response timeout'), { code: 4 });
      }
    };
    const response = await f.invoke('delete', 'first');
    if (loseResponse) {
      failure(response);
      assert.equal(JSON.stringify(response.body).includes('private-state'), false);
    } else assertReviewQueueUnavailable(response);
    assert.equal(confirmed, true);
    deleted(f, subjectConfig, 2);
    assert.equal(f.remaining(), 251);
    assert.equal(f.docs.has(STUDY), false);
    assert.equal(f.chunks().length, 1);
    const before = new Map(f.docs), writes = f.writes.length;
    const deletedCards = f.writes.filter(w => w.type === 'delete' && w.path.startsWith(CARDS + '/'));
    assert.equal(deletedCards.length, 200);
    f.hooks.afterCommit = undefined;
    assertReviewQueueUnavailable(await f.invoke('delete', 'retry'));
    assert.deepEqual(f.docs, before);
    assert.equal(f.writes.length, writes);
    assert.equal(f.docs.has(STUDY), false);
    assert.equal(new Set(deletedCards.map(w => w.path)).size, 200);
    assertSingleSeal(f);
  });
}

test('F01 subject: completed cleanup with no remaining cards does not need or recreate counter', async t => {
  const f = subjectFixture(t, 0, { subjectExists: false, markerExists: true });
  f.put(STUDY, undefined);
  const before = new Map(f.docs);
  success(await f.invoke('delete'), subjectConfig, 'delete');
  assert.deepEqual(f.docs, before);
  assert.equal(f.writes.length, 0);
  assert.equal(f.docs.has(STUDY), false);
});

test('F01 subject: pending cards and existing tombstone/creation receipt never authorize unknown counter', async t => {
  const f = subjectFixture(t, 1, { subjectExists: false, markerExists: true });
  f.put(STUDY, undefined);
  const receiptPath = USER + '/study_card_create_receipts/card-0';
  f.put(receiptPath, { schemaVersion: 1, appliedAt: Timestamp.fromDate(new Date(DATE)) });
  const before = new Map(f.docs);
  assertReviewQueueUnavailable(await f.invoke('delete'));
  assert.deepEqual(f.docs, before);
  assert.equal(f.writes.length, 0);
  assert.equal(f.remaining(), 1);
});


for (const reviewQueue of [0, 1, Number.MAX_SAFE_INTEGER]) {
  test('R1 subject: safe counter ' + reviewQueue + ' debits exactly across chunks and replay', async t => {
    const f = subjectFixture(t, 201, { reviewQueue });
    const other = 'users/other-uid/study_info/main';
    f.put(other, { reviewQueue: 81 });
    const receiptPath = USER + '/study_card_create_receipts/card-0';
    const receipt = { schemaVersion: 1, appliedAt: Timestamp.fromDate(new Date(DATE)) };
    f.put(receiptPath, receipt);
    success(await f.invoke('delete'), subjectConfig, 'delete');
    assertSubjectCleanup(f, 2, Math.max(0, reviewQueue - 201));
    assert.equal(f.chunks().length, 2);
    assert.deepEqual(f.chunks().map(c => c.result.reviewQueue),
      [Math.max(0, reviewQueue - 200), Math.max(0, reviewQueue - 201)]);
    const before = new Map(f.docs), writes = f.writes.length;
    success(await f.invoke('delete', 'repeat'), subjectConfig, 'delete');
    assert.deepEqual(f.docs, before);
    assert.equal(f.writes.length, writes);
    assert.equal(f.docs.get(receiptPath), receipt);
    assert.deepEqual(f.docs.get(other), { reviewQueue: 81 });
    assertSingleSeal(f);
  });
}

for (const reviewQueue of [2 ** 53, 2 ** 54]) {
  test('R1 subject: retry rejects unsafe counter ' + reviewQueue + ' without committing chunk', async t => {
    const f = subjectFixture(t, 201);
    let raced = false;
    f.hooks.beforeCommit = ({ record }) => {
      if (!raced && record.queryReads.size) {
        raced = true;
        f.put(STUDY, { reviewQueue, unrelated: 'preserved' });
      }
    };
    assertReviewQueueUnavailable(await f.invoke('delete'));
    assert.equal(f.remaining(), 201);
    assert.equal(f.reviewQueue(), reviewQueue);
    assert.ok(f.conflicts.some(c => c.paths.includes(STUDY)));
    assert.equal(f.chunks().length, 0);
    assert.ok(f.writes.every(w => w.path !== STUDY && !w.path.startsWith(CARDS + '/')));
    assert.equal(f.attempts.at(-1).pending.length, 0);
    assertSingleSeal(f);
  });

  for (const loseResponse of [false, true]) {
    test('R1 subject: unsafe counter ' + reviewQueue + ' preserves confirmed chunk (timeout=' + loseResponse + ')', async t => {
      const f = subjectFixture(t, 451);
      const receiptPath = USER + '/study_card_create_receipts/card-0';
      const receipt = { schemaVersion: 1, appliedAt: Timestamp.fromDate(new Date(DATE)) };
      f.put(receiptPath, receipt);
      let confirmed = false;
      f.hooks.afterCommit = record => {
        if (!confirmed && record.result?.deleted > 0) {
          confirmed = true;
          assert.equal(record.result.reviewQueue, 258);
          f.put(STUDY, { reviewQueue, unrelated: 'preserved' });
          if (loseResponse) throw Object.assign(new Error('private-state timeout'), { code: 4 });
        }
      };
      const response = await f.invoke('delete', 'first');
      if (loseResponse) failure(response);
      else assertReviewQueueUnavailable(response);
      assert.equal(confirmed, true);
      assert.equal(f.remaining(), 251);
      assert.equal(f.chunks().length, 1);
      assert.equal(f.reviewQueue(), reviewQueue);
      deleted(f, subjectConfig, 2);
      const before = new Map(f.docs), writes = f.writes.length;
      f.hooks.afterCommit = undefined;
      assertReviewQueueUnavailable(await f.invoke('delete', 'repeat'));
      assert.deepEqual(f.docs, before);
      assert.equal(f.writes.length, writes);
      assert.equal(f.docs.get(receiptPath), receipt);
      assert.equal(f.writes.filter(w => w.type === 'delete' && w.path.startsWith(CARDS + '/')).length, 200);
      assert.ok(f.attempts.filter(a => a.queryReads.size && !a.applied).every(a => a.pending.length === 0));
      assertSingleSeal(f);
    });
  }

  for (const subjectExists of [false, true]) {
    test('R1 subject: empty chunk with unsafe counter ' + reviewQueue + ' preserves seal (subject=' + subjectExists + ')', async t => {
      const f = subjectFixture(t, 0, { reviewQueue, subjectExists, markerExists: !subjectExists });
      const info = f.docs.get(STUDY);
      const marker = f.docs.get(f.marker);
      success(await f.invoke('delete'), subjectConfig, 'delete');
      deleted(f, subjectConfig, subjectExists ? 2 : 3);
      assert.equal(f.docs.get(STUDY), info);
      assert.equal(f.chunks().length, 0);
      assert.ok(f.attempts.filter(a => a.queryReads.size).every(a => a.pending.length === 0));
      assert.ok(f.writes.every(w => w.path !== STUDY && !w.path.startsWith(CARDS + '/')));
      if (subjectExists) assertSingleSeal(f);
      else { assert.equal(f.writes.length, 0); assert.equal(f.docs.get(f.marker), marker); }
      const before = new Map(f.docs), writes = f.writes.length;
      success(await f.invoke('delete', 'repeat'), subjectConfig, 'delete');
      assert.deepEqual(f.docs, before);
      assert.equal(f.writes.length, writes);
    });
  }
}
