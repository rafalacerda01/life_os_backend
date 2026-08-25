import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';

if (!getApps().length) {
  initializeApp({ projectId: 'distributed-rate-limit-handlers-test' });
}

const { chatHandler } = await import('../api/chat.js');
const { syncHandler } = await import('../api/sync.js');

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

function authenticatedPost(body) {
  return {
    method: 'POST',
    headers: {
      'x-firebase-appcheck': 'valid-app-check-token',
      authorization: 'Bearer valid-id-token',
    },
    body,
  };
}

function chatRuntime(overrides = {}) {
  return {
    verifyAppCheckToken: async () => ({ appId: 'test-app' }),
    verifyIdToken: async (_, checkRevoked) => {
      assert.equal(checkRevoked, true);
      return { uid: 'verified-chat-user' };
    },
    hasAiConsent: async () => true,
    hasPremiumAccess: async () => true,
    geminiApiKey: 'test-api-key',
    ...overrides,
  };
}

function syncRuntime(overrides = {}) {
  return {
    verifyAppCheckToken: async () => ({ appId: 'test-app' }),
    verifyIdToken: async (_, checkRevoked) => {
      assert.equal(checkRevoked, true);
      return { uid: 'verified-sync-user' };
    },
    ...overrides,
  };
}

async function invoke(handler, request, runtime) {
  const response = responseStub();
  await handler(request, response, runtime);
  return response;
}

async function captureErrorLogs(callback) {
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(' '));

  try {
    return await callback(logs);
  } finally {
    console.error = originalConsoleError;
  }
}

test('Chat aplica limite distribuído 15/60s ao UID verificado', async () => {
  let parameters;
  let fetchCalls = 0;
  const response = await invoke(
    chatHandler,
    authenticatedPost({
      message: 'Como melhorar meu foco nos estudos?',
      context: {},
    }),
    chatRuntime({
      checkRateLimit: async (received) => {
        parameters = received;
        return false;
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Gemini não deveria ser chamado');
      },
    }),
  );

  assert.deepEqual(parameters, {
    scope: 'chat',
    uid: 'verified-chat-user',
    limit: 15,
    windowMs: 60_000,
  });
  assert.equal(response.statusCode, 429);
  assert.deepEqual(response.body, {
    error: 'Muitas solicitações. Tente novamente em alguns instantes.',
  });
  assert.equal(fetchCalls, 0);
});

test('Chat falha fechado e sanitiza erro do rate limit', async () => {
  const privateDetail = 'private-firestore-error verified-chat-user';
  let fetchCalls = 0;

  await captureErrorLogs(async (logs) => {
    const response = await invoke(
      chatHandler,
      authenticatedPost({
        message: 'Como melhorar meu foco nos estudos?',
        context: {},
      }),
      chatRuntime({
        checkRateLimit: async () => {
          throw new Error(privateDetail);
        },
        fetch: async () => {
          fetchCalls += 1;
        },
      }),
    );

    const serialized = JSON.stringify({ response: response.body, logs });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      error: 'Não foi possível verificar o limite de solicitações.',
    });
    assert.deepEqual(logs, ['[chat] Falha ao verificar rate limit.']);
    assert.doesNotMatch(serialized, new RegExp(privateDetail));
    assert.equal(fetchCalls, 0);
  });
});

test('Sync aplica limite distribuído 30/60s ao UID verificado', async () => {
  let parameters;
  let operationCalls = 0;
  const response = await invoke(
    syncHandler,
    authenticatedPost({
      operation: 'create_transaction',
      transactionId: 'transaction-1',
      title: 'Transação',
      amount: 10,
      type: 'expense',
      category: 'Teste',
      date: '2026-08-24T12:00:00.000Z',
    }),
    syncRuntime({
      checkRateLimit: async (received) => {
        parameters = received;
        return false;
      },
      createTransactionWithQuota: async () => {
        operationCalls += 1;
      },
    }),
  );

  assert.deepEqual(parameters, {
    scope: 'sync',
    uid: 'verified-sync-user',
    limit: 30,
    windowMs: 60_000,
  });
  assert.equal(response.statusCode, 429);
  assert.deepEqual(response.body, {
    error: 'Muitas solicitações de sincronização. Tente novamente mais tarde.',
  });
  assert.equal(operationCalls, 0);
});

test('Sync falha fechado e sanitiza erro do rate limit', async () => {
  const privateDetail = 'private-firestore-error verified-sync-user';
  let operationCalls = 0;

  await captureErrorLogs(async (logs) => {
    const response = await invoke(
      syncHandler,
      authenticatedPost({
        operation: 'create_transaction',
      }),
      syncRuntime({
        checkRateLimit: async () => {
          throw new Error(privateDetail);
        },
        createTransactionWithQuota: async () => {
          operationCalls += 1;
        },
      }),
    );

    const serialized = JSON.stringify({ response: response.body, logs });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      error: 'Não foi possível verificar o limite de sincronização.',
    });
    assert.deepEqual(logs, ['[sync] Falha ao verificar rate limit.']);
    assert.doesNotMatch(serialized, new RegExp(privateDetail));
    assert.equal(operationCalls, 0);
  });
});
