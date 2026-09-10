import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';
import {
  applyStudyProgressReset,
  validateStudyProgressResetPayload,
} from '../api/study/_sync_progress_reset.js';

if (!getApps().length) initializeApp({ projectId: 'study-progress-reset-test' });
const { syncHandler } = await import('../api/sync.js');

const mutationA = '7d287d4e-190f-42ab-90a8-a93696f8c462';
const mutationB = '5a3ccf1f-d43e-4a34-823d-61ed255e568a';
const resetAt = new Date('2026-09-09T10:00:00.000Z');
const serverTimestamp = () => new Date('2026-09-09T15:00:00.000Z');

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

class Reference {
  constructor(owner, path) {
    this.owner = owner;
    this.path = path;
  }
  collection(name) {
    return new Collection(this.owner, `${this.path}/${name}`);
  }
}

class Collection {
  constructor(owner, path) {
    this.owner = owner;
    this.path = path;
  }
  doc(id) {
    return new Reference(this.owner, `${this.path}/${id}`);
  }
  where(field, operator, value) {
    return new Query(this.owner, this.path, field, operator, value);
  }
}

class Query {
  constructor(owner, path, field, operator, value) {
    this.owner = owner;
    this.path = path;
    this.field = field;
    this.operator = operator;
    this.value = value;
  }
}

class Snapshot {
  constructor(value) {
    this.value = value;
    this.exists = value !== undefined;
  }
  data() {
    return this.value === undefined ? undefined : clone(this.value);
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
  }
}

class Transaction {
  constructor(source) {
    this.data = new Map([...source.entries()].map(([path, value]) => [path, clone(value)]));
  }
  async get(target) {
    if (target instanceof Query) {
      assert.equal(target.operator, '>');
      const prefix = `${target.path}/`;
      const docs = [];
      for (const [path, value] of this.data.entries()) {
        if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
        const candidate = value[target.field];
        const candidateDate = candidate instanceof Date
          ? candidate
          : typeof candidate?.toDate === 'function'
            ? candidate.toDate()
            : null;
        if (candidateDate !== null && candidateDate.getTime() > target.value.getTime()) {
          docs.push(new Snapshot(value));
        }
      }
      return new QuerySnapshot(docs);
    }
    return new Snapshot(this.data.get(target.path));
  }
  set(reference, value, options) {
    const current = options?.merge ? clone(this.data.get(reference.path) ?? {}) : {};
    Object.assign(current, clone(value));
    this.data.set(reference.path, current);
  }
}

class Firestore {
  constructor(initial = {}) {
    this.data = new Map(Object.entries(initial).map(([path, value]) => [path, clone(value)]));
  }
  collection(name) {
    return new Collection(this, name);
  }
  async runTransaction(callback) {
    const transaction = new Transaction(this.data);
    const result = await callback(transaction);
    this.data = transaction.data;
    return result;
  }
  read(path) {
    return clone(this.data.get(path));
  }
}

function database({ progress = .5, state, events = {} } = {}) {
  const initial = {
    'users/user-a': { isPremium: true },
    'users/user-a/study_info/main': { progress },
  };
  if (state !== undefined) initial['users/user-a/study_progress_state/main'] = state;
  for (const [id, value] of Object.entries(events)) {
    initial[`users/user-a/study_progress_events/${id}`] = value;
  }
  return new Firestore(initial);
}

function event(delta, occurredAt, overrides = {}) {
  return {
    kind: 'study_activity',
    progressDelta: delta,
    occurredAt: new Date(occurredAt),
    createdAt: new Date('2026-09-09T14:00:00.000Z'),
    ...overrides,
  };
}

function apply(db, overrides = {}) {
  return applyStudyProgressReset({
    db,
    userId: 'user-a',
    mutationId: mutationA,
    occurredAt: resetAt,
    serverTimestamp,
    ...overrides,
  });
}

test('reset normal zera progress sem eventos posteriores', async () => {
  const db = database();
  const result = await apply(db);
  assert.equal(result.progress, 0);
  assert.equal(db.read('users/user-a/study_info/main').progress, 0);
});

test('study_info sem progress é tratado como zero permitido', async () => {
  const db = new Firestore({
    'users/user-a': { isPremium: true },
    'users/user-a/study_info/main': { streak: 2 },
  });
  await apply(db);
  assert.deepEqual(db.read('users/user-a/study_info/main'), {
    streak: 2,
    progress: 0,
  });
});

test('reset atrasado reconstrói somente atividade posterior', async () => {
  const db = database({
    progress: .75,
    events: { later: event(.25, '2026-09-09T10:05:00.000Z') },
  });
  await apply(db);
  assert.equal(db.read('users/user-a/study_info/main').progress, .25);
});

test('múltiplos eventos posteriores acumulam e clampam em um', async () => {
  const db = database({
    events: {
      a: event(.25, '2026-09-09T10:01:00.000Z'),
      b: event(.1, '2026-09-09T10:02:00.000Z', { kind: 'review' }),
      c: event(.05, '2026-09-09T10:03:00.000Z'),
    },
  });
  await apply(db);
  assert.ok(
    Math.abs(db.read('users/user-a/study_info/main').progress - .4) < 1e-12,
  );

  const clamped = database({
    events: {
      a: event(.7, '2026-09-09T10:01:00.000Z'),
      b: event(.6, '2026-09-09T10:02:00.000Z'),
    },
  });
  await apply(clamped);
  assert.equal(clamped.read('users/user-a/study_info/main').progress, 1);
});

