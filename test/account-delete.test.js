import assert from 'node:assert/strict';
import test from 'node:test';

import { Timestamp } from 'firebase-admin/firestore';

import {
  ACCOUNT_AUTH_RECENCY_WINDOW_MS,
  createAccountHandler,
  MAX_CIRCLE_CHALLENGES_TO_SCAN,
  PROCESSED_EVENT_DELETE_PAGE_SIZE,
  validateDeletePayload,
} from '../api/account/_shared.js';
import { deleteAccount } from '../api/account/delete.js';
import { sha256 } from '../api/billing/google/_reconciliation.js';
import { checkDistributedRateLimit } from '../api/_distributed_rate_limit.js';

const UID = 'user-1';
const CIRCLE_ID = 'circle-1';
const ADMIN_UID = 'admin-1';
const APP_CHECK_TOKEN = 'mock-app-check-token';
const ACCOUNT_DELETION_MARKER_PATH =
  'users/user-1/runtime/account_deletion';

function path(...parts) {
  return parts.join('/');
}

class FakeDocumentReference {
  constructor(db, documentPath) {
    this.db = db;
    this.path = documentPath;
    this.kind = 'document';
  }

  collection(name) {
    return new FakeCollectionReference(this.db, path(this.path, name));
  }

  get() {
    return Promise.resolve(this.db.documentSnapshot(this));
  }

  set(data) {
    this.db.setCalls.push({ path: this.path, data });
    this.db.store.set(this.path, data);
    return Promise.resolve();
  }
}

class FakeQuery {
  constructor(collectionRef, filters = [], limitValue = null) {
    this.collectionRef = collectionRef;
    this.filters = filters;
    this.limitValue = limitValue;
    this.path = collectionRef.path;
    this.kind = 'query';
  }

  where(field, op, value) {
    return new FakeQuery(
      this.collectionRef,
      [...this.filters, { field, op, value }],
      this.limitValue,
    );
  }

  limit(value) {
    return new FakeQuery(this.collectionRef, this.filters, value);
  }

  orderBy() { return this; }

  startAfter(snapshot) { this.cursor = snapshot.ref.path; return this; }

  get() {
    return Promise.resolve(this.collectionRef.db.querySnapshot(this));
  }
}

class FakeCollectionReference {
  constructor(db, collectionPath) {
    this.db = db;
    this.path = collectionPath;
    this.kind = 'collection';
  }

  doc(id) {
    return new FakeDocumentReference(this.db, path(this.path, id));
  }

  where(field, op, value) {
    return new FakeQuery(this, [{ field, op, value }]);
  }

  limit(value) {
    return new FakeQuery(this, [], value);
  }

  get() {
    return Promise.resolve(this.db.querySnapshot(this));
  }

  orderBy() { return new FakeQuery(this); }
}

class FakeDocumentSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.path.split('/').at(-1);
    this.exists = data !== undefined;
    this._data = data;
  }

  data() {
    return this._data;
  }
}

class FakeQuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }
}

class FakeWriter {
  constructor(db) {
    this.db = db;
    this.writes = [];
  }

  delete(ref) {
    this.writes.push({ type: 'delete', ref });
    return this;
  }

  update(ref, data) {
    this.writes.push({ type: 'update', ref, data });
    return this;
  }
}

class FakeBatch extends FakeWriter {
  async commit() {
    this.db.batchCommitCount += 1;
    this.db.batchSizes.push(this.writes.length);
    if (this.db.failBatchAt === this.db.batchCommitCount) {
      throw new Error('batch cleanup failed');
    }
    this.db.applyWrites(this.writes);
  }
}

class FakeTransaction extends FakeWriter {
  constructor(db) {
    super(db);
    this.operations = [];
    this.hasWritten = false;
  }

  async get(ref) {
    if (this.hasWritten) throw new Error('read after write');
    this.operations.push({ type: 'read', path: ref.path });
    if (ref.kind === 'query' || ref.kind === 'collection') {
      return this.db.querySnapshot(ref);
    }
    return this.db.documentSnapshot(ref);
  }

  delete(ref) {
    this.hasWritten = true;
    this.operations.push({ type: 'write', operation: 'delete', path: ref.path });
    return super.delete(ref);
  }

  update(ref, data) {
    this.hasWritten = true;
    this.operations.push({ type: 'write', operation: 'update', path: ref.path });
    return super.update(ref, data);
  }

  set(ref, data) {
    this.hasWritten = true;
    this.operations.push({ type: 'write', operation: 'set', path: ref.path });
    this.writes.push({ type: 'set', ref, data });
    return this;
  }

  commit() {
    if (this.writes.some((write) => /\/(processed_events|progress|ranking)\//.test(write.ref.path))) {
      this.db.historyCommits = (this.db.historyCommits ?? 0) + 1;
      if (this.db.historyCommits === this.db.failHistoryAt) throw new Error('history transport failure');
    }
    if (this.db.failHistoryOnce && this.writes.some((write) =>
      /\/(processed_events|progress|ranking)\//.test(write.ref.path))) {
      this.db.failHistoryOnce = false;
      throw new Error('batch cleanup failed');
    }
    this.db.applyWrites(this.writes);
  }
}

class FakeFirestore {
  constructor() {
    this.store = new Map();
    this.transactions = [];
    this.transactionCount = 0;
    this.beforeTransactions = new Map();
    this.recursiveDeletes = [];
    this.failRecursiveDeleteOnce = new Map();
    this.batchCommitCount = 0;
    this.batchSizes = [];
    this.failBatchAt = null;
    this.setCalls = [];
    this.operationLog = [];
  }

  collection(name) {
    return new FakeCollectionReference(this, name);
  }

  collectionGroup(name) {
    const ref = new FakeCollectionReference(this, name);
    ref.group = name;
    return ref;
  }

  batch() {
    return new FakeBatch(this);
  }

  seed(documentPath, data) {
    this.store.set(documentPath, data);
  }

  data(documentPath) {
    return this.store.get(documentPath);
  }

  documentSnapshot(ref) {
    return new FakeDocumentSnapshot(ref, this.store.get(ref.path));
  }

  querySnapshot(ref) {
    const collectionRef = ref.kind === 'query' ? ref.collectionRef : ref;
    const filters = ref.kind === 'query' ? ref.filters : [];
    const limitValue = ref.kind === 'query' ? ref.limitValue : null;
    const prefix = collectionRef.path + '/';
    let docs = [];

    for (const [documentPath, data] of [...this.store.entries()].sort()) {
      if (collectionRef.group) {
        if (documentPath.split('/').at(-2) !== collectionRef.group) continue;
      } else {
        if (!documentPath.startsWith(prefix)) continue;
        const suffix = documentPath.slice(prefix.length);
        if (!suffix || suffix.includes('/')) continue;
      }
      if (ref.cursor && documentPath <= ref.cursor) continue;
      const snapshot = new FakeDocumentSnapshot(
        new FakeDocumentReference(this, documentPath),
        data,
      );
      const matches = filters.every(
        (filter) =>
          filter.op === '==' && snapshot.data()?.[filter.field] === filter.value,
      );
      if (matches) docs.push(snapshot);
    }

    if (limitValue !== null) docs = docs.slice(0, limitValue);
    return new FakeQuerySnapshot(docs);
  }

  applyWrites(writes) {
    const nextStore = new Map(this.store);
    for (const write of writes) {
      if (write.type === 'delete') {
        nextStore.delete(write.ref.path);
      } else if (write.type === 'set') {
        nextStore.set(write.ref.path, { ...write.data });
      } else {
        if (!nextStore.has(write.ref.path)) {
          throw new Error('missing update: ' + write.ref.path);
        }
        nextStore.set(write.ref.path, {
          ...nextStore.get(write.ref.path),
          ...write.data,
        });
      }
    }
    this.store = nextStore;
    this.operationLog.push(...writes.map((write) => ({
      type: write.type,
      path: write.ref.path,
    })));
  }

  async recursiveDelete(ref) {
    this.recursiveDeletes.push(ref.path);
    this.operationLog.push({ type: 'recursiveDelete', path: ref.path });
    const failuresLeft = this.failRecursiveDeleteOnce.get(ref.path) ?? 0;
    if (failuresLeft > 0) {
      this.failRecursiveDeleteOnce.set(ref.path, failuresLeft - 1);
      throw new Error('recursive delete failed');
    }
    for (const documentPath of [...this.store.keys()]) {
      if (
        documentPath === ref.path ||
        documentPath.startsWith(ref.path + '/')
      ) {
        this.store.delete(documentPath);
      }
    }
  }

  async runTransaction(callback) {
    this.transactionCount += 1;
    this.beforeTransactions.get(this.transactionCount)?.(this);
    const transaction = new FakeTransaction(this);
    this.transactions.push(transaction);
    const result = await callback(transaction);
    transaction.commit();
    return result;
  }
}

class FakeAuth {
  constructor(decodedToken, options = {}) {
    this.decodedToken = decodedToken;
    this.options = options;
    this.verifyCalls = [];
    this.deleteCalls = [];
    this.deleted = false;
  }

  async verifyIdToken(token, checkRevoked) {
    this.verifyCalls.push({ token, checkRevoked });
    if (this.options.verifyError) throw this.options.verifyError;
    return this.decodedToken;
  }

  async deleteUser(uid) {
    this.deleteCalls.push(uid);
    const errorCode = this.options.deleteUserErrors?.length
      ? this.options.deleteUserErrors.shift()
      : this.options.deleteUserError;
    if (errorCode) {
      const error = new Error('delete failed');
      error.code = errorCode;
      if (errorCode === 'auth/user-not-found') this.deleted = true;
      throw error;
    }
    this.deleted = true;
  }
}

function timestamp(milliseconds = Date.now()) {
  return Timestamp.fromMillis(milliseconds);
}

function externalCleanupMarker(circleDeleted = false, activeCircleId = null) {
  return {
    version: 1,
    state: 'EXTERNAL_CLEANUP_COMPLETE',
    circleDeleted,
    activeCircleId,
    completedAt: timestamp(),
  };
}

function baseCircle(overrides = {}) {
  return {
    name: 'Circle',
    description: 'Fixture',
    adminId: ADMIN_UID,
    memberCount: 2,
    memberLimit: 3,
    createdAt: timestamp(Date.now() - 60_000),
    updatedAt: timestamp(Date.now() - 30_000),
    schemaVersion: 2,
    ...overrides,
  };
}

function member(role) {
  return {
    role,
    displayNameSnapshot: 'User',
    photoUrlSnapshot: null,
    joinedAt: timestamp(),
  };
}

function progressData(value = 1, uid = UID) {
  return { uid, value, updatedAt: timestamp(100), lastEventAt: timestamp(100) };
}

function focusEvent(id, uid = UID) {
  return { uid, source: 'VERIFIED_FOCUS', sessionId: id,
    challengeType: 'FOCUS_MINUTES', contributionValue: 1,
    sessionStartedAt: timestamp(0), sessionCompletedAt: timestamp(100),
    processedAt: timestamp(100), schemaVersion: 1 };
}

function activityEvent(id, uid = UID) {
  return { uid, source: 'VERIFIED_ACTIVITY', activityEventId: id,
    activityType: 'TASK_COMPLETION', challengeType: 'TASK_COMPLETIONS', resourceId: 'task',
    contributionValue: 1, eventOccurredAt: timestamp(100), processedAt: timestamp(100), schemaVersion: 1 };
}

function seedNormalCircle(db, options = {}) {
  const {
    includeUserMember = true,
    memberCount = includeUserMember ? 2 : 1,
    userData = { activeCircleId: CIRCLE_ID },
    circleOverrides = {},
  } = options;
  db.seed(path('users', UID), userData);
  db.seed(
    path('circles', CIRCLE_ID),
    baseCircle({ memberCount, ...circleOverrides }),
  );
  db.seed(path('circles', CIRCLE_ID, 'members', ADMIN_UID), member('admin'));
  if (includeUserMember) {
    db.seed(path('circles', CIRCLE_ID, 'members', UID), member('member'));
  }
  return db;
}

function seedNormalCircleWithMemberships(db, memberLimit, membershipCount) {
  seedNormalCircle(db, {
    memberCount: membershipCount,
    circleOverrides: { memberLimit },
  });
  for (let index = 2; index < membershipCount; index += 1) {
    db.seed(
      path('circles', CIRCLE_ID, 'members', 'member-' + index),
      member('member'),
    );
  }
  return db;
}

function seedSoleAdmin(db, options = {}) {
  db.seed(path('users', UID), {
    activeCircleId: CIRCLE_ID,
    ...(options.userData ?? {}),
  });
  db.seed(
    path('circles', CIRCLE_ID),
    baseCircle({
      adminId: UID,
      memberCount: 1,
      ...(options.circleOverrides ?? {}),
    }),
  );
  if (options.includeMember !== false) {
    db.seed(path('circles', CIRCLE_ID, 'members', UID), member('admin'));
  }
  return db;
}

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

async function invoke(handler, req, runtime) {
  const res = responseStub();
  await handler(req, res, runtime);
  return res;
}

function handlerFixture({
  decodedToken,
  verifyError,
  nowMillis,
  execute = async () => ({ body: { ok: true } }),
}) {
  const auth = new FakeAuth(decodedToken, { verifyError });
  const db = new FakeFirestore();
  const appCheckCalls = [];
  const appCheck = {
    async verifyToken(token) {
      appCheckCalls.push(token);
      assert.equal(token, APP_CHECK_TOKEN);
      return { appId: 'mock-app-id' };
    },
  };
  const handler = createAccountHandler(
    'delete',
    'ACCOUNT_DELETE_FAILED',
    execute,
    {
      getServices: () => ({ auth, appCheck, db }),
      nowProvider: () => nowMillis,
    },
  );
  return { auth, db, handler, appCheckCalls };
}

function authenticatedAccountPost() {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret-token',
      'x-firebase-appcheck': APP_CHECK_TOKEN,
    },
    body: {},
  };
}

