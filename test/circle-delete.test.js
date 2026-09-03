import assert from 'node:assert/strict';
import test from 'node:test';

import { Timestamp } from 'firebase-admin/firestore';

import handler, {
  CIRCLE_DELETION_COLLECTION,
  CIRCLE_DELETION_STATE,
  deleteCircle,
} from '../api/circles/delete.js';

const ADMIN_UID = 'admin-1';
const MEMBER_UID = 'member-1';
const OTHER_UID = 'other-1';
const CIRCLE_ID = 'circle-1';
const NOW = Timestamp.fromDate(new Date('2026-08-23T12:00:00.000Z'));

class FakeDocumentReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split('/').at(-1);
  }

  collection(name) {
    return new FakeCollectionReference(this.db, `${this.path}/${name}`);
  }

  async get() {
    return new FakeDocumentSnapshot(this, this.db.store.get(this.path));
  }

  async delete() {
    this.db.store.delete(this.path);
  }
}

class FakeCollectionReference {
  constructor(db, path, limitValue = null) {
    this.db = db;
    this.path = path;
    this.limitValue = limitValue;
  }

  doc(id) {
    return new FakeDocumentReference(this.db, `${this.path}/${id}`);
  }

  limit(value) {
    return new FakeCollectionReference(this.db, this.path, value);
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs = [];
    for (const [path, data] of this.db.store) {
      if (!path.startsWith(prefix)) continue;
      const suffix = path.slice(prefix.length);
      if (!suffix || suffix.includes('/')) continue;
      docs.push(
        new FakeDocumentSnapshot(
          new FakeDocumentReference(this.db, path),
          data,
        ),
      );
    }
    docs.sort((left, right) => left.id.localeCompare(right.id));
    return {
      docs: this.limitValue === null ? docs : docs.slice(0, this.limitValue),
    };
  }
}

class FakeDocumentSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = data !== undefined;
    this._data = data;
  }

  data() {
    return this._data;
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
    this.writes = [];
    this.hasWritten = false;
  }

  async get(ref) {
    if (this.hasWritten) throw new Error('read after write');
    return new FakeDocumentSnapshot(ref, this.db.store.get(ref.path));
  }

  set(ref, data) {
    this.hasWritten = true;
    this.writes.push({ type: 'set', ref, data });
  }

  update(ref, data) {
    this.hasWritten = true;
    this.writes.push({ type: 'update', ref, data });
  }

  commit() {
    const next = new Map(this.db.store);
    for (const write of this.writes) {
      if (write.type === 'set') {
        next.set(write.ref.path, write.data);
        continue;
      }
      if (!next.has(write.ref.path)) {
        throw new Error(`missing update: ${write.ref.path}`);
      }
      next.set(write.ref.path, {
        ...next.get(write.ref.path),
        ...write.data,
      });
    }
    this.db.store = next;
  }
}

class FakeFirestore {
  constructor() {
    this.store = new Map();
    this.recursiveDeletes = [];
    this.failRecursiveDeleteOnce = false;
  }

  collection(name) {
    return new FakeCollectionReference(this, name);
  }

  seed(path, data) {
    this.store.set(path, data);
  }

  data(path) {
    return this.store.get(path);
  }

  async runTransaction(callback) {
    const transaction = new FakeTransaction(this);
    const result = await callback(transaction);
    transaction.commit();
    return result;
  }

  async recursiveDelete(ref) {
    this.recursiveDeletes.push(ref.path);
    if (this.failRecursiveDeleteOnce) {
      this.failRecursiveDeleteOnce = false;
      const partialPath = [...this.store.keys()].find((path) =>
        path.startsWith(`${ref.path}/challenges/`),
      );
      if (partialPath !== undefined) this.store.delete(partialPath);
      throw new Error('recursive delete failed');
    }
    for (const path of [...this.store.keys()]) {
      if (path === ref.path || path.startsWith(`${ref.path}/`)) {
        this.store.delete(path);
      }
    }
  }
}

