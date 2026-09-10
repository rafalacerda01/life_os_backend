import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';
import {
  applyStudyReview,
  validateStudyReviewPayload,
} from '../api/study/_sync_review.js';

if (!getApps().length) initializeApp({ projectId: 'study-sync-review-test' });
const { syncHandler } = await import('../api/sync.js');

const occurredAt = new Date('2026-09-09T12:00:00.000Z');
const serverTimestamp = () => new Date('2026-09-09T15:00:00.000Z');

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    );
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

class Transaction {
  constructor(source) {
    this.data = new Map(
      [...source.entries()].map(([path, value]) => [path, clone(value)]),
    );
    this.hasWritten = false;
    this.readAfterWrite = false;
  }
  async get(reference) {
    if (this.hasWritten) this.readAfterWrite = true;
    return new Snapshot(this.data.get(reference.path));
  }
  set(reference, value, options) {
    this.hasWritten = true;
    const current = options?.merge
      ? clone(this.data.get(reference.path) ?? {})
      : {};
    Object.assign(current, clone(value));
    this.data.set(reference.path, current);
  }
  update(reference, value) {
    this.hasWritten = true;
    const current = this.data.get(reference.path);
    if (current === undefined) throw new Error('DOCUMENT_NOT_FOUND');
    this.data.set(reference.path, { ...clone(current), ...clone(value) });
  }
}

class Firestore {
  constructor(initial) {
    this.data = new Map(
      Object.entries(initial).map(([path, value]) => [path, clone(value)]),
    );
    this.lastTransaction = null;
  }
  collection(name) {
    return new Collection(this, name);
  }
  async runTransaction(callback) {
    const transaction = new Transaction(this.data);
    this.lastTransaction = transaction;
    const result = await callback(transaction);
    this.data = transaction.data;
    return result;
  }
  read(path) {
    return clone(this.data.get(path));
  }
}

const paths = {
  user: 'users/user-a',
  card: 'users/user-a/review_queue/card-1',
  subject: 'users/user-a/subjects/subject-1',
  info: 'users/user-a/study_info/main',
  state: 'users/user-a/study_progress_state/main',
  event: `users/user-a/study_progress_events/review_card-1_${occurredAt.getTime()}`,
};

function database(overrides = {}) {
  const initial = {
    [paths.user]: { isPremium: true },
    [paths.card]: { subjectId: 'subject-1', lastReviewed: null },
    [paths.subject]: { cardsToReview: 2 },
    [paths.info]: { reviewQueue: 3, progress: .2 },
  };
  for (const [path, value] of Object.entries(overrides)) {
    if (value === undefined) delete initial[path];
    else initial[path] = value;
  }
  return new Firestore(initial);
}

function apply(db, overrides = {}) {
  return applyStudyReview({
    db,
    userId: 'user-a',
    cardId: 'card-1',
    subjectId: 'subject-1',
    occurredAt,
    timeZoneOffsetMinutes: 0,
    serverTimestamp,
    ...overrides,
  });
}

function assertNoWrites(db, before) {
  assert.deepEqual(Object.fromEntries(db.data), before);
}

test('review normal atualiza card, counters, progress e ledger atomicamente', async () => {
  const db = database();
  const result = await apply(db);
  assert.deepEqual(result, {
    alreadyApplied: false,
    skippedAsStale: false,
    progress: .25,
  });
  assert.equal(db.read(paths.info).reviewQueue, 2);
  assert.equal(db.read(paths.info).progress, .25);
  assert.equal(db.read(paths.subject).cardsToReview, 1);
  assert.equal(db.read(paths.card).lastReviewed.toISOString(), occurredAt.toISOString());
  assert.deepEqual(db.read(paths.event), {
    kind: 'review',
    progressDelta: .05,
    occurredAt,
    createdAt: serverTimestamp(),
  });
  assert.equal(db.lastTransaction.readAfterWrite, false);
});

test('progress em um continua criando ledger', async () => {
  const db = database({ [paths.info]: { reviewQueue: 3, progress: 1 } });
  await apply(db);
  assert.equal(db.read(paths.info).progress, 1);
  assert.notEqual(db.read(paths.event), undefined);
});

test('review posterior ao reset credita progress e ledger', async () => {
  const db = database({
    [paths.state]: { lastResetAt: new Date('2026-09-09T11:00:00.000Z') },
  });
  await apply(db);
  assert.equal(db.read(paths.info).progress, .25);
  assert.notEqual(db.read(paths.event), undefined);
});

test('review anterior ou igual ao reset conclui sem progress ou ledger', async () => {
  for (const reset of [
    '2026-09-09T12:00:00.000Z',
    '2026-09-09T13:00:00.000Z',
  ]) {
    const db = database({
      [paths.state]: { lastResetAt: new Date(reset) },
    });
    await apply(db);
    assert.equal(db.read(paths.card).lastReviewed.toISOString(), occurredAt.toISOString());
    assert.equal(db.read(paths.info).reviewQueue, 2);
    assert.equal(db.read(paths.info).progress, .2);
    assert.equal(db.read(paths.subject).cardsToReview, 1);
    assert.equal(db.read(paths.event), undefined);
  }
});

