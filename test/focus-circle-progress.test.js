import assert from 'node:assert/strict';
import test from 'node:test';

import { Timestamp } from 'firebase-admin/firestore';

import {
  applyCircleProgressPlan,
  MAX_CIRCLE_PROGRESS_CHALLENGES,
  readCircleProgressPlan,
} from '../api/focus/_circle_progress.js';
import { finishFocus } from '../api/focus/finish.js';
import { calculateExpiresAtMillis } from '../api/focus/_shared.js';

const UID = 'user-1';
const CIRCLE_ID = 'circle-1';
const SESSION_ID = 'session-1';

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

  delete(ref) {
    this.#write('delete', ref);
  }

  #write(type, ref, data) {
    this.hasWritten = true;
    this.operations.push({ type: 'write', operation: type, path: ref.path });
    this.writes.push({ type, ref, data });
  }

  commit() {
    const nextStore = new Map(this.db.store);
    for (const write of this.writes) {
      const path = write.ref.path;
      if (write.type === 'create') {
        if (nextStore.has(path)) throw new Error(`already exists: ${path}`);
        nextStore.set(path, write.data);
      } else if (write.type === 'update') {
        if (!nextStore.has(path)) throw new Error(`missing update: ${path}`);
        nextStore.set(path, { ...nextStore.get(path), ...write.data });
      } else {
        nextStore.delete(path);
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

function timestamp(milliseconds) {
  return Timestamp.fromMillis(milliseconds);
}

function completedSession({
  sessionId = SESSION_ID,
  targetType = 'TASK',
  durationSeconds = 60,
  startedAtMillis = 1_000_000,
  completedAtMillis = startedAtMillis + durationSeconds * 1000,
} = {}) {
  return {
    sessionId,
    uid: UID,
    targetId: targetType === 'SUBJECT' ? 'subject-1' : 'task-1',
    targetType,
    plannedDurationSeconds: durationSeconds,
    verifiedDurationSeconds: durationSeconds,
    status: 'COMPLETED',
    startedAt: timestamp(startedAtMillis),
    completedAt: timestamp(completedAtMillis),
    expiresAt: timestamp(
      calculateExpiresAtMillis(startedAtMillis, durationSeconds),
    ),
    schemaVersion: 1,
  };
}

function challenge(session, type, overrides = {}) {
  return {
    type,
    startAt: session.startedAt,
    endAt: session.completedAt,
    schemaVersion: 2,
    ...overrides,
  };
}

function validCircleData(session, overrides = {}) {
  return {
    name: 'Test Circle',
    description: 'Deterministic Circle V2 fixture',
    adminId: UID,
    memberCount: 1,
    memberLimit: 3,
    createdAt: timestamp(session.startedAt.toMillis() - 60_000),
    updatedAt: timestamp(session.startedAt.toMillis() - 30_000),
    schemaVersion: 2,
    ...overrides,
  };
}

function validMemberData(session, overrides = {}) {
  return {
    role: 'admin',
    displayNameSnapshot: 'Test User',
    photoUrlSnapshot: null,
    joinedAt: session.startedAt,
    ...overrides,
  };
}

function seedCircle(
  db,
  session,
  {
    userData = { activeCircleId: CIRCLE_ID },
    circleData,
    memberData,
    challenges = [],
    includeCircle = true,
    includeMember = true,
  } = {},
) {
  db.seed(`users/${UID}`, userData);
  if (includeCircle) {
    db.seed(
      `circles/${CIRCLE_ID}`,
      circleData ?? validCircleData(session),
    );
  }
  if (includeMember) {
    db.seed(
      `circles/${CIRCLE_ID}/members/${UID}`,
      memberData ?? validMemberData(session),
    );
  }
  for (const [id, data] of challenges) {
    db.seed(`circles/${CIRCLE_ID}/challenges/${id}`, data);
  }
}

async function processCircle(db, session) {
  const userRef = db.collection('users').doc(UID);
  return db.runTransaction(async (transaction) => {
    const plan = await readCircleProgressPlan({
      transaction,
      db,
      userRef,
      uid: UID,
      session,
    });
    applyCircleProgressPlan({
      transaction,
      plan,
      uid: UID,
      session,
      processedAt: session.completedAt,
    });
    return plan;
  });
}

function progressPath(challengeId) {
  return `circles/${CIRCLE_ID}/challenges/${challengeId}/progress/${UID}`;
}

function eventPath(challengeId, sessionId = SESSION_ID) {
  return `circles/${CIRCLE_ID}/challenges/${challengeId}/processed_events/${sessionId}`;
}

function runningFinishFixture({
  durationSeconds = 60,
  targetType = 'TASK',
  activeCircleId,
  challenges = [],
  circleOverrides = {},
  memberOverrides = {},
} = {}) {
  const db = new FakeFirestore();
  const startedAtMillis = Date.now() - durationSeconds * 1000 - 2000;
  const session = {
    sessionId: SESSION_ID,
    uid: UID,
    targetId: targetType === 'SUBJECT' ? 'subject-1' : 'task-1',
    targetType,
    plannedDurationSeconds: durationSeconds,
    status: 'RUNNING',
    startedAt: timestamp(startedAtMillis),
    expiresAt: timestamp(
      calculateExpiresAtMillis(startedAtMillis, durationSeconds),
    ),
    schemaVersion: 1,
  };
  const sessionPath = `users/${UID}/verified_focus_sessions/${SESSION_ID}`;
  const activePath = `users/${UID}/runtime/active_focus`;
  db.seed(sessionPath, session);
  db.seed(activePath, {
    sessionId: session.sessionId,
    targetId: session.targetId,
    targetType: session.targetType,
    plannedDurationSeconds: session.plannedDurationSeconds,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    schemaVersion: 1,
  });
  db.seed(`users/${UID}`, activeCircleId ? { activeCircleId } : {});
  if (activeCircleId) {
    db.seed(
      `circles/${activeCircleId}`,
      validCircleData(session, circleOverrides),
    );
    db.seed(
      `circles/${activeCircleId}/members/${UID}`,
      validMemberData(session, memberOverrides),
    );
    for (const [id, data] of challenges) {
      db.seed(`circles/${activeCircleId}/challenges/${id}`, data);
    }
  }
  return { db, session, sessionPath, activePath };
}

test('finish without activeCircleId completes with zero Circle writes', async () => {
  const { db, sessionPath, activePath } = runningFinishFixture();

  const result = await finishFocus({
    body: { sessionId: SESSION_ID },
    db,
    uid: UID,
  });

  assert.equal(result.body.status, 'COMPLETED');
  assert.equal(db.data(sessionPath).status, 'COMPLETED');
  assert.equal(db.data(activePath), undefined);
  assert.equal([...db.store.keys()].some((path) => path.includes('/progress/')), false);
});

test('invalid activeCircleId still completes Focus with zero progress', async () => {
  const fixture = runningFinishFixture();
  fixture.db.seed(`users/${UID}`, { activeCircleId: 'invalid/circle' });

  const result = await finishFocus({
    body: { sessionId: SESSION_ID },
    db: fixture.db,
    uid: UID,
  });

  assert.equal(result.body.status, 'COMPLETED');
  assert.equal(fixture.db.data(fixture.sessionPath).status, 'COMPLETED');
});

test('missing or malformed Circle still completes Focus', async () => {
  for (const mode of ['missing', 'wrong-schema']) {
    const fixture = runningFinishFixture({
      activeCircleId: CIRCLE_ID,
      challenges: [
        [
          'focus',
          {
            type: 'FOCUS_MINUTES',
            startAt: timestamp(0),
            endAt: timestamp(Date.now() + 60_000),
            schemaVersion: 2,
          },
        ],
      ],
    });
    if (mode === 'missing') {
      fixture.db.store.delete(`circles/${CIRCLE_ID}`);
    } else {
      fixture.db.seed(`circles/${CIRCLE_ID}`, { schemaVersion: 1 });
    }

    const result = await finishFocus({
      body: { sessionId: SESSION_ID },
      db: fixture.db,
      uid: UID,
    });

    assert.equal(result.body.status, 'COMPLETED');
    assert.equal(fixture.db.data(progressPath('focus')), undefined);
  }
});

test('missing or late membership still completes Focus', async () => {
  for (const mode of ['missing', 'late']) {
    const fixture = runningFinishFixture({
      activeCircleId: CIRCLE_ID,
      challenges: [
        [
          'focus',
          {
            type: 'FOCUS_MINUTES',
            startAt: timestamp(0),
            endAt: timestamp(Date.now() + 60_000),
            schemaVersion: 2,
          },
        ],
      ],
    });
    const memberPath = `circles/${CIRCLE_ID}/members/${UID}`;
    if (mode === 'missing') {
      fixture.db.store.delete(memberPath);
    } else {
      fixture.db.seed(
        memberPath,
        validMemberData(fixture.session, {
          joinedAt: timestamp(fixture.session.startedAt.toMillis() + 1),
        }),
      );
    }

    const result = await finishFocus({
      body: { sessionId: SESSION_ID },
      db: fixture.db,
      uid: UID,
    });

    assert.equal(result.body.status, 'COMPLETED');
    assert.equal(fixture.db.data(progressPath('focus')), undefined);
  }
});
test('missing Circle and wrong schema fail closed for progress', async () => {
  const session = completedSession();
  for (const fixture of [
    { includeCircle: false },
    { circleData: { schemaVersion: 1 } },
  ]) {
    const db = new FakeFirestore();
    seedCircle(db, session, {
      ...fixture,
      challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
    });
    const plan = await processCircle(db, session);
    assert.equal(plan.entries.length, 0);
    assert.equal(db.data(progressPath('focus')), undefined);
  }
});

test('missing membership fails closed for progress', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    includeMember: false,
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });

  const plan = await processCircle(db, session);

  assert.equal(plan.entries.length, 0);
});