for (const [name, value] of [
  ['missing', undefined],
  ['empty', ''],
  ['whitespace', '   '],
  ['non-string', 123],
  ['array', [APP_CHECK_TOKEN]],
]) {
  test(`App Check ${name} fails before Auth or deletion`, async () => {
    let executeCalls = 0;
    let rateLimitCalls = 0;
    const { handler, auth, db, appCheckCalls } = handlerFixture({
      execute: async () => {
        executeCalls += 1;
        return { body: { deleted: true } };
      },
    });
    const headers = { authorization: 'Bearer secret-token' };
    if (value !== undefined) headers['x-firebase-appcheck'] = value;
    const response = await invoke(handler, { method: 'POST', headers, body: {} }, {
      checkRateLimit: async () => {
        rateLimitCalls += 1;
        return true;
      },
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, {
      code: 'APP_CHECK_REQUIRED',
      error: 'Verificação de segurança do aplicativo necessária.',
    });
    assert.deepEqual(appCheckCalls, []);
    assert.deepEqual(auth.verifyCalls, []);
    assert.equal(rateLimitCalls, 0);
    assert.deepEqual(auth.deleteCalls, []);
    assert.deepEqual(db.recursiveDeletes, []);
    assert.equal(executeCalls, 0);
  });
}

test('invalid App Check fails before Auth and sanitizes logs and response', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  let executeCalls = 0;
  let appCheckCalls = 0;
  let rateLimitCalls = 0;
  const { handler, auth, db } = handlerFixture({
    execute: async () => {
      executeCalls += 1;
      return { body: { deleted: true } };
    },
  });
  const response = await invoke(handler, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret-token',
      'x-firebase-appcheck': APP_CHECK_TOKEN,
    },
    body: {},
  }, {
    checkRateLimit: async () => {
      rateLimitCalls += 1;
      return true;
    },
    verifyAppCheckToken: async (token) => {
      appCheckCalls += 1;
      assert.equal(token, APP_CHECK_TOKEN);
      throw new Error(`private Firebase error ${token} secret-token user@example.com`);
    },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, {
    code: 'APP_CHECK_INVALID',
    error: 'Verificação de segurança do aplicativo inválida.',
  });
  assert.equal(appCheckCalls, 1);
  assert.equal(rateLimitCalls, 0);
  assert.deepEqual(auth.verifyCalls, []);
  assert.deepEqual(auth.deleteCalls, []);
  assert.deepEqual(db.recursiveDeletes, []);
  assert.equal(executeCalls, 0);
  const logs = log.mock.calls.map((call) => call.arguments);
  assert.deepEqual(logs, [['[account] Falha na verificação do App Check.']]);
  for (const privateValue of [APP_CHECK_TOKEN, 'secret-token', 'private Firebase error', 'user@example.com']) {
    assert.equal(JSON.stringify({ body: response.body, logs }).includes(privateValue), false);
  }
});

