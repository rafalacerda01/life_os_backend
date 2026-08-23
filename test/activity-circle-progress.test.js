import assert from 'node:assert/strict';
import test from 'node:test';

import { Timestamp } from 'firebase-admin/firestore';

import {
  completeHabitActivity as retiredHabitCompletion,
} from '../api/activity/habit-complete.js';
import { completeTaskActivity } from '../api/activity/task-complete.js';
import { MAX_CIRCLE_PROGRESS_CHALLENGES } from '../api/activity/_circle_progress.js';
import {
  syncHabitCompletionUpdate,
  syncHabitUpdate,
  syncTaskUpdate,
} from '../api/activity/_sync_updates.js';
import {
  ACTIVITY_EVENT_SOURCE,
  ACTIVITY_EVENT_TYPES,
  habitEventId,
  recordVerifiedActivity,
  taskEventId,
  utcDayKey,
} from '../api/activity/_verified_events.js';

const UID = 'user-1';
const CIRCLE_ID = 'circle-1';
const TASK_ID = 'task-1';
const HABIT_ID = 'habit-1';
const EVENT_AT = Timestamp.fromDate(new Date('2026-08-18T12:00:00.000Z'));

class FakeDocumentReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.kind = 'document';
  }

  collection(name) {
    return new FakeCollectionReference(this.db, `${this.path}/${name}`);
  }
}

class FakeCollectionReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.kind = 'collection';
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

    if (ref.kind === 'collection') {
      const prefix = `${ref.path}/`;
      const docs = [];
      for (const [path, data] of this.db.store) {
        if (!path.startsWith(prefix)) continue;
        const suffix = path.slice(prefix.length);
        if (!suffix || suffix.includes('/')) continue;
        docs.push(
          new FakeDocumentSnapshot(
            new FakeDocumentReference(this.db, path),
            data,
          ),
        );
      }
      return { docs };
    }

    return new FakeDocumentSnapshot(ref, this.db.store.get(ref.path));
  }

  create(ref, data) {
    this.#write('create', ref, data);
  }

  update(ref, data) {
    this.#write('update', ref, data);
  }

  #write(type, ref, data) {
    this.hasWritten = true;
    this.operations.push({ type: 'write', operation: type, path: ref.path });
    this.writes.push({ type, ref, data });
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

function validCircle(overrides = {}) {
  return {
    name: 'Activity Circle',
    description: 'Verified activity fixture',
    adminId: UID,
    memberCount: 1,
    memberLimit: 3,
    createdAt: Timestamp.fromMillis(EVENT_AT.toMillis() - 60_000),
    updatedAt: Timestamp.fromMillis(EVENT_AT.toMillis() - 30_000),
    schemaVersion: 2,
    ...overrides,
  };
}

function validMember(overrides = {}) {
  return {
    role: 'admin',
    displayNameSnapshot: 'Test User',
    photoUrlSnapshot: null,
    joinedAt: Timestamp.fromMillis(EVENT_AT.toMillis() - 1),
    ...overrides,
  };
}

function validTask(overrides = {}) {
  return {
    title: 'Complete secure task',
    priority: 'high',
    isCompleted: true,
    ...overrides,
  };
}

function validHabit(overrides = {}) {
  return {
    title: 'Complete secure habit',
    completedDates: ['2026-08-18'],
    ...overrides,
  };
}

function challenge(type, overrides = {}) {
  return {
    type,
    startAt: Timestamp.fromMillis(EVENT_AT.toMillis() - 1),
    endAt: Timestamp.fromMillis(EVENT_AT.toMillis() + 1),
    schemaVersion: 2,
    ...overrides,
  };
}

