import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';

import {
  applyStudyActivity,
  validateStudyActivityPayload,
} from '../api/study/_sync_activity.js';

if (!getApps().length) {
  initializeApp({ projectId: 'study-sync-activity-test' });
}

const { syncHandler } = await import('../api/sync.js');

const mutationA = '7d287d4e-190f-42ab-90a8-a93696f8c462';
const mutationB = '5a3ccf1f-d43e-4a34-823d-61ed255e568a';
const serverTimestamp = () => 'SERVER_TIMESTAMP';

function cloneValue(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]),
    );
  }
  return value;
}

class MemoryReference {
  constructor(owner, path) {
    this.owner = owner;
    this.path = path;
  }

  collection(name) {
    return new MemoryCollection(this.owner, `${this.path}/${name}`);
  }
}

class MemoryCollection {
  constructor(owner, path) {
    this.owner = owner;
    this.path = path;
  }

  doc(id) {
    return new MemoryReference(this.owner, `${this.path}/${id}`);
  }
}

class MemorySnapshot {
  constructor(value) {
    this.value = value;
    this.exists = value !== undefined;
  }

  data() {
    return this.value === undefined ? undefined : cloneValue(this.value);
  }
}

class MemoryTransaction {
  constructor(source) {
    this.data = new Map(
      [...source.entries()].map(([path, value]) => [path, cloneValue(value)]),
    );
  }

  async get(reference) {
    return new MemorySnapshot(this.data.get(reference.path));
  }

  set(reference, value, options) {
    const current = options?.merge
      ? cloneValue(this.data.get(reference.path) ?? {})
      : {};
    Object.assign(current, cloneValue(value));
    this.data.set(reference.path, current);
  }

  update(reference, value) {
    const current = this.data.get(reference.path);
    if (current === undefined) throw new Error('DOCUMENT_NOT_FOUND');
    this.data.set(reference.path, {
      ...cloneValue(current),
      ...cloneValue(value),
    });
  }
}

class MemoryFirestore {
  constructor(initial = {}) {
    this.data = new Map(
      Object.entries(initial).map(([path, value]) => [path, cloneValue(value)]),
    );
    this.transactionRuns = 0;
  }

  collection(name) {
    return new MemoryCollection(this, name);
  }

  async runTransaction(callback) {
    this.transactionRuns += 1;
    const transaction = new MemoryTransaction(this.data);
    const result = await callback(transaction);
    this.data = transaction.data;
    return result;
  }

  read(path) {
    return cloneValue(this.data.get(path));
  }
}

function firestoreWithStudyInfo(studyInfo = {}, subject = undefined) {
  const initial = {
    'users/user-a': { isPremium: true },
    'users/user-a/study_info/main': studyInfo,
  };
  if (subject !== undefined) {
    initial['users/user-a/subjects/subject-1'] = subject;
  }
  return new MemoryFirestore(initial);
}

function apply(db, overrides = {}) {
  return applyStudyActivity({
    db,
    userId: 'user-a',
    mutationId: mutationA,
    subjectId: null,
    progressDelta: .25,
    occurredAt: new Date('2026-09-09T12:00:00.000Z'),
    timeZoneOffsetMinutes: 0,
    serverTimestamp,
    ...overrides,
  });
}

test('primeira mutation incrementa study_info progress', async () => {
  const db = firestoreWithStudyInfo({ progress: .2 });
  await apply(db);
  assert.equal(db.read('users/user-a/study_info/main').progress, .45);
});

test('replay da mesma mutationId não incrementa novamente', async () => {
  const db = firestoreWithStudyInfo({ progress: .2 });
  await apply(db);
  const replay = await apply(db);
  assert.equal(replay.alreadyApplied, true);
  assert.equal(db.read('users/user-a/study_info/main').progress, .45);
});

test('duas mutationIds distintas acumulam sem lost update', async () => {
  const db = firestoreWithStudyInfo({ progress: .2 });
  await apply(db);
  await apply(db, { mutationId: mutationB });
  assert.equal(db.read('users/user-a/study_info/main').progress, .7);
});

test('progress é limitado a um', async () => {
  const db = firestoreWithStudyInfo({ progress: .9 });
  await apply(db);
  assert.equal(db.read('users/user-a/study_info/main').progress, 1);
});