test('membership joined after start is rejected and exact boundary counts', async () => {
  const session = completedSession();
  const lateDb = new FakeFirestore();
  seedCircle(lateDb, session, {
    memberData: validMemberData(session, {
      joinedAt: timestamp(session.startedAt.toMillis() + 1),
    }),
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });
  assert.equal((await processCircle(lateDb, session)).entries.length, 0);

  const boundaryDb = new FakeFirestore();
  seedCircle(boundaryDb, session, {
    memberData: validMemberData(session),
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });
  assert.equal((await processCircle(boundaryDb, session)).entries.length, 1);
});

test('TASK contributes to Focus but never Study minutes', async () => {
  const session = completedSession({ targetType: 'TASK' });
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [
      ['focus', challenge(session, 'FOCUS_MINUTES')],
      ['study', challenge(session, 'STUDY_MINUTES')],
    ],
  });

  await processCircle(db, session);

  assert.equal(db.data(progressPath('focus')).value, 1);
  assert.equal(db.data(progressPath('study')), undefined);
});

test('SUBJECT contributes equally to Focus and Study challenges', async () => {
  const session = completedSession({ targetType: 'SUBJECT', durationSeconds: 1500 });
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [
      ['focus', challenge(session, 'FOCUS_MINUTES')],
      ['study', challenge(session, 'STUDY_MINUTES')],
    ],
  });

  await processCircle(db, session);

  assert.equal(db.data(progressPath('focus')).value, 25);
  assert.equal(db.data(progressPath('study')).value, 25);
  assert.ok(db.data(eventPath('focus')));
  assert.ok(db.data(eventPath('study')));
});