test('valid App Check and Auth allow the existing account deletion flow', async () => {
  const uid = 'app-check-delete-user';
  const rateLimitCalls = [];
  const { handler, auth, db, appCheckCalls } = handlerFixture({
    decodedToken: { uid, auth_time: 1000 },
    nowMillis: 1_000_000,
    execute: deleteAccount,
  });
  db.seed(path('users', uid), { activeCircleId: null });
  const response = await invoke(handler, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret-token',
      'x-firebase-appcheck': ` ${APP_CHECK_TOKEN} `,
    },
    body: {},
  }, {
    checkRateLimit: async (parameters) => {
      rateLimitCalls.push(parameters);
      assert.deepEqual(appCheckCalls, [APP_CHECK_TOKEN]);
      assert.deepEqual(auth.verifyCalls, [{ token: 'secret-token', checkRevoked: true }]);
      assert.deepEqual(auth.deleteCalls, []);
      return checkDistributedRateLimit(parameters);
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(rateLimitCalls, [{
    db,
    scope: 'account_delete',
    uid,
    limit: 5,
    windowMs: 60_000,
    nowMs: 1_000_000,
  }]);
  assert.deepEqual(response.body, { deleted: true, circleDeleted: false });
  assert.deepEqual(appCheckCalls, [APP_CHECK_TOKEN]);
  assert.deepEqual(auth.verifyCalls, [{ token: 'secret-token', checkRevoked: true }]);
  assert.deepEqual(auth.deleteCalls, [uid]);
  assert.deepEqual(db.recursiveDeletes, [path('users', uid)]);
});

test('delete payload accepts exactly {}', () => {
  assert.deepEqual(validateDeletePayload({}), {});
  assert.throws(() => validateDeletePayload({ uid: UID }));
  assert.throws(() => validateDeletePayload(null));
  assert.throws(() => validateDeletePayload([]));
});

test('handler verifies revocation and accepts auth_time exactly five minutes old', async () => {
  const nowMillis = 1_800_000;
  const { auth, handler } = handlerFixture({
    decodedToken: {
      uid: 'auth-boundary-user',
      auth_time: (nowMillis - ACCOUNT_AUTH_RECENCY_WINDOW_MS) / 1000,
    },
    nowMillis,
  });
  const response = await invoke(handler, {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token', 'x-firebase-appcheck': APP_CHECK_TOKEN },
    body: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(auth.verifyCalls, [
    { token: 'secret-token', checkRevoked: true },
  ]);
});

test('valid App Check with revoked or invalid Auth token returns sanitized 401', async () => {
  const nowMillis = 2_000_000;
  let rateLimitCalls = 0;
  const { handler, auth, appCheckCalls } = handlerFixture({
    decodedToken: null,
    verifyError: new Error('revoked secret-token user@example.com'),
    nowMillis,
  });
  const response = await invoke(handler, {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token', 'x-firebase-appcheck': APP_CHECK_TOKEN },
    body: {},
  }, {
    checkRateLimit: async () => {
      rateLimitCalls += 1;
      return true;
    },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'UNAUTHENTICATED');
  assert.equal(rateLimitCalls, 0);
  assert.deepEqual(appCheckCalls, [APP_CHECK_TOKEN]);
  assert.deepEqual(auth.verifyCalls, [{ token: 'secret-token', checkRevoked: true }]);
  assert.doesNotMatch(JSON.stringify(response.body), /secret-token|example\.com|stack/i);
});

test('missing, invalid, future, and older auth_time require reauthentication', async () => {
  const nowMillis = 3_000_000;
  const cases = [
    ['missing', undefined],
    ['invalid', '3000'],
    ['future', nowMillis / 1000 + 1],
    ['older', (nowMillis - ACCOUNT_AUTH_RECENCY_WINDOW_MS - 1000) / 1000],
  ];

  for (const [name, authTime] of cases) {
    let executeCalls = 0;
    const { handler, db } = handlerFixture({
      decodedToken: { uid: 'auth-' + name, auth_time: authTime },
      nowMillis,
      execute: async () => {
        executeCalls += 1;
        return { body: { deleted: true } };
      },
    });
    const response = await invoke(handler, {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'x-firebase-appcheck': APP_CHECK_TOKEN },
      body: {},
    });
    assert.equal(response.statusCode, 401, name);
    assert.equal(response.body.code, 'REAUTHENTICATION_REQUIRED', name);
    assert.equal(db.transactionCount, 1);
    assert.equal(executeCalls, 0);
  }
});

test('invalid UID never reaches the distributed limiter or deletion', async () => {
  for (const uid of [undefined, '', 'bad/path', ' user ']) {
    let rateLimitCalls = 0;
    let executeCalls = 0;
    const { handler } = handlerFixture({
      decodedToken: { uid, auth_time: 1000 },
      nowMillis: 1_000_000,
      execute: async () => {
        executeCalls += 1;
        return { body: { deleted: true } };
      },
    });
    const response = await invoke(handler, authenticatedAccountPost(), {
      checkRateLimit: async () => {
        rateLimitCalls += 1;
        return true;
      },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.code, 'UNAUTHENTICATED');
    assert.equal(rateLimitCalls, 0);
    assert.equal(executeCalls, 0);
  }
});

test('exhausted distributed quota returns 429 before recent auth or deletion', async () => {
  let executeCalls = 0;
  let rateLimitCalls = 0;
  const { handler, auth, db } = handlerFixture({
    decodedToken: { uid: UID, auth_time: 0 },
    nowMillis: 1_000_000,
    execute: async () => {
      executeCalls += 1;
      return { body: { deleted: true } };
    },
  });
  const response = await invoke(handler, authenticatedAccountPost(), {
    checkRateLimit: async () => {
      rateLimitCalls += 1;
      return false;
    },
  });
  assert.equal(response.statusCode, 429);
  assert.deepEqual(response.body, {
    code: 'RATE_LIMITED',
    error: 'Muitas solicitacoes de conta. Tente novamente em instantes.',
  });
  assert.equal(rateLimitCalls, 1);
  assert.equal(executeCalls, 0);
  assert.deepEqual(auth.deleteCalls, []);
  assert.deepEqual(db.recursiveDeletes, []);
});

for (const failureSource of ['checker', 'firestore']) {
  test(`${failureSource} rate limit failure returns sanitized 503 without deletion`, async (t) => {
    const log = t.mock.method(console, 'error', () => {});
    const privateDetail = `private-error ${UID} server_rate_limits/private secret-token ${APP_CHECK_TOKEN}`;
    let executeCalls = 0;
    let failureCalls = 0;
    const failRateLimit = async () => {
      failureCalls += 1;
      throw new Error(privateDetail);
    };
    const { handler, auth, db } = handlerFixture({
      decodedToken: { uid: UID, auth_time: 1000 },
      nowMillis: 1_000_000,
      execute: async () => {
        executeCalls += 1;
        return { body: { deleted: true } };
      },
    });
    const runtime = {};
    if (failureSource === 'firestore') {
      db.runTransaction = failRateLimit;
    } else {
      runtime.checkRateLimit = failRateLimit;
    }
    const response = await invoke(handler, authenticatedAccountPost(), runtime);

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      code: 'RATE_LIMIT_UNAVAILABLE',
      error: 'Não foi possível verificar o limite de solicitações.',
    });
    assert.equal(failureCalls, 1);
    assert.equal(executeCalls, 0);
    assert.deepEqual(auth.deleteCalls, []);
    assert.deepEqual(db.recursiveDeletes, []);
    const logs = log.mock.calls.map((call) => call.arguments);
    assert.deepEqual(logs, [['[account] Falha ao verificar rate limit.']]);
    for (const secret of [UID, 'server_rate_limits', 'secret-token', APP_CHECK_TOKEN, 'private-error', 'stack']) {
      assert.equal(JSON.stringify({ body: response.body, logs }).includes(secret), false);
    }
  });
}

test('new account handlers share persisted quota: five allowed, sixth denied, new window allowed', async () => {
  const db = new FakeFirestore();
  let executeCalls = 0;
  const callFromNewHandler = async (nowMillis) => {
    const { handler, auth } = handlerFixture({
      decodedToken: { uid: UID, auth_time: nowMillis / 1000 },
      nowMillis,
      execute: async () => {
        executeCalls += 1;
        return { body: { ok: true } };
      },
    });
    return invoke(handler, authenticatedAccountPost(), {
      getServices: () => ({
        auth,
        db,
        appCheck: { verifyToken: async () => ({ appId: 'mock-app-id' }) },
      }),
    });
  };

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await callFromNewHandler(1_000_000)).statusCode, 200);
  }
  const denied = await callFromNewHandler(1_059_999);
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.body.code, 'RATE_LIMITED');
  assert.equal(executeCalls, 5);
  assert.deepEqual([...db.store.values()], [{ windowStartMs: 1_000_000, count: 5 }]);
  assert.equal((await callFromNewHandler(1_060_000)).statusCode, 200);
  assert.equal(executeCalls, 6);
  assert.deepEqual([...db.store.values()], [{ windowStartMs: 1_060_000, count: 1 }]);
});

test('HTTP contract accepts OPTIONS and rejects methods or extra body fields', async () => {
  const nowMillis = 4_000_000;
  const { handler } = handlerFixture({
    decodedToken: { uid: 'http-user', auth_time: nowMillis / 1000 },
    nowMillis,
  });

  const options = await invoke(handler, {
    method: 'OPTIONS',
    headers: { origin: 'https://app.life-os.com' },
  });
  assert.equal(options.statusCode, 204);
  assert.equal(
    options.headers['Access-Control-Allow-Headers'],
    'Content-Type, Authorization, X-Firebase-AppCheck',
  );
  assert.equal(
    options.headers['Access-Control-Allow-Origin'],
    'https://app.life-os.com',
  );

  const method = await invoke(handler, {
    method: 'DELETE',
    headers: {},
    body: {},
  });
  assert.equal(method.statusCode, 405);

  const payload = await invoke(handler, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'x-firebase-appcheck': APP_CHECK_TOKEN },
    body: { uid: 'attacker-selected' },
  });
  assert.equal(payload.statusCode, 400);
  assert.equal(payload.body.code, 'INVALID_ACCOUNT_PAYLOAD');
});

test('account without Circle, including activeCircleId null, is deleted recursively', async () => {
  const db = new FakeFirestore();
  db.seed(path('users', UID), { activeCircleId: null });
  db.seed(path('users', UID, 'tasks', 'task-1'), { title: 'Task' });
  const auth = new FakeAuth({});

  const result = await deleteAccount({ db, auth, uid: UID });

  assert.deepEqual(result.body, { deleted: true, circleDeleted: false });
  assert.equal(db.data(path('users', UID, 'tasks', 'task-1')), undefined);
  assert.deepEqual(db.recursiveDeletes, [path('users', UID)]);
  assert.deepEqual(auth.deleteCalls, [UID]);
});