test('atividade posterior ao reset cria ledger mesmo com progress em um', async () => {
  const db = firestoreWithStudyInfo({ progress: 1 });
  db.data.set('users/user-a/study_progress_state/main', {
    lastResetAt: new Date('2026-09-09T10:00:00.000Z'),
  });

  await apply(db);

  assert.equal(db.read('users/user-a/study_info/main').progress, 1);
  assert.deepEqual(
    db.read(`users/user-a/study_progress_events/${mutationA}`),
    {
      kind: 'study_activity',
      progressDelta: .25,
      occurredAt: new Date('2026-09-09T12:00:00.000Z'),
      createdAt: 'SERVER_TIMESTAMP',
    },
  );
});

test('atividade anterior ou igual ao reset não credita global nem cria ledger', async () => {
  for (const resetAt of [
    '2026-09-09T12:00:00.000Z',
    '2026-09-09T13:00:00.000Z',
  ]) {
    const db = firestoreWithStudyInfo(
      { progress: .4 },
      { progress: .3, streakDays: 2 },
    );
    db.data.set('users/user-a/study_progress_state/main', {
      lastResetAt: new Date(resetAt),
    });

    await apply(db, { subjectId: 'subject-1' });

    assert.equal(db.read('users/user-a/study_info/main').progress, .4);
    assert.equal(db.read('users/user-a/subjects/subject-1').progress, .55);
    assert.equal(
      db.read(`users/user-a/study_progress_events/${mutationA}`),
      undefined,
    );
    assert.deepEqual(
      db.read(`users/user-a/study_activity_receipts/${mutationA}`),
      { appliedAt: 'SERVER_TIMESTAMP' },
    );
  }
});

test('progress state inválido falha fechado sem writes ou receipt', async () => {
  const studyInfo = { progress: .2 };
  const db = firestoreWithStudyInfo(studyInfo);
  db.data.set('users/user-a/study_progress_state/main', {
    lastResetAt: null,
  });

  await assert.rejects(
    apply(db),
    (error) =>
      error.statusCode === 409 && error.code === 'STUDY_ACTIVITY_STATE_INVALID',
  );

  assert.deepEqual(db.read('users/user-a/study_info/main'), studyInfo);
  assert.equal(
    db.read(`users/user-a/study_activity_receipts/${mutationA}`),
    undefined,
  );
  assert.equal(
    db.read(`users/user-a/study_progress_events/${mutationA}`),
    undefined,
  );
});

test('subject progress soma server-side na mesma transação', async () => {
  const db = firestoreWithStudyInfo(
    { progress: .2 },
    { progress: .3, streakDays: 2 },
  );
  await apply(db, { subjectId: 'subject-1' });
  assert.equal(db.read('users/user-a/study_info/main').progress, .45);
  assert.equal(db.read('users/user-a/subjects/subject-1').progress, .55);
});

test('evento no mesmo dia mantém streak', async () => {
  const db = firestoreWithStudyInfo({
    progress: .2,
    streak: 4,
    lastStudyDate: new Date('2026-09-09T10:00:00.000Z'),
  });
  await apply(db);
  const info = db.read('users/user-a/study_info/main');
  assert.equal(info.streak, 4);
  assert.equal(info.lastStudyDate.toISOString(), '2026-09-09T12:00:00.000Z');
});

test('evento no dia seguinte incrementa streak', async () => {
  const db = firestoreWithStudyInfo({
    progress: .2,
    streak: 4,
    lastStudyDate: new Date('2026-09-08T12:00:00.000Z'),
  });
  await apply(db);
  assert.equal(db.read('users/user-a/study_info/main').streak, 5);
});

test('gap maior que um dia reinicia streak', async () => {
  const db = firestoreWithStudyInfo({
    progress: .2,
    streak: 4,
    lastStudyDate: new Date('2026-09-06T12:00:00.000Z'),
  });
  await apply(db);
  assert.equal(db.read('users/user-a/study_info/main').streak, 1);
});

