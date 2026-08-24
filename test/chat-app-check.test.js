import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';

if (!getApps().length) {
  initializeApp({ projectId: 'chat-app-check-test' });
}

const { chatHandler } = await import('../api/chat.js');

const APP_CHECK_TOKEN = 'app-check-token-secret';

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
  await chatHandler(req, res, runtime);
  return res;
}

function post(headers = {}) {
  return {
    method: 'POST',
    headers,
    body: { message: 'Olá', context: {} },
  };
}

test('POST sem X-Firebase-AppCheck é rejeitado', async () => {
  const response = await invoke(post());

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'APP_CHECK_REQUIRED');
});

test('header X-Firebase-AppCheck vazio é rejeitado', async () => {
  const response = await invoke(
    post({ 'x-firebase-appcheck': '   ' }),
  );

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'APP_CHECK_REQUIRED');
});

test('token App Check inválido é rejeitado', async () => {
  let verifiedToken;
  const response = await invoke(
    post({ 'x-firebase-appcheck': 'invalid-token' }),
    {
      verifyAppCheckToken: async (token) => {
        verifiedToken = token;
        throw new Error('invalid token');
      },
    },
  );

  assert.equal(verifiedToken, 'invalid-token');
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'APP_CHECK_INVALID');
});

test('falha do verifyToken é sanitizada sem token ou erro bruto', async () => {
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...values) => logged.push(values.join(' '));

  try {
    const response = await invoke(
      post({ 'x-firebase-appcheck': APP_CHECK_TOKEN }),
      {
        verifyAppCheckToken: async () => {
          throw new Error(
            `firebase failure ${APP_CHECK_TOKEN} user@example.com`,
          );
        },
      },
    );

    const serializedResponse = JSON.stringify(response.body);
    const serializedLogs = JSON.stringify(logged);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.code, 'APP_CHECK_INVALID');
    assert.doesNotMatch(
      serializedResponse,
      /app-check-token-secret|example\.com|firebase failure/i,
    );
    assert.doesNotMatch(
      serializedLogs,
      /app-check-token-secret|example\.com|firebase failure/i,
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('App Check válido permite continuar para Firebase Auth', async () => {
  let verificationCalls = 0;
  const response = await invoke(
    post({ 'x-firebase-appcheck': APP_CHECK_TOKEN }),
    {
      verifyAppCheckToken: async () => {
        verificationCalls += 1;
        return { appId: 'test-app' };
      },
    },
  );

  assert.equal(verificationCalls, 1);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, undefined);
  assert.match(response.body.error, /Token de segurança ausente/);
});

test('OPTIONS retorna 204 sem exigir App Check', async () => {
  let verificationCalls = 0;
  const response = await invoke(
    { method: 'OPTIONS', headers: {} },
    {
      verifyAppCheckToken: async () => {
        verificationCalls += 1;
      },
    },
  );

  assert.equal(response.statusCode, 204);
  assert.equal(response.ended, true);
  assert.equal(verificationCalls, 0);
});

test('CORS permite o header oficial X-Firebase-AppCheck', async () => {
  const response = await invoke({ method: 'OPTIONS', headers: {} });

  assert.equal(
    response.headers['Access-Control-Allow-Headers'],
    'Content-Type, Authorization, X-Firebase-AppCheck',
  );
});

test('token App Check não aparece na resposta de rejeição', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await invoke(
      post({ 'x-firebase-appcheck': APP_CHECK_TOKEN }),
      {
        verifyAppCheckToken: async () => {
          throw new Error(APP_CHECK_TOKEN);
        },
      },
    );

    assert.doesNotMatch(JSON.stringify(response.body), /app-check-token-secret/);
  } finally {
    console.error = originalConsoleError;
  }
});
test('header X-Firebase-AppCheck em formato inesperado é rejeitado', async () => {
  const response = await invoke(
    post({
      'x-firebase-appcheck': [APP_CHECK_TOKEN],
    }),
  );

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'APP_CHECK_REQUIRED');
});