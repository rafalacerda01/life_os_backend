import assert from 'node:assert/strict';
import test from 'node:test';

import { Timestamp } from 'firebase-admin/firestore';

import { validateHabitPayload } from '../api/activity/_shared.js';
import taskHandler, {
  completeTaskActivity,
} from '../api/activity/task-complete.js';
import habitHandler, {
  completeHabitActivity as retiredHabitCompletion,
} from '../api/activity/habit-complete.js';
import {
  ACTIVITY_EVENT_SOURCE,
  ACTIVITY_EVENT_TYPES,
  habitEventId,
  recordVerifiedActivity,
  taskEventId,
  utcDayKey,
} from '../api/activity/_verified_events.js';
import {
  syncHabitCompletionUpdate,
  syncHabitUpdate,
  syncTaskUpdate,
} from '../api/activity/_sync_updates.js';

const UID = 'user-1';
const TASK_ID = 'task-1';
const HABIT_ID = 'habit-1';
const HABIT_COMPLETION_ID = '7d287d4e-190f-42ab-90a8-a93696f8c462';
const TASK_NOW = Timestamp.fromDate(new Date('2026-08-18T12:34:56.000Z'));
const HABIT_NOW = Timestamp.fromDate(new Date('2026-08-18T23:59:59.000Z'));

async function completeHabitActivity({ body, db, uid, now }) {
  const { habitId } = validateHabitPayload(body);
  const dayKey = utcDayKey(now);
  const result = await recordVerifiedActivity({
    db,
    uid,
    resourceId: habitId,
    resourceKind: 'habit',
    type: ACTIVITY_EVENT_TYPES.HABIT,
    eventId: habitEventId(habitId, dayKey),
    dayKey,
    now,
  });
  return {
    body: {
      type: ACTIVITY_EVENT_TYPES.HABIT,
      resourceId: habitId,
      dayKey,
      occurredAt: result.event.occurredAt.toDate().toISOString(),
      replayed: result.replayed,
    },
  };
}

class FakeDocumentReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  collection(name) {
    return new FakeCollectionReference(this.db, `${this.path}/${name}`);
  }
}

class FakeCollectionReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  doc(id) {
    return new FakeDocumentReference(this.db, `${this.path}/${id}`);
  }
}

class FakeDocumentSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.exists = data !== undefined;
    this._data = data;
  }

  data() {
    return this._data;
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
    this.operations = [];
    this.writes = [];
    this.hasWritten = false;
  }

  async get(ref) {
    if (this.hasWritten) throw new Error('read after write');
    this.operations.push({ type: 'read', path: ref.path });
    return new FakeDocumentSnapshot(ref, this.db.store.get(ref.path));
  }

  create(ref, data) {
    this.hasWritten = true;
    this.operations.push({ type: 'write', operation: 'create', path: ref.path });
    this.writes.push({ type: 'create', ref, data });
  }

  update(ref, data) {
    this.hasWritten = true;
    this.operations.push({ type: 'write', operation: 'update', path: ref.path });
    this.writes.push({ type: 'update', ref, data });
  }

  commit() {
    const nextStore = new Map(this.db.store);
    for (const write of this.writes) {
      if (write.type === 'create') {
        if (nextStore.has(write.ref.path)) {
          throw new Error(`already exists: ${write.ref.path}`);
        }
        nextStore.set(write.ref.path, write.data);
      } else {
        if (!nextStore.has(write.ref.path)) {
          throw new Error(`missing update: ${write.ref.path}`);
        }
        nextStore.set(write.ref.path, {
          ...nextStore.get(write.ref.path),
          ...write.data,
        });
      }
    }
    this.db.store = nextStore;
  }
}

class FakeFirestore {
  constructor() {
    this.store = new Map();
    this.transactions = [];
  }

  collection(name) {
    return new FakeCollectionReference(this, name);
  }

  seed(path, data) {
    this.store.set(path, data);
  }

  data(path) {
    return this.store.get(path);
  }

  async runTransaction(callback) {
    const transaction = new FakeTransaction(this);
    this.transactions.push(transaction);
    const result = await callback(transaction);
    transaction.commit();
    return result;
  }
}

function validTask(overrides = {}) {
  return {
    title: 'Ship verified activity',
    priority: 'high',
    isCompleted: true,
    date: Timestamp.fromDate(new Date('2026-08-20T09:00:00.000Z')),
    ...overrides,
  };
}

function validHabit(overrides = {}) {
  return {
    title: 'Read every day',
    completedDates: ['2026-08-18', '2026-08-19'],
    ...overrides,
  };
}