test('evento antigo soma progress sem regredir streak ou data', async () => {
  const remoteDate = new Date('2026-09-10T12:00:00.000Z');
  const db = firestoreWithStudyInfo(
    { progress: .2, streak: 5, lastStudyDate: remoteDate },
    { progress: .3, streakDays: 7 },
  );
  await apply(db, { subjectId: 'subject-1' });
  const info = db.read('users/user-a/study_info/main');
  const subject = db.read('users/user-a/subjects/subject-1');
  assert.equal(info.progress, .45);
  assert.equal(info.streak, 5);
  assert.equal(info.lastStudyDate.toISOString(), remoteDate.toISOString());
  assert.equal(subject.progress, .55);
  assert.equal(subject.streakDays, 7);
});

test('subject inexistente retorna erro 409 estável', async () => {
  const db = firestoreWithStudyInfo({ progress: .2 });
  await assert.rejects(
    apply(db, { subjectId: 'subject-1' }),
    (error) =>
      error.statusCode === 409 &&
      error.code === 'STUDY_ACTIVITY_SUBJECT_NOT_FOUND',
  );
  assert.equal(
    db.read(`users/user-a/study_activity_receipts/${mutationA}`),
    undefined,
  );
});

test('estado remoto inválido não é sobrescrito', async () => {
  const db = firestoreWithStudyInfo({ progress: 'invalid' });
  await assert.rejects(
    apply(db),
    (error) =>
      error.statusCode === 409 && error.code === 'STUDY_ACTIVITY_STATE_INVALID',
  );
  assert.equal(db.read('users/user-a/study_info/main').progress, 'invalid');
  assert.equal(
    db.read(`users/user-a/study_activity_receipts/${mutationA}`),
    undefined,
  );
});

test('campos numéricos presentes como null falham fechado', async () => {
  const cases = [
    {
      studyInfo: { progress: null },
      subject: undefined,
      subjectId: null,
    },
    {
      studyInfo: { progress: .2, streak: null },
      subject: undefined,
      subjectId: null,
    },
    {
      studyInfo: { progress: .2 },
      subject: { progress: null, streakDays: 2 },
      subjectId: 'subject-1',
    },
    {
      studyInfo: { progress: .2 },
      subject: { progress: .3, streakDays: null },
      subjectId: 'subject-1',
    },
  ];

  for (const testCase of cases) {
    const db = firestoreWithStudyInfo(testCase.studyInfo, testCase.subject);
    await assert.rejects(
      apply(db, { subjectId: testCase.subjectId }),
      (error) =>
        error.statusCode === 409 &&
        error.code === 'STUDY_ACTIVITY_STATE_INVALID',
    );
    assert.deepEqual(
      db.read('users/user-a/study_info/main'),
      testCase.studyInfo,
    );
    if (testCase.subject !== undefined) {
      assert.deepEqual(
        db.read('users/user-a/subjects/subject-1'),
        testCase.subject,
      );
    }
    assert.equal(
      db.read(`users/user-a/study_activity_receipts/${mutationA}`),
      undefined,
    );
  }
});

test('study_info sem progress começa em zero e aplica delta', async () => {
  const db = firestoreWithStudyInfo({ streak: 0 });
  await apply(db);
  const info = db.read('users/user-a/study_info/main');
  assert.equal(info.progress, .25);
});

test('study_info sem streak e lastStudyDate inicia streak', async () => {
  const db = firestoreWithStudyInfo({ progress: .2 });
  await apply(db);
  const info = db.read('users/user-a/study_info/main');
  assert.equal(info.streak, 1);
});

test('lastStudyDate presente e inválido falha fechado', async () => {
  for (const lastStudyDate of [null, undefined, 'invalid']) {
    const studyInfo = { progress: .2, streak: 3, lastStudyDate };
    const subject = { progress: .3, streakDays: 2 };
    const db = firestoreWithStudyInfo(studyInfo, subject);
    await assert.rejects(
      apply(db, { subjectId: 'subject-1' }),
      (error) =>
        error.statusCode === 409 &&
        error.code === 'STUDY_ACTIVITY_STATE_INVALID',
    );
    assert.deepEqual(db.read('users/user-a/study_info/main'), studyInfo);
    assert.deepEqual(db.read('users/user-a/subjects/subject-1'), subject);
    assert.equal(
      db.read(`users/user-a/study_activity_receipts/${mutationA}`),
      undefined,
    );
  }
});