test('Habit and Task completion challenges are ignored', async () => {
  const session = completedSession({ targetType: 'SUBJECT' });
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [
      ['habit', challenge(session, 'HABIT_COMPLETIONS')],
      ['task', challenge(session, 'TASK_COMPLETIONS')],
    ],
  });

  const plan = await processCircle(db, session);

  assert.equal(plan.entries.length, 0);
});

test('session start boundary is inclusive and an earlier start is rejected', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [
      ['equal', challenge(session, 'FOCUS_MINUTES')],
      [
        'late-start',
        challenge(session, 'FOCUS_MINUTES', {
          startAt: timestamp(session.startedAt.toMillis() + 1),
        }),
      ],
    ],
  });

  await processCircle(db, session);

  assert.equal(db.data(progressPath('equal')).value, 1);
  assert.equal(db.data(progressPath('late-start')), undefined);
});

test('session completion boundary is inclusive and a later finish is rejected', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [
      ['equal', challenge(session, 'FOCUS_MINUTES')],
      [
        'early-end',
        challenge(session, 'FOCUS_MINUTES', {
          endAt: timestamp(session.completedAt.toMillis() - 1),
        }),
      ],
    ],
  });

  await processCircle(db, session);

  assert.equal(db.data(progressPath('equal')).value, 1);
  assert.equal(db.data(progressPath('early-end')), undefined);
});