test('invalid or whitespace-normalized activeCircleId fails closed', async () => {
  const invalidValues = [123, '', 'bad/id', 'x'.repeat(1501), ' circle-1 '];
  for (const activeCircleId of invalidValues) {
    const db = new FakeFirestore();
    db.seed(path('users', UID), { activeCircleId });
    const auth = new FakeAuth({});
    await assert.rejects(
      deleteAccount({ db, auth, uid: UID }),
      (error) => error.code === 'ACCOUNT_STATE_CONFLICT',
    );
    assert.deepEqual(db.recursiveDeletes, []);
    assert.deepEqual(auth.deleteCalls, []);
  }
});

test('adminId blocks shared Circle deletion with member present or absent', async () => {
  for (const includeMember of [true, false]) {
    const db = seedSoleAdmin(new FakeFirestore(), {
      includeMember,
      circleOverrides: { memberCount: 2 },
    });
    if (includeMember) {
      db.seed(path('circles', CIRCLE_ID, 'members', 'other'), member('member'));
    }
    const auth = new FakeAuth({});
    await assert.rejects(
      deleteAccount({ db, auth, uid: UID }),
      (error) => error.code === 'CIRCLE_ADMIN_ACTION_REQUIRED',
    );
    assert.ok(db.data(path('circles', CIRCLE_ID)));
    assert.deepEqual(auth.deleteCalls, []);
  }
});

test('valid sole admin deletes Circle root safely and all descendants', async () => {
  const db = seedSoleAdmin(new FakeFirestore());
  db.seed(path('circles', CIRCLE_ID, 'challenges', 'c1'), { corrupted: true });
  db.seed(
    path('circles', CIRCLE_ID, 'challenges', 'c1', 'progress', UID),
    { value: 1 },
  );
  const auth = new FakeAuth({});

  const result = await deleteAccount({ db, auth, uid: UID });

  assert.deepEqual(result.body, { deleted: true, circleDeleted: true });
  assert.deepEqual(db.recursiveDeletes, [
    path('circles', CIRCLE_ID),
    path('users', UID),
  ]);
  assert.equal(
    db.data(path('circles', CIRCLE_ID, 'challenges', 'c1')),
    undefined,
  );
  assert.deepEqual(auth.deleteCalls, [UID]);
});

test('sole admin with memberLimit 30 deletes Circle and account', async () => {
  const db = seedSoleAdmin(new FakeFirestore(), {
    circleOverrides: { memberLimit: 30 },
  });
  const auth = new FakeAuth({});
  const circlePath = path('circles', CIRCLE_ID);
  const userPath = path('users', UID);

  assert.equal(db.data(circlePath).memberCount, 1);
  assert.equal(db.data(circlePath).memberLimit, 30);
  assert.equal(db.data(circlePath).schemaVersion, 2);
  assert.equal(db.data(circlePath).adminId, UID);

  const result = await deleteAccount({ db, auth, uid: UID });

  assert.deepEqual(result.body, { deleted: true, circleDeleted: true });
  assert.deepEqual(auth.deleteCalls, [UID]);
  assert.equal(db.data(circlePath), undefined);
  assert.equal(db.data(userPath), undefined);
  assert.deepEqual(db.recursiveDeletes, [circlePath, userPath]);
});

test('inconsistent sole admin fails before destructive work', async () => {
  const db = seedSoleAdmin(new FakeFirestore(), { includeMember: false });
  const auth = new FakeAuth({});
  await assert.rejects(
    deleteAccount({ db, auth, uid: UID }),
    (error) => error.code === 'ACCOUNT_STATE_CONFLICT',
  );
  assert.ok(db.data(path('circles', CIRCLE_ID)));
  assert.deepEqual(db.recursiveDeletes, []);
  assert.deepEqual(auth.deleteCalls, []);
});

test('sole-admin marker resumes after recursive Circle cleanup failure', async () => {
  const db = seedSoleAdmin(new FakeFirestore());
  db.seed(path('circles', CIRCLE_ID, 'challenges', 'c1'), { any: 'data' });
  db.failRecursiveDeleteOnce.set(path('circles', CIRCLE_ID), 1);
  const auth = new FakeAuth({});

  await assert.rejects(deleteAccount({ db, auth, uid: UID }), /recursive delete/);
  assert.equal(db.data(path('circles', CIRCLE_ID)), undefined);
  assert.ok(db.data(path('users', UID))._serverAccountDeletion);
  assert.deepEqual(auth.deleteCalls, []);

  const result = await deleteAccount({ db, auth, uid: UID });
  assert.equal(result.body.circleDeleted, true);
  assert.equal(
    db.data(path('circles', CIRCLE_ID, 'challenges', 'c1')),
    undefined,
  );
  assert.deepEqual(auth.deleteCalls, [UID]);
});

test('sole-admin retry marker cannot delete a recreated Circle root', async () => {
  const db = new FakeFirestore();
  db.seed(path('users', UID), {
    activeCircleId: CIRCLE_ID,
    _serverAccountDeletion: {
      version: 1,
      mode: 'SOLE_ADMIN_CIRCLE',
      circleId: CIRCLE_ID,
      startedAt: timestamp(),
    },
  });
  db.seed(path('circles', CIRCLE_ID), baseCircle());
  const auth = new FakeAuth({});

  await assert.rejects(
    deleteAccount({ db, auth, uid: UID }),
    (error) => error.code === 'ACCOUNT_STATE_CONFLICT',
  );
  assert.ok(db.data(path('circles', CIRCLE_ID)));
  assert.deepEqual(auth.deleteCalls, []);
});

test('missing Circle root without retry marker fails closed', async () => {
  const db = new FakeFirestore();
  db.seed(path('users', UID), { activeCircleId: CIRCLE_ID });
  const auth = new FakeAuth({});
  await assert.rejects(
    deleteAccount({ db, auth, uid: UID }),
    (error) => error.code === 'ACCOUNT_STATE_CONFLICT',
  );
  assert.ok(db.data(path('users', UID)));
  assert.deepEqual(auth.deleteCalls, []);
});

test('normal member cleanup removes Focus and Activity events but keeps another UID', async () => {
  const db = seedNormalCircle(new FakeFirestore());
  const challengePath = path('circles', CIRCLE_ID, 'challenges', 'c1');
  db.seed(challengePath, { corrupted: true });
  db.seed(path(challengePath, 'progress', UID), progressData(3));
  db.seed(path(challengePath, 'processed_events', 'focus'), focusEvent('focus'));
  db.seed(path(challengePath, 'processed_events', 'activity'), activityEvent('activity'));
  db.seed(path(challengePath, 'processed_events', 'foreign'), {
    uid: 'other-user',
    source: 'VERIFIED_FOCUS',
    sessionId: 'session-2',
  });
  const auth = new FakeAuth({});

  await deleteAccount({ db, auth, uid: UID });

  assert.equal(db.data(path('circles', CIRCLE_ID, 'members', UID)), undefined);
  assert.equal(db.data(path('circles', CIRCLE_ID)).memberCount, 1);
  assert.equal(db.data(path(challengePath, 'progress', UID)), undefined);
  assert.equal(db.data(path(challengePath, 'processed_events', 'focus')), undefined);
  assert.equal(
    db.data(path(challengePath, 'processed_events', 'activity')),
    undefined,
  );
  assert.ok(db.data(path(challengePath, 'processed_events', 'foreign')));
  assert.ok(
    db.transactions.every((transaction) => transaction.writes.length <= 2),
  );
});

test('memberLimit 30 allows a normal member to delete the account', async () => {
  const db = seedNormalCircleWithMemberships(new FakeFirestore(), 30, 2);
  const auth = new FakeAuth({});

  const result = await deleteAccount({ db, auth, uid: UID });

  assert.deepEqual(result.body, { deleted: true, circleDeleted: false });
  assert.equal(db.data(path('circles', CIRCLE_ID)).memberCount, 1);
  assert.equal(db.data(path('circles', CIRCLE_ID, 'members', UID)), undefined);
  assert.deepEqual(auth.deleteCalls, [UID]);
  assert.deepEqual(db.recursiveDeletes, [path('users', UID)]);
});

test('Circle with 30 memberships is accepted', async () => {
  const db = seedNormalCircleWithMemberships(new FakeFirestore(), 30, 30);
  const auth = new FakeAuth({});

  await deleteAccount({ db, auth, uid: UID });

  assert.equal(db.data(path('circles', CIRCLE_ID)).memberCount, 29);
  assert.equal(db.data(path('circles', CIRCLE_ID, 'members', UID)), undefined);
  assert.ok(db.data(path('circles', CIRCLE_ID, 'members', 'member-29')));
  assert.deepEqual(auth.deleteCalls, [UID]);
});

test('legacy memberLimit 10 remains accepted', async () => {
  const db = seedNormalCircleWithMemberships(new FakeFirestore(), 10, 10);
  const auth = new FakeAuth({});

  await deleteAccount({ db, auth, uid: UID });

  assert.equal(db.data(path('circles', CIRCLE_ID)).memberCount, 9);
  assert.equal(db.data(path('circles', CIRCLE_ID, 'members', UID)), undefined);
  assert.deepEqual(auth.deleteCalls, [UID]);
});

test('free memberLimit 3 remains accepted', async () => {
  const db = seedNormalCircleWithMemberships(new FakeFirestore(), 3, 3);
  const auth = new FakeAuth({});

  await deleteAccount({ db, auth, uid: UID });

  assert.equal(db.data(path('circles', CIRCLE_ID)).memberCount, 2);
  assert.equal(db.data(path('circles', CIRCLE_ID, 'members', UID)), undefined);
  assert.deepEqual(auth.deleteCalls, [UID]);
});