function storedTaskEvent(occurredAt, overrides = {}) {
  return {
    schemaVersion: 1,
    type: ACTIVITY_EVENT_TYPES.TASK,
    source: ACTIVITY_EVENT_SOURCE,
    uid: UID,
    resourceId: TASK_ID,
    occurredAt,
    ...overrides,
  };
}

function storedHabitEvent(occurredAt, dayKey = '2026-08-18', overrides = {}) {
  return {
    schemaVersion: 1,
    type: ACTIVITY_EVENT_TYPES.HABIT,
    source: ACTIVITY_EVENT_SOURCE,
    uid: UID,
    resourceId: HABIT_ID,
    dayKey,
    occurredAt,
    ...overrides,
  };
}

function taskPath(taskId = TASK_ID) {
  return `users/${UID}/tasks/${taskId}`;
}

function habitPath(habitId = HABIT_ID) {
  return `users/${UID}/habits/${habitId}`;
}

function activityPath(eventId) {
  return `users/${UID}/verified_activity_events/${eventId}`;
}

function activityOperationPath(operationId = HABIT_COMPLETION_ID) {
  return `users/${UID}/verified_activity_operations/${operationId}`;
}

function seedTask(db, { user = {}, task = validTask(), taskId = TASK_ID } = {}) {
  db.seed(`users/${UID}`, user);
  db.seed(taskPath(taskId), task);
}

function seedHabit(
  db,
  { user = {}, habit = validHabit(), habitId = HABIT_ID } = {},
) {
  db.seed(`users/${UID}`, user);
  db.seed(habitPath(habitId), habit);
}

async function expectActivityError(promise, statusCode, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  });
}

test('TASK missing resource returns TASK_NOT_FOUND', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});

  await expectActivityError(
    completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW }),
    404,
    'TASK_NOT_FOUND',
  );
});

test('TASK missing user returns USER_NOT_FOUND', async () => {
  const db = new FakeFirestore();
  db.seed(taskPath(), validTask());

  await expectActivityError(
    completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW }),
    404,
    'USER_NOT_FOUND',
  );
});

test('TASK rejects invalid taskId values', async () => {
  for (const taskId of ['', '   ', 'tasks/task-1', 'x'.repeat(129), 123]) {
    await expectActivityError(
      completeTaskActivity({ body: { taskId }, db: new FakeFirestore(), uid: UID, now: TASK_NOW }),
      400,
      'INVALID_ACTIVITY_PAYLOAD',
    );
  }
});

test('TASK rejects payload with any extra field', async () => {
  await expectActivityError(
    completeTaskActivity({
      body: { taskId: TASK_ID, circleId: 'circle-1' },
      db: new FakeFirestore(),
      uid: UID,
      now: TASK_NOW,
    }),
    400,
    'INVALID_ACTIVITY_PAYLOAD',
  );
});

test('valid TASK creates one immutable verified event', async () => {
  const db = new FakeFirestore();
  seedTask(db);

  const result = await completeTaskActivity({
    body: { taskId: `  ${TASK_ID}  ` },
    db,
    uid: UID,
    now: TASK_NOW,
  });

  assert.equal(result.body.replayed, false);
  assert.deepEqual(db.data(activityPath(taskEventId(TASK_ID))), {
    schemaVersion: 1,
    type: ACTIVITY_EVENT_TYPES.TASK,
    source: ACTIVITY_EVENT_SOURCE,
    uid: UID,
    resourceId: TASK_ID,
    occurredAt: TASK_NOW,
  });
});

test('TASK replay returns replayed true without a second write', async () => {
  const db = new FakeFirestore();
  seedTask(db);
  await completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW });
  const replay = await completeTaskActivity({
    body: { taskId: TASK_ID },
    db,
    uid: UID,
    now: Timestamp.fromMillis(TASK_NOW.toMillis() + 60_000),
  });

  assert.equal(replay.body.replayed, true);
  assert.equal(db.transactions[1].writes.length, 0);
});

test('TASK replay preserves the original occurredAt', async () => {
  const db = new FakeFirestore();
  seedTask(db);
  await completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW });
  const later = Timestamp.fromMillis(TASK_NOW.toMillis() + 3_600_000);
  const replay = await completeTaskActivity({
    body: { taskId: TASK_ID },
    db,
    uid: UID,
    now: later,
  });

  assert.equal(replay.body.occurredAt, TASK_NOW.toDate().toISOString());
  assert.equal(db.data(activityPath(taskEventId(TASK_ID))).occurredAt, TASK_NOW);
});

