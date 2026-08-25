import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';

if (!getApps().length) {
  initializeApp({ projectId: 'privacy-logging-test' });
}

const { chatHandler } = await import('../api/chat.js');
const { syncHandler } = await import('../api/sync.js');

const SECRET_PATTERN =
  /firebase-id-token-secret|sensitive-uid|user@example\.com|private-payload|stack-secret/i;

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

async function invoke(handler, req, runtime = {}) {
  const res = responseStub();
  await handler(req, res, runtime);
  return res;
}

async function captureBackendLogs(callback) {
  const logs = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  const capture = (...values) => {
    logs.push(
      values
        .map((value) =>
          typeof value === 'string' ? value : JSON.stringify(value),
        )
        .join(' '),
    );
  };

  console.error = capture;
  console.warn = capture;
  try {
    return await callback(logs);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
}

function assertNoSecrets(response, logs) {
  assert.doesNotMatch(JSON.stringify(response.body), SECRET_PATTERN);
  assert.doesNotMatch(JSON.stringify(logs), SECRET_PATTERN);
}

function chatPost() {
  return {
    method: 'POST',
    headers: {
      'x-firebase-appcheck': 'valid-app-check',
      authorization: 'Bearer firebase-id-token-secret',
    },
    body: { message: 'Como melhorar meu foco nos estudos?', context: {} },
  };
}

function chatRuntime(overrides = {}) {
  return {
    verifyAppCheckToken: async () => ({ appId: 'test-app' }),
    verifyIdToken: async () => ({ uid: 'safe-test-user' }),
    hasAiConsent: async () => true,
    hasPremiumAccess: async () => true,
    checkRateLimit: async () => true,
    geminiApiKey: 'test-api-key',
    ...overrides,
  };
}

function syncPost(body) {
  return {
    method: 'POST',
    headers: {
      'x-firebase-appcheck': 'valid-app-check',
      authorization: 'Bearer firebase-id-token-secret',
    },
    body,
  };
}

function sensitiveError() {
  const error = new Error(
    'firebase-id-token-secret sensitive-uid user@example.com private-payload',
  );
  error.stack = 'stack-secret';
  return error;
}

test('Chat sanitiza falha de Firebase Auth em log e resposta', async () => {
  await captureBackendLogs(async (logs) => {
    const response = await invoke(
      chatHandler,
      chatPost(),
      chatRuntime({
        verifyIdToken: async () => {
          throw sensitiveError();
        },
      }),
    );

    assert.equal(response.statusCode, 401);
    assertNoSecrets(response, logs);
  });
});

test('Chat sanitiza falha ao consultar consentimento', async () => {
  await captureBackendLogs(async (logs) => {
    const response = await invoke(
      chatHandler,
      chatPost(),
      chatRuntime({
        hasAiConsent: async () => {
          throw sensitiveError();
        },
      }),
    );

    assert.equal(response.statusCode, 500);
    assertNoSecrets(response, logs);
  });
});

test('Chat sanitiza falha ao consultar Premium', async () => {
  await captureBackendLogs(async (logs) => {
    const response = await invoke(
      chatHandler,
      chatPost(),
      chatRuntime({
        hasPremiumAccess: async () => {
          throw sensitiveError();
        },
      }),
    );

    assert.equal(response.statusCode, 500);
    assertNoSecrets(response, logs);
  });
});

test('Chat sanitiza falha inesperada sem chamar Gemini real', async () => {
  await captureBackendLogs(async (logs) => {
    const response = await invoke(
      chatHandler,
      chatPost(),
      chatRuntime({
        fetch: async () => {
          throw sensitiveError();
        },
      }),
    );

    assert.equal(response.statusCode, 500);
    assertNoSecrets(response, logs);
  });
});

test('Chat não registra mensagem textual retornada pelo Google', async () => {
  await captureBackendLogs(async (logs) => {
    const response = await invoke(
      chatHandler,
      chatPost(),
      chatRuntime({
        fetch: async () => ({
          ok: false,
          status: 429,
          json: async () => ({
            error: {
              code: 429,
              status: 'private-payload',
              message:
                'firebase-id-token-secret sensitive-uid user@example.com',
            },
          }),
        }),
      }),
    );

    assert.equal(response.statusCode, 502);
    assert.match(JSON.stringify(logs), /429/);
    assertNoSecrets(response, logs);
  });
});

test('Sync sanitiza falha de Firebase Auth em log e resposta', async () => {
  await captureBackendLogs(async (logs) => {
    const response = await invoke(syncHandler, syncPost(null), {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async () => {
        throw sensitiveError();
      },
    });

    assert.equal(response.statusCode, 401);
    assertNoSecrets(response, logs);
  });
});

test('Sync preserva contrato de erro de domínio allowlisted', async () => {
  await captureBackendLogs(async (logs) => {
    const domainError = new Error(
      'Limite gratuito de 3 transações atingido.',
    );
    domainError.statusCode = 403;
    domainError.code = 'TRANSACTION_QUOTA_EXCEEDED';

    const response = await invoke(
      syncHandler,
      syncPost({
        operation: 'create_transaction',
        transactionId: 'transaction-1',
        title: 'Transação',
        amount: 10,
        type: 'expense',
        category: 'Teste',
        date: '2026-08-24T12:00:00.000Z',
      }),
      {
        verifyAppCheckToken: async () => ({ appId: 'test-app' }),
        verifyIdToken: async () => ({ uid: 'safe-test-user' }),
        checkRateLimit: async () => true,
        createTransactionWithQuota: async () => {
          throw domainError;
        },
      },
    );

    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, {
      error: 'Limite gratuito de 3 transações atingido.',
      code: 'TRANSACTION_QUOTA_EXCEEDED',
    });
    assertNoSecrets(response, logs);
  });
});

test('Sync usa fallback fixo para erro inesperado de operação', async () => {
  await captureBackendLogs(async (logs) => {
    const error = sensitiveError();
    error.statusCode = 418;
    error.code = 'private-payload';

    const response = await invoke(
      syncHandler,
      syncPost({
        operation: 'create_transaction',
        transactionId: 'transaction-2',
        title: 'Transação',
        amount: 10,
        type: 'expense',
        category: 'Teste',
        date: '2026-08-24T12:00:00.000Z',
      }),
      {
        verifyAppCheckToken: async () => ({ appId: 'test-app' }),
        verifyIdToken: async () => ({ uid: 'safe-test-user-2' }),
        checkRateLimit: async () => true,
        createTransactionWithQuota: async () => {
          throw error;
        },
      },
    );

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
      error: 'Não foi possível criar a transação.',
      code: 'TRANSACTION_CREATE_FAILED',
    });
    assertNoSecrets(response, logs);
  });
});
