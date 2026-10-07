import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({ projectId: 'sync-premium-entitlement-test' });
}

const { syncHandler } = await import('../api/sync.js');
const firestore = getFirestore();
const UID = 'quota-user';
const USER_PATH = `users/${UID}`;
const DATE = '2026-01-01T12:00:00.000Z';
const FUTURE = Timestamp.fromDate(new Date('2100-01-01T00:00:00.000Z'));
const PAST = Timestamp.fromDate(new Date('2000-01-01T00:00:00.000Z'));

function premium(plan = 'monthly', overrides = {}) {
  return {
    isPremium: true,
    premiumProvider: 'google_play',
    premiumProductId: 'life_os_premium',
    premiumBasePlanId: plan,
    premiumTier: plan,
    premiumSubscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    premiumExpiresAt: FUTURE,
    ...overrides,
  };
}

const expired = () => premium('monthly', {
  premiumSubscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
  premiumExpiresAt: PAST,
});

const operations = [
  {
    entity: 'transaction', collection: 'transactions', counter: 'transactionsCount',
    idField: 'transactionId', quotaCode: 'TRANSACTION_QUOTA_EXCEEDED',
    payload: { title: 'Transaction', amount: 10, type: 'expense', category: 'Outros', date: DATE },
  },
  {
    entity: 'medication', collection: 'medications', counter: 'medicationsCount',
    idField: 'medicationId', quotaCode: 'MEDICATION_QUOTA_EXCEEDED', premiumLimit: 30,
    payload: { name: 'Medication', startDate: DATE, durationDays: null, endDate: null },
  },
  {
    entity: 'subject', collection: 'subjects', counter: 'subjectsCount',
    idField: 'subjectId', quotaCode: 'SUBJECT_QUOTA_EXCEEDED', premiumLimit: 30,
    payload: { title: 'Subject', hasExam: false, examDate: null },
  },
  {
    entity: 'goal', collection: 'goals', counter: 'goalsCount',
    idField: 'goalId', quotaCode: 'GOAL_QUOTA_EXCEEDED', premiumLimit: 30,
    payload: { title: 'Goal', period: 'MENSAL', targetValue: 5, createdAt: DATE },
  },
  {
    entity: 'task', collection: 'tasks', counter: 'tasksCount',
    idField: 'taskId', quotaCode: 'TASK_QUOTA_EXCEEDED',
    payload: { title: 'Task', priority: 'high', date: DATE },
  },
  {
    entity: 'habit', collection: 'habits', counter: 'habitsCount',
    idField: 'habitId', quotaCode: 'HABIT_QUOTA_EXCEEDED', premiumLimit: 30,
    payload: { title: 'Habit', completedDates: [] },
  },
];

function collection(path) {
  return {
    doc: id => document(`${path}/${id}`),
    where: () => ({ path, query: true, limit: () => ({ path, query: true }) }),
  };
}

function document(path) {
  return { path, collection: name => collection(`${path}/${name}`) };
}

function fixture(t, config, entitlement, count = 3) {
  const targetPath = `${USER_PATH}/${config.collection}/entity-1`;
  const userData = { ...entitlement, [config.counter]: count };
  const docs = new Map([[USER_PATH, userData]]);
  const writes = [];
  t.mock.method(firestore, 'collection', collection);
  t.mock.method(firestore, 'runTransaction', async callback => {
    const pendingWrites = [];
    const result = await callback({
      async get(reference) {
        if (reference.query) return { size: 0, docs: [] };
        return { exists: docs.has(reference.path), data: () => docs.get(reference.path) };
      },
      set: (reference, data, options) => pendingWrites.push({ type: 'set', reference, data, options }),
      update: (reference, data) => pendingWrites.push({ type: 'update', reference, data }),
      delete: reference => pendingWrites.push({ type: 'delete', reference }),
    });
    // Only commit the simulated writes when the real quota transaction succeeds.
    for (const write of pendingWrites) {
      writes.push(write);
      const path = write.reference.path;
      if (write.type === 'delete') docs.delete(path);
      else if (write.type === 'update' || write.options?.merge) {
        docs.set(path, { ...docs.get(path), ...write.data });
      } else docs.set(path, write.data);
    }
    return result;
  });

  async function invoke(action = 'create') {
    const response = {
      statusCode: 200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await syncHandler({
      method: 'POST',
      headers: { 'x-firebase-appcheck': 'test-app-check', authorization: 'Bearer test-id-token' },
      body: {
        operation: `${action}_${config.entity}`,
        [config.idField]: 'entity-1',
        ...(action === 'create' ? config.payload : {}),
      },
    }, response, {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async (_, checkRevoked) => {
        assert.equal(checkRevoked, true);
        return { uid: UID };
      },
      checkRateLimit: async parameters => {
        assert.deepEqual(parameters, { scope: 'sync', uid: UID, limit: 30, windowMs: 60_000 });
        return true;
      },
    });
    return response;
  }

  return { docs, writes, targetPath, userData, invoke };
}

function assertQuotaDenied(f, response, config) {
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, config.quotaCode);
  assert.equal(f.writes.length, 0);
  assert.equal(f.docs.has(f.targetPath), false);
  assert.deepEqual(f.docs.get(USER_PATH), f.userData);
}