test('malformed stored TASK event returns state conflict without overwrite', async () => {
  const db = new FakeFirestore();
  seedTask(db);
  const path = activityPath(taskEventId(TASK_ID));
  const malformed = { schemaVersion: 1, type: 'TASK_COMPLETION' };
  db.seed(path, malformed);

  await expectActivityError(
    completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW }),
    409,
    'ACTIVITY_EVENT_STATE_CONFLICT',
  );
  assert.equal(db.data(path), malformed);
});

test('TASK with invalid title fails closed', async () => {
  const db = new FakeFirestore();
  seedTask(db, { task: validTask({ title: '   ' }) });

  await expectActivityError(
    completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW }),
    409,
    'ACTIVITY_RESOURCE_STATE_CONFLICT',
  );
});

test('TASK with invalid priority fails closed', async () => {
  const db = new FakeFirestore();
  seedTask(db, { task: validTask({ priority: 'urgent' }) });

  await expectActivityError(
    completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW }),
    409,
    'ACTIVITY_RESOURCE_STATE_CONFLICT',
  );
});

test('TASK isCompleted=false creates no event or progress', async () => {
  const db = new FakeFirestore();
  seedTask(db, { task: validTask({ isCompleted: false }) });

  await expectActivityError(
    completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW }),
    409,
    'ACTIVITY_RESOURCE_STATE_CONFLICT',
  );
  assert.equal(db.data(activityPath(taskEventId(TASK_ID))), undefined);
});

test('TASK without isCompleted creates no event or progress', async () => {
  const db = new FakeFirestore();
  const task = validTask();
  delete task.isCompleted;
  seedTask(db, { task });

  await expectActivityError(
    completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW }),
    409,
    'ACTIVITY_RESOURCE_STATE_CONFLICT',
  );
  assert.equal(db.data(activityPath(taskEventId(TASK_ID))), undefined);
});

test('two logical TASK executions persist exactly one event', async () => {
  const db = new FakeFirestore();
  seedTask(db);

  const first = await completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW });
  const second = await completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW });

  assert.equal(first.body.replayed, false);
  assert.equal(second.body.replayed, true);
  assert.equal([...db.store.keys()].filter((path) => path.includes('/verified_activity_events/')).length, 1);
});

test('TASK event never changes personal isCompleted', async () => {
  const db = new FakeFirestore();
  const task = validTask({ isCompleted: true });
  seedTask(db, { task });

  await completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW });

  assert.equal(db.data(taskPath()).isCompleted, true);
  assert.deepEqual(db.data(taskPath()), task);
});

test('TASK event never changes tasksCount', async () => {
  const db = new FakeFirestore();
  seedTask(db, { user: { tasksCount: 17 } });

  await completeTaskActivity({ body: { taskId: TASK_ID }, db, uid: UID, now: TASK_NOW });

  assert.deepEqual(db.data(`users/${UID}`), { tasksCount: 17 });
});

test('HABIT missing resource returns HABIT_NOT_FOUND', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});

  await expectActivityError(
    completeHabitActivity({ body: { habitId: HABIT_ID }, db, uid: UID, now: HABIT_NOW }),
    404,
    'HABIT_NOT_FOUND',
  );
});

test('HABIT rejects invalid habitId values', async () => {
  for (const habitId of ['', ' ', 'habits/habit-1', 'x'.repeat(129), null]) {
    await expectActivityError(
      completeHabitActivity({ body: { habitId }, db: new FakeFirestore(), uid: UID, now: HABIT_NOW }),
      400,
      'INVALID_ACTIVITY_PAYLOAD',
    );
  }
});

test('valid HABIT creates one immutable verified event', async () => {
  const db = new FakeFirestore();
  seedHabit(db);

  const result = await completeHabitActivity({ body: { habitId: HABIT_ID }, db, uid: UID, now: HABIT_NOW });

  assert.equal(result.body.replayed, false);
  assert.deepEqual(db.data(activityPath(habitEventId(HABIT_ID, '2026-08-18'))), {
    schemaVersion: 1,
    type: ACTIVITY_EVENT_TYPES.HABIT,
    source: ACTIVITY_EVENT_SOURCE,
    uid: UID,
    resourceId: HABIT_ID,
    dayKey: '2026-08-18',
    occurredAt: HABIT_NOW,
  });
});

test('HABIT dayKey is derived from the server timestamp in UTC', async () => {
  const db = new FakeFirestore();
  seedHabit(db);
  const utcBoundary = Timestamp.fromDate(new Date('2026-08-19T00:00:00.000Z'));

  const result = await completeHabitActivity({ body: { habitId: HABIT_ID }, db, uid: UID, now: utcBoundary });

  assert.equal(result.body.dayKey, '2026-08-19');
  assert.ok(db.data(activityPath(habitEventId(HABIT_ID, '2026-08-19'))));
});

