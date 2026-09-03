import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createActivityHandler } from '../api/activity/_shared.js';
import { createFocusHandler } from '../api/focus/_shared.js';
import { createCircleDeleteHandler } from '../api/circles/_shared.js';

const UID = 'private-gateway-uid';
const ID_TOKEN = 'private-firebase-token';
const APP_CHECK_TOKEN = 'private-app-check-token';
const gateways = [
  ...[
    ['taskComplete', 'activity_task_complete', { taskId: 'private-task' }],
    ['habitComplete', 'activity_habit_complete', { habitId: 'private-habit' }],
  ].map(([operation, scope, body]) => ({
    group: 'activity', scope, body, limit: 30,
    create: (execute) => createActivityHandler(operation, 'ACTIVITY_FAILED', execute),
    limitedMessage: 'Muitas solicitacoes de atividade. Tente novamente em instantes.',
    unavailableMessage: 'Não foi possível verificar o limite de atividade.',
  })),
  ...[
    ['start', 20, { targetId: 'private-task', targetType: 'TASK', plannedDurationSeconds: 60 }],
    ['finish', 30, { sessionId: 'private-session' }],
    ['cancel', 30, { sessionId: 'private-session' }],
  ].map(([operation, limit, body]) => ({
    group: 'focus', scope: `focus_${operation}`, body, limit,
    create: (execute) => createFocusHandler(operation, 'FOCUS_FAILED', execute),
    limitedMessage: 'Muitas solicitações Focus. Tente novamente em instantes.',
    unavailableMessage: 'Não foi possível verificar o limite de solicitações Focus.',
  })),
  {
    group: 'circles', scope: 'circle_delete', limit: 5,
    body: { circleId: 'private-circle' },
    create: (execute) => createCircleDeleteHandler(execute),
    limitedMessage: 'Muitas solicitacoes. Tente novamente em instantes.',
    unavailableMessage: 'Não foi possível verificar o limite de solicitações.',
  },
];

// Serial transactions model atomic access across separate handler instances.
class FakeFirestore {
  documents = new Map();
  transactionCalls = 0;
  tail = Promise.resolve();

  collection(name) {
    assert.equal(name, 'server_rate_limits');
    return { doc: (id) => ({ id }) };
  }

