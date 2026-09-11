import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';
import {
  applyStudyReview,
  validateStudyReviewPayload,
} from '../api/study/_sync_review.js';
import { canonicalLocalDayOrdinal } from '../api/study/_streak_history.js';

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

  where(field, operator, value) {
    return new Query(this.owner, this.path).where(field, operator, value);
  }

  orderBy(field, direction) {
    return new Query(this.owner, this.path).orderBy(field, direction);
  }
}

class Query {
  constructor(owner, path, filter = null, order = null, limitCount = null) {
    this.owner = owner;
    this.path = path;
    this.filter = filter;
    this.order = order;
    this.limitCount = limitCount;
  }
  where(field, operator, value) {
    return new Query(
      this.owner,
      this.path,
      { field, operator, value },
      this.order,
      this.limitCount,
    );
  }
  orderBy(field, direction) {
    return new Query(
      this.owner,
      this.path,
      this.filter,
      { field, direction },
      this.limitCount,
    );
  }
  limit(count) {
    return new Query(
      this.owner,
      this.path,
      this.filter,
      this.order,
      count,
    );
  }
}

class Snapshot {
  constructor(value, ref = null) {
    this.value = value;
    this.exists = value !== undefined;
    this.ref = ref;
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
    this.data = new Map(
      [...source.entries()].map(([path, value]) => [path, clone(value)]),
    );
    this.hasWritten = false;
    this.readAfterWrite = false;
  }
  async get(reference) {
    if (this.hasWritten) this.readAfterWrite = true;
    if (reference instanceof Query) {
      const prefix = `${reference.path}/`;
      let documents = [...this.data.entries()]
        .filter(([path]) =>
          path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, value]) => ({ path, value }));
      if (reference.filter !== null) {
        const { field, operator, value } = reference.filter;
        documents = documents.filter((document) => {
          const candidate = document.value[field];
          if (operator === '<=') return candidate <= value;
          if (operator === '>') return candidate > value;
          throw new Error('UNSUPPORTED_QUERY');
        });
      }
      if (reference.order !== null) {
        const { field, direction } = reference.order;
        documents.sort((left, right) => {
          const comparison = left.value[field] - right.value[field];
          return direction === 'desc' ? -comparison : comparison;
        });
      }
      if (reference.limitCount !== null) {
        documents = documents.slice(0, reference.limitCount);
      }
      return new QuerySnapshot(
        documents.map(
          (document) => new Snapshot(
            document.value,
            new Reference(null, document.path),
          ),
        ),
      );
    }
    return new Snapshot(this.data.get(reference.path), reference);
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
  delete(reference) {
    this.hasWritten = true;
    this.data.delete(reference.path);
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

function storedRanges(db) {
  const prefix = 'users/user-a/study_streak_ranges/';
  return [...db.data.entries()]
    .filter(([path]) => path.startsWith(prefix))
    .map(([, value]) => clone(value));
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
  assert.equal(db.read(paths.info).streak, 1);
  assert.equal(db.read(paths.subject).cardsToReview, 1);
  assert.equal(db.read(paths.card).lastReviewed.toISOString(), occurredAt.toISOString());
  assert.equal(
    db.read(paths.card).lastReviewedDayOrdinal,
    canonicalLocalDayOrdinal(occurredAt, 0),
  );
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
  const reviewDay = canonicalLocalDayOrdinal(occurredAt, 0);
  const db = database({
    [paths.card]: {
      subjectId: 'subject-1',
      lastReviewed: occurredAt,
      lastReviewedDayOrdinal: reviewDay,
    },
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      streak: 6,
      lastStudyDate: occurredAt,
    },
    'users/user-a/study_streak_ranges/history': {
      startDayOrdinal: reviewDay - 5,
      endDayOrdinal: reviewDay,
    },
  });
  const before = clone(Object.fromEntries(db.data));
  const result = await apply(db);
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.skippedAsStale, false);
  assertNoWrites(db, before);
});

