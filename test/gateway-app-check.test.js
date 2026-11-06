import assert from 'node:assert/strict';
import test from 'node:test';
import {createNormalWriterFixture, assertGuardedDatabase, r5Paths, writerObservation} from './helpers/normal-writer-fixture.cjs';

import { createActivityHandler } from '../api/activity/_shared.js';
import { createFocusHandler } from '../api/focus/_shared.js';
import { createCircleDeleteHandler } from '../api/circles/_shared.js';
import taskHandler from '../api/activity/task-complete.js';
import habitHandler from '../api/activity/habit-complete.js';
import startHandler from '../api/focus/start.js';
import finishHandler from '../api/focus/finish.js';
import cancelHandler from '../api/focus/cancel.js';
import circleHandler from '../api/circles/delete.js';

const APP_CHECK_TOKEN = 'firebase-app-check-token';
const ID_TOKEN = 'firebase-id-token';
let fixtureId = 0;
const gateways = [
  {
    name: 'activity',
    body: { taskId: 'private-task' },
    create: (execute) => createActivityHandler('taskComplete', 'ACTIVITY_FAILED', execute),
  },
  {
    name: 'focus',
    body: { targetId: 'private-task', targetType: 'TASK', plannedDurationSeconds: 60 },
    create: (execute) => createFocusHandler('start', 'FOCUS_FAILED', execute),
  },
  {
    name: 'circles',
    body: { circleId: 'private-circle' },
    create: (execute) => createCircleDeleteHandler(execute),
  },
];