for (const invalidMemberLimit of [11, 31]) {
  test(`memberLimit ${invalidMemberLimit} fails closed`, async () => {
    const db = seedNormalCircleWithMemberships(
      new FakeFirestore(),
      invalidMemberLimit,
      2,
    );
    const privatePath = path('users', UID, 'tasks', 'private-task');
    const memberPath = path('circles', CIRCLE_ID, 'members', UID);
    db.seed(privatePath, { title: 'Private task' });
    const originalCircle = db.data(path('circles', CIRCLE_ID));
    const originalMembership = db.data(memberPath);
    const auth = new FakeAuth({});

    await assert.rejects(
      deleteAccount({ db, auth, uid: UID }),
      (error) => error.code === 'ACCOUNT_STATE_CONFLICT',
    );

    assert.deepEqual(auth.deleteCalls, []);
    assert.deepEqual(db.recursiveDeletes, []);
    assert.deepEqual(db.data(path('users', UID)), {
      activeCircleId: CIRCLE_ID,
    });
    assert.deepEqual(db.data(privatePath), { title: 'Private task' });
    assert.deepEqual(db.data(memberPath), originalMembership);
    assert.deepEqual(db.data(path('circles', CIRCLE_ID)), originalCircle);
    assert.equal(
      db.data(path('circles', CIRCLE_ID)).memberLimit,
      invalidMemberLimit,
    );
    assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH), undefined);
  });
}

test('more than 30 memberships fails closed', async () => {
  const db = seedNormalCircleWithMemberships(new FakeFirestore(), 30, 30);
  const privatePath = path('users', UID, 'tasks', 'private-task');
  const memberPath = path('circles', CIRCLE_ID, 'members', UID);
  db.seed(
    path('circles', CIRCLE_ID, 'members', 'overflow-member'),
    member('member'),
  );
  db.seed(privatePath, { title: 'Private task' });
  const originalCircle = db.data(path('circles', CIRCLE_ID));
  const originalMembership = db.data(memberPath);
  const auth = new FakeAuth({});

  await assert.rejects(
    deleteAccount({ db, auth, uid: UID }),
    (error) => error.code === 'ACCOUNT_STATE_CONFLICT',
  );

  assert.deepEqual(auth.deleteCalls, []);
  assert.deepEqual(db.recursiveDeletes, []);
  assert.deepEqual(db.data(path('users', UID)), {
    activeCircleId: CIRCLE_ID,
  });
  assert.deepEqual(db.data(privatePath), { title: 'Private task' });
  assert.deepEqual(db.data(memberPath), originalMembership);
  assert.deepEqual(db.data(path('circles', CIRCLE_ID)), originalCircle);
  assert.equal(db.data(path('circles', CIRCLE_ID)).memberCount, 30);
  assert.ok(
    db.data(path('circles', CIRCLE_ID, 'members', 'overflow-member')),
  );
  assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH), undefined);
});

test('retry state is idempotent and a provable stale counter is corrected', async () => {
  for (const memberCount of [1, 2]) {
    const db = seedNormalCircle(new FakeFirestore(), {
      includeUserMember: false,
      memberCount,
    });
    const auth = new FakeAuth({});

    await deleteAccount({ db, auth, uid: UID });

    assert.equal(db.data(path('circles', CIRCLE_ID)).memberCount, 1);
    assert.deepEqual(auth.deleteCalls, [UID]);
  }
});

test('ambiguous missing membership state fails closed', async () => {
  const db = seedNormalCircle(new FakeFirestore(), {
    includeUserMember: false,
    memberCount: 3,
  });
  const auth = new FakeAuth({});
  await assert.rejects(
    deleteAccount({ db, auth, uid: UID }),
    (error) => error.code === 'ACCOUNT_STATE_CONFLICT',
  );
  assert.deepEqual(auth.deleteCalls, []);
});

test('commit transaction rereads a raced memberCount', async () => {
  const db = seedNormalCircle(new FakeFirestore());
  db.beforeTransactions.set(3, (firestore) => {
    firestore.seed(
      path('circles', CIRCLE_ID, 'members', 'new-user'),
      member('member'),
    );
    firestore.seed(
      path('circles', CIRCLE_ID),
      baseCircle({ memberCount: 3 }),
    );
  });
  const auth = new FakeAuth({});

  await deleteAccount({ db, auth, uid: UID });

  assert.equal(db.data(path('circles', CIRCLE_ID)).memberCount, 2);
  assert.ok(db.data(path('circles', CIRCLE_ID, 'members', 'new-user')));
});

test('exact challenge safety boundary is accepted', async () => {
  const db = seedNormalCircle(new FakeFirestore());
  for (let index = 0; index < MAX_CIRCLE_CHALLENGES_TO_SCAN; index += 1) {
    db.seed(
      path('circles', CIRCLE_ID, 'challenges', 'c-' + index),
      { invalid: true },
    );
  }
  const auth = new FakeAuth({});

  await deleteAccount({ db, auth, uid: UID });

  assert.deepEqual(auth.deleteCalls, [UID]);
});

test('large processed event history uses bounded ownership-checked transactions', async () => {
  const db = seedNormalCircle(new FakeFirestore());
  const challengePath = path('circles', CIRCLE_ID, 'challenges', 'c1');
  db.seed(challengePath, { invalid: true });
  const eventCount = PROCESSED_EVENT_DELETE_PAGE_SIZE * 2 + 17;
  for (let index = 0; index < eventCount; index += 1) {
    db.seed(
      path(
        challengePath,
        'processed_events',
        'e-' + String(index).padStart(4, '0'),
      ),
      focusEvent('e-' + String(index).padStart(4, '0')),
    );
  }
  const auth = new FakeAuth({});

  await deleteAccount({ db, auth, uid: UID });

  const pages = db.transactions.filter((transaction) =>
    transaction.writes.some((write) => write.ref.path.includes('/processed_events/')));
  assert.equal(pages.length, 3);
  assert.ok(
    pages.every((transaction) => transaction.writes.length <= PROCESSED_EVENT_DELETE_PAGE_SIZE),
  );
  assert.ok(
    pages.every((transaction) => transaction.writes.every((write) => write.type === 'delete')),
  );
});

test('Circle cleanup failure never deletes Firebase Auth', async () => {
  const circleDb = seedNormalCircle(new FakeFirestore());
  circleDb.seed(path('circles', CIRCLE_ID, 'challenges', 'c1'), { any: true });
  circleDb.seed(path('circles', CIRCLE_ID, 'challenges', 'c1', 'progress', UID), progressData());
  circleDb.failHistoryOnce = true;
  const circleAuth = new FakeAuth({});
  await assert.rejects(
    deleteAccount({ db: circleDb, auth: circleAuth, uid: UID }),
    /batch cleanup/,
  );
  assert.deepEqual(circleAuth.deleteCalls, []);
  assert.equal(circleDb.data(ACCOUNT_DELETION_MARKER_PATH), undefined);
});

test('auth/user-not-found with safe marker finalizes recursive user cleanup', async () => {
  const db = new FakeFirestore();
  db.seed(path('users', UID), { activeCircleId: null });
  db.seed(ACCOUNT_DELETION_MARKER_PATH, externalCleanupMarker());
  const auth = new FakeAuth({}, { deleteUserError: 'auth/user-not-found' });

  const result = await deleteAccount({ db, auth, uid: UID });

  assert.equal(result.body.deleted, true);
  assert.deepEqual(auth.deleteCalls, [UID]);
  assert.equal(auth.deleted, true);
  assert.equal(db.data(path('users', UID)), undefined);
  assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH), undefined);
});

test('transient Auth failure preserves user tree and external cleanup marker', async () => {
  const db = seedNormalCircle(new FakeFirestore());
  db.seed(path('users', UID, 'tasks', 'task-1'), { title: 'Task' });
  const auth = new FakeAuth({}, { deleteUserError: 'auth/internal-error' });

  await assert.rejects(
    deleteAccount({ db, auth, uid: UID }),
    (error) => error.code === 'auth/internal-error',
  );
  assert.ok(db.data(path('users', UID)));
  assert.ok(db.data(path('users', UID, 'tasks', 'task-1')));
  assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH).version, 2);
  assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH).scope, 'GLOBAL_CIRCLE_UID');
  assert.equal(
    db.data(ACCOUNT_DELETION_MARKER_PATH).state,
    'EXTERNAL_CLEANUP_COMPLETE',
  );
  assert.deepEqual(auth.deleteCalls, [UID]);
  assert.equal(auth.deleted, false);
  assert.equal(db.data(path('circles', CIRCLE_ID)).memberCount, 1);
  assert.equal(db.data(path('circles', CIRCLE_ID, 'members', UID)), undefined);
  assert.deepEqual(db.recursiveDeletes, []);
});