test('replay exato migrado ignora offset divergente e não altera history', async () => {
  const exactTimestamp = new Date('2026-09-10T01:00:00.000Z');
  const persistedDay = canonicalLocalDayOrdinal(exactTimestamp, -180);
  const replayDay = canonicalLocalDayOrdinal(exactTimestamp, 840);
  assert.notEqual(persistedDay, replayDay);
  const db = database({
    [paths.card]: {
      subjectId: 'subject-1',
      lastReviewed: exactTimestamp,
      lastReviewedDayOrdinal: persistedDay,
    },
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      streak: 1,
      lastStudyDate: exactTimestamp,
    },
    'users/user-a/study_streak_ranges/history': {
      startDayOrdinal: persistedDay,
      endDayOrdinal: persistedDay,
    },
  });
  const before = clone(Object.fromEntries(db.data));

  const result = await apply(db, {
    occurredAt: exactTimestamp,
    timeZoneOffsetMinutes: 840,
  });

  assert.deepEqual(result, {
    alreadyApplied: true,
    skippedAsStale: false,
  });
  assertNoWrites(db, before);
});

test('primeiro replay legacy cria somente history e metadata de streak', async () => {
  const db = database({
    [paths.card]: { subjectId: 'subject-1', lastReviewed: occurredAt },
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      streak: 5,
      lastStudyDate: new Date('2026-09-08T12:00:00.000Z'),
    },
  });

  const result = await apply(db);

  assert.equal(result.alreadyApplied, true);
  assert.equal(db.read(paths.info).reviewQueue, 3);
  assert.equal(db.read(paths.info).progress, .2);
  assert.equal(db.read(paths.info).streak, 6);
  assert.equal(db.read(paths.subject).cardsToReview, 2);
  assert.equal(db.read(paths.event), undefined);
  assert.equal(storedRanges(db).length, 1);
  assert.equal(
    db.read(paths.card).lastReviewedDayOrdinal,
    canonicalLocalDayOrdinal(occurredAt, 0),
  );
});

test('replay exato legacy migra somente lastReviewedDayOrdinal', async () => {
  const reviewDay = canonicalLocalDayOrdinal(occurredAt, 0);
  const db = database({
    [paths.card]: { subjectId: 'subject-1', lastReviewed: occurredAt },
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      streak: 1,
      lastStudyDate: occurredAt,
    },
    'users/user-a/study_streak_ranges/history': {
      startDayOrdinal: reviewDay,
      endDayOrdinal: reviewDay,
    },
  });
  const infoBefore = db.read(paths.info);
  const subjectBefore = db.read(paths.subject);

  const result = await apply(db);

  assert.deepEqual(result, {
    alreadyApplied: true,
    skippedAsStale: false,
  });
  assert.deepEqual(db.read(paths.card), {
    subjectId: 'subject-1',
    lastReviewed: occurredAt,
    lastReviewedDayOrdinal: reviewDay,
  });
  assert.deepEqual(db.read(paths.info), infoBefore);
  assert.deepEqual(db.read(paths.subject), subjectBefore);
  assert.equal(db.read(paths.event), undefined);
  assert.deepEqual(storedRanges(db), [{
    startDayOrdinal: reviewDay,
    endDayOrdinal: reviewDay,
  }]);
});

test('review mais antiga é no-op e não regride lastReviewed', async () => {
  const newer = new Date('2026-09-10T12:00:00.000Z');
  const db = database({
    [paths.card]: { subjectId: 'subject-1', lastReviewed: newer },
  });
  const result = await apply(db);
  assert.equal(result.alreadyApplied, false);
  assert.equal(result.skippedAsStale, true);
  assert.equal(db.read(paths.card).lastReviewed.toISOString(), newer.toISOString());
  assert.equal(db.read(paths.info).reviewQueue, 3);
  assert.equal(db.read(paths.info).progress, .2);
  assert.equal(db.read(paths.info).streak, 1);
  assert.equal(db.read(paths.subject).cardsToReview, 2);
  assert.equal(db.read(paths.event), undefined);
  assert.equal(storedRanges(db).length, 1);
  assert.equal(
    Object.hasOwn(db.read(paths.card), 'lastReviewedDayOrdinal'),
    false,
  );
});

test('review legacy posterior no mesmo dia local é no-op', async () => {
  const db = database({
    [paths.card]: {
      subjectId: 'subject-1',
      lastReviewed: new Date('2026-09-09T10:00:00.000Z'),
    },
  });
  const result = await apply(db, {
    occurredAt: new Date('2026-09-09T23:00:00.000Z'),
    timeZoneOffsetMinutes: -180,
  });
  assert.equal(result.alreadyApplied, true);
  assert.equal(db.read(paths.info).reviewQueue, 3);
  assert.equal(db.read(paths.info).progress, .2);
  assert.equal(db.read(paths.info).streak, 1);
  assert.equal(db.read(paths.subject).cardsToReview, 2);
  assert.equal(db.read(paths.event), undefined);
  assert.equal(storedRanges(db).length, 1);
  assert.equal(
    Object.hasOwn(db.read(paths.card), 'lastReviewedDayOrdinal'),
    false,
  );
});

