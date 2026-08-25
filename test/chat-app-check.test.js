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
    body: { message: 'Como melhorar meu foco nos estudos?', context: {} },
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

test('Chat verifica Auth válido com checkRevoked=true após App Check', async () => {
  const verifyCalls = [];
  const response = await invoke(
    post({
      'x-firebase-appcheck': APP_CHECK_TOKEN,
      authorization: 'Bearer firebase-id-token',
    }),
    {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async (token, checkRevoked) => {
        verifyCalls.push({ token, checkRevoked });
        return { uid: 'chat-revocation-check' };
      },
      hasAiConsent: async () => false,
    },
  );

  assert.deepEqual(verifyCalls, [
    { token: 'firebase-id-token', checkRevoked: true },
  ]);
  assert.equal(response.statusCode, 451);
});

test('Chat rejeita token Auth revogado com resposta sanitizada', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await invoke(
      post({
        'x-firebase-appcheck': APP_CHECK_TOKEN,
        authorization: 'Bearer firebase-id-token-secret',
      }),
      {
        verifyAppCheckToken: async () => ({ appId: 'test-app' }),
        verifyIdToken: async () => {
          throw new Error(
            'firebase-id-token-secret sensitive-uid user@example.com stack',
          );
        },
      },
    );

    assert.equal(response.statusCode, 401);
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /firebase-id-token-secret|sensitive-uid|example\.com|stack/i,
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('App Check inválido impede qualquer chamada ao Auth', async () => {
  let authCalls = 0;
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await invoke(
      post({
        'x-firebase-appcheck': APP_CHECK_TOKEN,
        authorization: 'Bearer firebase-id-token',
      }),
      {
        verifyAppCheckToken: async () => {
          throw new Error('invalid App Check');
        },
        verifyIdToken: async () => {
          authCalls += 1;
          return { uid: 'must-not-run' };
        },
      },
    );

    assert.equal(response.statusCode, 401);
    assert.equal(response.body.code, 'APP_CHECK_INVALID');
    assert.equal(authCalls, 0);
  } finally {
    console.error = originalConsoleError;
  }
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

test('Chat usa exatamente o endpoint Gemini configurado', async () => {
  let receivedUrl;
  const response = await invoke(
    post({
      'x-firebase-appcheck': APP_CHECK_TOKEN,
      authorization: 'Bearer firebase-id-token',
    }),
    {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async () => ({ uid: 'gemini-endpoint-test' }),
      hasAiConsent: async () => true,
      hasPremiumAccess: async () => true,
      geminiApiKey: 'test-api-key',
      fetch: async (url) => {
        receivedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: 'Resposta de teste' }],
                },
              },
            ],
          }),
        };
      },
    },
  );

  assert.equal(
    receivedUrl,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
  );
  assert.equal(response.statusCode, 200);
});

test('timeout do Gemini aborta o fetch e retorna 504 controlado', async () => {
  let receivedSignal;
  let abortObserved = false;
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await invoke(
      post({
        'x-firebase-appcheck': APP_CHECK_TOKEN,
        authorization: 'Bearer firebase-id-token',
      }),
      {
        verifyAppCheckToken: async () => ({ appId: 'test-app' }),
        verifyIdToken: async () => ({ uid: 'gemini-timeout-test' }),
        hasAiConsent: async () => true,
        hasPremiumAccess: async () => true,
        geminiApiKey: 'test-api-key',
        geminiTimeoutMs: 5,
        fetch: async (_, options) => {
          receivedSignal = options.signal;
          assert.ok(receivedSignal instanceof AbortSignal);

          return new Promise((_, reject) => {
            receivedSignal.addEventListener(
              'abort',
              () => {
                abortObserved = true;
                reject(new Error('abort detail must stay private'));
              },
              { once: true },
            );
          });
        },
      },
    );

    assert.equal(receivedSignal.aborted, true);
    assert.equal(abortObserved, true);
    assert.equal(response.statusCode, 504);
    assert.deepEqual(response.body, {
      error: 'O serviço de IA demorou para responder.',
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('timeout do Gemini aborta durante a leitura de response.json', async () => {
  let receivedSignal;
  let abortObserved = false;
  const privateError = 'private response body error';
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await invoke(
      post({
        'x-firebase-appcheck': APP_CHECK_TOKEN,
        authorization: 'Bearer firebase-id-token',
      }),
      {
        verifyAppCheckToken: async () => ({ appId: 'test-app' }),
        verifyIdToken: async () => ({ uid: 'gemini-json-timeout-test' }),
        hasAiConsent: async () => true,
        hasPremiumAccess: async () => true,
        geminiApiKey: 'test-api-key',
        geminiTimeoutMs: 5,
        fetch: async (_, options) => {
          receivedSignal = options.signal;
          assert.ok(receivedSignal instanceof AbortSignal);

          return {
            ok: true,
            status: 200,
            json: () =>
              new Promise((_, reject) => {
                receivedSignal.addEventListener(
                  'abort',
                  () => {
                    abortObserved = true;
                    reject(new Error(privateError));
                  },
                  { once: true },
                );
              }),
          };
        },
      },
    );

    assert.equal(receivedSignal.aborted, true);
    assert.equal(abortObserved, true);
    assert.equal(response.statusCode, 504);
    assert.deepEqual(response.body, {
      error: 'O serviço de IA demorou para responder.',
    });
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(privateError));
  } finally {
    console.error = originalConsoleError;
  }
});

test('sucesso do Gemini limpa o timer e não aborta depois', async () => {
  let receivedSignal;
  const response = await invoke(
    post({
      'x-firebase-appcheck': APP_CHECK_TOKEN,
      authorization: 'Bearer firebase-id-token',
    }),
    {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async () => ({ uid: 'gemini-timeout-cleanup-test' }),
      hasAiConsent: async () => true,
      hasPremiumAccess: async () => true,
      geminiApiKey: 'test-api-key',
      geminiTimeoutMs: 5,
      fetch: async (_, options) => {
        receivedSignal = options.signal;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: 'Resposta sem timeout' }],
                },
              },
            ],
          }),
        };
      },
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { reply: 'Resposta sem timeout' });
  assert.equal(receivedSignal.aborted, false);
});

test('erro normal do fetch não é classificado como timeout', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await invoke(
      post({
        'x-firebase-appcheck': APP_CHECK_TOKEN,
        authorization: 'Bearer firebase-id-token',
      }),
      {
        verifyAppCheckToken: async () => ({ appId: 'test-app' }),
        verifyIdToken: async () => ({ uid: 'gemini-fetch-error-test' }),
        hasAiConsent: async () => true,
        hasPremiumAccess: async () => true,
        geminiApiKey: 'test-api-key',
        geminiTimeoutMs: 50,
        fetch: async () => {
          throw new Error('private upstream error');
        },
      },
    );

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
      error: 'Não foi possível processar sua solicitação.',
    });
    assert.doesNotMatch(JSON.stringify(response.body), /private upstream error/);
  } finally {
    console.error = originalConsoleError;
  }
});