test('replay exato é no-op sem decremento duplicado', async () => {
  const db = database({
    [paths.card]: { subjectId: 'subject-1', lastReviewed: occurredAt },
  });
  const before = clone(Object.fromEntries(db.data));
  const result = await apply(db);
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.skippedAsStale, false);
  assertNoWrites(db, before);
});

test('review mais antiga é no-op e não regride lastReviewed', async () => {
  const newer = new Date('2026-09-10T12:00:00.000Z');
  const db = database({
    [paths.card]: { subjectId: 'subject-1', lastReviewed: newer },
  });
  const before = clone(Object.fromEntries(db.data));
  const result = await apply(db);
  assert.equal(result.alreadyApplied, false);
  assert.equal(result.skippedAsStale, true);
  assertNoWrites(db, before);
});

test('review posterior no mesmo dia local é no-op', async () => {
  const db = database({
    [paths.card]: {
      subjectId: 'subject-1',
      lastReviewed: new Date('2026-09-09T10:00:00.000Z'),
    },
  });
  const before = clone(Object.fromEntries(db.data));
  const result = await apply(db, {
    occurredAt: new Date('2026-09-09T23:00:00.000Z'),
    timeZoneOffsetMinutes: -180,
  });
  assert.equal(result.alreadyApplied, true);
  assertNoWrites(db, before);
});

test('próximo dia local aplica exatamente uma vez', async () => {
  const nextDay = new Date('2026-09-10T04:00:00.000Z');
  const db = database({
    [paths.card]: {
      subjectId: 'subject-1',
      lastReviewed: new Date('2026-09-09T23:00:00.000Z'),
    },
  });
  await apply(db, { occurredAt: nextDay, timeZoneOffsetMinutes: -180 });
  assert.equal(db.read(paths.info).reviewQueue, 2);
  assert.equal(db.read(paths.subject).cardsToReview, 1);
  const replay = await apply(db, {
    occurredAt: nextDay,
    timeZoneOffsetMinutes: -180,
  });
  assert.equal(replay.alreadyApplied, true);
  assert.equal(db.read(paths.info).reviewQueue, 2);
});

test('subjectId divergente falha fechado', async () => {
  const db = database();
  const before = clone(Object.fromEntries(db.data));
  await assert.rejects(
    apply(db, { subjectId: 'subject-other' }),
    (error) => error.code === 'STUDY_REVIEW_SUBJECT_NOT_FOUND',
  );
  assertNoWrites(db, before);
});

test('card e subject ausentes retornam erros estáveis', async () => {
  const missingCard = database({ [paths.card]: undefined });
  await assert.rejects(
    apply(missingCard),
    (error) => error.code === 'STUDY_REVIEW_CARD_NOT_FOUND',
  );

  const missingSubject = database({ [paths.subject]: undefined });
  await assert.rejects(
    apply(missingSubject),
    (error) => error.code === 'STUDY_REVIEW_SUBJECT_NOT_FOUND',
  );
});

test('subjectId remoto divergente falha como estado inválido', async () => {
  const db = database({
    [paths.card]: { subjectId: 'subject-other', lastReviewed: null },
  });
  const before = clone(Object.fromEntries(db.data));
  await assert.rejects(
    apply(db),
    (error) => error.code === 'STUDY_REVIEW_STATE_INVALID',
  );
  assertNoWrites(db, before);
});

test('progress state malformado falha sem writes', async () => {
  const db = database({ [paths.state]: { lastResetAt: null } });
  const before = clone(Object.fromEntries(db.data));
  await assert.rejects(
    apply(db),
    (error) => error.code === 'STUDY_REVIEW_STATE_INVALID',
  );
  assertNoWrites(db, before);
});

test('card, progress e contadores inválidos falham sem writes', async () => {
  const databases = [
    database({
      [paths.card]: { subjectId: 'subject-1', lastReviewed: 'invalid' },
    }),
    database({ [paths.info]: { reviewQueue: 3, progress: null } }),
    database({ [paths.info]: { reviewQueue: null, progress: .2 } }),
    database({ [paths.subject]: { cardsToReview: null } }),
  ];
  for (const db of databases) {
    const before = clone(Object.fromEntries(db.data));
    await assert.rejects(
      apply(db),
      (error) => error.code === 'STUDY_REVIEW_STATE_INVALID',
    );
    assertNoWrites(db, before);
  }
});

test('study_info ausente usa defaults permitidos', async () => {
  const db = database({ [paths.info]: undefined });
  await apply(db);
  assert.deepEqual(db.read(paths.info), {
    reviewQueue: 0,
    lastStudyDate: occurredAt,
    progress: .05,
  });
});

test('lastStudyDate ausente recebe occurredAt', async () => {
  const db = database({
    [paths.info]: { reviewQueue: 3, progress: .2 },
  });

  await apply(db);

  assert.equal(
    db.read(paths.info).lastStudyDate.toISOString(),
    occurredAt.toISOString(),
  );
});