test('ordinal persistido impede reinterpretar review anterior após mudança de timezone', async () => {
  const reviewA = new Date('2026-09-10T01:00:00.000Z');
  const reviewB = new Date('2026-09-10T11:00:00.000Z');
  const dayA = canonicalLocalDayOrdinal(reviewA, -180);
  const dayB = canonicalLocalDayOrdinal(reviewB, 180);
  assert.notEqual(dayA, dayB);
  assert.equal(canonicalLocalDayOrdinal(reviewA, 180), dayB);
  const db = database({
    [paths.card]: {
      subjectId: 'subject-1',
      lastReviewed: reviewA,
      lastReviewedDayOrdinal: dayA,
    },
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      streak: 1,
      lastStudyDate: reviewA,
    },
    'users/user-a/study_streak_ranges/day-a': {
      startDayOrdinal: dayA,
      endDayOrdinal: dayA,
    },
  });
  const eventPath =
    `users/user-a/study_progress_events/review_card-1_${reviewB.getTime()}`;

  const result = await apply(db, {
    occurredAt: reviewB,
    timeZoneOffsetMinutes: 180,
  });

  assert.deepEqual(result, {
    alreadyApplied: false,
    skippedAsStale: false,
    progress: .25,
  });
  assert.equal(db.read(paths.card).lastReviewed.toISOString(), reviewB.toISOString());
  assert.equal(db.read(paths.card).lastReviewedDayOrdinal, dayB);
  assert.equal(db.read(paths.info).reviewQueue, 2);
  assert.equal(db.read(paths.info).progress, .25);
  assert.equal(db.read(paths.info).streak, 2);
  assert.equal(db.read(paths.subject).cardsToReview, 1);
  assert.notEqual(db.read(eventPath), undefined);
});

test('review posterior no ordinal persistido do mesmo dia não reaplica efeitos', async () => {
  const previous = new Date('2026-09-09T10:00:00.000Z');
  const later = new Date('2026-09-09T23:00:00.000Z');
  const day = canonicalLocalDayOrdinal(later, -180);
  const db = database({
    [paths.card]: {
      subjectId: 'subject-1',
      lastReviewed: previous,
      lastReviewedDayOrdinal: day,
    },
  });

  const result = await apply(db, {
    occurredAt: later,
    timeZoneOffsetMinutes: -180,
  });

  assert.equal(result.alreadyApplied, true);
  assert.equal(db.read(paths.card).lastReviewed.toISOString(), previous.toISOString());
  assert.equal(db.read(paths.card).lastReviewedDayOrdinal, day);
  assert.equal(db.read(paths.info).reviewQueue, 3);
  assert.equal(db.read(paths.info).progress, .2);
  assert.equal(db.read(paths.subject).cardsToReview, 2);
  assert.equal(
    db.read(`users/user-a/study_progress_events/review_card-1_${later.getTime()}`),
    undefined,
  );
});

test('review stale fecha gap de streak sem repetir efeitos do card', async () => {
  const day8 = canonicalLocalDayOrdinal(
    new Date('2026-09-08T12:00:00.000Z'),
    0,
  );
  const day10 = canonicalLocalDayOrdinal(
    new Date('2026-09-10T12:00:00.000Z'),
    0,
  );
  const newestReview = new Date('2026-09-10T15:00:00.000Z');
  const db = database({
    [paths.card]: {
      subjectId: 'subject-1',
      lastReviewed: newestReview,
      lastReviewedDayOrdinal: day10,
    },
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      streak: 1,
      lastStudyDate: newestReview,
    },
    'users/user-a/study_streak_ranges/day-8': {
      startDayOrdinal: day8,
      endDayOrdinal: day8,
    },
    'users/user-a/study_streak_ranges/day-10': {
      startDayOrdinal: day10,
      endDayOrdinal: day10,
    },
  });

  const result = await apply(db);

  assert.equal(result.skippedAsStale, true);
  assert.equal(db.read(paths.card).lastReviewed.toISOString(), newestReview.toISOString());
  assert.equal(db.read(paths.card).lastReviewedDayOrdinal, day10);
  assert.equal(db.read(paths.info).reviewQueue, 3);
  assert.equal(db.read(paths.info).progress, .2);
  assert.equal(db.read(paths.info).streak, 3);
  assert.equal(
    db.read(paths.info).lastStudyDate.toISOString(),
    newestReview.toISOString(),
  );
  assert.equal(db.read(paths.subject).cardsToReview, 2);
  assert.equal(db.read(paths.event), undefined);
  const history = storedRanges(db);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], {
    startDayOrdinal: day8,
    endDayOrdinal: day10,
  });
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

