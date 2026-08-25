import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({ projectId: 'sync-legacy-disabled-test' });
}

const { syncHandler } = await import('../api/sync.js');
const firestore = getFirestore();

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
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
    end() {
      this.ended = true;
      return this;
    },
  };
}

function post(body) {
  return {
    method: 'POST',
    headers: {
      'x-firebase-appcheck': 'valid-app-check',
      authorization: 'Bearer valid-id-token',
    },
    body,
  };
}

function validRuntime(overrides = {}) {
  return {
    verifyAppCheckToken: async () => ({ appId: 'test-app' }),
    verifyIdToken: async (_, checkRevoked) => {
      assert.equal(checkRevoked, true);
      return { uid: 'modern-sync-user' };
    },
    ...overrides,
  };
}

async function invoke(body, runtime = validRuntime()) {
  const res = responseStub();
  await syncHandler(post(body), res, runtime);
  return res;
}

function restoreMethod(target, name, hadOwnMethod, originalMethod) {
  if (hadOwnMethod) {
    target[name] = originalMethod;
  } else {
    delete target[name];
  }
}

async function invokeWithRootWriteGuard(body) {
  const hadOwnCollection = Object.hasOwn(firestore, 'collection');
  const originalCollection = firestore.collection;
  let firestoreAccesses = 0;

  firestore.collection = () => {
    firestoreAccesses += 1;
    throw new Error('LEGACY_FIRESTORE_ACCESS_FORBIDDEN');
  };

  try {
    const response = await invoke(body);
    return { response, firestoreAccesses };
  } finally {
    restoreMethod(
      firestore,
      'collection',
      hadOwnCollection,
      originalCollection,
    );
  }
}

function assertLegacyContract(response) {
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    code: 'SYNC_OPERATION_REQUIRED',
    error: 'Operação de sincronização inválida ou não suportada.',
  });
}

const legacyCases = [
  [
    'bulk tasks é rejeitado sem escrita root',
    { tasks: [{ id: 'task-1', title: 'Teste' }] },
  ],
  [
    'bulk habits é rejeitado sem escrita root',
    { habits: [{ id: 'habit-1', title: 'Teste' }] },
  ],
  [
    'bulk finances é rejeitado sem escrita root',
    { finances: [{ id: 'finance-1', amount: 10 }] },
  ],
  [
    'bulk combinado é rejeitado sem escrita root',
    { tasks: [], habits: [], finances: [] },
  ],
  ['body vazio é rejeitado sem escrita root', {}],
  [
    'operação desconhecida é rejeitada sem escrita root',
    { operation: 'qualquer_coisa' },
  ],
];

for (const [name, body] of legacyCases) {
  test(name, async () => {
    const { response, firestoreAccesses } =
      await invokeWithRootWriteGuard(body);

    assertLegacyContract(response);
    assert.equal(firestoreAccesses, 0);
  });
}

function fakeCollection(path) {
  return {
    path,
    doc(id) {
      return fakeDocument(`${path}/${id}`);
    },
  };
}

function fakeDocument(path) {
  return {
    path,
    collection(name) {
      return fakeCollection(`${path}/${name}`);
    },
  };
}

async function invokeWithQuotaFirestore(body) {
  const hadOwnCollection = Object.hasOwn(firestore, 'collection');
  const hadOwnRunTransaction = Object.hasOwn(firestore, 'runTransaction');
  const originalCollection = firestore.collection;
  const originalRunTransaction = firestore.runTransaction;
  let transactionWrites = 0;

  firestore.collection = (name) => fakeCollection(name);
  firestore.runTransaction = async (callback) => callback({
    async get(reference) {
      if (reference.path === 'users/modern-sync-user') {
        return {
          exists: true,
          data: () => ({
            isPremium: true,
            tasksCount: 0,
            habitsCount: 0,
          }),
        };
      }
      return { exists: false, data: () => undefined };
    },
    set() {
      transactionWrites += 1;
    },
    update() {
      transactionWrites += 1;
    },
  });

  try {
    const response = await invoke(body);
    return { response, transactionWrites };
  } finally {
    restoreMethod(
      firestore,
      'collection',
      hadOwnCollection,
      originalCollection,
    );
    restoreMethod(
      firestore,
      'runTransaction',
      hadOwnRunTransaction,
      originalRunTransaction,
    );
  }
}

test('create_task moderno continua válido', async () => {
  const { response, transactionWrites } = await invokeWithQuotaFirestore({
    operation: 'create_task',
    taskId: 'task-1',
    title: 'Tarefa moderna',
    priority: 'high',
    date: '2026-08-24T12:00:00.000Z',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    success: true,
    operation: 'create_task',
  });
  assert.equal(transactionWrites, 2);
});

test('create_habit moderno continua válido', async () => {
  const { response, transactionWrites } = await invokeWithQuotaFirestore({
    operation: 'create_habit',
    habitId: 'habit-1',
    title: 'Hábito moderno',
    completedDates: [],
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    success: true,
    operation: 'create_habit',
  });
  assert.equal(transactionWrites, 2);
});

test('create_transaction moderno continua válido', async () => {
  let operationCalls = 0;
  const response = await invoke(
    {
      operation: 'create_transaction',
      transactionId: 'transaction-1',
      title: 'Transação moderna',
      amount: 10,
      type: 'expense',
      category: 'Teste',
      date: '2026-08-24T12:00:00.000Z',
    },
    validRuntime({
      createTransactionWithQuota: async () => {
        operationCalls += 1;
      },
    }),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    success: true,
    operation: 'create_transaction',
  });
  assert.equal(operationCalls, 1);
});