function createFixture({
  kind = 'task',
  activeCircleId = CIRCLE_ID,
  includeCircle = true,
  includeMember = true,
  circleOverrides = {},
  memberOverrides = {},
  resourceOverrides = {},
  userOverrides = {},
  challenges = [],
} = {}) {
  const db = new FakeFirestore();
  const user = { tasksCount: 7, habitsCount: 5, ...userOverrides };
  if (activeCircleId !== undefined) user.activeCircleId = activeCircleId;
  db.seed(`users/${UID}`, user);

  if (kind === 'task') {
    db.seed(`users/${UID}/tasks/${TASK_ID}`, validTask(resourceOverrides));
  } else {
    db.seed(`users/${UID}/habits/${HABIT_ID}`, validHabit(resourceOverrides));
  }

  if (activeCircleId === CIRCLE_ID) {
    if (includeCircle) {
      db.seed(`circles/${CIRCLE_ID}`, validCircle(circleOverrides));
    }
    if (includeMember) {
      db.seed(
        `circles/${CIRCLE_ID}/members/${UID}`,
        validMember(memberOverrides),
      );
    }
    for (const [id, data] of challenges) {
      db.seed(`circles/${CIRCLE_ID}/challenges/${id}`, data);
    }
  }

  return { db, kind };
}

async function complete(fixture, now = EVENT_AT) {
  if (fixture.kind === 'task') {
    return completeTaskActivity({
      body: { taskId: TASK_ID },
      db: fixture.db,
      uid: UID,
      now,
    });
  }
  const dayKey = utcDayKey(now);
  const result = await recordVerifiedActivity({
    db: fixture.db,
    uid: UID,
    resourceId: HABIT_ID,
    resourceKind: 'habit',
    type: ACTIVITY_EVENT_TYPES.HABIT,
    eventId: habitEventId(HABIT_ID, dayKey),
    dayKey,
    now,
  });
  return {
    body: {
      type: ACTIVITY_EVENT_TYPES.HABIT,
      resourceId: HABIT_ID,
      dayKey,
      occurredAt: result.event.occurredAt.toDate().toISOString(),
      replayed: result.replayed,
    },
  };
}

function activityId(kind, occurredAt = EVENT_AT) {
  return kind === 'task'
    ? taskEventId(TASK_ID)
    : habitEventId(HABIT_ID, utcDayKey(occurredAt));
}

function activityPath(kind, occurredAt = EVENT_AT) {
  return `users/${UID}/verified_activity_events/${activityId(kind, occurredAt)}`;
}

function progressPath(challengeId) {
  return `circles/${CIRCLE_ID}/challenges/${challengeId}/progress/${UID}`;
}

function processedPath(challengeId, kind = 'task', occurredAt = EVENT_AT) {
  return `circles/${CIRCLE_ID}/challenges/${challengeId}/processed_events/${activityId(kind, occurredAt)}`;
}

function circleWrites(db, transactionIndex = 0) {
  return db.transactions[transactionIndex].writes.filter((write) =>
    write.ref.path.startsWith('circles/'),
  );
}

function seedStoredEvent(fixture, occurredAt = EVENT_AT) {
  const type =
    fixture.kind === 'task'
      ? ACTIVITY_EVENT_TYPES.TASK
      : ACTIVITY_EVENT_TYPES.HABIT;
  const event = {
    schemaVersion: 1,
    type,
    source: ACTIVITY_EVENT_SOURCE,
    uid: UID,
    resourceId: fixture.kind === 'task' ? TASK_ID : HABIT_ID,
    ...(fixture.kind === 'habit' ? { dayKey: utcDayKey(occurredAt) } : {}),
    occurredAt,
  };
  fixture.db.seed(activityPath(fixture.kind, occurredAt), event);
  return event;
}

test('Task without activeCircleId creates event with zero Circle writes', async () => {
  const fixture = createFixture({ activeCircleId: undefined });
  await complete(fixture);
  assert.ok(fixture.db.data(activityPath('task')));
  assert.equal(circleWrites(fixture.db).length, 0);
});

test('Habit without activeCircleId creates event with zero Circle writes', async () => {
  const fixture = createFixture({ kind: 'habit', activeCircleId: undefined });
  await complete(fixture);
  assert.ok(fixture.db.data(activityPath('habit')));
  assert.equal(circleWrites(fixture.db).length, 0);
});

test('invalid activeCircleId creates event with zero Circle progress', async () => {
  const fixture = createFixture({ activeCircleId: 'invalid/circle' });
  await complete(fixture);
  assert.ok(fixture.db.data(activityPath('task')));
  assert.equal(circleWrites(fixture.db).length, 0);
});

test('missing Circle creates verified event with zero progress', async () => {
  const fixture = createFixture({ includeCircle: false });
  await complete(fixture);
  assert.ok(fixture.db.data(activityPath('task')));
  assert.equal(circleWrites(fixture.db).length, 0);
});