test('range remota inválida falha fechado com código de review', async () => {
  const db = database({
    'users/user-a/study_streak_ranges/invalid': {
      startDayOrdinal: 20705,
      endDayOrdinal: 20704,
    },
  });
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

test('lastReviewedDayOrdinal inválido falha fechado sem writes', async () => {
  const validLastReviewed = new Date('2026-09-09T10:00:00.000Z');
  const invalidCards = [
    { subjectId: 'subject-1', lastReviewedDayOrdinal: 20705 },
    {
      subjectId: 'subject-1',
      lastReviewed: null,
      lastReviewedDayOrdinal: 20705,
    },
    {
      subjectId: 'subject-1',
      lastReviewed: validLastReviewed,
      lastReviewedDayOrdinal: null,
    },
    {
      subjectId: 'subject-1',
      lastReviewed: validLastReviewed,
      lastReviewedDayOrdinal: '20705',
    },
    {
      subjectId: 'subject-1',
      lastReviewed: validLastReviewed,
      lastReviewedDayOrdinal: 20705.5,
    },
  ];

  for (const card of invalidCards) {
    const db = database({ [paths.card]: card });
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
    streak: 1,
    lastStudyDate: occurredAt,
    progress: .05,
  });
});

test('lastStudyDate ausente recebe occurredAt', async () => {
  const db = database({
    [paths.info]: { reviewQueue: 3, progress: .2 },
  });

  await apply(db);

  assert.equal(db.read(paths.info).streak, 1);
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
      streak: 5,
      lastStudyDate: previous,
    },
  });

  await apply(db);

  assert.equal(db.read(paths.info).streak, 5);
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
      streak: 6,
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
  assert.equal(db.read(paths.info).streak, 6);
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
      streak: 5,
      lastStudyDate: occurredAt,
    },
  });

  await apply(db);

  assert.equal(db.read(paths.info).streak, 5);
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

test('review no dia local seguinte incrementa streak uma vez', async () => {
  const db = database({
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      streak: 5,
      lastStudyDate: new Date('2026-09-08T12:00:00.000Z'),
    },
  });

  await apply(db);

  assert.equal(db.read(paths.info).streak, 6);
  assert.equal(
    db.read(paths.info).lastStudyDate.toISOString(),
    occurredAt.toISOString(),
  );
});

test('review no mesmo dia local mantém streak', async () => {
  const db = database({
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      streak: 5,
      lastStudyDate: new Date('2026-09-09T10:00:00.000Z'),
    },
  });

  await apply(db);

  assert.equal(db.read(paths.info).streak, 5);
  assert.equal(
    db.read(paths.info).lastStudyDate.toISOString(),
    occurredAt.toISOString(),
  );
});

test('gap maior que um dia reinicia streak', async () => {
  const db = database({
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      streak: 5,
      lastStudyDate: new Date('2026-09-06T12:00:00.000Z'),
    },
  });

  await apply(db);

  assert.equal(db.read(paths.info).streak, 1);
  assert.equal(
    db.read(paths.info).lastStudyDate.toISOString(),
    occurredAt.toISOString(),
  );
});

test('lastStudyDate presente exige streak', async () => {
  const db = database({
    [paths.info]: {
      reviewQueue: 3,
      progress: .2,
      lastStudyDate: new Date('2026-09-08T12:00:00.000Z'),
    },
  });
  const before = clone(Object.fromEntries(db.data));

  await assert.rejects(
    apply(db),
    (error) => error.code === 'STUDY_REVIEW_STATE_INVALID',
  );
  assertNoWrites(db, before);
});

test('streak presente inválida falha fechado', async () => {
  for (const invalidStreak of [null, -1, 1.5, '5']) {
    const db = database({
      [paths.info]: {
        reviewQueue: 3,
        progress: .2,
        streak: invalidStreak,
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