  runTransaction(callback) {
    const run = this.tail.then(async () => {
      this.transactionCalls += 1;
      const writes = new Map();
      const result = await callback({
        get: async ({ id }) => ({
          exists: this.documents.has(id),
          data: () => ({ ...this.documents.get(id) }),
        }),
        set: ({ id }, data) => writes.set(id, { ...data }),
      });
      for (const [id, data] of writes) this.documents.set(id, data);
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
}

function fixture(gateway) {
  const db = new FakeFirestore();
  const calls = [];
  const rateCalls = [];
  const businessCalls = [];
  const state = { allowed: true, rateError: null, rejectApp: false, rejectAuth: false, now: 1_000 };
  const runtime = {
    getServices: () => ({
      db,
      appCheck: {
        async verifyToken(token) {
          calls.push('appCheck');
          assert.equal(token, APP_CHECK_TOKEN);
          if (state.rejectApp) throw new Error('private-app-error');
          return { appId: 'test-app' };
        },
      },
      auth: {
        async verifyIdToken(token, checkRevoked) {
          calls.push('auth');
          assert.equal(token, ID_TOKEN);
          assert.equal(checkRevoked, true);
          if (state.rejectAuth) throw new Error('private-auth-error');
          return { uid: UID };
        },
      },
    }),
    nowProvider: () => { calls.push('now'); return state.now; },
    checkRateLimit: async (parameters) => {
      calls.push('rateLimit');
      rateCalls.push(parameters);
      if (state.rateError) throw state.rateError;
      return state.allowed;
    },
  };
  const execute = async (parameters) => {
    calls.push('business');
    businessCalls.push(parameters);
    return { body: { ok: true } };
  };
  const handler = gateway.create(execute);
  return { db, calls, rateCalls, businessCalls, state, runtime, execute, handler };
}

function post(gateway) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ID_TOKEN}`,
      'x-firebase-appcheck': APP_CHECK_TOKEN,
    },
    body: gateway.body,
  };
}

async function invoke(handler, req, runtime) {
  const res = {
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  await handler(req, res, runtime);
  return res;
}

for (const gateway of gateways) {
  test(`${gateway.scope}: verified UID, static scope, quota and security order`, async () => {
    const f = fixture(gateway);
    const response = await invoke(f.handler, post(gateway), f.runtime);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ok: true });
    const time = gateway.group === 'circles' ? { nowMs: f.state.now } : {};
    assert.deepEqual(f.rateCalls, [{
      db: f.db, uid: UID, scope: gateway.scope,
      limit: gateway.limit, windowMs: 60_000, ...time,
    }]);
    assert.deepEqual(f.calls, [
      'appCheck', 'auth', ...(gateway.group === 'circles' ? ['now'] : []),
      'rateLimit', 'business',
    ]);
    assert.deepEqual(f.businessCalls, [{
      body: gateway.body, db: f.db, uid: UID,
      ...(gateway.group === 'circles' ? { nowMillis: f.state.now } : {}),
    }]);
  });

  test(`${gateway.scope}: denied quota preserves 429 and skips business`, async () => {
    const f = fixture(gateway);
    f.state.allowed = false;
    const response = await invoke(f.handler, post(gateway), f.runtime);
    assert.equal(response.statusCode, 429);
    assert.deepEqual(response.body, { code: 'RATE_LIMITED', error: gateway.limitedMessage });
    assert.equal(f.rateCalls.length, 1);
    assert.deepEqual(f.businessCalls, []);
  });

  test(`${gateway.scope}: limiter failure returns sanitized 503 without business`, async (t) => {
    const log = t.mock.method(console, 'error', () => {});
    const f = fixture(gateway);
    const secrets = [
      UID, ID_TOKEN, APP_CHECK_TOKEN, JSON.stringify(gateway.body),
      'private-firestore-error', 'private-stack',
      ...Object.values(gateway.body).filter((value) => typeof value === 'string'),
    ];
    f.state.rateError = new Error(secrets.join(' '));
    const response = await invoke(f.handler, post(gateway), f.runtime);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      code: 'RATE_LIMIT_UNAVAILABLE', error: gateway.unavailableMessage,
    });
    assert.equal(f.rateCalls.length, 1);
    assert.deepEqual(f.businessCalls, []);
    const logs = log.mock.calls.map((call) => call.arguments);
    assert.deepEqual(logs, [[`[${gateway.group}] Falha ao verificar rate limit.`]]);
    const output = JSON.stringify({ body: response.body, logs });
    for (const secret of secrets) assert.equal(output.includes(secret), false);
  });

  for (const failure of ['missingAppCheck', 'invalidAppCheck', 'invalidAuth']) {
    test(`${gateway.scope}: ${failure} never consumes distributed quota`, async (t) => {
      t.mock.method(console, 'error', () => {});
      const f = fixture(gateway);
      const req = post(gateway);
      if (failure === 'missingAppCheck') delete req.headers['x-firebase-appcheck'];
      f.state.rejectApp = failure === 'invalidAppCheck';
      f.state.rejectAuth = failure === 'invalidAuth';
      const response = await invoke(f.handler, req, f.runtime);
      assert.equal(response.statusCode, 401);
      assert.deepEqual(f.rateCalls, []);
      assert.deepEqual(f.businessCalls, []);
      assert.equal(f.db.transactionCalls, 0);
      assert.equal(f.db.documents.size, 0);
    });
  }

  test(`${gateway.scope}: default helper shares concurrent quota across handlers and renews after 60s`, async (t) => {
    const f = fixture(gateway);
    t.mock.method(Date, 'now', () => f.state.now);
    delete f.runtime.checkRateLimit;
    const handlers = [f.handler, gateway.create(f.execute)];
    const responses = await Promise.all(Array.from({ length: gateway.limit + 2 }, (_, i) =>
      invoke(handlers[i % 2], post(gateway), f.runtime)));
    assert.equal(responses.filter((res) => res.statusCode === 200).length, gateway.limit);
    assert.equal(responses.filter((res) => res.statusCode === 429).length, 2);
    assert.equal(f.businessCalls.length, gateway.limit);
    assert.equal(f.db.documents.size, 1);
    const hash = createHash('sha256').update(UID, 'utf8').digest('hex');
    assert.deepEqual([...f.db.documents], [[`${gateway.scope}_${hash}`, {
      windowStartMs: 1_000, count: gateway.limit,
    }]]);
    f.state.now = 60_999;
    assert.equal((await invoke(handlers[1], post(gateway), f.runtime)).statusCode, 429);
    f.state.now = 61_000;
    assert.equal((await invoke(handlers[1], post(gateway), f.runtime)).statusCode, 200);
    assert.deepEqual([...f.db.documents.values()], [{ windowStartMs: 61_000, count: 1 }]);
  });

  test(`${gateway.scope}: default helper Firestore failure has no memory fallback`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const f = fixture(gateway);
    delete f.runtime.checkRateLimit;
    f.db.runTransaction = async () => { throw new Error('private-firestore-error'); };
    const response = await invoke(f.handler, post(gateway), f.runtime);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      code: 'RATE_LIMIT_UNAVAILABLE', error: gateway.unavailableMessage,
    });
    assert.deepEqual(f.businessCalls, []);
    assert.equal(f.db.documents.size, 0);
  });
}