function post(body) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ID_TOKEN}`,
      'x-firebase-appcheck': `  ${APP_CHECK_TOKEN}  `,
    },
    body,
  };
}

async function invoke(handler, req, runtime) {
  const res = {
    statusCode: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  await handler(req, res, runtime);
  return res;
}

function fixture(gateway) {
  const calls = [];
  const uid = `gateway-test-${++fixtureId}`;
  const state = { appCheckError: null, authError: null, uidReads: 0 };
  const db = createNormalWriterFixture();
  const appCheck = {
    async verifyToken(token) {
      calls.push('appCheck');
      assert.equal(token, APP_CHECK_TOKEN);
      if (state.appCheckError) throw state.appCheckError;
      return { appId: 'test-app' };
    },
  };
  const auth = {
    async verifyIdToken(token, checkRevoked) {
      calls.push('auth');
      assert.equal(token, ID_TOKEN);
      assert.equal(checkRevoked, true);
      if (state.authError) throw state.authError;
      return {
        get uid() { state.uidReads += 1; return uid; },
      };
    },
  };
  const handler = gateway.create(async (parameters) => {
    calls.push('execute');
    assert.equal(parameters.uid, uid);
    await assertGuardedDatabase(parameters.db, db, uid);
    assert.deepEqual(parameters.body, gateway.body);
    return { body: { ok: true } };
  });
  return {
    handler, calls, state, uid, db,
    runtime: {
      getServices: () => ({ auth, appCheck, db }),
      checkRateLimit: async () => { calls.push('rateLimit'); return true; },
    },
  };
}

for (const gateway of gateways) {
  test(`${gateway.name}: OPTIONS keeps CORS without security or business calls`, async () => {
    const f = fixture(gateway);
    const res = await invoke(f.handler, {
      method: 'OPTIONS', headers: { origin: 'https://app.life-os.com' },
    }, f.runtime);
    assert.equal(res.statusCode, 204);
    const custodyGateway = gateway.name === 'activity' || gateway.name === 'focus';
    assert.equal(res.headers['Access-Control-Allow-Headers'], custodyGateway
      ? 'Content-Type, Authorization, X-Firebase-AppCheck, X-LifeOS-Operation'
      : 'Content-Type, Authorization, X-Firebase-AppCheck');
    if (custodyGateway) assert.equal(res.headers['Access-Control-Expose-Headers'], 'X-LifeOS-Operation-Ack');
    assert.equal(res.headers['Access-Control-Allow-Methods'], 'POST,OPTIONS');
    assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://app.life-os.com');
    assert.deepEqual(f.calls, []);
    assert.equal(f.state.uidReads, 0);
  });

  for (const [name, value] of [
    ['missing', undefined], ['empty', ''], ['whitespace', '   '],
    ['non-string', 123], ['array', [APP_CHECK_TOKEN]],
  ]) {
    test(`${gateway.name}: ${name} App Check blocks Auth and business`, async () => {
      const f = fixture(gateway);
      const req = post(gateway.body);
      delete req.headers['x-firebase-appcheck'];
      if (value !== undefined) req.headers['x-firebase-appcheck'] = value;
      const res = await invoke(f.handler, req, f.runtime);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, {
        code: 'APP_CHECK_REQUIRED',
        error: 'Verificação de segurança do aplicativo necessária.',
      });
      assert.deepEqual(f.calls, []);
      assert.equal(f.state.uidReads, 0);
    });
  }

  test(`${gateway.name}: invalid App Check is sanitized and stops before Auth`, async (t) => {
    const log = t.mock.method(console, 'error', () => {});
    const f = fixture(gateway);
    f.state.appCheckError = new Error(
      `private-verifier-error ${APP_CHECK_TOKEN} ${ID_TOKEN} ${f.uid} ${JSON.stringify(gateway.body)}`,
    );
    const res = await invoke(f.handler, post(gateway.body), f.runtime);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      code: 'APP_CHECK_INVALID',
      error: 'Verificação de segurança do aplicativo inválida.',
    });
    assert.deepEqual(f.calls, ['appCheck']);
    assert.equal(f.state.uidReads, 0);
    const logs = log.mock.calls.map((call) => call.arguments);
    assert.deepEqual(logs, [[`[${gateway.name}] Falha na verificação do App Check.`]]);
    const output = JSON.stringify({ body: res.body, logs });
    for (const secret of [
      APP_CHECK_TOKEN, ID_TOKEN, f.uid, 'private-verifier-error',
      ...Object.values(gateway.body).filter((value) => typeof value === 'string'),
    ]) assert.equal(output.includes(secret), false);
  });

  test(`${gateway.name}: valid App Check precedes revoked Auth rejection`, async () => {
    const f = fixture(gateway);
    f.state.authError = new Error('private-auth-error');
    const res = await invoke(f.handler, post(gateway.body), f.runtime);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'UNAUTHENTICATED');
    assert.deepEqual(f.calls, ['appCheck', 'auth']);
    assert.equal(f.state.uidReads, 0);
  });

  test(`${gateway.name}: App Check, Auth, rate limit, business execute in order`, async () => {
    const f = fixture(gateway);
    const res = await invoke(f.handler, post(gateway.body), f.runtime);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.deepEqual(f.calls, ['appCheck', 'auth', 'rateLimit', 'execute']);
  });

  test(`${gateway.name}: runtime verifier seam is used without Firebase`, async () => {
    const f = fixture(gateway);
    const res = await invoke(f.handler, post(gateway.body), {
      ...f.runtime,
      verifyAppCheckToken: async (token) => {
        assert.equal(token, APP_CHECK_TOKEN);
        f.calls.push('runtimeAppCheck');
        return { appId: 'test-app' };
      },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(f.calls, ['runtimeAppCheck', 'auth', 'rateLimit', 'execute']);
  });

  test(`${gateway.name}: rejected App Check never calls the distributed limiter`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const f = fixture(gateway);
    const missing = post(gateway.body);
    delete missing.headers['x-firebase-appcheck'];
    assert.equal((await invoke(f.handler, missing, f.runtime)).body.code, 'APP_CHECK_REQUIRED');
    f.state.appCheckError = new Error('invalid');
    assert.equal((await invoke(f.handler, post(gateway.body), f.runtime)).body.code, 'APP_CHECK_INVALID');
    assert.equal(f.state.uidReads, 0);
    assert.equal(f.calls.filter((call) => call === 'rateLimit').length, 0);
    assert.equal(f.calls.filter((call) => call === 'execute').length, 0);
    f.state.appCheckError = null;
    assert.equal((await invoke(f.handler, post(gateway.body), f.runtime)).statusCode, 200);
    assert.equal(f.calls.filter((call) => call === 'rateLimit').length, 1);
    assert.equal(f.calls.filter((call) => call === 'execute').length, 1);
  });
}

for (const [name, handler, body] of [
  ['task-complete', taskHandler, { taskId: 'task-1' }],
  ['habit-complete', habitHandler, { habitId: 'habit-1' }],
  ['start', startHandler, { targetId: 'task-1', targetType: 'TASK', plannedDurationSeconds: 60 }],
  ['finish', finishHandler, { sessionId: 'session-1' }],
  ['cancel', cancelHandler, { sessionId: 'session-1' }],
  ['circle-delete', circleHandler, { circleId: 'circle-1' }],
]) {
  test(`entrypoint ${name} rejects missing App Check before services`, async () => {
    const req = post(body);
    delete req.headers['x-firebase-appcheck'];
    let servicesCalls = 0;
    const res = await invoke(handler, req, {
      getServices: () => { servicesCalls += 1; throw new Error('unexpected'); },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'APP_CHECK_REQUIRED');
    assert.equal(servicesCalls, 0);
  });
}

for (const gateway of gateways) {
  for (const index of [0, 1, 2]) test(gateway.name + ': isolated R5 control ' + index + ' denies the writer callback', async () => {
    const f = fixture(gateway); f.db.put(r5Paths(f.uid)[index], {});
    const before = [...f.db.docs];
    const response = await invoke(f.handler, post(gateway.body), f.runtime);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'ACCOUNT_DELETION_BLOCKED');
    assert.deepEqual([...f.db.docs], before);
    assert.equal(writerObservation(f.db).probes.at(-1).entered, false);
  });
  test(gateway.name + ': controls for independent B do not block verified A', async () => {
    const f = fixture(gateway); for (const path of r5Paths('independent-B')) f.db.put(path, {deny: true});
    const before = [...f.db.docs];
    const response = await invoke(f.handler, post(gateway.body), f.runtime);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {ok: true});
    assert.deepEqual([...f.db.docs], before);
    assert.equal(writerObservation(f.db).probes.at(-1).completed, true);
  });
  test(gateway.name + ': R5 introduced before commit is checked again on retry', async () => {
    const f = fixture(gateway), target = f.db.doc('users/' + f.uid + '/probe/private');
    f.db.put('users/independent-B', {keep: true}); let injected = 0;
    f.db.hooks.beforeCommit = ({writes}) => {
      if (!injected && writes.some(w => w.path === target.path)) {injected++; f.db.put(r5Paths(f.uid)[2], {deny: true});}
    };
    const handler = gateway.create(async parameters => {
      await parameters.db.runTransaction(tx => {tx.set(target, {mutation: true});});
      return {body: {ok: true}};
    });
    const response = await invoke(handler, post(gateway.body), f.runtime);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'ACCOUNT_DELETION_BLOCKED');
    assert.equal(injected, 1); assert.ok(f.db.conflicts >= 1);
    assert.equal(f.db.docs.has(target.path), false);
    assert.deepEqual(f.db.docs.get('users/independent-B'), {keep: true});
    assert.equal(writerObservation(f.db).attempts.length, 2);
    const attempts = writerObservation(f.db).attempts;
    assert.deepEqual(attempts[0].reads, [...r5Paths(f.uid), 'trusted_account_origins/' + f.uid]);
    // The retry refuses at the third R5 control, before origin/business reads.
    assert.deepEqual(attempts[1].reads, r5Paths(f.uid));
  });
}
