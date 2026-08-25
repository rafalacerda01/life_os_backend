import assert from 'node:assert/strict';
import test from 'node:test';

import { checkDistributedRateLimit } from '../api/_distributed_rate_limit.js';

class FakeFirestore {
  constructor() {
    this.documents = new Map();
    this.documentIds = [];
    this.transactionCalls = 0;
    this.tail = Promise.resolve();
  }

  collection(name) {
    assert.equal(name, 'server_rate_limits');
    return {
      doc: (id) => {
        this.documentIds.push(id);
        return { id };
      },
    };
  }

  runTransaction(callback) {
    const run = this.tail.then(async () => {
      this.transactionCalls += 1;
      const pendingWrites = new Map();
      const transaction = {
        get: async (reference) => {
          const data = this.documents.get(reference.id);
          return {
            exists: data !== undefined,
            data: () => data === undefined ? undefined : { ...data },
          };
        },
        set: (reference, data) => {
          pendingWrites.set(reference.id, { ...data });
        },
      };

      const result = await callback(transaction);
      for (const [id, data] of pendingWrites) {
        this.documents.set(id, data);
      }
      return result;
    });

    this.tail = run.catch(() => {});
    return run;
  }
}

function check(db, overrides = {}) {
  return checkDistributedRateLimit({
    db,
    scope: 'chat',
    uid: 'user-1',
    limit: 3,
    windowMs: 60_000,
    nowMs: 1_000,
    ...overrides,
  });
}

test('primeira request cria a janela e é permitida', async () => {
  const db = new FakeFirestore();

  assert.equal(await check(db), true);
  assert.equal(db.documents.size, 1);
  assert.deepEqual([...db.documents.values()], [
    { windowStartMs: 1_000, count: 1 },
  ]);
});

test('requests até o limite são permitidas e a seguinte é bloqueada', async () => {
  const db = new FakeFirestore();

  assert.equal(await check(db), true);
  assert.equal(await check(db, { nowMs: 2_000 }), true);
  assert.equal(await check(db, { nowMs: 3_000 }), true);
  assert.equal(await check(db, { nowMs: 4_000 }), false);
  assert.deepEqual([...db.documents.values()], [
    { windowStartMs: 1_000, count: 3 },
  ]);
});

test('janela expirada reinicia o contador', async () => {
  const db = new FakeFirestore();

  await check(db);
  await check(db, { nowMs: 2_000 });
  assert.equal(await check(db, { nowMs: 61_000 }), true);
  assert.deepEqual([...db.documents.values()], [
    { windowStartMs: 61_000, count: 1 },
  ]);
});

test('scopes chat e sync possuem documentos independentes', async () => {
  const db = new FakeFirestore();

  assert.equal(await check(db, { scope: 'chat', limit: 1 }), true);
  assert.equal(await check(db, { scope: 'chat', limit: 1 }), false);
  assert.equal(await check(db, { scope: 'sync', limit: 1 }), true);
  assert.equal(db.documents.size, 2);
});

test('usuários diferentes possuem contadores independentes', async () => {
  const db = new FakeFirestore();

  assert.equal(await check(db, { uid: 'user-a', limit: 1 }), true);
  assert.equal(await check(db, { uid: 'user-a', limit: 1 }), false);
  assert.equal(await check(db, { uid: 'user-b', limit: 1 }), true);
  assert.equal(db.documents.size, 2);
});

test('estado persistido inválido falha fechado', async () => {
  const db = new FakeFirestore();
  await check(db);
  const [documentId] = db.documents.keys();
  db.documents.set(documentId, { windowStartMs: 1_000, count: 'invalid' });

  await assert.rejects(
    check(db, { nowMs: 2_000 }),
    { message: 'DISTRIBUTED_RATE_LIMIT_FAILED' },
  );
});

test('transações concorrentes respeitam o limite global', async () => {
  const db = new FakeFirestore();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => check(db, { limit: 10 })),
  );

  assert.equal(results.filter(Boolean).length, 10);
  assert.equal(results.filter((allowed) => !allowed).length, 10);
  assert.deepEqual([...db.documents.values()], [
    { windowStartMs: 1_000, count: 10 },
  ]);
});

test('document ID usa scope e SHA-256 sem expor UID', async () => {
  const db = new FakeFirestore();
  const uid = 'uid-super-secreto';
  await check(db, { uid });

  const [documentId] = db.documentIds;
  assert.match(documentId, /^chat_[a-f0-9]{64}$/);
  assert.doesNotMatch(documentId, new RegExp(uid));
});

test('falha do Firestore é convertida em erro genérico sem segredo', async () => {
  const uid = 'uid-super-secreto';
  const token = 'token-super-secreto';
  const db = {
    collection: () => ({ doc: () => ({}) }),
    runTransaction: async () => {
      throw new Error(`${uid} ${token} private-stack`);
    },
  };

  await assert.rejects(
    checkDistributedRateLimit({
      db,
      scope: 'chat',
      uid,
      limit: 15,
      windowMs: 60_000,
      nowMs: 1_000,
    }),
    (error) => {
      assert.equal(error.message, 'DISTRIBUTED_RATE_LIMIT_FAILED');
      assert.doesNotMatch(error.message, new RegExp(uid));
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    },
  );
});