test('malformed Circle V2 fails closed only for competition', async () => {
  const fixture = createFixture({ circleOverrides: { memberCount: 0 } });
  await complete(fixture);
  assert.ok(fixture.db.data(activityPath('task')));
  assert.equal(circleWrites(fixture.db).length, 0);
});

test('missing membership fails closed only for competition', async () => {
  const fixture = createFixture({ includeMember: false });
  await complete(fixture);
  assert.ok(fixture.db.data(activityPath('task')));
  assert.equal(circleWrites(fixture.db).length, 0);
});

test('membership after event receives zero progress', async () => {
  const fixture = createFixture({
    memberOverrides: {
      joinedAt: Timestamp.fromMillis(EVENT_AT.toMillis() + 1),
    },
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')), undefined);
});

test('membership exactly at occurredAt is eligible', async () => {
  const fixture = createFixture({
    memberOverrides: { joinedAt: EVENT_AT },
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')).value, 1);
});

test('admin and member role incoherence fails closed', async () => {
  for (const options of [
    { memberOverrides: { role: 'member' } },
    {
      circleOverrides: { adminId: 'other-admin' },
      memberOverrides: { role: 'admin' },
    },
  ]) {
    const fixture = createFixture({
      ...options,
      challenges: [['task', challenge('TASK_COMPLETIONS')]],
    });
    await complete(fixture);
    assert.equal(fixture.db.data(progressPath('task')), undefined);
  }
});

test('TASK_COMPLETION credits TASK_COMPLETIONS by one', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')).value, 1);
});

test('TASK_COMPLETION never credits HABIT_COMPLETIONS', async () => {
  const fixture = createFixture({
    challenges: [['habit', challenge('HABIT_COMPLETIONS')]],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('habit')), undefined);
});

test('HABIT_COMPLETION credits HABIT_COMPLETIONS by one', async () => {
  const fixture = createFixture({
    kind: 'habit',
    challenges: [['habit', challenge('HABIT_COMPLETIONS')]],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('habit')).value, 1);
});

test('HABIT_COMPLETION never credits TASK_COMPLETIONS', async () => {
  const fixture = createFixture({
    kind: 'habit',
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')), undefined);
});

test('challenge startAt equal to occurredAt is inclusive', async () => {
  const fixture = createFixture({
    challenges: [
      ['task', challenge('TASK_COMPLETIONS', { startAt: EVENT_AT })],
    ],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')).value, 1);
});

test('challenge endAt equal to occurredAt is inclusive', async () => {
  const fixture = createFixture({
    challenges: [
      ['task', challenge('TASK_COMPLETIONS', { endAt: EVENT_AT })],
    ],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')).value, 1);
});

test('event before challenge startAt receives zero progress', async () => {
  const fixture = createFixture({
    challenges: [[
      'task',
      challenge('TASK_COMPLETIONS', {
        startAt: Timestamp.fromMillis(EVENT_AT.toMillis() + 1),
      }),
    ]],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')), undefined);
});

test('event after challenge endAt receives zero progress', async () => {
  const fixture = createFixture({
    challenges: [[
      'task',
      challenge('TASK_COMPLETIONS', {
        endAt: Timestamp.fromMillis(EVENT_AT.toMillis() - 1),
      }),
    ]],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')), undefined);
});

test('two eligible Challenges both receive one credit', async () => {
  const fixture = createFixture({
    challenges: [
      ['task-a', challenge('TASK_COMPLETIONS')],
      ['task-b', challenge('TASK_COMPLETIONS')],
    ],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task-a')).value, 1);
  assert.equal(fixture.db.data(progressPath('task-b')).value, 1);
});

test('missing progress is created with value one', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  await complete(fixture);
  assert.deepEqual(fixture.db.data(progressPath('task')), {
    value: 1,
    updatedAt: EVENT_AT,
    lastEventAt: EVENT_AT,
  });
});

test('valid existing progress increments exactly one', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  const previousAt = Timestamp.fromMillis(EVENT_AT.toMillis() - 1);
  fixture.db.seed(progressPath('task'), {
    value: 8,
    updatedAt: previousAt,
    lastEventAt: previousAt,
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')).value, 9);
});

test('malformed progress is untouched while another Challenge continues', async () => {
  const fixture = createFixture({
    challenges: [
      ['bad', challenge('TASK_COMPLETIONS')],
      ['good', challenge('TASK_COMPLETIONS')],
    ],
  });
  const malformed = { value: -1, updatedAt: 'invalid' };
  fixture.db.seed(progressPath('bad'), malformed);
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('bad')), malformed);
  assert.equal(fixture.db.data(processedPath('bad')), undefined);
  assert.equal(fixture.db.data(progressPath('good')).value, 1);
});

test('unsafe integer progress fails closed', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  const progress = { value: Number.MAX_SAFE_INTEGER };
  fixture.db.seed(progressPath('task'), progress);
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')), progress);
  assert.equal(fixture.db.data(processedPath('task')), undefined);
});

test('existing processed event prevents another increment', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  const processed = { source: 'VERIFIED_ACTIVITY' };
  fixture.db.seed(processedPath('task'), processed);
  fixture.db.seed(progressPath('task'), { value: 4 });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')).value, 4);
  assert.equal(fixture.db.data(processedPath('task')), processed);
});

test('activity replay never duplicates Circle progress', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  const first = await complete(fixture);
  const replay = await complete(fixture);
  assert.equal(first.body.replayed, false);
  assert.equal(replay.body.replayed, true);
  assert.equal(fixture.db.data(progressPath('task')).value, 1);
});

test('replay preserves original occurredAt for response and progress', async () => {
  const originalAt = Timestamp.fromMillis(EVENT_AT.toMillis() - 60_000);
  const fixture = createFixture({
    memberOverrides: {
      joinedAt: Timestamp.fromMillis(originalAt.toMillis() - 1),
    },
    challenges: [[
      'task',
      challenge('TASK_COMPLETIONS', {
        startAt: originalAt,
        endAt: EVENT_AT,
      }),
    ]],
  });
  seedStoredEvent(fixture, originalAt);
  const replay = await complete(fixture, EVENT_AT);
  assert.equal(replay.body.occurredAt, originalAt.toDate().toISOString());
  assert.equal(fixture.db.data(progressPath('task')).lastEventAt, originalAt);
});

test('replay after later membership never grants retroactive credit', async () => {
  const originalAt = Timestamp.fromMillis(EVENT_AT.toMillis() - 60_000);
  const fixture = createFixture({
    memberOverrides: {
      joinedAt: Timestamp.fromMillis(originalAt.toMillis() + 1),
    },
    challenges: [[
      'task',
      challenge('TASK_COMPLETIONS', {
        startAt: originalAt,
        endAt: EVENT_AT,
      }),
    ]],
  });
  seedStoredEvent(fixture, originalAt);
  const replay = await complete(fixture, EVENT_AT);
  assert.equal(replay.body.replayed, true);
  assert.equal(fixture.db.data(progressPath('task')), undefined);
});

test('exactly 240 eligible Challenges are processed', async () => {
  const challenges = [];
  for (let index = 0; index < MAX_CIRCLE_PROGRESS_CHALLENGES; index++) {
    challenges.push([`task-${index}`, challenge('TASK_COMPLETIONS')]);
  }
  const fixture = createFixture({ challenges });
  await complete(fixture);
  assert.equal(circleWrites(fixture.db).length, 480);
  assert.equal(fixture.db.data(progressPath('task-239')).value, 1);
});

test('241 eligible Challenges persist activity with zero Circle writes', async () => {
  const challenges = [];
  for (let index = 0; index <= MAX_CIRCLE_PROGRESS_CHALLENGES; index++) {
    challenges.push([`task-${index}`, challenge('TASK_COMPLETIONS')]);
  }
  const fixture = createFixture({ challenges });
  await complete(fixture);
  assert.ok(fixture.db.data(activityPath('task')));
  assert.equal(circleWrites(fixture.db).length, 0);
});

test('all transaction reads happen before the first write', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  await complete(fixture);
  const operations = fixture.db.transactions[0].operations;
  const firstWrite = operations.findIndex((operation) => operation.type === 'write');
  assert.ok(firstWrite > 0);
  assert.equal(
    operations.slice(firstWrite).some((operation) => operation.type === 'read'),
    false,
  );
});

test('verified event and Circle writes share one logical commit', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  await complete(fixture);
  assert.equal(fixture.db.transactions.length, 1);
  const paths = fixture.db.transactions[0].writes.map((write) => write.ref.path);
  assert.ok(paths.includes(activityPath('task')));
  assert.ok(paths.includes(processedPath('task')));
  assert.ok(paths.includes(progressPath('task')));
});

test('personal Task isCompleted remains untouched', async () => {
  const fixture = createFixture({
    resourceOverrides: { isCompleted: true },
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  const before = fixture.db.data(`users/${UID}/tasks/${TASK_ID}`);
  await complete(fixture);
  assert.equal(fixture.db.data(`users/${UID}/tasks/${TASK_ID}`), before);
  assert.equal(before.isCompleted, true);
});

test('personal Habit completedDates remains untouched', async () => {
  const fixture = createFixture({
    kind: 'habit',
    challenges: [['habit', challenge('HABIT_COMPLETIONS')]],
  });
  const before = fixture.db.data(`users/${UID}/habits/${HABIT_ID}`);
  await complete(fixture);
  assert.equal(fixture.db.data(`users/${UID}/habits/${HABIT_ID}`), before);
  assert.deepEqual(before.completedDates, ['2026-08-18']);
});

test('tasksCount and habitsCount remain untouched', async () => {
  for (const kind of ['task', 'habit']) {
    const fixture = createFixture({
      kind,
      challenges: [[kind, challenge(`${kind.toUpperCase()}_COMPLETIONS`)]],
    });
    await complete(fixture);
    assert.equal(fixture.db.data(`users/${UID}`).tasksCount, 7);
    assert.equal(fixture.db.data(`users/${UID}`).habitsCount, 5);
  }
});

test('processed event stores the deterministic activityEventId', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  await complete(fixture);
  assert.equal(
    fixture.db.data(processedPath('task')).activityEventId,
    taskEventId(TASK_ID),
  );
});

test('processed event contributionValue is exactly one', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(processedPath('task')).contributionValue, 1);
});

test('progress lastEventAt equals activity event occurredAt', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  await complete(fixture);
  assert.equal(fixture.db.data(progressPath('task')).lastEventAt, EVENT_AT);
});

test('processedAt and updatedAt use current server now', async () => {
  const originalAt = Timestamp.fromMillis(EVENT_AT.toMillis() - 60_000);
  const fixture = createFixture({
    memberOverrides: {
      joinedAt: Timestamp.fromMillis(originalAt.toMillis() - 1),
    },
    challenges: [[
      'task',
      challenge('TASK_COMPLETIONS', {
        startAt: originalAt,
        endAt: EVENT_AT,
      }),
    ]],
  });
  seedStoredEvent(fixture, originalAt);
  await complete(fixture, EVENT_AT);
  assert.equal(fixture.db.data(processedPath('task')).processedAt, EVENT_AT);
  assert.equal(fixture.db.data(progressPath('task')).updatedAt, EVENT_AT);
  assert.equal(fixture.db.data(progressPath('task')).lastEventAt, originalAt);
});

test('Task and Habit remain idempotent under logical reexecution', async () => {
  for (const kind of ['task', 'habit']) {
    const challengeId = kind;
    const fixture = createFixture({
      kind,
      challenges: [[challengeId, challenge(`${kind.toUpperCase()}_COMPLETIONS`)]],
    });
    await complete(fixture);
    const replay = await complete(fixture);
    assert.equal(replay.body.replayed, true);
    assert.equal(fixture.db.data(progressPath(challengeId)).value, 1);
  }
});

test('Circle selection comes only from transactional activeCircleId', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  await complete(fixture);
  const circleReads = fixture.db.transactions[0].operations
    .filter((operation) => operation.type === 'read')
    .map((operation) => operation.path)
    .filter((path) => path.startsWith('circles/'));
  assert.ok(circleReads.length > 0);
  assert.equal(
    circleReads.every((path) => path.startsWith(`circles/${CIRCLE_ID}`)),
    true,
  );
});

test('Activity HTTP response contracts remain unchanged', async () => {
  const taskFixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  const taskResult = await complete(taskFixture);
  const habitFixture = createFixture({
    kind: 'habit',
    challenges: [['habit', challenge('HABIT_COMPLETIONS')]],
  });
  const habitResult = await complete(habitFixture);
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
test('replay keeps newer progress lastEventAt and original processed timestamp', async () => {
  const originalAt = Timestamp.fromMillis(EVENT_AT.toMillis() - 60_000);
  const newerLastEventAt = Timestamp.fromMillis(
    EVENT_AT.toMillis() - 30_000,
  );
  const fixture = createFixture({
    memberOverrides: {
      joinedAt: Timestamp.fromMillis(originalAt.toMillis() - 1),
    },
    challenges: [[
      'task',
      challenge('TASK_COMPLETIONS', {
        startAt: originalAt,
        endAt: EVENT_AT,
      }),
    ]],
  });
  seedStoredEvent(fixture, originalAt);
  fixture.db.seed(progressPath('task'), {
    value: 8,
    updatedAt: Timestamp.fromMillis(EVENT_AT.toMillis() - 1),
    lastEventAt: newerLastEventAt,
  });

  const replay = await complete(fixture, EVENT_AT);

  assert.equal(replay.body.replayed, true);
  assert.equal(fixture.db.data(progressPath('task')).value, 9);
  assert.equal(
    fixture.db.data(progressPath('task')).lastEventAt,
    newerLastEventAt,
  );
  assert.equal(
    fixture.db.data(processedPath('task')).eventOccurredAt,
    originalAt,
  );
});

test('newer activity event advances existing progress lastEventAt', async () => {
  const olderLastEventAt = Timestamp.fromMillis(EVENT_AT.toMillis() - 2);
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  fixture.db.seed(progressPath('task'), {
    value: 3,
    updatedAt: Timestamp.fromMillis(EVENT_AT.toMillis() - 1),
    lastEventAt: olderLastEventAt,
  });

  await complete(fixture);

  assert.equal(fixture.db.data(progressPath('task')).value, 4);
  assert.equal(fixture.db.data(progressPath('task')).lastEventAt, EVENT_AT);
});

test('existing progress without lastEventAt adopts activity occurredAt', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  fixture.db.seed(progressPath('task'), {
    value: 5,
    updatedAt: Timestamp.fromMillis(EVENT_AT.toMillis() - 1),
  });

  await complete(fixture);

  assert.equal(fixture.db.data(progressPath('task')).value, 6);
  assert.equal(fixture.db.data(progressPath('task')).lastEventAt, EVENT_AT);
});

test('equal progress lastEventAt stays equal and increments only once', async () => {
  const fixture = createFixture({
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });
  fixture.db.seed(progressPath('task'), {
    value: 11,
    updatedAt: EVENT_AT,
    lastEventAt: EVENT_AT,
  });

  await complete(fixture);

  assert.equal(fixture.db.data(progressPath('task')).value, 12);
  assert.equal(fixture.db.data(progressPath('task')).lastEventAt, EVENT_AT);
});

test('sync update confirms Task before verified event and Circle progress', async () => {
  const fixture = createFixture({
    resourceOverrides: { isCompleted: false },
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });

  const result = await syncTaskUpdate({
    body: { operation: 'update_task', taskId: TASK_ID, isCompleted: true },
    db: fixture.db,
    uid: UID,
    now: EVENT_AT,
  });

  assert.equal(result.body.activityRecorded, true);
  assert.equal(fixture.db.data(`users/${UID}/tasks/${TASK_ID}`).isCompleted, true);
  assert.ok(fixture.db.data(activityPath('task')));
  assert.equal(fixture.db.data(progressPath('task')).value, 1);
  assert.ok(fixture.db.data(processedPath('task')));
});

test('rejected sync payload produces no event or Circle progress', async () => {
  const fixture = createFixture({
    resourceOverrides: { isCompleted: false },
    challenges: [['task', challenge('TASK_COMPLETIONS')]],
  });

  await assert.rejects(
    syncTaskUpdate({
      body: {
        operation: 'update_task',
        taskId: TASK_ID,
        isCompleted: true,
        uid: 'attacker',
      },
      db: fixture.db,
      uid: UID,
      now: EVENT_AT,
    }),
    (error) => error.code === 'INVALID_SYNC_PAYLOAD',
  );

  assert.equal(fixture.db.data(activityPath('task')), undefined);
  assert.equal(fixture.db.data(progressPath('task')), undefined);
  assert.equal(fixture.db.data(processedPath('task')), undefined);
});

test('weekly matrix HABIT update cannot create competitive progress', async () => {
  const fixture = createFixture({
    kind: 'habit',
    resourceOverrides: { completedDates: [] },
    challenges: [['habit', challenge('HABIT_COMPLETIONS')]],
  });

  const result = await syncHabitUpdate({
    body: {
      operation: 'update_habit',
      habitId: HABIT_ID,
      completedDates: ['2026-08-18'],
    },
    db: fixture.db,
    uid: UID,
    now: EVENT_AT,
  });

  assert.equal(result.body.activityRecorded, false);
  assert.equal(fixture.db.data(activityPath('habit')), undefined);
  assert.equal(fixture.db.data(progressPath('habit')), undefined);
  assert.equal(fixture.db.data(processedPath('habit', 'habit')), undefined);
});

test('legacy HABIT endpoint cannot promote a normal update to competition', async () => {
  const fixture = createFixture({
    kind: 'habit',
    resourceOverrides: { completedDates: [] },
    challenges: [['habit', challenge('HABIT_COMPLETIONS')]],
  });

  const normalUpdate = await syncHabitUpdate({
    body: {
      operation: 'update_habit',
      habitId: HABIT_ID,
      completedDates: ['2026-08-18'],
    },
    db: fixture.db,
    uid: UID,
    now: EVENT_AT,
  });
  await assert.rejects(
    retiredHabitCompletion({
      body: { habitId: HABIT_ID },
      db: fixture.db,
      uid: UID,
      now: EVENT_AT,
    }),
    (error) =>
      error.statusCode === 410 &&
      error.code === 'HABIT_ACTIVITY_ENDPOINT_RETIRED',
  );

  assert.equal(normalUpdate.body.activityRecorded, false);
  assert.deepEqual(
    fixture.db.data(`users/${UID}/habits/${HABIT_ID}`).completedDates,
    ['2026-08-18'],
  );
  assert.equal(fixture.db.data(activityPath('habit')), undefined);
  assert.equal(fixture.db.data(progressPath('habit')), undefined);
  assert.equal(fixture.db.data(processedPath('habit', 'habit')), undefined);
});

test('HABIT completion retry across UTC midnight never duplicates progress', async () => {
  const beforeMidnight = Timestamp.fromDate(
    new Date('2026-08-18T23:59:59.000Z'),
  );
  const afterMidnight = Timestamp.fromDate(
    new Date('2026-08-19T00:05:00.000Z'),
  );
  const fixture = createFixture({
    kind: 'habit',
    resourceOverrides: { completedDates: [] },
    challenges: [
      [
        'habit',
        challenge('HABIT_COMPLETIONS', {
          startAt: Timestamp.fromDate(new Date('2026-08-18T00:00:00.000Z')),
          endAt: Timestamp.fromDate(new Date('2026-08-19T23:59:59.000Z')),
        }),
      ],
    ],
  });
  const body = {
    operation: 'update_habit_completion',
    habitId: HABIT_ID,
    completedDates: ['2026-08-18'],
    competitiveCompletionId: '7d287d4e-190f-42ab-90a8-a93696f8c462',
  };

  await syncHabitCompletionUpdate({
    body,
    db: fixture.db,
    uid: UID,
    now: beforeMidnight,
  });
  const replay = await syncHabitCompletionUpdate({
    body,
    db: fixture.db,
    uid: UID,
    now: afterMidnight,
  });

  assert.equal(replay.body.replayed, true);
  assert.equal(fixture.db.data(progressPath('habit')).value, 1);
  assert.ok(fixture.db.data(activityPath('habit', beforeMidnight)));
  assert.equal(fixture.db.data(activityPath('habit', afterMidnight)), undefined);
  assert.ok(
    fixture.db.data(processedPath('habit', 'habit', beforeMidnight)),
  );
  assert.equal(fixture.db.transactions[1].writes.length, 0);
});