function circle(overrides = {}) {
  return {
    name: 'Secure Circle',
    description: 'Delete fixture',
    adminId: ADMIN_UID,
    memberCount: 1,
    memberLimit: 3,
    schemaVersion: 2,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function seedCircle(db, { multipleMembers = false } = {}) {
  db.seed(`circles/${CIRCLE_ID}`, circle({ memberCount: multipleMembers ? 2 : 1 }));
  db.seed(`circles/${CIRCLE_ID}/members/${ADMIN_UID}`, { role: 'admin' });
  db.seed(`users/${ADMIN_UID}`, { activeCircleId: CIRCLE_ID });
  if (multipleMembers) {
    db.seed(`circles/${CIRCLE_ID}/members/${MEMBER_UID}`, { role: 'member' });
    db.seed(`users/${MEMBER_UID}`, { activeCircleId: CIRCLE_ID });
  }
  db.seed(`circles/${CIRCLE_ID}/challenges/challenge-1`, { schemaVersion: 2 });
  db.seed(
    `circles/${CIRCLE_ID}/challenges/challenge-1/progress/${ADMIN_UID}`,
    { value: 3 },
  );
  db.seed(
    `circles/${CIRCLE_ID}/challenges/challenge-1/processed_events/event-1`,
    { uid: ADMIN_UID },
  );
  return db;
}

function markerPath() {
  return `${CIRCLE_DELETION_COLLECTION}/${CIRCLE_ID}`;
}

async function execute(db, uid = ADMIN_UID) {
  return deleteCircle({
    body: { circleId: CIRCLE_ID },
    db,
    uid,
    now: NOW,
  });
}

function createResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

async function invoke(request, services) {
  const response = createResponse();
  await handler(request, response, {
    getServices: () => services,
    verifyAppCheckToken: async () => ({ appId: 'test-app' }),
  });
  return response;
}

test('unauthenticated request is rejected before deletion', async () => {
  const db = seedCircle(new FakeFirestore());
  const response = await invoke(
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-firebase-appcheck': 'test-app-check',
      },
      body: { circleId: CIRCLE_ID },
    },
    { auth: {}, db },
  );
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'UNAUTHENTICATED');
  assert.ok(db.data(`circles/${CIRCLE_ID}`));
});

test('member cannot delete the Circle', async () => {
  const db = seedCircle(new FakeFirestore(), { multipleMembers: true });
  await assert.rejects(execute(db, MEMBER_UID), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'CIRCLE_ADMIN_REQUIRED');
    return true;
  });
  assert.ok(db.data(`circles/${CIRCLE_ID}`));
  assert.equal(db.data(markerPath()), undefined);
});

test('different authenticated uid cannot impersonate admin through payload', async () => {
  const db = seedCircle(new FakeFirestore());
  await assert.rejects(execute(db, OTHER_UID), (error) => {
    assert.equal(error.code, 'CIRCLE_ADMIN_REQUIRED');
    return true;
  });
  assert.ok(db.data(`circles/${CIRCLE_ID}`));
});

test('sole admin deletes complete Circle tree', async () => {
  const db = seedCircle(new FakeFirestore());
  const result = await execute(db);
  assert.deepEqual(result.body, { deleted: true });
  assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
  assert.equal(db.data(`users/${ADMIN_UID}`).activeCircleId, null);
  assert.equal(db.data(markerPath()), undefined);
});

test('admin deletes Circle with multiple members', async () => {
  const db = seedCircle(new FakeFirestore(), { multipleMembers: true });
  await execute(db);
  assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
  assert.equal(db.data(`users/${ADMIN_UID}`).activeCircleId, null);
  assert.equal(db.data(`users/${MEMBER_UID}`).activeCircleId, null);
});

test('activeCircleId is cleared for every matching member', async () => {
  const db = seedCircle(new FakeFirestore(), { multipleMembers: true });
  await execute(db);
  assert.equal(db.data(`users/${ADMIN_UID}`).activeCircleId, null);
  assert.equal(db.data(`users/${MEMBER_UID}`).activeCircleId, null);
});