test('retry after transient Auth failure skips Circle cleanup and completes', async () => {
  const db = seedNormalCircle(new FakeFirestore());
  db.seed(path('users', UID, 'tasks', 'task-1'), { title: 'Task' });
  const auth = new FakeAuth({}, {
    deleteUserErrors: ['auth/internal-error'],
  });

  await assert.rejects(
    deleteAccount({ db, auth, uid: UID }),
    (error) => error.code === 'auth/internal-error',
  );
  const transactionsAfterCleanup = db.transactionCount;
  const batchesAfterCleanup = db.batchCommitCount;

  const result = await deleteAccount({ db, auth, uid: UID });

  assert.deepEqual(result.body, { deleted: true, circleDeleted: false });
  assert.ok(db.transactions.slice(transactionsAfterCleanup).every((transaction) =>
    transaction.writes.every((write) => !write.ref.path.startsWith('circles/'))));
  assert.equal(db.batchCommitCount, batchesAfterCleanup);
  assert.equal(db.data(path('circles', CIRCLE_ID)).memberCount, 1);
  assert.deepEqual(auth.deleteCalls, [UID, UID]);
  assert.equal(auth.deleted, true);
  assert.equal(db.data(path('users', UID)), undefined);
  assert.equal(db.data(path('users', UID, 'tasks', 'task-1')), undefined);
  assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH), undefined);
  assert.deepEqual(db.recursiveDeletes, [path('users', UID)]);
});

test('retry rejects stale marker when membership was recreated', async () => {
  const db = seedNormalCircle(new FakeFirestore());
  const auth = new FakeAuth({}, {
    deleteUserErrors: ['auth/internal-error'],
  });

  await assert.rejects(
    deleteAccount({ db, auth, uid: UID }),
    (error) => error.code === 'auth/internal-error',
  );
  const transactionsAfterFirstCleanup = db.transactionCount;
  db.seed(path('circles', CIRCLE_ID, 'members', UID), member('member'));
  db.seed(
    path('circles', CIRCLE_ID),
    baseCircle({ memberCount: 2 }),
  );

  await deleteAccount({ db, auth, uid: UID });

  assert.ok(db.transactionCount > transactionsAfterFirstCleanup);
  assert.equal(db.data(path('circles', CIRCLE_ID)).memberCount, 1);
  assert.equal(db.data(path('circles', CIRCLE_ID, 'members', UID)), undefined);
  assert.deepEqual(auth.deleteCalls, [UID, UID]);
});

test('recursive user cleanup failure occurs after Auth deletion', async () => {
  const db = new FakeFirestore();
  db.seed(path('users', UID), { activeCircleId: null });
  db.seed(path('users', UID, 'tasks', 'task-1'), { title: 'Task' });
  db.failRecursiveDeleteOnce.set(path('users', UID), 1);
  const auth = new FakeAuth({});

  await assert.rejects(
    deleteAccount({ db, auth, uid: UID }),
    /recursive delete/,
  );

  assert.equal(auth.deleted, true);
  assert.deepEqual(auth.deleteCalls, [UID]);
  assert.ok(db.data(path('users', UID)));
  assert.ok(db.data(path('users', UID, 'tasks', 'task-1')));
  assert.ok(db.data(ACCOUNT_DELETION_MARKER_PATH));
});

test('billing deletion barrier removes token indexes and account index last', async () => {
  const db = new FakeFirestore();
  const accountHash = sha256(UID);
  const accountPath = path('billing_google_accounts', accountHash);
  const tokenPaths = ['token-a', 'token-b'].map((token) =>
    path('billing_google_tokens', sha256(token)));
  db.seed(path('users', UID), { activeCircleId: null });
  db.seed(accountPath, { uid: UID, state: 'ACTIVE' });
  for (const tokenPath of tokenPaths) db.seed(tokenPath, { accountHash });
  const auth = new FakeAuth({});

  await deleteAccount({ db, auth, uid: UID });

  assert.deepEqual(auth.deleteCalls, [UID]);
  assert.equal(db.data(path('users', UID)), undefined);
  assert.equal(db.data(accountPath), undefined);
  assert.ok(tokenPaths.every((tokenPath) => db.data(tokenPath) === undefined));
  const operation = (type, target) => db.operationLog.findIndex(
    (entry) => entry.type === type && entry.path === target,
  );
  assert.ok(operation('set', accountPath) < operation('delete', tokenPaths[0]));
  assert.ok(operation('delete', tokenPaths[0]) < operation('recursiveDelete', path('users', UID)));
  assert.ok(operation('recursiveDelete', path('users', UID)) < operation('delete', accountPath));
});

test('billing token indexes are deleted in bounded pages', async () => {
  const db = new FakeFirestore();
  const accountHash = sha256(UID);
  db.seed(path('users', UID), { activeCircleId: null });
  db.seed(path('billing_google_accounts', accountHash), { uid: UID, state: 'ACTIVE' });
  for (let index = 0; index < 205; index += 1) {
    db.seed(path('billing_google_tokens', sha256(`token-${index}`)), { accountHash });
  }

  await deleteAccount({ db, auth: new FakeAuth({}), uid: UID });

  assert.equal([...db.store.keys()].filter((value) => value.startsWith('billing_google_')).length, 0);
  const indexDeletes = db.operationLog.filter(
    (entry) => entry.type === 'delete' && entry.path.startsWith('billing_google_tokens/'),
  );
  assert.equal(indexDeletes.length, 205);
});

test('billing index cleanup conflict aborts before Auth and user deletion', async () => {
  const db = new FakeFirestore();
  const accountHash = sha256(UID);
  const indexPath = path('billing_google_tokens', sha256('token-a'));
  db.seed(path('users', UID), { activeCircleId: null });
  db.seed(path('billing_google_accounts', accountHash), { uid: UID, state: 'ACTIVE' });
  db.seed(indexPath, { accountHash });
  db.beforeTransactions.set(3, (firestore) => {
    firestore.seed(indexPath, { accountHash: sha256('other-user') });
  });
  const auth = new FakeAuth({});

  await assert.rejects(deleteAccount({ db, auth, uid: UID }));

  assert.deepEqual(auth.deleteCalls, []);
  assert.deepEqual(db.recursiveDeletes, []);
  assert.ok(db.data(path('users', UID)));
  assert.ok(db.data(indexPath));
});

test('foreign account index ownership conflict is never overwritten or deleted', async () => {
  const db = new FakeFirestore();
  const accountPath = path('billing_google_accounts', sha256(UID));
  const foreign = { uid: 'other-user', state: 'ACTIVE' };
  db.seed(path('users', UID), { activeCircleId: null });
  db.seed(accountPath, foreign);
  const auth = new FakeAuth({});

  await assert.rejects(deleteAccount({ db, auth, uid: UID }));

  assert.deepEqual(db.data(accountPath), foreign);
  assert.deepEqual(auth.deleteCalls, []);
  assert.deepEqual(db.recursiveDeletes, []);
});

test('billing cleanup transport failure retains DELETING barrier without deleting Auth', async () => {
  const db = new FakeFirestore();
  const accountPath = path('billing_google_accounts', sha256(UID));
  const indexPath = path('billing_google_tokens', sha256('token-a'));
  db.seed(path('users', UID), { activeCircleId: null });
  db.seed(indexPath, { accountHash: sha256(UID) });
  db.beforeTransactions.set(3, () => { throw new Error('private-billing-transport-error'); });
  const auth = new FakeAuth({});

  await assert.rejects(deleteAccount({ db, auth, uid: UID }));

  assert.deepEqual(db.data(accountPath), { uid: UID, state: 'DELETING' });
  assert.ok(db.data(indexPath));
  assert.deepEqual(auth.deleteCalls, []);
  assert.deepEqual(db.recursiveDeletes, []);
});

test('user-tree cleanup failure after Auth leaves billing barrier closed', async () => {
  const db = new FakeFirestore();
  db.seed(path('users', UID), { activeCircleId: null });
  db.failRecursiveDeleteOnce.set(path('users', UID), 1);
  const auth = new FakeAuth({});

  await assert.rejects(deleteAccount({ db, auth, uid: UID }));

  assert.equal(auth.deleted, true);
  assert.deepEqual(db.data(path('billing_google_accounts', sha256(UID))), {
    uid: UID, state: 'DELETING',
  });
});

test('missing user evidence fails closed', async () => {
  const db = new FakeFirestore();
  const auth = new FakeAuth({});
  await assert.rejects(
    deleteAccount({ db, auth, uid: UID }),
    (error) => error.code === 'ACCOUNT_STATE_CONFLICT',
  );
  assert.deepEqual(auth.deleteCalls, []);
});

test('unexpected failures return no token, email, UID, or stack', async () => {
  const nowMillis = 5_000_000;
  const secretUid = 'sensitive-uid';
  const { handler } = handlerFixture({
    decodedToken: { uid: secretUid, auth_time: nowMillis / 1000 },
    nowMillis,
    execute: async () => {
      throw new Error('secret-token user@example.com sensitive-uid');
    },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const response = await invoke(handler, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token', 'x-firebase-appcheck': APP_CHECK_TOKEN },
      body: {},
    });
    const serialized = JSON.stringify(response.body);
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.code, 'ACCOUNT_DELETE_FAILED');
    assert.doesNotMatch(
      serialized,
      /secret-token|example\.com|sensitive-uid|stack/i,
    );
  } finally {
    console.error = originalConsoleError;
  }
});
const GUARD_PATH = `account_deletion_guards/${UID}`;
function rankingData(owner = UID) {
  return {uid: owner, name: 'Private name', totalXp: 10, photoUrl: null, updatedAt: timestamp(100)};
}
function seedHistory(db, circleId = 'old-circle', challengeId = 'old-challenge') {
  const root = `circles/${circleId}/challenges/${challengeId}`;
  db.seed(`${root}/progress/${UID}`, progressData());
  db.seed(`${root}/processed_events/focus-old`, focusEvent('focus-old'));
  db.seed(`circles/${circleId}/ranking/${UID}`, rankingData());
  return root;
}

