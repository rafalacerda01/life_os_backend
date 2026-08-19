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

const UID = 'user-1';
const CIRCLE_ID = 'circle-1';
const ADMIN_UID = 'admin-1';
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
}

class FakeDocumentSnapshot {
  constructor(ref, data) {
    this.ref = ref;
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

  commit() {
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
  }

  collection(name) {
    return new FakeCollectionReference(this, name);
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
      if (!documentPath.startsWith(prefix)) continue;
      const suffix = documentPath.slice(prefix.length);
      if (!suffix || suffix.includes('/')) continue;
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
  }

  async recursiveDelete(ref) {
    this.recursiveDeletes.push(ref.path);
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
  const handler = createAccountHandler(
    'delete',
    'ACCOUNT_DELETE_FAILED',
    execute,
    {
      getServices: () => ({ auth, db }),
      nowProvider: () => nowMillis,
    },
  );
  return { auth, db, handler };
}

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
    headers: { authorization: 'Bearer secret-token' },
    body: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(auth.verifyCalls, [
    { token: 'secret-token', checkRevoked: true },
  ]);
});

test('revoked or invalid token returns sanitized 401', async () => {
  const nowMillis = 2_000_000;
  const { handler } = handlerFixture({
    decodedToken: null,
    verifyError: new Error('revoked secret-token user@example.com'),
    nowMillis,
  });
  const response = await invoke(handler, {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token' },
    body: {},
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'UNAUTHENTICATED');
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
    const { handler } = handlerFixture({
      decodedToken: { uid: 'auth-' + name, auth_time: authTime },
      nowMillis,
    });
    const response = await invoke(handler, {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: {},
    });
    assert.equal(response.statusCode, 401, name);
    assert.equal(response.body.code, 'REAUTHENTICATION_REQUIRED', name);
  }
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
    headers: { authorization: 'Bearer token' },
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
  const invalidValues = [123, '', 'bad/id', 'x'.repeat(129), ' circle-1 '];
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
  db.seed(path(challengePath, 'progress', UID), { value: 3 });
  db.seed(path(challengePath, 'processed_events', 'focus'), {
    uid: UID,
    source: 'VERIFIED_FOCUS',
    sessionId: 'session-1',
  });
  db.seed(path(challengePath, 'processed_events', 'activity'), {
    uid: UID,
    source: 'VERIFIED_ACTIVITY',
    activityEventId: 'event-1',
  });
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
  db.beforeTransactions.set(2, (firestore) => {
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

test('large processed event history is paged outside transactions', async () => {
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
      { uid: UID, source: 'VERIFIED_FOCUS', sessionId: 's-' + index },
    );
  }
  const auth = new FakeAuth({});

  await deleteAccount({ db, auth, uid: UID });

  assert.ok(db.batchSizes.filter((size) => size > 1).length >= 3);
  assert.ok(
    db.batchSizes.every((size) => size <= PROCESSED_EVENT_DELETE_PAGE_SIZE),
  );
  assert.ok(
    db.transactions.every((transaction) =>
      transaction.writes.every(
        (write) => !write.ref.path.includes('processed_events'),
      ),
    ),
  );
});

test('Circle cleanup failure never deletes Firebase Auth', async () => {
  const circleDb = seedNormalCircle(new FakeFirestore());
  circleDb.seed(path('circles', CIRCLE_ID, 'challenges', 'c1'), { any: true });
  circleDb.failBatchAt = 1;
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
  assert.deepEqual(
    db.data(ACCOUNT_DELETION_MARKER_PATH),
    db.setCalls.at(-1).data,
  );
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
  assert.equal(db.transactionCount, transactionsAfterCleanup);
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
      headers: { authorization: 'Bearer secret-token' },
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
