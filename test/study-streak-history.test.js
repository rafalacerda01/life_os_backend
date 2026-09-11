import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalLocalDayOrdinal,
  updateStudyStreakHistory,
} from '../api/study/_streak_history.js';

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
  constructor(path) {
    this.path = path;
  }
  collection(name) {
    return new Collection(`${this.path}/${name}`);
  }
}

class Collection {
  constructor(path) {
    this.path = path;
  }
  doc(id) {
    return new Reference(`${this.path}/${id}`);
  }
  where(field, operator, value) {
    return new Query(this.path).where(field, operator, value);
  }
  orderBy(field, direction) {
    return new Query(this.path).orderBy(field, direction);
  }
}

class Query {
  constructor(path, filter = null, order = null, limitCount = null) {
    this.path = path;
    this.filter = filter;
    this.order = order;
    this.limitCount = limitCount;
  }
  where(field, operator, value) {
    return new Query(
      this.path,
      { field, operator, value },
      this.order,
      this.limitCount,
    );
  }
  orderBy(field, direction) {
    return new Query(
      this.path,
      this.filter,
      { field, direction },
      this.limitCount,
    );
  }
  limit(count) {
    return new Query(this.path, this.filter, this.order, count);
  }
}

class Snapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.value = value;
    this.exists = value !== undefined;
  }
  data() {
    return clone(this.value);
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
    this.queryReads = 0;
    this.hasWritten = false;
    this.readAfterWrite = false;
  }
  async get(query) {
    if (this.hasWritten) this.readAfterWrite = true;
    assert.ok(query instanceof Query);
    this.queryReads += 1;
    const prefix = `${query.path}/`;
    let documents = [...this.data.entries()]
      .filter(([path]) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, value]) => ({ path, value }));
    if (query.filter !== null) {
      const { field, operator, value } = query.filter;
      documents = documents.filter((document) => {
        const candidate = document.value[field];
        if (operator === '<=') return candidate <= value;
        if (operator === '>') return candidate > value;
        throw new Error('UNSUPPORTED_QUERY');
      });
    }
    if (query.order !== null) {
      const { field, direction } = query.order;
      documents.sort((left, right) => {
        const comparison = left.value[field] - right.value[field];
        return direction === 'desc' ? -comparison : comparison;
      });
    }
    if (query.limitCount !== null) {
      documents = documents.slice(0, query.limitCount);
    }
    return new QuerySnapshot(
      documents.map(
        (document) => new Snapshot(
          new Reference(document.path),
          document.value,
        ),
      ),
    );
  }
  set(reference, value) {
    this.hasWritten = true;
    this.data.set(reference.path, clone(value));
  }
  delete(reference) {
    this.hasWritten = true;
    this.data.delete(reference.path);
  }
}

class Firestore {
  constructor(initial = {}) {
    this.data = new Map(
      Object.entries(initial).map(([path, value]) => [path, clone(value)]),
    );
    this.lastTransaction = null;
  }
  collection(name) {
    return new Collection(name);
  }
  async runTransaction(callback) {
    const transaction = new Transaction(this.data);
    this.lastTransaction = transaction;
    const result = await callback(transaction);
    this.data = transaction.data;
    return result;
  }
}

function stateInvalid() {
  const error = new Error('STATE_INVALID');
  error.code = 'STATE_INVALID';
  return error;
}

function ranges(db) {
  const prefix = 'users/user-a/study_streak_ranges/';
  return [...db.data.entries()]
    .filter(([path]) => path.startsWith(prefix))
    .map(([, value]) => clone(value))
    .sort((left, right) => left.startDayOrdinal - right.startDayOrdinal);
}

function day(value) {
  const [year, month, date] = value.split('-');
  return new Date(
    `${year}-${month.padStart(2, '0')}-${date.padStart(2, '0')}T12:00:00.000Z`,
  );
}

async function applyDay(db, state, occurredAt, offset = 0) {
  const result = await db.runTransaction((transaction) =>
    updateStudyStreakHistory({
      transaction,
      userRef: db.collection('users').doc('user-a'),
      occurredAt,
      timeZoneOffsetMinutes: offset,
      currentStreak: state.streak,
      legacyLastStudyDate: state.lastStudyDate,
      stateInvalid,
    }));
  state.streak = result.streak;
  if (
    state.lastStudyDate === null ||
    occurredAt.getTime() > state.lastStudyDate.getTime()
  ) {
    state.lastStudyDate = occurredAt;
  }
  return result;
}

test('canonical local day usa exclusivamente o offset do evento', () => {
  const instant = new Date('2026-09-10T02:30:00.000Z');
  const dayWithBrazilOffset = canonicalLocalDayOrdinal(instant, -180);
  const dayWithUtcOffset = canonicalLocalDayOrdinal(instant, 0);
  assert.equal(dayWithUtcOffset - dayWithBrazilOffset, 1);
  assert.equal(
    canonicalLocalDayOrdinal(new Date('2026-09-09T15:00:00.000Z'), 540),
    dayWithUtcOffset,
  );
  assert.equal(
    canonicalLocalDayOrdinal(new Date('2026-09-09T10:00:00.000Z'), 840),
    dayWithUtcOffset,
  );
  assert.equal(
    canonicalLocalDayOrdinal(new Date('2026-09-10T14:00:00.000Z'), -840),
    dayWithUtcOffset,
  );
});

