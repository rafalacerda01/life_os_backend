import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';

if (!getApps().length) {
  initializeApp({ projectId: 'auth-revocation-test' });
}

const { createActivityHandler } = await import('../api/activity/_shared.js');
const { createFocusHandler } = await import('../api/focus/_shared.js');
const { syncHandler } = await import('../api/sync.js');

const TOKEN = 'firebase-id-token-secret';

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
  await handler(req, res, {
    verifyAppCheckToken: async () => ({ appId: 'test-app' }),
    ...runtime,
  });
  return res;
}

function authenticatedPost(body = {}) {
  return {
    method: 'POST',
    headers: {
      'x-firebase-appcheck': 'valid-app-check',
      authorization: `Bearer ${TOKEN}`,
    },
    body,
  };
}

function assertSanitizedAuthenticationError(response, expectedCode) {
  const serialized = JSON.stringify(response.body);
  assert.equal(response.statusCode, 401);
  if (expectedCode !== undefined) {
    assert.equal(response.body.code, expectedCode);
  }
  assert.doesNotMatch(
    serialized,
    /firebase-id-token-secret|revoked-user|example\.com|stack/i,
  );
}

test('Activity verifica o ID token com checkRevoked=true', async () => {
  const verifyCalls = [];
  const handler = createActivityHandler(
    'taskComplete',
    'ACTIVITY_FAILED',
    async () => ({ body: { ok: true } }),
  );

  const response = await invoke(handler, authenticatedPost(), {
    getServices: () => ({
      auth: {
        verifyIdToken: async (token, checkRevoked) => {
          verifyCalls.push({ token, checkRevoked });
          return { uid: 'activity-revocation-check' };
        },
      },
      db: {},
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(verifyCalls, [{ token: TOKEN, checkRevoked: true }]);
});

test('Activity rejeita token revogado com resposta sanitizada', async () => {
  const handler = createActivityHandler(
    'taskComplete',
    'ACTIVITY_FAILED',
    async () => ({ body: { ok: true } }),
  );
  const response = await invoke(handler, authenticatedPost(), {
    getServices: () => ({
      auth: {
        verifyIdToken: async () => {
          throw new Error(
            `${TOKEN} revoked-user user@example.com stack`,
          );
        },
      },
      db: {},
    }),
  });

  assertSanitizedAuthenticationError(response, 'UNAUTHENTICATED');
});

test('Focus verifica o ID token com checkRevoked=true', async () => {
  const verifyCalls = [];
  const handler = createFocusHandler(
    'start',
    'FOCUS_FAILED',
    async () => ({ body: { ok: true } }),
  );

  const response = await invoke(handler, authenticatedPost(), {
    getServices: () => ({
      auth: {
        verifyIdToken: async (token, checkRevoked) => {
          verifyCalls.push({ token, checkRevoked });
          return { uid: 'focus-revocation-check' };
        },
      },
      db: {},
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(verifyCalls, [{ token: TOKEN, checkRevoked: true }]);
});

test('Focus rejeita token revogado com resposta sanitizada', async () => {
  const handler = createFocusHandler(
    'start',
    'FOCUS_FAILED',
    async () => ({ body: { ok: true } }),
  );
  const response = await invoke(handler, authenticatedPost(), {
    getServices: () => ({
      auth: {
        verifyIdToken: async () => {
          throw new Error(
            `${TOKEN} revoked-user user@example.com stack`,
          );
        },
      },
      db: {},
    }),
  });

  assertSanitizedAuthenticationError(response, 'UNAUTHENTICATED');
});

test('Sync verifica o ID token com checkRevoked=true', async () => {
  const verifyCalls = [];
  const response = await invoke(syncHandler, authenticatedPost(null), {
    verifyAppCheckToken: async () => ({ appId: 'test-app' }),
    verifyIdToken: async (token, checkRevoked) => {
      verifyCalls.push({ token, checkRevoked });
      return { uid: 'sync-revocation-check' };
    },
    checkRateLimit: async () => true,
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(verifyCalls, [{ token: TOKEN, checkRevoked: true }]);
});

test('Sync rejeita token revogado com resposta sanitizada', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await invoke(syncHandler, authenticatedPost(null), {
      verifyAppCheckToken: async () => ({ appId: 'test-app' }),
      verifyIdToken: async () => {
        throw new Error(
          `${TOKEN} revoked-user user@example.com stack`,
        );
      },
    });

    assertSanitizedAuthenticationError(response);
  } finally {
    console.error = originalConsoleError;
  }
});