test('replay da mesma mutation é idempotente', async () => {
  const db = database({ events: { later: event(.25, '2026-09-09T10:05:00.000Z') } });
  await apply(db);
  db.data.set('users/user-a/study_progress_events/new', event(.2, '2026-09-09T10:06:00.000Z'));
  const replay = await apply(db);
  assert.equal(replay.alreadyApplied, true);
  assert.equal(db.read('users/user-a/study_info/main').progress, .25);
});

test('reset anterior ou igual preserva progress e state mas cria receipt', async () => {
  for (const lastResetAt of [
    '2026-09-09T10:00:00.000Z',
    '2026-09-09T11:00:00.000Z',
  ]) {
    const state = { lastResetAt: new Date(lastResetAt) };
    const db = database({ progress: .4, state });
    const result = await apply(db);
    assert.equal(result.skippedAsStale, true);
    assert.equal(db.read('users/user-a/study_info/main').progress, .4);
    assert.deepEqual(db.read('users/user-a/study_progress_state/main'), state);
    assert.deepEqual(
      db.read(`users/user-a/study_progress_reset_receipts/${mutationA}`),
      { appliedAt: serverTimestamp() },
    );
  }
});

test('state, progress e evento malformados falham sem writes', async () => {
  const cases = [
    database({ state: { lastResetAt: null } }),
    database({ progress: null }),
    database({ events: { invalid: event(.25, '2026-09-09T10:05:00.000Z', { kind: 'invalid' }) } }),
  ];
  for (const db of cases) {
    const before = clone(Object.fromEntries(db.data));
    await assert.rejects(
      apply(db),
      (error) => error.statusCode === 409 && error.code === 'STUDY_PROGRESS_STATE_INVALID',
    );
    assert.deepEqual(Object.fromEntries(db.data), before);
    assert.equal(db.read(`users/user-a/study_progress_reset_receipts/${mutationA}`), undefined);
  }
});

test('validação rejeita campo extra, mutationId e timezone inválidos', () => {
  const valid = {
    operation: 'apply_study_progress_reset',
    mutationId: mutationA,
    occurredAt: '2026-09-09T10:00:00.000Z',
  };
  for (const body of [
    { ...valid, extra: true },
    { ...valid, mutationId: 'invalid' },
    { ...valid, occurredAt: 'invalid' },
    { ...valid, occurredAt: '2026-09-09T10:00:00.000' },
  ]) {
    assert.equal(validateStudyProgressResetPayload(body).valid, false);
  }
});

function responseStub() {
  return {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('syncHandler roteia apply_study_progress_reset validado', async () => {
  let received;
  const response = responseStub();
  await syncHandler(
    {
      method: 'POST',
      headers: {
        'x-firebase-appcheck': 'valid-app-check',
        authorization: 'Bearer valid-token',
      },
      body: {
        operation: 'apply_study_progress_reset',
        mutationId: mutationB,
        occurredAt: '2026-09-09T10:00:00.000Z',
      },
    },
    response,
    {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async (_, checkRevoked) => {
        assert.equal(checkRevoked, true);
        return { uid: 'user-a' };
      },
      checkRateLimit: async () => true,
      applyStudyProgressReset: async (parameters) => {
        received = parameters;
        return { alreadyApplied: false, skippedAsStale: false };
      },
    },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.operation, 'apply_study_progress_reset');
  assert.equal(received.userId, 'user-a');
  assert.equal(received.mutationId, mutationB);
});

test('syncHandler rejeita payload reset extra com HTTP 400', async () => {
  const response = responseStub();
  await syncHandler(
    {
      method: 'POST',
      headers: {
        'x-firebase-appcheck': 'valid-app-check',
        authorization: 'Bearer valid-token',
      },
      body: {
        operation: 'apply_study_progress_reset',
        mutationId: mutationB,
        occurredAt: '2026-09-09T10:00:00.000Z',
        extra: true,
      },
    },
    response,
    {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async () => ({ uid: 'user-a' }),
      checkRateLimit: async () => true,
    },
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'INVALID_PAYLOAD');
});

test('syncHandler expõe state invalid allowlisted sem erro bruto', async () => {
  const response = responseStub();
  await syncHandler(
    {
      method: 'POST',
      headers: {
        'x-firebase-appcheck': 'valid-app-check',
        authorization: 'Bearer valid-token',
      },
      body: {
        operation: 'apply_study_progress_reset',
        mutationId: mutationB,
        occurredAt: '2026-09-09T10:00:00.000Z',
      },
    },
    response,
    {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async () => ({ uid: 'user-a' }),
      checkRateLimit: async () => true,
      applyStudyProgressReset: async () => {
        const error = new Error(
          'O estado remoto do progresso de estudos está inconsistente.',
        );
        error.statusCode = 409;
        error.code = 'STUDY_PROGRESS_STATE_INVALID';
        error.privateDetail = 'private-state';
        throw error;
      },
    },
  );
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    error: 'O estado remoto do progresso de estudos está inconsistente.',
    code: 'STUDY_PROGRESS_STATE_INVALID',
  });
  assert.equal(JSON.stringify(response.body).includes('private-state'), false);
});