test('two eligible Focus challenges both receive the same session', async () => {
  const session = completedSession({ durationSeconds: 600 });
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [
      ['focus-a', challenge(session, 'FOCUS_MINUTES')],
      ['focus-b', challenge(session, 'FOCUS_MINUTES')],
    ],
  });

  await processCircle(db, session);

  assert.equal(db.data(progressPath('focus-a')).value, 10);
  assert.equal(db.data(progressPath('focus-b')).value, 10);
  assert.ok(db.data(eventPath('focus-a')));
  assert.ok(db.data(eventPath('focus-b')));
});

test('missing progress is created with server-owned event metadata', async () => {
  const session = completedSession({ durationSeconds: 180 });
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });

  await processCircle(db, session);

  const progress = db.data(progressPath('focus'));
  const event = db.data(eventPath('focus'));
  assert.deepEqual(progress, {
    value: 3,
    updatedAt: session.completedAt,
    lastEventAt: session.completedAt,
  });
  assert.equal(event.source, 'VERIFIED_FOCUS');
  assert.equal(event.contributionValue, 3);
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.processedAt, session.completedAt);
});

test('valid existing progress increments exactly once', async () => {
  const session = completedSession({ durationSeconds: 180 });
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });
  db.seed(progressPath('focus'), {
    value: 7,
    updatedAt: session.startedAt,
    lastEventAt: session.startedAt,
  });

  await processCircle(db, session);
  await processCircle(db, session);

  assert.equal(db.data(progressPath('focus')).value, 10);
});

test('malformed progress is not overwritten and does not block processing', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [
      ['bad', challenge(session, 'FOCUS_MINUTES')],
      ['good', challenge(session, 'FOCUS_MINUTES')],
    ],
  });
  const malformed = { value: -1, updatedAt: 'not-a-timestamp' };
  db.seed(progressPath('bad'), malformed);

  await processCircle(db, session);

  assert.deepEqual(db.data(progressPath('bad')), malformed);
  assert.equal(db.data(eventPath('bad')), undefined);
  assert.equal(db.data(progressPath('good')).value, 1);
});

test('an existing processed event prevents any increment or overwrite', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });
  const existingEvent = { source: 'VERIFIED_FOCUS', schemaVersion: 1 };
  db.seed(eventPath('focus'), existingEvent);
  db.seed(progressPath('focus'), {
    value: 8,
    updatedAt: session.startedAt,
    lastEventAt: session.startedAt,
  });

  await processCircle(db, session);

  assert.equal(db.data(progressPath('focus')).value, 8);
  assert.equal(db.data(eventPath('focus')), existingEvent);
});