test('review mais nova avança lastStudyDate', async () => {
  const previous = new Date('2026-09-09T10:00:00.000Z');
  const db = database({
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      lastStudyDate: previous,
    },
  });

  await apply(db);

  assert.equal(
    db.read(paths.info).lastStudyDate.toISOString(),
    occurredAt.toISOString(),
  );
});

test('review atrasada não regride lastStudyDate global', async () => {
  const currentGlobal = new Date('2026-09-10T15:00:00.000Z');
  const delayedReview = new Date('2026-09-09T18:00:00.000Z');
  const eventPath =
    `users/user-a/study_progress_events/review_card-1_${delayedReview.getTime()}`;
  const db = database({
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      lastStudyDate: currentGlobal,
    },
  });

  await apply(db, { occurredAt: delayedReview });

  assert.equal(
    db.read(paths.card).lastReviewed.toISOString(),
    delayedReview.toISOString(),
  );
  assert.equal(db.read(paths.info).reviewQueue, 2);
  assert.equal(db.read(paths.subject).cardsToReview, 1);
  assert.equal(db.read(paths.info).progress, .25);
  assert.equal(
    db.read(paths.info).lastStudyDate.toISOString(),
    currentGlobal.toISOString(),
  );
  assert.notEqual(db.read(eventPath), undefined);
});

test('lastStudyDate igual a occurredAt permanece estável', async () => {
  const db = database({
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      lastStudyDate: occurredAt,
    },
  });

  await apply(db);

  assert.equal(
    db.read(paths.info).lastStudyDate.toISOString(),
    occurredAt.toISOString(),
  );
  assert.equal(db.read(paths.info).reviewQueue, 2);
});

test('lastStudyDate presente null falha fechado', async () => {
  const db = database({
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      lastStudyDate: null,
    },
  });
  const before = clone(Object.fromEntries(db.data));

  await assert.rejects(
    apply(db),
    (error) => error.code === 'STUDY_REVIEW_STATE_INVALID',
  );
  assertNoWrites(db, before);
});

test('lastStudyDate presente inválido falha fechado', async () => {
  for (const invalidValue of ['invalid', { seconds: 1 }]) {
    const db = database({
      [paths.info]: {
        reviewQueue: 3,
        progress: .2,
        lastStudyDate: invalidValue,
      },
    });
    const before = clone(Object.fromEntries(db.data));

    await assert.rejects(
      apply(db),
      (error) => error.code === 'STUDY_REVIEW_STATE_INVALID',
    );
    assertNoWrites(db, before);
  }
});

test('validação rejeita campos extras, datas, offsets e IDs inválidos', () => {
  const valid = {
    operation: 'apply_study_review',
    cardId: 'card-1',
    subjectId: 'subject-1',
    occurredAt: '2026-09-09T12:00:00.000Z',
    timeZoneOffsetMinutes: -180,
  };
  for (const body of [
    { ...valid, extra: true },
    { ...valid, cardId: '' },
    { ...valid, cardId: 'invalid/id' },
    { ...valid, subjectId: '' },
    { ...valid, subjectId: 'invalid/id' },
    { ...valid, occurredAt: 'invalid' },
    { ...valid, occurredAt: '2026-09-09T12:00:00.000' },
    { ...valid, timeZoneOffsetMinutes: 841 },
  ]) {
    assert.equal(validateStudyReviewPayload(body).valid, false);
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

function request(body = {}) {
  return {
    method: 'POST',
    headers: {
      'x-firebase-appcheck': 'valid-app-check',
      authorization: 'Bearer valid-token',
    },
    body: {
      operation: 'apply_study_review',
      cardId: 'card-1',
      subjectId: 'subject-1',
      occurredAt: '2026-09-09T12:00:00.000Z',
      timeZoneOffsetMinutes: -180,
      ...body,
    },
  };
}

function runtime(overrides = {}) {
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

test('syncHandler roteia apply_study_review', async () => {
  let received;
  const response = responseStub();
  await syncHandler(
    request(),
    response,
    runtime({
      applyStudyReview: async (parameters) => {
        received = parameters;
        return { alreadyApplied: false, skippedAsStale: false };
      },
    }),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.operation, 'apply_study_review');
  assert.equal(received.userId, 'user-a');
  assert.equal(received.cardId, 'card-1');
});

test('syncHandler retorna 400 para payload extra', async () => {
  const response = responseStub();
  await syncHandler(request({ extra: true }), response, runtime());
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'INVALID_PAYLOAD');
});

test('erros de domínio são sanitizados e allowlisted', async () => {
  const response = responseStub();
  await syncHandler(
    request(),
    response,
    runtime({
      applyStudyReview: async () => {
        const error = new Error(
          'O estado remoto da revisão de estudo está inconsistente.',
        );
        error.statusCode = 409;
        error.code = 'STUDY_REVIEW_STATE_INVALID';
        error.privateDetail = 'private-state';
        throw error;
      },
    }),
  );
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    error: 'O estado remoto da revisão de estudo está inconsistente.',
    code: 'STUDY_REVIEW_STATE_INVALID',
  });
  assert.equal(JSON.stringify(response.body).includes('private-state'), false);
});