for (const config of operations) {
  test(`${config.entity}: expired stale Premium uses Free quota without writes`, async t => {
    const f = fixture(t, config, expired());
    assertQuotaDenied(f, await f.invoke(), config);
  });

  for (const plan of ['monthly', 'annual']) {
    test(`${config.entity}: valid ${plan} Premium creates above Free quota`, async t => {
      const f = fixture(t, config, premium(plan));
      const response = await f.invoke();
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, { success: true, operation: `create_${config.entity}` });
      assert.equal(f.docs.has(f.targetPath), true);
      assert.equal(f.docs.get(USER_PATH)[config.counter], 4);
      assert.equal(f.writes.length, 2);
    });
  }

  test(`${config.entity}: existing creation remains idempotent after Premium expires`, async t => {
    const f = fixture(t, config, expired(), 30);
    const existing = { ...config.payload };
    f.docs.set(f.targetPath, existing);
    assert.equal((await f.invoke()).statusCode, 200);
    assert.equal((await f.invoke()).statusCode, 200);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.docs.get(f.targetPath), existing);
    assert.deepEqual(f.docs.get(USER_PATH), f.userData);
  });

  test(`${config.entity}: expired Premium still allows deletion and idempotent retry`, async t => {
    const f = fixture(t, config, expired());
    f.docs.set(f.targetPath, { ...config.payload });
    assert.equal((await f.invoke('delete')).statusCode, 200);
    assert.equal(f.docs.has(f.targetPath), false);
    assert.equal(f.docs.get(USER_PATH)[config.counter], 2);
    const committedWrites = f.writes.length;
    assert.ok(f.writes.some(write => write.type === 'delete' && write.reference.path === f.targetPath));
    assert.equal((await f.invoke('delete')).statusCode, 200);
    assert.equal(f.writes.length, committedWrites);
    assert.equal(f.docs.get(USER_PATH)[config.counter], 2);
  });

  test(`${config.entity}: original Premium limit remains unchanged`, async t => {
    const f = fixture(t, config, premium(), 30);
    const response = await f.invoke();
    if (config.premiumLimit === 30) assertQuotaDenied(f, response, config);
    else {
      assert.equal(response.statusCode, 200);
      assert.equal(f.docs.has(f.targetPath), true);
      assert.equal(f.docs.get(USER_PATH)[config.counter], 31);
    }
  });
}

for (const [name, overrides, allowed] of [
  ['grace period with future expiry', { premiumSubscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' }, true],
  ['canceled with future expiry', { premiumSubscriptionState: 'SUBSCRIPTION_STATE_CANCELED' }, true],
  ['canceled with past expiry', { premiumSubscriptionState: 'SUBSCRIPTION_STATE_CANCELED', premiumExpiresAt: PAST }, false],
  ['active with past expiry', { premiumExpiresAt: PAST }, false],
  ['on hold', { premiumSubscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' }, false],
  ['paused', { premiumSubscriptionState: 'SUBSCRIPTION_STATE_PAUSED' }, false],
  ['invalid provider', { premiumProvider: 'other' }, false],
  ['invalid product', { premiumProductId: 'other' }, false],
  ['invalid base plan', { premiumBasePlanId: 'other' }, false],
  ['tier mismatch', { premiumTier: 'annual' }, false],
  ['missing metadata', { premiumProvider: undefined, premiumExpiresAt: undefined }, false],
  ['malformed expiry', { premiumExpiresAt: '2100-01-01' }, false],
  ['null expiry', { premiumExpiresAt: null }, false],
]) {
  test(`task quota integration: ${name}`, async t => {
    const config = operations.find(operation => operation.entity === 'task');
    const f = fixture(t, config, premium('monthly', overrides));
    const response = await f.invoke();
    if (!allowed) assertQuotaDenied(f, response, config);
    else {
      assert.equal(response.statusCode, 200);
      assert.equal(f.docs.has(f.targetPath), true);
      assert.equal(f.docs.get(USER_PATH)[config.counter], 4);
    }
  });
}