test('finish replay preserves response contract and never duplicates progress', async () => {
  const fixture = runningFinishFixture({
    activeCircleId: CIRCLE_ID,
    challenges: [
      [
        'focus',
        {
          type: 'FOCUS_MINUTES',
          startAt: timestamp(0),
          endAt: timestamp(Date.now() + 60_000),
          schemaVersion: 2,
        },
      ],
    ],
  });

  const first = await finishFocus({
    body: { sessionId: SESSION_ID },
    db: fixture.db,
    uid: UID,
  });
  const replay = await finishFocus({
    body: { sessionId: SESSION_ID },
    db: fixture.db,
    uid: UID,
  });

  assert.equal(first.body.replayed, false);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(Object.keys(replay.body).sort(), [
    'completedAt',
    'replayed',
    'sessionId',
    'status',
    'verifiedDurationSeconds',
  ]);
  assert.equal(fixture.db.data(progressPath('focus')).value, 1);
});

test('contribution comes from the stored verified duration, not request data', async () => {
  const fixture = runningFinishFixture({
    durationSeconds: 180,
    activeCircleId: CIRCLE_ID,
    challenges: [
      [
        'focus',
        {
          type: 'FOCUS_MINUTES',
          startAt: timestamp(0),
          endAt: timestamp(Date.now() + 60_000),
          schemaVersion: 2,
        },
      ],
    ],
  });

  await finishFocus({ body: { sessionId: SESSION_ID }, db: fixture.db, uid: UID });

  assert.equal(fixture.db.data(progressPath('focus')).value, 3);
});

test('malformed challenges are ignored without affecting valid challenges', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [
      ['wrong-schema', challenge(session, 'FOCUS_MINUTES', { schemaVersion: 1 })],
      ['bad-window', challenge(session, 'FOCUS_MINUTES', {
        startAt: session.completedAt,
        endAt: session.startedAt,
      })],
      ['bad-time', challenge(session, 'FOCUS_MINUTES', { startAt: 'bad' })],
      ['valid', challenge(session, 'FOCUS_MINUTES')],
    ],
  });

  await processCircle(db, session);

  assert.equal(db.data(progressPath('wrong-schema')), undefined);
  assert.equal(db.data(progressPath('bad-window')), undefined);
  assert.equal(db.data(progressPath('bad-time')), undefined);
  assert.equal(db.data(progressPath('valid')).value, 1);
});

test('write budget overflow gives zero Circle credit but completes Focus', async () => {
  const challenges = [];
  for (let index = 0; index <= MAX_CIRCLE_PROGRESS_CHALLENGES; index++) {
    challenges.push([
      `focus-${index}`,
      {
        type: 'FOCUS_MINUTES',
        startAt: timestamp(0),
        endAt: timestamp(Date.now() + 60_000),
        schemaVersion: 2,
      },
    ]);
  }
  const fixture = runningFinishFixture({
    activeCircleId: CIRCLE_ID,
    challenges,
  });

  const result = await finishFocus({
    body: { sessionId: SESSION_ID },
    db: fixture.db,
    uid: UID,
  });

  assert.equal(result.body.status, 'COMPLETED');
  assert.equal(fixture.db.data(fixture.sessionPath).status, 'COMPLETED');
  assert.equal(
    [...fixture.db.store.keys()].some((path) => path.includes('/progress/')),
    false,
  );
});

test('finish transaction performs every read before its first write', async () => {
  const fixture = runningFinishFixture({
    activeCircleId: CIRCLE_ID,
    challenges: [
      [
        'focus',
        {
          type: 'FOCUS_MINUTES',
          startAt: timestamp(0),
          endAt: timestamp(Date.now() + 60_000),
          schemaVersion: 2,
        },
      ],
    ],
  });

  await finishFocus({ body: { sessionId: SESSION_ID }, db: fixture.db, uid: UID });

  const operations = fixture.db.transactions[0].operations;
  const firstWrite = operations.findIndex((operation) => operation.type === 'write');
  assert.ok(firstWrite > 0);
  assert.equal(
    operations.slice(firstWrite).some((operation) => operation.type === 'read'),
    false,
  );
});