test('HABIT client cannot provide dayKey', async () => {
  await expectActivityError(
    completeHabitActivity({
      body: { habitId: HABIT_ID, dayKey: '2020-01-01' },
      db: new FakeFirestore(),
      uid: UID,
      now: HABIT_NOW,
    }),
    400,
    'INVALID_ACTIVITY_PAYLOAD',
  );
});

test('HABIT client cannot provide date', async () => {
  await expectActivityError(
    completeHabitActivity({
      body: { habitId: HABIT_ID, date: '2020-01-01' },
      db: new FakeFirestore(),
      uid: UID,
      now: HABIT_NOW,
    }),
    400,
    'INVALID_ACTIVITY_PAYLOAD',
  );
});

test('HABIT replay on the same UTC day never duplicates', async () => {
  const db = new FakeFirestore();
  seedHabit(db);
  await completeHabitActivity({ body: { habitId: HABIT_ID }, db, uid: UID, now: HABIT_NOW });
  const replay = await completeHabitActivity({
    body: { habitId: HABIT_ID },
    db,
    uid: UID,
    now: Timestamp.fromDate(new Date('2026-08-18T23:59:59.999Z')),
  });

  assert.equal(replay.body.replayed, true);
  assert.equal(db.transactions[1].writes.length, 0);
});

test('HABIT on a different UTC day creates a different eventId', async () => {
  const db = new FakeFirestore();
  seedHabit(db);
  await completeHabitActivity({ body: { habitId: HABIT_ID }, db, uid: UID, now: HABIT_NOW });
  await completeHabitActivity({
    body: { habitId: HABIT_ID },
    db,
    uid: UID,
    now: Timestamp.fromDate(new Date('2026-08-19T00:00:00.000Z')),
  });

  assert.ok(db.data(activityPath(habitEventId(HABIT_ID, '2026-08-18'))));
  assert.ok(db.data(activityPath(habitEventId(HABIT_ID, '2026-08-19'))));
});

test('malformed stored HABIT event returns state conflict', async () => {
  const db = new FakeFirestore();
  seedHabit(db);
  const path = activityPath(habitEventId(HABIT_ID, '2026-08-18'));
  const malformed = {
    schemaVersion: 1,
    type: ACTIVITY_EVENT_TYPES.HABIT,
    source: ACTIVITY_EVENT_SOURCE,
    uid: UID,
    resourceId: HABIT_ID,
    dayKey: '2026-08-17',
    occurredAt: HABIT_NOW,
  };
  db.seed(path, malformed);

  await expectActivityError(
    completeHabitActivity({ body: { habitId: HABIT_ID }, db, uid: UID, now: HABIT_NOW }),
    409,
    'ACTIVITY_EVENT_STATE_CONFLICT',
  );
  assert.equal(db.data(path), malformed);
});

test('HABIT with malformed completedDates fails closed', async () => {
  for (const completedDates of ['2026-08-18', ['x'.repeat(21)], Array(5001).fill('x')]) {
    const db = new FakeFirestore();
    seedHabit(db, { habit: validHabit({ completedDates }) });
    await expectActivityError(
      completeHabitActivity({ body: { habitId: HABIT_ID }, db, uid: UID, now: HABIT_NOW }),
      409,
      'ACTIVITY_RESOURCE_STATE_CONFLICT',
    );
  }
});

test('HABIT without the server dayKey creates no event or progress', async () => {
  const db = new FakeFirestore();
  seedHabit(db, {
    habit: validHabit({ completedDates: ['2026-08-17'] }),
  });

  await expectActivityError(
    completeHabitActivity({ body: { habitId: HABIT_ID }, db, uid: UID, now: HABIT_NOW }),
    409,
    'ACTIVITY_RESOURCE_STATE_CONFLICT',
  );
  assert.equal(
    db.data(activityPath(habitEventId(HABIT_ID, '2026-08-18'))),
    undefined,
  );
});

test('retroactive HABIT history creates no additional events', async () => {
  const db = new FakeFirestore();
  seedHabit(db, {
    habit: validHabit({ completedDates: ['2020-01-01', '2021-02-02', '2026-08-18'] }),
  });

  await completeHabitActivity({ body: { habitId: HABIT_ID }, db, uid: UID, now: HABIT_NOW });

  assert.equal([...db.store.keys()].filter((path) => path.includes('/verified_activity_events/')).length, 1);
  assert.ok(db.data(activityPath(habitEventId(HABIT_ID, '2026-08-18'))));
});