test('legacy oversized Circle and Challenge history is cleaned without touching another UID', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});
  const root = seedHistory(db, 'c'.repeat(129), 'h'.repeat(129));
  const original = {schemaVersion: 2, createdBy: UID, title: 'Shared challenge'};
  db.seed(root, original);
  const foreign = progressData(7, 'other-user');
  db.seed(`${root}/progress/other-user`, foreign);
  const auth = new FakeAuth({});
  const result = await deleteAccount({db, auth, uid: UID});
  assert.equal(result.body.deleted, true);
  assert.equal(db.data(`${root}/progress/${UID}`), undefined);
  assert.equal(db.data(`${root}/processed_events/focus-old`), undefined);
  assert.equal(db.data(`circles/${'c'.repeat(129)}/ranking/${UID}`), undefined);
  assert.deepEqual(db.data(`${root}/progress/other-user`), foreign);
  assert.deepEqual(db.data(root), {...original, createdBy: ''});
  assert.deepEqual(auth.deleteCalls, [UID]);
});

for (const soleAdmin of [false, true]) {
  test(`legacy oversized active Circle supports account cleanup (sole admin: ${soleAdmin})`, async () => {
    const db = new FakeFirestore();
    const id = 'c'.repeat(129);
    db.seed(`users/${UID}`, {activeCircleId: id});
    db.seed(`circles/${id}`, baseCircle({adminId: soleAdmin ? UID : ADMIN_UID,
      memberCount: soleAdmin ? 1 : 2}));
    db.seed(`circles/${id}/members/${UID}`, member(soleAdmin ? 'admin' : 'member'));
    if (!soleAdmin) db.seed(`circles/${id}/members/${ADMIN_UID}`, member('admin'));
    const auth = new FakeAuth({});
    const result = await deleteAccount({db, auth, uid: UID});
    assert.equal(result.body.deleted, true);
    assert.equal(db.data(`users/${UID}`), undefined);
    assert.equal(db.data(`circles/${id}/members/${UID}`), undefined);
    if (soleAdmin) assert.equal(db.data(`circles/${id}`), undefined);
    else {
      assert.equal(db.data(`circles/${id}`).memberCount, 1);
      assert.ok(db.data(`circles/${id}/members/${ADMIN_UID}`));
    }
    assert.deepEqual(auth.deleteCalls, [UID]);
  });
}

test('global history in Circle A and current membership B are both cleaned', async () => {
  const db = seedNormalCircle(new FakeFirestore());
  const old = seedHistory(db);
  db.seed(old, {schemaVersion: 2, title: 'Shared challenge', createdBy: UID});
  const foreign = progressData(7, 'other-user');
  db.seed(`${old}/progress/other-user`, foreign);
  const auth = new FakeAuth({});
  auth.deleteUser = async (owner) => {
    assert.equal(db.data(`${old}/progress/${UID}`), undefined);
    assert.equal(db.data(`${old}/processed_events/focus-old`), undefined);
    assert.equal(db.data(`circles/old-circle/ranking/${UID}`), undefined);
    assert.equal(db.data(`circles/${CIRCLE_ID}/members/${UID}`), undefined);
    assert.equal(db.data(old).createdBy, '');
    const marker = db.data(ACCOUNT_DELETION_MARKER_PATH);
    assert.equal(marker.version, 2);
    assert.equal(marker.scope, 'GLOBAL_CIRCLE_UID');
    assert.equal(marker.deletionId, db.data(GUARD_PATH).deletionId);
    auth.deleteCalls.push(owner);
  };
  await deleteAccount({db, auth, uid: UID});
  assert.deepEqual(db.data(`${old}/progress/other-user`), foreign);
  const guardSet = db.operationLog.findIndex((entry) => entry.path === GUARD_PATH && entry.type === 'set');
  const historyDelete = db.operationLog.findIndex((entry) => entry.path === `${old}/progress/${UID}`);
  assert.ok(guardSet >= 0 && guardSet < historyDelete);
  assert.equal(db.data(GUARD_PATH).state, 'COMPLETE');
});

for (const data of [{}, {activeCircleId: null}]) {
  test(`leaving Circle A before deletion still discovers history (${Object.keys(data).length})`, async () => {
    const db = new FakeFirestore();
    db.seed(`users/${UID}`, data);
    const old = seedHistory(db);
    const result = await deleteAccount({db, auth: new FakeAuth({}), uid: UID});
    assert.equal(result.body.deleted, true);
    assert.equal(db.data(`${old}/progress/${UID}`), undefined);
    assert.equal(db.data(`${old}/processed_events/focus-old`), undefined);
    assert.equal(db.data(`circles/old-circle/ranking/${UID}`), undefined);
  });
}

test('more than 240 challenges including absent parents are cleaned globally', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});
  for (let index = 0; index < 321; index++) {
    db.seed(`circles/history/challenges/c-${index}/progress/${UID}`, progressData());
  }
  await deleteAccount({db, auth: new FakeAuth({}), uid: UID});
  assert.equal([...db.store.keys()].some((key) => key.includes('/progress/')), false);
});

test('global progress events and ranking all converge across multiple bounded pages', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});
  for (let index = 0; index < 417; index++) seedHistory(db, `old-${index}`);
  await deleteAccount({db, auth: new FakeAuth({}), uid: UID});
  for (const group of ['progress', 'processed_events', 'ranking']) {
    const pages = db.transactions.filter((tx) => tx.writes.some((write) => write.ref.path.includes(`/${group}/`)));
    assert.equal(pages.length, 3);
    assert.ok(pages.every((tx) => tx.writes.length <= 200));
  }
  assert.deepEqual([...db.store.keys()], [GUARD_PATH]);
});

for (const [name, documentPath, document] of [
  ['progress doc ownership mismatch', 'circles/old/challenges/c/progress/other-user', progressData()],
  ['progress field ownership mismatch', `circles/old/challenges/c/progress/${UID}`, progressData(1, 'other-user')],
  ['malformed progress path', `users/elsewhere/progress/${UID}`, progressData()],
  ['malformed event path', 'users/elsewhere/processed_events/focus-old', focusEvent('focus-old')],
  ['malformed ranking path', `users/elsewhere/ranking/${UID}`, rankingData()],
  ['ranking ownership mismatch', 'circles/old/ranking/other-user', rankingData()],
  ['invalid progress schema', `circles/old/challenges/c/progress/${UID}`, {...progressData(), value: '1'}],
  ['invalid event schema', 'circles/old/challenges/c/processed_events/focus-old', {uid: UID}],
  ['invalid ranking schema', `circles/old/ranking/${UID}`, {...rankingData(), totalXp: -1}],
]) {
  test(`${name} fails closed without deleting the inconsistent document or Auth`, async () => {
    const db = new FakeFirestore();
    db.seed(`users/${UID}`, {});
    db.seed(documentPath, document);
    const auth = new FakeAuth({});
    await assert.rejects(deleteAccount({db, auth, uid: UID}), (error) => error.code === 'ACCOUNT_STATE_CONFLICT');
    assert.deepEqual(db.data(documentPath), document);
    assert.deepEqual(auth.deleteCalls, []);
    assert.ok(db.data(`users/${UID}`));
    assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH), undefined);
  });
}

test('retry after a partially committed global page keeps the same barrier identity', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});
  for (let index = 0; index < 417; index++) {
    const id = `focus-${String(index).padStart(4, '0')}`;
    db.seed(`circles/old/challenges/c/processed_events/${id}`, focusEvent(id));
  }
  db.failHistoryAt = 2;
  const auth = new FakeAuth({});
  await assert.rejects(deleteAccount({db, auth, uid: UID}), /history transport failure/);
  assert.equal([...db.store.keys()].filter((key) => key.includes('/processed_events/')).length, 217);
  assert.deepEqual(auth.deleteCalls, []);
  assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH), undefined);
  const id = db.data(GUARD_PATH).deletionId;
  await deleteAccount({db, auth, uid: UID});
  assert.equal(db.data(GUARD_PATH).deletionId, id);
  assert.equal(db.data(GUARD_PATH).state, 'COMPLETE');
  assert.equal([...db.store.keys()].some((key) => key.includes('/processed_events/')), false);
});

test('legacy marker v1 is not proof of global cleanup and is upgraded only after discovery', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {activeCircleId: null});
  db.seed(ACCOUNT_DELETION_MARKER_PATH, externalCleanupMarker());
  const old = seedHistory(db);
  const auth = new FakeAuth({}, {deleteUserError: 'auth/internal-error'});
  await assert.rejects(deleteAccount({db, auth, uid: UID}));
  assert.equal(db.data(`${old}/progress/${UID}`), undefined);
  assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH).version, 2);
  assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH).deletionId, db.data(GUARD_PATH).deletionId);
});

test('shared admin preflight does not create an account barrier or mutate Billing', async () => {
  const db = seedSoleAdmin(new FakeFirestore(), {circleOverrides: {memberCount: 2}});
  db.seed(`circles/${CIRCLE_ID}/members/other`, member('member'));
  const auth = new FakeAuth({});
  await assert.rejects(deleteAccount({db, auth, uid: UID}), (error) => error.code === 'CIRCLE_ADMIN_ACTION_REQUIRED');
  assert.equal(db.data(GUARD_PATH), undefined);
  assert.equal(db.operationLog.length, 0);
  assert.deepEqual(auth.deleteCalls, []);
});

