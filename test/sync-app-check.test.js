import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';

if (!getApps().length) {
  initializeApp({ projectId: 'sync-app-check-test' });
}

const { syncHandler } = await import('../api/sync.js');

const APP_CHECK_TOKEN = 'firebase-app-check-secret';
const ID_TOKEN = 'firebase-id-token-secret';

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

async function invoke(req, runtime = {}) {
  const res = responseStub();
  await syncHandler(req, res, runtime);
  return res;
}

function validBody() {
  return {
    operation: 'create_transaction',
    transactionId: 'transaction-1',
    title: 'Transação',
    amount: 10,
    type: 'expense',
    category: 'Teste',
    date: '2026-08-24T12:00:00.000Z',
  };
}

function post(appCheckToken = APP_CHECK_TOKEN) {
  const headers = {
    authorization: `Bearer ${ID_TOKEN}`,
  };
  if (appCheckToken !== undefined) {
    headers['x-firebase-appcheck'] = appCheckToken;
  }
  return { method: 'POST', headers, body: validBody() };
}

test('POST sem App Check falha antes de Auth e da operação', async () => {
  let authCalls = 0;
  let operationCalls = 0;
  const request = post();
  delete request.headers['x-firebase-appcheck'];
  const response = await invoke(request, {
    verifyIdToken: async () => {
      authCalls += 1;
      return { uid: 'user-1' };
    },
    createTransactionWithQuota: async () => {
      operationCalls += 1;
    },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, {
    code: 'APP_CHECK_REQUIRED',
    error: 'Verificação de segurança do aplicativo necessária.',
  });
  assert.equal(authCalls, 0);
  assert.equal(operationCalls, 0);
});

test('App Check vazio ou whitespace falha antes de Auth', async () => {
  for (const token of ['', '   ']) {
    let authCalls = 0;
    const response = await invoke(post(token), {
      verifyIdToken: async () => {
        authCalls += 1;
        return { uid: 'user-1' };
      },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.body.code, 'APP_CHECK_REQUIRED');
    assert.equal(authCalls, 0);
  }
});

test('App Check inválido retorna erro sanitizado sem executar Auth', async () => {
  let authCalls = 0;
  const privateError = 'APP-CHECK-PRIVATE-ERROR';
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(' '));

  try {
    const response = await invoke(post(), {
      verifyAppCheckToken: async () => {
        throw new Error(`${APP_CHECK_TOKEN} ${privateError}`);
      },
      verifyIdToken: async () => {
        authCalls += 1;
        return { uid: 'user-1' };
      },
    });

    const serialized = JSON.stringify({ body: response.body, logs });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, {
      code: 'APP_CHECK_INVALID',
      error: 'Verificação de segurança do aplicativo inválida.',
    });
    assert.equal(authCalls, 0);
    assert.doesNotMatch(serialized, new RegExp(APP_CHECK_TOKEN));
    assert.doesNotMatch(serialized, new RegExp(privateError));
    assert.deepEqual(logs, ['[sync] Falha na verificação do App Check.']);
  } finally {
    console.error = originalConsoleError;
  }
});

test('App Check válido precede Auth e permite a operação Sync', async () => {
  const order = [];
  const response = await invoke(post(), {
    verifyAppCheckToken: async (token) => {
      order.push('app-check');
      assert.equal(token, APP_CHECK_TOKEN);
      return { appId: 'test-app' };
    },
    verifyIdToken: async (token, checkRevoked) => {
      order.push('auth');
      assert.equal(token, ID_TOKEN);
      assert.equal(checkRevoked, true);
      return { uid: 'user-1' };
    },
    createTransactionWithQuota: async () => {
      order.push('operation');
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    success: true,
    operation: 'create_transaction',
  });
  assert.deepEqual(order, ['app-check', 'auth', 'operation']);
});

test('OPTIONS preserva CORS e permite X-Firebase-AppCheck', async () => {
  const response = await invoke({ method: 'OPTIONS', headers: {} });
  const allowedHeaders = response.headers['Access-Control-Allow-Headers'];

  assert.equal(response.statusCode, 204);
  assert.match(allowedHeaders, /Content-Type/);
  assert.match(allowedHeaders, /Authorization/);
  assert.match(allowedHeaders, /X-Firebase-AppCheck/);
});