test('HABIT event never changes completedDates', async () => {
  const db = new FakeFirestore();
  const habit = validHabit({ completedDates: ['2026-08-18'] });
  seedHabit(db, { habit });

  await completeHabitActivity({ body: { habitId: HABIT_ID }, db, uid: UID, now: HABIT_NOW });

  assert.deepEqual(db.data(habitPath()), habit);
});

test('HABIT event never changes habitsCount', async () => {
  const db = new FakeFirestore();
  seedHabit(db, { user: { habitsCount: 9 } });

  await completeHabitActivity({ body: { habitId: HABIT_ID }, db, uid: UID, now: HABIT_NOW });

  assert.deepEqual(db.data(`users/${UID}`), { habitsCount: 9 });
});

test('TASK and HABIT perform every read before their first write', async () => {
  const taskDb = new FakeFirestore();
  seedTask(taskDb);
  await completeTaskActivity({ body: { taskId: TASK_ID }, db: taskDb, uid: UID, now: TASK_NOW });
  const habitDb = new FakeFirestore();
  seedHabit(habitDb);
  await completeHabitActivity({ body: { habitId: HABIT_ID }, db: habitDb, uid: UID, now: HABIT_NOW });

  for (const db of [taskDb, habitDb]) {
    assert.deepEqual(db.transactions[0].operations.map((entry) => entry.type), [
      'read',
      'read',
      'read',
      'write',
    ]);
  }
});

test('verified event IDs are deterministic and type-separated', () => {
  assert.equal(taskEventId(TASK_ID), 'TASK_COMPLETION__task-1');
  assert.equal(
    habitEventId(HABIT_ID, '2026-08-18'),
    'HABIT_COMPLETION__habit-1__2026-08-18',
  );
  assert.notEqual(taskEventId(TASK_ID), habitEventId(TASK_ID, '2026-08-18'));
});

test('request payload cannot choose uid', async () => {
  for (const operation of [
    completeTaskActivity({
      body: { taskId: TASK_ID, uid: 'attacker' },
      db: new FakeFirestore(),
      uid: UID,
      now: TASK_NOW,
    }),
    completeHabitActivity({
      body: { habitId: HABIT_ID, userId: 'attacker' },
      db: new FakeFirestore(),
      uid: UID,
      now: HABIT_NOW,
    }),
  ]) {
    await expectActivityError(operation, 400, 'INVALID_ACTIVITY_PAYLOAD');
  }
});

test('success responses do not expose uid or internal data', async () => {
  const taskDb = new FakeFirestore();
  seedTask(taskDb);
  const result = await completeTaskActivity({ body: { taskId: TASK_ID }, db: taskDb, uid: UID, now: TASK_NOW });
  const serialized = JSON.stringify(result.body);

  assert.equal(serialized.includes(UID), false);
  for (const key of ['circleId', 'eventId', 'path', 'source', 'schemaVersion']) {
    assert.equal(Object.hasOwn(result.body, key), false);
  }
});

test('TASK and HABIT occurredAt are server-owned Timestamps', async () => {
  const taskDb = new FakeFirestore();
  seedTask(taskDb);
  await completeTaskActivity({ body: { taskId: TASK_ID }, db: taskDb, uid: UID, now: TASK_NOW });
  const habitDb = new FakeFirestore();
  seedHabit(habitDb);
  await completeHabitActivity({ body: { habitId: HABIT_ID }, db: habitDb, uid: UID, now: HABIT_NOW });

  assert.equal(dbTimestamp(taskDb, taskEventId(TASK_ID)), TASK_NOW);
  assert.equal(dbTimestamp(habitDb, habitEventId(HABIT_ID, '2026-08-18')), HABIT_NOW);
});

test('transaction-backed retries remain idempotent for both resource types', async () => {
  const taskDb = new FakeFirestore();
  seedTask(taskDb);
  const habitDb = new FakeFirestore();
  seedHabit(habitDb);

  for (let index = 0; index < 3; index++) {
    await completeTaskActivity({ body: { taskId: TASK_ID }, db: taskDb, uid: UID, now: TASK_NOW });
    await completeHabitActivity({ body: { habitId: HABIT_ID }, db: habitDb, uid: UID, now: HABIT_NOW });
  }

  assert.equal(countEvents(taskDb), 1);
  assert.equal(countEvents(habitDb), 1);
});