test('historical membership without activeCircleId is removed without touching the administrator', async () => {
  const db = seedNormalCircle(new FakeFirestore(), {userData: {activeCircleId: null}});
  await deleteAccount({db, auth: new FakeAuth({}), uid: UID});
  assert.equal(db.data(`circles/${CIRCLE_ID}/members/${UID}`), undefined);
  assert.equal(db.data(`circles/${CIRCLE_ID}`).memberCount, 1);
  assert.ok(db.data(`circles/${CIRCLE_ID}/members/${ADMIN_UID}`));
});

test('historical sole-admin Circle without activeCircleId is safely removed', async () => {
  const db = seedSoleAdmin(new FakeFirestore(), {userData: {activeCircleId: null}});
  const result = await deleteAccount({db, auth: new FakeAuth({}), uid: UID});
  assert.equal(result.body.circleDeleted, true);
  assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
  assert.equal(db.data(`circle_deletions/${CIRCLE_ID}`), undefined);
  assert.equal(db.data(`circle_cleanup_guards/${CIRCLE_ID}`).state, 'SERVER_DELETING');
});

test('current and legacy challenge attribution is anonymized without deleting shared content', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});
  for (const version of [undefined, 2]) {
    const key = `circles/shared/challenges/author-${String(version)}`;
    const original = {createdBy: UID, title: 'Shared challenge', targetValue: 100};
    if (version) original.schemaVersion = version;
    db.seed(key, original);
    db.seed(`${key}/progress/other-user`, {value: 4});
    await deleteAccount({db, auth: new FakeAuth({}), uid: UID});
    assert.deepEqual(db.data(key), {...original, createdBy: ''});
    assert.deepEqual(db.data(`${key}/progress/other-user`), {value: 4});
    db.seed(`users/${UID}`, {});
  }
});

test('pending Circle deletion marker UID references are finalized behind a non-UID closure guard', async () => {
  const db = seedNormalCircle(new FakeFirestore(), {userData: {activeCircleId: null},
    circleOverrides: {deletionState: 'SERVER_DELETING'}});
  db.seed(`users/${ADMIN_UID}`, {activeCircleId: CIRCLE_ID});
  db.seed(`circle_deletions/${CIRCLE_ID}`, {version: 1, state: 'SERVER_DELETING',
    circleId: CIRCLE_ID, initiatedBy: ADMIN_UID, memberUids: [ADMIN_UID, UID], createdAt: timestamp(100)});
  await deleteAccount({db, auth: new FakeAuth({}), uid: UID});
  assert.equal(db.data(`circle_deletions/${CIRCLE_ID}`), undefined);
  assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
  assert.deepEqual(db.data(`users/${ADMIN_UID}`), {activeCircleId: null});
  const closure = `circle_cleanup_guards/${CIRCLE_ID}`;
  assert.equal(db.data(closure).state, 'SERVER_DELETING');
  assert.equal(JSON.stringify(db.data(closure)).includes(UID), false);
  assert.ok(db.operationLog.findIndex((entry) => entry.path === closure) <
    db.operationLog.findIndex((entry) => entry.type === 'recursiveDelete' && entry.path === `circles/${CIRCLE_ID}`));
});

test('v2 proof cannot be reused with a different barrier identity', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});
  const auth = new FakeAuth({}, {deleteUserError: 'auth/internal-error'});
  await assert.rejects(deleteAccount({db, auth, uid: UID}));
  const marker = db.data(ACCOUNT_DELETION_MARKER_PATH);
  db.seed(ACCOUNT_DELETION_MARKER_PATH, {...marker, deletionId: '11111111-1111-4111-8111-111111111111'});
  await assert.rejects(deleteAccount({db, auth, uid: UID}), (error) => error.code === 'ACCOUNT_STATE_CONFLICT');
  assert.deepEqual(auth.deleteCalls, [UID]);
});

test('barrier identity changed during global cleanup cannot publish completion or delete Auth', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});
  const old = seedHistory(db);
  const originalRunTransaction = db.runTransaction.bind(db);
  let replaced = false;
  db.runTransaction = async (callback) => {
    if (!replaced && db.data(GUARD_PATH) && db.data(`${old}/progress/${UID}`) === undefined) {
      db.seed(GUARD_PATH, {...db.data(GUARD_PATH),
        deletionId: '22222222-2222-4222-8222-222222222222'});
      replaced = true;
    }
    return originalRunTransaction(callback);
  };
  const auth = new FakeAuth({});
  await assert.rejects(deleteAccount({db, auth, uid: UID}), error => error.code === 'ACCOUNT_STATE_CONFLICT');
  assert.equal(replaced, true);
  assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH), undefined);
  assert.deepEqual(auth.deleteCalls, []);
  assert.ok(db.data(`users/${UID}`));
});

test('final UID verification rejects history injected after repeat-until-empty', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});
  const originalQuery = db.querySnapshot.bind(db);
  let injected = false;
  const latePath = 'circles/late/challenges/late/processed_events/focus-late';
  db.querySnapshot = ref => {
    const result = originalQuery(ref);
    const collection = ref.collectionRef;
    if (!injected && collection?.group === 'processed_events' && ref.limitValue === 1) {
      db.seed(latePath, focusEvent('focus-late'));
      injected = true;
      return originalQuery(ref);
    }
    return result;
  };
  const auth = new FakeAuth({});
  await assert.rejects(deleteAccount({db, auth, uid: UID}), error => error.code === 'ACCOUNT_STATE_CONFLICT');
  assert.equal(injected, true);
  assert.ok(db.data(latePath));
  assert.ok(db.data(`users/${UID}`));
  assert.equal(db.data(ACCOUNT_DELETION_MARKER_PATH), undefined);
  assert.deepEqual(auth.deleteCalls, []);
  await deleteAccount({db, auth, uid: UID});
  assert.equal(db.data(latePath), undefined);
});

test('pending Circle marker belonging to a different live root cannot authorize recursive deletion', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});
  const root = {schemaVersion: 2, adminId: 'another-admin', memberLimit: 3, memberCount: 1};
  db.seed('circles/old', root);
  db.seed('circle_deletions/old', {version: 1, state: 'SERVER_DELETING',
    circleId: 'old', initiatedBy: UID, memberUids: [UID], createdAt: timestamp(100)});
  const auth = new FakeAuth({});
  await assert.rejects(deleteAccount({db, auth, uid: UID}), error => error.code === 'ACCOUNT_STATE_CONFLICT');
  assert.deepEqual(db.data('circles/old'), root);
  assert.deepEqual(db.recursiveDeletes, []);
  assert.deepEqual(auth.deleteCalls, []);
});

test('legacy oversized pending Circle marker finalizes without retaining UID references', async () => {
  const db = new FakeFirestore();
  const id = 'c'.repeat(129);
  db.seed(`users/${UID}`, {});
  db.seed(`circles/${id}`, baseCircle({adminId: UID, memberCount: 1, deletionState: 'SERVER_DELETING'}));
  db.seed(`circles/${id}/members/${UID}`, member('admin'));
  db.seed(`circle_deletions/${id}`, {version: 1, state: 'SERVER_DELETING',
    circleId: id, initiatedBy: UID, memberUids: [UID], createdAt: timestamp(100)});
  const auth = new FakeAuth({});
  await deleteAccount({db, auth, uid: UID});
  assert.equal(db.data(`circles/${id}`), undefined);
  assert.equal(db.data(`circle_deletions/${id}`), undefined);
  assert.equal(db.data(`users/${UID}`), undefined);
  assert.deepEqual(auth.deleteCalls, [UID]);
});

test('backfilled legacy progress with optional timestamps is cleaned without changing writers', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, {});
  const key = `circles/old/challenges/legacy/progress/${UID}`;
  db.seed(key, {uid: UID, value: 7});
  await deleteAccount({db, auth: new FakeAuth({}), uid: UID});
  assert.equal(db.data(key), undefined);
});

test('historical sole-admin partial recursive deletion retains context until retry converges', async () => {
  const db = seedSoleAdmin(new FakeFirestore(), {userData: {activeCircleId: null}});
  const recursiveDelete = db.recursiveDelete.bind(db);
  let failed = false;
  db.recursiveDelete = async ref => {
    if (ref.path === `circles/${CIRCLE_ID}` && !failed) {
      db.store.delete(ref.path);
      failed = true;
      throw new Error('partial recursive failure');
    }
    return recursiveDelete(ref);
  };
  const auth = new FakeAuth({});
  await assert.rejects(deleteAccount({db, auth, uid: UID}), /partial recursive failure/);
  assert.equal(db.data(`circle_deletions/${CIRCLE_ID}`).initiatedBy, UID);
  assert.deepEqual(auth.deleteCalls, []);
  const result = await deleteAccount({db, auth, uid: UID});
  assert.equal(result.body.circleDeleted, true);
  assert.equal(db.data(`circle_deletions/${CIRCLE_ID}`), undefined);
  assert.equal(db.data(`circles/${CIRCLE_ID}/members/${UID}`), undefined);
  assert.deepEqual(auth.deleteCalls, [UID]);
});