test('user pointing to another Circle is never cleared', async () => {
  const db = seedCircle(new FakeFirestore(), { multipleMembers: true });
  db.seed(`users/${MEMBER_UID}`, { activeCircleId: 'circle-2' });
  await execute(db);
  assert.equal(db.data(`users/${MEMBER_UID}`).activeCircleId, 'circle-2');
});

for (const [label, path] of [
  ['progress', `circles/${CIRCLE_ID}/challenges/challenge-1/progress/${ADMIN_UID}`],
  ['processed_events', `circles/${CIRCLE_ID}/challenges/challenge-1/processed_events/event-1`],
  ['members', `circles/${CIRCLE_ID}/members/${ADMIN_UID}`],
  ['challenges', `circles/${CIRCLE_ID}/challenges/challenge-1`],
]) {
  test(`${label} descendants are removed recursively`, async () => {
    const db = seedCircle(new FakeFirestore());
    await execute(db);
    assert.equal(db.data(path), undefined);
  });
}

test('Circle root does not exist after success', async () => {
  const db = seedCircle(new FakeFirestore());
  await execute(db);
  assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
  assert.deepEqual(db.recursiveDeletes, [`circles/${CIRCLE_ID}`]);
});

test('unrelated Circle remains intact', async () => {
  const db = seedCircle(new FakeFirestore());
  db.seed('circles/circle-2', circle({ adminId: OTHER_UID }));
  db.seed('circles/circle-2/members/other-1', { role: 'admin' });
  await execute(db);
  assert.ok(db.data('circles/circle-2'));
  assert.ok(db.data('circles/circle-2/members/other-1'));
});

test('retry after partial recursiveDelete failure converges safely', async () => {
  const db = seedCircle(new FakeFirestore(), { multipleMembers: true });
  db.failRecursiveDeleteOnce = true;

  await assert.rejects(execute(db), /recursive delete failed/);
  assert.equal(db.data(`circles/${CIRCLE_ID}`).deletionState, CIRCLE_DELETION_STATE);
  assert.ok(db.data(markerPath()));
  assert.equal(db.data(`users/${ADMIN_UID}`).activeCircleId, null);
  assert.equal(db.data(`users/${MEMBER_UID}`).activeCircleId, null);

  const result = await execute(db);
  assert.deepEqual(result.body, { deleted: true });
  assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
  assert.equal(db.data(markerPath()), undefined);
  assert.deepEqual(db.recursiveDeletes, [
    `circles/${CIRCLE_ID}`,
    `circles/${CIRCLE_ID}`,
  ]);
});

test('second call after completion returns stable CIRCLE_NOT_FOUND', async () => {
  const db = seedCircle(new FakeFirestore());
  await execute(db);
  await assert.rejects(execute(db), (error) => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, 'CIRCLE_NOT_FOUND');
    return true;
  });
  assert.equal(db.data(markerPath()), undefined);
});

test('Circle continua verificando o ID token com checkRevoked=true', async () => {
  const db = seedCircle(new FakeFirestore());
  const verifyCalls = [];
  const response = await invoke(
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer circle-token',
        'x-firebase-appcheck': 'test-app-check',
      },
      body: { circleId: CIRCLE_ID },
    },
    {
      auth: {
        verifyIdToken: async (token, checkRevoked) => {
          verifyCalls.push({ token, checkRevoked });
          return { uid: ADMIN_UID };
        },
      },
      db,
    },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(verifyCalls, [
    { token: 'circle-token', checkRevoked: true },
  ]);
});

test('handler takes uid only from verified token and validates JSON body', async () => {
  const db = seedCircle(new FakeFirestore());
  const response = await invoke(
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token',
        'x-firebase-appcheck': 'test-app-check',
      },
      body: { circleId: CIRCLE_ID, adminUid: OTHER_UID },
    },
    {
      auth: { verifyIdToken: async () => ({ uid: ADMIN_UID }) },
      db,
    },
  );
  assert.equal(response.statusCode, 400);
  assert.ok(db.data(`circles/${CIRCLE_ID}`));
});