test('HTTP domain response contracts remain minimal', async () => {
  const taskDb = new FakeFirestore();
  seedTask(taskDb);
  const taskResult = await completeTaskActivity({ body: { taskId: TASK_ID }, db: taskDb, uid: UID, now: TASK_NOW });
  const habitDb = new FakeFirestore();
  seedHabit(habitDb);
  const habitResult = await completeHabitActivity({ body: { habitId: HABIT_ID }, db: habitDb, uid: UID, now: HABIT_NOW });

  assert.deepEqual(Object.keys(taskResult.body).sort(), [
    'occurredAt',
    'replayed',
    'resourceId',
    'type',
  ]);
  assert.deepEqual(Object.keys(habitResult.body).sort(), [
    'dayKey',
    'occurredAt',
    'replayed',
    'resourceId',
    'type',
  ]);
});

test('activity endpoint modules export runtime handlers', () => {
  assert.equal(typeof taskHandler, 'function');
  assert.equal(typeof habitHandler, 'function');
  assert.equal(typeof completeTaskActivity, 'function');
  assert.equal(typeof retiredHabitCompletion, 'function');
});

test('legacy HABIT completion is retired before any Firestore access', async () => {
  const db = new FakeFirestore();
  seedHabit(db);

  await expectActivityError(
    retiredHabitCompletion({
      body: { habitId: HABIT_ID },
      db,
      uid: UID,
      now: HABIT_NOW,
    }),
    410,
    'HABIT_ACTIVITY_ENDPOINT_RETIRED',
  );

  assert.equal(db.transactions.length, 0);
  assert.equal(countEvents(db), 0);
});

test('HABIT replay rejects occurredAt from the previous UTC day', async () => {
  const db = new FakeFirestore();
  seedHabit(db);
  const path = activityPath(habitEventId(HABIT_ID, '2026-08-18'));
  const storedEvent = storedHabitEvent(
    Timestamp.fromDate(new Date('2026-08-17T23:59:59.999Z')),
  );
  db.seed(path, storedEvent);

  await expectActivityError(
    completeHabitActivity({
      body: { habitId: HABIT_ID },
      db,
      uid: UID,
      now: HABIT_NOW,
    }),
    409,
    'ACTIVITY_EVENT_STATE_CONFLICT',
  );

  assert.equal(db.data(path), storedEvent);
  assert.equal(db.transactions[0].writes.length, 0);
});

test('HABIT replay rejects occurredAt from the following UTC day', async () => {
  const db = new FakeFirestore();
  seedHabit(db);
  const path = activityPath(habitEventId(HABIT_ID, '2026-08-18'));
  const storedEvent = storedHabitEvent(
    Timestamp.fromDate(new Date('2026-08-19T00:00:00.000Z')),
  );
  db.seed(path, storedEvent);

  await expectActivityError(
    completeHabitActivity({
      body: { habitId: HABIT_ID },
      db,
      uid: UID,
      now: HABIT_NOW,
    }),
    409,
    'ACTIVITY_EVENT_STATE_CONFLICT',
  );

  assert.equal(db.data(path), storedEvent);
  assert.equal(db.transactions[0].writes.length, 0);
});

test('HABIT replay accepts occurredAt within the same UTC day', async () => {
  const db = new FakeFirestore();
  seedHabit(db);
  const occurredAt = Timestamp.fromDate(
    new Date('2026-08-18T00:00:00.000Z'),
  );
  db.seed(
    activityPath(habitEventId(HABIT_ID, '2026-08-18')),
    storedHabitEvent(occurredAt),
  );

  const result = await completeHabitActivity({
    body: { habitId: HABIT_ID },
    db,
    uid: UID,
    now: HABIT_NOW,
  });

  assert.equal(result.body.replayed, true);
  assert.equal(result.body.occurredAt, occurredAt.toDate().toISOString());
  assert.equal(db.transactions[0].writes.length, 0);
});

test('TASK replay rejects stored occurredAt in the future', async () => {
  const db = new FakeFirestore();
  seedTask(db);
  const path = activityPath(taskEventId(TASK_ID));
  const storedEvent = storedTaskEvent(
    Timestamp.fromMillis(TASK_NOW.toMillis() + 1),
  );
  db.seed(path, storedEvent);

  await expectActivityError(
    completeTaskActivity({
      body: { taskId: TASK_ID },
      db,
      uid: UID,
      now: TASK_NOW,
    }),
    409,
    'ACTIVITY_EVENT_STATE_CONFLICT',
  );

  assert.equal(db.data(path), storedEvent);
  assert.equal(db.transactions[0].writes.length, 0);
});

