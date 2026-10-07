import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) initializeApp({ projectId: 'sync-tombstones-test' });
const { syncHandler } = await import('../api/sync.js');
const firestore = getFirestore();
const requestContext = new AsyncLocalStorage();
const UID = 'tombstone-user';
const USER = `users/${UID}`;
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
      assert.equal(operator, '==');
      return { path, query: true, field, value,
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
  const hooks = {};
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
      const reads = new Map();
      const queryReads = new Map();
      const pending = [];
      const attemptRecord = { label, attempt, reads, queryReads, querySnapshots: [], pending };
      attempts.push(attemptRecord);
      const result = await callback({
        async get(ref) {
          assert.equal(pending.length, 0, 'Firestore requires all reads before writes');
          let value;
          if (ref.query) {
            queryReads.set(ref.path, startCollectionVersions.get(ref.path) ?? 0);
            const matches = [...state.keys()].filter(path =>
              path.slice(0, path.lastIndexOf('/')) === ref.path && state.get(path)[ref.field] === ref.value);
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
        set: (ref, data, options) => pending.push({ type: 'set', path: ref.path, data, options }),
        update: (ref, data) => pending.push({ type: 'update', path: ref.path, data }),
        delete: ref => pending.push({ type: 'delete', path: ref.path }),
      });
      await hooks.beforeCommit?.({ label, attempt });
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
      // No await during commit: all writes become visible atomically.
      for (const write of pending) {
        writes.push(write);
        if (write.type === 'delete') docs.delete(write.path);
        else {
          if (write.type === 'update') assert.ok(docs.has(write.path));
          const data = Object.fromEntries(Object.entries(write.data).map(([key, value]) =>
            [key, value?.constructor?.name === 'ServerTimestampTransform' ? new Date(DATE) : value]));
          docs.set(write.path, write.type === 'update' || write.options?.merge
            ? { ...docs.get(write.path), ...data } : data);
        }
        versions.set(write.path, (versions.get(write.path) ?? 0) + 1);
        const parent = write.path.slice(0, write.path.lastIndexOf('/'));
        collectionVersions.set(parent, (collectionVersions.get(parent) ?? 0) + 1);
      }
      attemptRecord.result = result;
      await hooks.afterCommit?.(attemptRecord);
      return result;
    }
    throw new Error('Exceeded conflict retry limit');
  });

  async function invoke(action = 'create', label = action, body = {}) {
    const res = { statusCode: 200, setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; } };
    await requestContext.run(label, () => syncHandler({
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'x-firebase-appcheck': 'test-app-check' },
      body: { operation: `${action}_${config.entity}`, [config.idField]: ID,
        ...(action === 'create' ? config.payload : {}), ...body },
    }, res, {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async (_, checkRevoked) => {
        assert.equal(checkRevoked, true);
        return { uid: UID };
      },
      checkRateLimit: async parameters => {
        assert.equal(parameters.uid, UID);
        return true;
      },
    }));
    return res;
  }
  return { docs, writes, attempts, conflicts, hooks, target, marker, invoke,
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

for (const config of operations) {
  const check = (name, fn) => test(`${config.entity}: ${name}`, { timeout: 5000 }, fn);

  check('normal create increments once and reads the marker within the transaction', async t => {
    const f = fixture(t, config);
    success(await f.invoke(), config, 'create');
    assert.equal(f.docs.has(f.target), true);
    assert.equal(f.count(), 1);
    assert.equal(f.docs.has(f.marker), false);
    assert.deepEqual([...f.attempts[0].reads.keys()], [USER, f.target, f.marker]);
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

function assertSubjectCleanup(f, expectedSubjects = 2, expectedReviewQueue = 7) {
  deleted(f, subjectConfig, expectedSubjects);
  assert.equal(f.remaining(), 0);
  assert.equal(f.reviewQueue(), expectedReviewQueue);
  assert.equal(f.docs.has(`${CARDS}/other-subject-card`), true);
  assert.equal(f.docs.get(STUDY).unrelated, 'preserved');
  const cardDeletes = f.writes.filter(write => write.type === 'delete' && write.path.startsWith(`${CARDS}/`));
  assert.equal(new Set(cardDeletes.map(write => write.path)).size, cardDeletes.length,
    'no card is deleted or counted twice');
  for (const attempt of f.attempts.filter(attempt => attempt.queryReads.size)) {
    assert.deepEqual([...attempt.reads.keys()], [STUDY]);
    assert.equal(attempt.querySnapshots[0].ref.limitCount, CHUNK_SIZE);
    assert.ok(attempt.querySnapshots[0].snapshot.size <= CHUNK_SIZE);
    assert.ok(attempt.pending.length <= CHUNK_SIZE + 1);
    if (attempt.result?.deleted > 0) {
      assert.equal(attempt.pending.filter(write => write.type === 'delete').length, attempt.result.deleted);
      assert.equal(attempt.pending.filter(write => write.path === STUDY).length, 1);
    }
  }
}

for (const size of [0, 1, CHUNK_SIZE, CHUNK_SIZE + 1, 450, 451, 1001]) {
  test(`subject chunks: ${size} cards succeed without a total-size rejection`, async t => {
    const f = subjectFixture(t, size);
    success(await f.invoke('delete'), subjectConfig, 'delete');
    assertSubjectCleanup(f);
    assert.equal(f.chunks().length, Math.ceil(size / CHUNK_SIZE));
    assert.equal(f.chunks().reduce((total, chunk) => total + chunk.result.deleted, 0), size);
    const seal = f.attempts[0];
    assert.deepEqual([...seal.reads.keys()], [USER, f.target, f.marker]);
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
  test(`subject chunks: reviewQueue ${String(initial)} retains normalization and floor zero`, async t => {
    const f = subjectFixture(t, 201);
    f.docs.set(STUDY, { reviewQueue: initial, unrelated: 'preserved' });
    success(await f.invoke('delete'), subjectConfig, 'delete');
    assertSubjectCleanup(f, 2, 0);
  });
}