test('logical transaction reexecution sees processed event and stays idempotent', async () => {
  const session = completedSession({ durationSeconds: 2700 });
  const db = new FakeFirestore();
  seedCircle(db, session, {
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });

  await processCircle(db, session);
  const firstEvent = db.data(eventPath('focus'));
  await processCircle(db, session);

  assert.equal(db.data(progressPath('focus')).value, 45);
  assert.equal(db.data(eventPath('focus')), firstEvent);
});
test('Circle V2 with invalid memberCount skips progress but completes Focus', async () => {
  const fixture = runningFinishFixture({
    activeCircleId: CIRCLE_ID,
    circleOverrides: { memberCount: 0 },
    challenges: [
      [
        'focus',
        {
          type: 'FOCUS_MINUTES',
          startAt: timestamp(0),
          endAt: timestamp(Date.now() + 60_000),
          schemaVersion: 2,
        },
      ],
    ],
  });

  const result = await finishFocus({
    body: { sessionId: SESSION_ID },
    db: fixture.db,
    uid: UID,
  });

  assert.equal(result.body.status, 'COMPLETED');
  assert.equal(fixture.db.data(fixture.sessionPath).status, 'COMPLETED');
  assert.equal(fixture.db.data(progressPath('focus')), undefined);
});

test('Circle V2 with invalid memberLimit fails closed for progress', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    circleData: validCircleData(session, { memberLimit: 5 }),
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });

  assert.equal((await processCircle(db, session)).entries.length, 0);
  assert.equal(db.data(progressPath('focus')), undefined);
});

test('Circle V2 without a safe adminId fails closed for progress', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    circleData: validCircleData(session, { adminId: 'invalid/admin' }),
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });

  assert.equal((await processCircle(db, session)).entries.length, 0);
  assert.equal(db.data(progressPath('focus')), undefined);
});

test('structurally valid Circle V2 still receives progress', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    circleData: validCircleData(session),
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });

  await processCircle(db, session);

  assert.equal(db.data(progressPath('focus')).value, 1);
});

test('membership with missing or invalid role fails closed for progress', async () => {
  const session = completedSession();
  for (const role of [undefined, 'owner']) {
    const db = new FakeFirestore();
    seedCircle(db, session, {
      memberData: validMemberData(session, { role }),
      challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
    });

    assert.equal((await processCircle(db, session)).entries.length, 0);
    assert.equal(db.data(progressPath('focus')), undefined);
  }
});

test('membership without a valid displayNameSnapshot fails closed', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    memberData: validMemberData(session, { displayNameSnapshot: '   ' }),
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });

  assert.equal((await processCircle(db, session)).entries.length, 0);
  assert.equal(db.data(progressPath('focus')), undefined);
});

test('membership with invalid photoUrlSnapshot fails closed', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    memberData: validMemberData(session, {
      photoUrlSnapshot: 'x'.repeat(2049),
    }),
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });

  assert.equal((await processCircle(db, session)).entries.length, 0);
  assert.equal(db.data(progressPath('focus')), undefined);
});

test('Circle admin membership with member role fails closed', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    memberData: validMemberData(session, { role: 'member' }),
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });

  assert.equal((await processCircle(db, session)).entries.length, 0);
  assert.equal(db.data(progressPath('focus')), undefined);
});

test('non-admin membership with admin role fails closed', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    circleData: validCircleData(session, { adminId: 'other-admin' }),
    memberData: validMemberData(session, { role: 'admin' }),
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });

  assert.equal((await processCircle(db, session)).entries.length, 0);
  assert.equal(db.data(progressPath('focus')), undefined);
});

test('structurally valid non-admin membership still receives progress', async () => {
  const session = completedSession();
  const db = new FakeFirestore();
  seedCircle(db, session, {
    circleData: validCircleData(session, { adminId: 'other-admin' }),
    memberData: validMemberData(session, { role: 'member' }),
    challenges: [['focus', challenge(session, 'FOCUS_MINUTES')]],
  });

  await processCircle(db, session);

  assert.equal(db.data(progressPath('focus')).value, 1);
});