test('HABIT replay rejects future occurredAt within the same UTC day', async () => {
  const db = new FakeFirestore();
  seedHabit(db);
  const now = Timestamp.fromDate(new Date('2026-08-18T12:00:00.000Z'));
  const path = activityPath(habitEventId(HABIT_ID, '2026-08-18'));
  const storedEvent = storedHabitEvent(
    Timestamp.fromDate(new Date('2026-08-18T13:00:00.000Z')),
  );
  db.seed(path, storedEvent);

  await expectActivityError(
    completeHabitActivity({
      body: { habitId: HABIT_ID },
      db,
      uid: UID,
      now,
    }),
    409,
    'ACTIVITY_EVENT_STATE_CONFLICT',
  );

  assert.equal(db.data(path), storedEvent);
  assert.equal(db.transactions[0].writes.length, 0);
});

test('TASK replay accepts stored occurredAt at or before now', async () => {
  for (const occurredAt of [
    Timestamp.fromMillis(TASK_NOW.toMillis() - 1),
    TASK_NOW,
  ]) {
    const db = new FakeFirestore();
    seedTask(db);
    db.seed(
      activityPath(taskEventId(TASK_ID)),
      storedTaskEvent(occurredAt),
    );

    const result = await completeTaskActivity({
      body: { taskId: TASK_ID },
      db,
      uid: UID,
      now: TASK_NOW,
    });

    assert.equal(result.body.replayed, true);
    assert.equal(result.body.occurredAt, occurredAt.toDate().toISOString());
    assert.equal(db.transactions[0].writes.length, 0);
  }
});

test('sync TASK false confirms remote state without competitive event', async () => {
  const db = new FakeFirestore();
  seedTask(db, { task: validTask({ isCompleted: true }) });

  const result = await syncTaskUpdate({
    body: { operation: 'update_task', taskId: TASK_ID, isCompleted: false },
    db,
    uid: UID,
    now: TASK_NOW,
  });

  assert.equal(result.body.activityRecorded, false);
  assert.equal(db.data(taskPath()).isCompleted, false);
  assert.equal(db.data(activityPath(taskEventId(TASK_ID))), undefined);
});

test('sync TASK true confirms state and records one idempotent event', async () => {
  const db = new FakeFirestore();
  seedTask(db, { task: validTask({ isCompleted: false }) });

  const first = await syncTaskUpdate({
    body: { operation: 'update_task', taskId: TASK_ID, isCompleted: true },
    db,
    uid: UID,
    now: TASK_NOW,
  });
  const replay = await syncTaskUpdate({
    body: { operation: 'update_task', taskId: TASK_ID, isCompleted: true },
    db,
    uid: UID,
    now: TASK_NOW,
  });

  assert.equal(first.body.activityRecorded, true);
  assert.equal(first.body.replayed, false);
  assert.equal(replay.body.replayed, true);
  assert.equal(countEvents(db), 1);
});

test('normal HABIT updates never create competitive activity', async () => {
  const db = new FakeFirestore();
  seedHabit(db, { habit: validHabit({ completedDates: [] }) });

  const historical = await syncHabitUpdate({
    body: {
      operation: 'update_habit',
      habitId: HABIT_ID,
      completedDates: ['2026-08-17'],
    },
    db,
    uid: UID,
    now: HABIT_NOW,
  });
  const matrixToday = await syncHabitUpdate({
    body: {
      operation: 'update_habit',
      habitId: HABIT_ID,
      completedDates: ['2026-08-18'],
    },
    db,
    uid: UID,
    now: HABIT_NOW,
  });

  assert.equal(historical.body.activityRecorded, false);
  assert.equal(matrixToday.body.activityRecorded, false);
  assert.deepEqual(db.data(habitPath()).completedDates, ['2026-08-18']);
  assert.equal(countEvents(db), 0);
  assert.equal(db.data(activityOperationPath()), undefined);
});

test('first HABIT completion after UTC midnight records exactly one server-day event', async () => {
  const db = new FakeFirestore();
  seedHabit(db, { habit: validHabit({ completedDates: [] }) });
  const afterMidnight = Timestamp.fromDate(
    new Date('2026-08-24T00:05:00.000Z'),
  );

  const result = await syncHabitCompletionUpdate({
    body: {
      operation: 'update_habit_completion',
      habitId: HABIT_ID,
      completedDates: ['2026-08-23'],
      competitiveCompletionId: HABIT_COMPLETION_ID,
    },
    db,
    uid: UID,
    now: afterMidnight,
  });

  assert.equal(result.body.activityRecorded, true);
  assert.equal(countEvents(db), 1);
  assert.ok(db.data(activityPath(habitEventId(HABIT_ID, '2026-08-24'))));
  assert.equal(
    db.data(activityPath(habitEventId(HABIT_ID, '2026-08-23'))),
    undefined,
  );
  assert.equal(db.data(activityOperationPath()).dayKey, '2026-08-24');
});