test('subject sem progress falha fechado sem escrita ou receipt', async () => {
  const studyInfo = { progress: .2 };
  const subject = { streakDays: 2 };
  const db = firestoreWithStudyInfo(studyInfo, subject);
  await assert.rejects(
    apply(db, { subjectId: 'subject-1' }),
    (error) =>
      error.statusCode === 409 &&
      error.code === 'STUDY_ACTIVITY_STATE_INVALID',
  );
  assert.deepEqual(db.read('users/user-a/study_info/main'), studyInfo);
  assert.deepEqual(db.read('users/user-a/subjects/subject-1'), subject);
  assert.equal(
    db.read(`users/user-a/study_activity_receipts/${mutationA}`),
    undefined,
  );
});

test('subject sem streakDays falha fechado sem escrita ou receipt', async () => {
  const studyInfo = { progress: .2 };
  const subject = { progress: .3 };
  const db = firestoreWithStudyInfo(studyInfo, subject);
  await assert.rejects(
    apply(db, { subjectId: 'subject-1' }),
    (error) =>
      error.statusCode === 409 &&
      error.code === 'STUDY_ACTIVITY_STATE_INVALID',
  );
  assert.deepEqual(db.read('users/user-a/study_info/main'), studyInfo);
  assert.deepEqual(db.read('users/user-a/subjects/subject-1'), subject);
  assert.equal(
    db.read(`users/user-a/study_activity_receipts/${mutationA}`),
    undefined,
  );
});

test('receipt contém somente timestamp server-owned', async () => {
  const db = firestoreWithStudyInfo({ progress: .2 });
  await apply(db);
  assert.deepEqual(
    db.read(`users/user-a/study_activity_receipts/${mutationA}`),
    { appliedAt: 'SERVER_TIMESTAMP' },
  );
});

test('validação backend rejeita campos extras e valores inválidos', () => {
  const valid = {
    operation: 'apply_study_activity',
    mutationId: mutationA,
    subjectId: null,
    progressDelta: .25,
    occurredAt: '2026-09-09T12:00:00.000Z',
    timeZoneOffsetMinutes: 0,
  };
  const invalidBodies = [
    { ...valid, extra: true },
    { ...valid, mutationId: 'invalid' },
    { ...valid, subjectId: 'invalid/id' },
    { ...valid, progressDelta: 0 },
    { ...valid, occurredAt: 'invalid' },
    { ...valid, timeZoneOffsetMinutes: 841 },
  ];
  for (const body of invalidBodies) {
    assert.equal(validateStudyActivityPayload(body).valid, false);
  }
});

function responseStub() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function validRequest() {
  return {
    method: 'POST',
    headers: {
      'x-firebase-appcheck': 'valid-app-check',
      authorization: 'Bearer valid-token',
    },
    body: {
      operation: 'apply_study_activity',
      mutationId: mutationA,
      subjectId: null,
      progressDelta: .25,
      occurredAt: '2026-09-09T12:00:00.000Z',
      timeZoneOffsetMinutes: 0,
    },
  };
}

function validRuntime(overrides = {}) {
  return {
    verifyAppCheckToken: async () => ({ appId: 'test-app' }),
    verifyIdToken: async (_, checkRevoked) => {
      assert.equal(checkRevoked, true);
      return { uid: 'user-a' };
    },
    checkRateLimit: async () => true,
    ...overrides,
  };
}

test('syncHandler roteia apply_study_activity validado', async () => {
  let received;
  const response = responseStub();
  await syncHandler(
    validRequest(),
    response,
    validRuntime({
      applyStudyActivity: async (parameters) => {
        received = parameters;
        return { alreadyApplied: false };
      },
    }),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.operation, 'apply_study_activity');
  assert.equal(received.userId, 'user-a');
  assert.equal(received.mutationId, mutationA);
});

test('syncHandler expõe erro de domínio allowlisted sem erro bruto', async () => {
  const response = responseStub();
  await syncHandler(
    validRequest(),
    response,
    validRuntime({
      applyStudyActivity: async () => {
        const error = new Error(
          'A matéria da atividade de estudo não foi encontrada.',
        );
        error.statusCode = 409;
        error.code = 'STUDY_ACTIVITY_SUBJECT_NOT_FOUND';
        throw error;
      },
    }),
  );
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    error: 'A matéria da atividade de estudo não foi encontrada.',
    code: 'STUDY_ACTIVITY_SUBJECT_NOT_FOUND',
  });
});