test('todas as permutações de três dias convergem para uma range e streak três', async () => {
  const permutations = [
    [8, 9, 10],
    [8, 10, 9],
    [9, 8, 10],
    [9, 10, 8],
    [10, 8, 9],
    [10, 9, 8],
  ];
  for (const permutation of permutations) {
    const db = new Firestore();
    const state = { streak: 0, lastStudyDate: null };
    for (const date of permutation) {
      await applyDay(db, state, day(`2026-09-${date}`));
    }
    const storedRanges = ranges(db);
    assert.equal(state.streak, 3);
    assert.equal(storedRanges.length, 1);
    assert.equal(
      storedRanges[0].endDayOrdinal - storedRanges[0].startDayOrdinal + 1,
      3,
    );
  }
});

test('bootstrap legacy 04..08 converge para sete com 10 depois 09 ou 09 depois 10', async () => {
  for (const order of [[10, 9], [9, 10]]) {
    const db = new Firestore();
    const state = { streak: 5, lastStudyDate: day('2026-09-08') };
    for (const date of order) {
      await applyDay(db, state, day(`2026-09-${date}`));
    }
    const storedRanges = ranges(db);
    assert.equal(state.streak, 7);
    assert.equal(storedRanges.length, 1);
    assert.equal(
      storedRanges[0].endDayOrdinal - storedRanges[0].startDayOrdinal + 1,
      7,
    );
  }
});

test('gaps reais permanecem separados e são fundidos quando o dia chega', async () => {
  const db = new Firestore();
  const state = { streak: 0, lastStudyDate: null };
  await applyDay(db, state, day('2026-09-08'));
  await applyDay(db, state, day('2026-09-10'));
  assert.equal(state.streak, 1);
  assert.equal(ranges(db).length, 2);

  await applyDay(db, state, day('2026-09-09'));
  assert.equal(state.streak, 3);
  assert.equal(ranges(db).length, 1);
});

test('múltiplos gaps são fundidos sem remover dias conhecidos', async () => {
  const db = new Firestore();
  const state = { streak: 5, lastStudyDate: day('2026-09-08') };
  for (const date of [10, 12, 11, 9]) {
    await applyDay(db, state, day(`2026-09-${date}`));
  }
  const storedRanges = ranges(db);
  assert.equal(state.streak, 9);
  assert.equal(storedRanges.length, 1);
  assert.equal(
    storedRanges[0].endDayOrdinal - storedRanges[0].startDayOrdinal + 1,
    9,
  );
});

test('mudança de timezone não reinterpreta dia já persistido', async () => {
  const db = new Firestore();
  const state = { streak: 0, lastStudyDate: null };
  const instant = new Date('2026-09-10T02:30:00.000Z');
  await applyDay(db, state, instant, -180);
  await applyDay(db, state, instant, 0);
  const storedRanges = ranges(db);
  assert.equal(state.streak, 2);
  assert.equal(storedRanges.length, 1);
  assert.equal(
    storedRanges[0].endDayOrdinal - storedRanges[0].startDayOrdinal + 1,
    2,
  );
});

test('streak zero com lastStudyDate bootstrapa somente o dia comprovado', async () => {
  const db = new Firestore();
  const state = { streak: 0, lastStudyDate: day('2026-09-08') };
  await applyDay(db, state, day('2026-09-09'));
  assert.equal(state.streak, 2);
  assert.equal(ranges(db).length, 1);
});

test('ranges inválidas falham fechado e preservam estado', async () => {
  const invalidRanges = [
    { startDayOrdinal: 10, endDayOrdinal: 9 },
    { startDayOrdinal: 8.5, endDayOrdinal: 9 },
    { startDayOrdinal: 8, endDayOrdinal: 9, unexpected: true },
  ];
  for (const invalidRange of invalidRanges) {
    const initial = {
      'users/user-a/study_streak_ranges/invalid': invalidRange,
    };
    const db = new Firestore(initial);
    const state = { streak: 1, lastStudyDate: day('2026-09-09') };
    await assert.rejects(
      applyDay(db, state, day('2026-09-10')),
      (error) => error.code === 'STATE_INVALID',
    );
    assert.deepEqual(Object.fromEntries(db.data), initial);
  }
});

test('helper usa três queries limitadas e não lê depois de escrever', async () => {
  const db = new Firestore();
  const state = { streak: 0, lastStudyDate: null };
  await applyDay(db, state, day('2026-09-09'));
  assert.equal(db.lastTransaction.queryReads, 3);
  assert.equal(db.lastTransaction.readAfterWrite, false);
});