test('HABIT completion retry on the same day is receipt-idempotent', async () => {
  const db = new FakeFirestore();
  seedHabit(db, { habit: validHabit({ completedDates: [] }) });
  const body = {
    operation: 'update_habit_completion',
    habitId: HABIT_ID,
    completedDates: ['2026-08-18'],
    competitiveCompletionId: HABIT_COMPLETION_ID,
  };

  await syncHabitCompletionUpdate({ body, db, uid: UID, now: HABIT_NOW });
  const replay = await syncHabitCompletionUpdate({
    body,
    db,
    uid: UID,
    now: Timestamp.fromDate(new Date('2026-08-18T23:59:59.999Z')),
  });

  assert.equal(replay.body.replayed, true);
  assert.equal(countEvents(db), 1);
  assert.equal(db.transactions[1].writes.length, 0);
});

test('HABIT completion retry after UTC midnight never creates a new-day event', async () => {
  const db = new FakeFirestore();
  seedHabit(db, { habit: validHabit({ completedDates: [] }) });
  const body = {
    operation: 'update_habit_completion',
    habitId: HABIT_ID,
    completedDates: ['2026-08-18'],
    competitiveCompletionId: HABIT_COMPLETION_ID,
  };

  await syncHabitCompletionUpdate({ body, db, uid: UID, now: HABIT_NOW });
  const replay = await syncHabitCompletionUpdate({
    body,
    db,
    uid: UID,
    now: Timestamp.fromDate(new Date('2026-08-19T00:05:00.000Z')),
  });

  assert.equal(replay.body.replayed, true);
  assert.equal(countEvents(db), 1);
  assert.ok(db.data(activityPath(habitEventId(HABIT_ID, '2026-08-18'))));
  assert.equal(
    db.data(activityPath(habitEventId(HABIT_ID, '2026-08-19'))),
    undefined,
  );
  assert.equal(db.transactions[1].writes.length, 0);
});

test('invalid HABIT competitive transition fails closed without activity', async () => {
  for (const completedDates of [
    [],
    ['2026-08-17', '2026-08-18'],
    ['2026-08-18', '2026-08-18'],
  ]) {
    const db = new FakeFirestore();
    seedHabit(db, { habit: validHabit({ completedDates: [] }) });

    await expectActivityError(
      syncHabitCompletionUpdate({
        body: {
          operation: 'update_habit_completion',
          habitId: HABIT_ID,
          completedDates,
          competitiveCompletionId: HABIT_COMPLETION_ID,
        },
        db,
        uid: UID,
        now: HABIT_NOW,
      }),
      409,
      'ACTIVITY_RESOURCE_STATE_CONFLICT',
    );
    assert.equal(countEvents(db), 0);
    assert.equal(db.data(activityOperationPath()), undefined);
  }
});

test('HABIT completion receipt rejects payload mutation on replay', async () => {
  const db = new FakeFirestore();
  seedHabit(db, { habit: validHabit({ completedDates: [] }) });
  const body = {
    operation: 'update_habit_completion',
    habitId: HABIT_ID,
    completedDates: ['2026-08-18'],
    competitiveCompletionId: HABIT_COMPLETION_ID,
  };
  await syncHabitCompletionUpdate({ body, db, uid: UID, now: HABIT_NOW });

  await expectActivityError(
    syncHabitCompletionUpdate({
      body: { ...body, completedDates: ['2026-08-19'] },
      db,
      uid: UID,
      now: Timestamp.fromDate(new Date('2026-08-19T12:00:00.000Z')),
    }),
    409,
    'ACTIVITY_OPERATION_STATE_CONFLICT',
  );
  assert.deepEqual(db.data(habitPath()).completedDates, ['2026-08-18']);
  assert.equal(countEvents(db), 1);
});

test('rejected competitive sync payload performs no write', async () => {
  const db = new FakeFirestore();
  seedTask(db, { task: validTask({ isCompleted: false }) });

  await expectActivityError(
    syncTaskUpdate({
      body: {
        operation: 'update_task',
        taskId: TASK_ID,
        isCompleted: true,
        uid: 'attacker',
      },
      db,
      uid: UID,
      now: TASK_NOW,
    }),
    400,
    'INVALID_SYNC_PAYLOAD',
  );
  assert.equal(db.transactions.length, 0);
  assert.equal(db.data(taskPath()).isCompleted, false);
  assert.equal(countEvents(db), 0);
});

function countEvents(db) {
  return [...db.store.keys()].filter((path) =>
    path.includes('/verified_activity_events/'),
  ).length;
}

function dbTimestamp(db, eventId) {
  return db.data(activityPath(eventId)).occurredAt;
}
