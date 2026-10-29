import assert from 'node:assert/strict';
import test from 'node:test';

import { Timestamp } from 'firebase-admin/firestore';
import deletionControl from '../api/account/_deletion_control.cjs';

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

// Optimistic fixture: document/query versions, stable per-attempt snapshots,
// atomic commits and genuine callback retries. Metadata RPCs remain outside
// the transaction read set, just as listCollections/listDocuments in the SDK.
function copyValue(value) {
  if (value instanceof Timestamp) return value;
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(copyValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyValue(v)]));
  return value;
}
function copyStore(store) { return new Map([...store].map(([p, data]) => [p, copyValue(data)])); }

class FakeDocumentReference {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').at(-1); }
  collection(name) { return this.db.collection(`${this.path}/${name}`); }
  async get() { return new FakeDocumentSnapshot(this, this.db.store.get(this.path)); }
  async listCollections() {
    const names = new Set([...this.db.store.keys()].filter(p => p.startsWith(this.path + '/'))
      .map(p => p.slice(this.path.length + 1).split('/')[0]));
    const result = [...names].sort().map(name => this.collection(name));
    this.db.metadataCalls.push({method: 'listCollections', path: this.path, paths: result.map(r => r.path)});
    await this.db.hooks.afterListCollections?.({ref: this, result});
    return result;
  }
  async delete() { this.db.nativeWrites.push(this.path); throw new Error('NATIVE_WRITE_FORBIDDEN'); }
}
class FakeCollectionReference {
  constructor(db, path, limitValue = null) { this.db = db; this.path = path; this.limitValue = limitValue; this.id = path.split('/').at(-1); }
  doc(id) { return this.db.doc(`${this.path}/${id}`); }
  limit(value) { return this.db.query(this.path, value); }
  snapshot(store) {
    const docs = [...store.keys()].filter(p => p.startsWith(this.path + '/') && !p.slice(this.path.length + 1).includes('/'))
      .sort().map(p => new FakeDocumentSnapshot(this.db.doc(p), store.get(p)));
    const selected = this.limitValue === null ? docs : docs.slice(0, this.limitValue);
    return {docs: selected, size: selected.length, empty: selected.length === 0};
  }
  async get() { return this.snapshot(this.db.store); }
  async listDocuments() {
    const ids = new Set([...this.db.store.keys()].filter(p => p.startsWith(this.path + '/'))
      .map(p => p.slice(this.path.length + 1).split('/')[0]));
    const result = [...ids].sort().map(id => this.doc(id));
    this.db.metadataCalls.push({method: 'listDocuments', path: this.path, paths: result.map(r => r.path)});
    await this.db.hooks.afterListDocuments?.({ref: this, result});
    return result;
  }
}
class FakeDocumentSnapshot {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this.exists = data !== undefined; this._data = copyValue(data); }
  data() { return copyValue(this._data); }
}
class FakeTransaction {
  constructor(db, record) {
    this.db = db; this.record = record; this.state = copyStore(db.store);
    this.startVersions = new Map(db.versions); this.startQueries = new Map(db.queryVersions);
    this.writes = record.writes; this.hasWritten = false;
  }
  async get(ref) {
    if (this.hasWritten) throw new Error('read after write');
    const query = ref instanceof FakeCollectionReference;
    const version = (query ? this.startQueries : this.startVersions).get(ref.path) ?? 0;
    (query ? this.record.queryReads : this.record.reads).set(ref.path, version);
    this.record.io.push({kind: 'read', query, path: ref.path});
    const result = query ? ref.snapshot(this.state) : new FakeDocumentSnapshot(ref, this.state.get(ref.path));
    await this.db.hooks.afterRead?.({record: this.record, ref, result});
    return result;
  }
  async getAll(...refs) { return Promise.all(refs.map(ref => this.get(ref))); }
  write(type, ref, data, options) {
    this.hasWritten = true; this.record.io.push({kind: 'write', path: ref.path});
    this.writes.push({type, ref, data: copyValue(data), options});
  }
  set(ref, data, options) { this.write('set', ref, data, options); }
  create(ref, data) { this.write('create', ref, data); }
  update(ref, data) { this.write('update', ref, data); }
  delete(ref) { this.write('delete', ref); }
  commit() {
    const changed = [...this.record.reads].filter(([p, v]) => (this.db.versions.get(p) ?? 0) !== v).map(([p]) => p);
    changed.push(...[...this.record.queryReads].filter(([p, v]) => (this.db.queryVersions.get(p) ?? 0) !== v).map(([p]) => p));
    if (changed.length) { this.db.conflicts.push({id: this.record.id, attempt: this.record.attempt, paths: changed}); return false; }
    const next = copyStore(this.db.store);
    for (const write of this.writes) {
      if (write.type === 'create' && next.has(write.ref.path)) throw new Error('create precondition failed');
      if (write.type === 'update' && !next.has(write.ref.path)) throw new Error(`missing update: ${write.ref.path}`);
      if (write.type === 'delete') next.delete(write.ref.path);
      else next.set(write.ref.path, write.type === 'update' || write.options?.merge ? {...next.get(write.ref.path), ...copyValue(write.data)} : copyValue(write.data));
    }
    // All preconditions pass before any part of the shared store is replaced.
    this.db.store = next;
    for (const write of this.writes) this.db.bump(write.ref.path);
    this.record.applied = true; this.record.after = copyStore(next); this.db.commits.push(this.record);
    return true;
  }
}
class FakeFirestore {
  constructor() {
    this.projectId = 'demo-life-os-p1'; this.databaseId = '(default)';
    this.store = new Map(); this.versions = new Map(); this.queryVersions = new Map();
    this.documents = new Map(); this.collections = new Map(); this.attempts = []; this.commits = []; this.conflicts = [];
    this.metadataCalls = []; this.nativeWrites = []; this.recursiveDeletes = []; this.hooks = {};
    this.failTreeDeleteCommit = null;
    this.treeDeleteCandidates = 0; this.faultEvents = []; this.nextId = 0; this.initial = null;
  }
  doc(path) { if (!this.documents.has(path)) this.documents.set(path, new FakeDocumentReference(this, path)); return this.documents.get(path); }
  query(path, limitValue = null) {
    const key = JSON.stringify([path, limitValue]);
    if (!this.collections.has(key)) this.collections.set(key, new FakeCollectionReference(this, path, limitValue));
    return this.collections.get(key);
  }
  collection(name) { return this.query(name); }
  bump(path) {
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
    const parent = path.slice(0, path.lastIndexOf('/'));
    this.queryVersions.set(parent, (this.queryVersions.get(parent) ?? 0) + 1);
  }
  seed(path, data) { if (data === undefined) this.store.delete(path); else this.store.set(path, copyValue(data)); this.bump(path); }
  data(path) { return this.store.get(path); }
  async runTransaction(callback) {
    this.initial ??= copyStore(this.store);
    const id = ++this.nextId;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const record = {id, attempt, before: copyStore(this.store), reads: new Map(), queryReads: new Map(), writes: [], io: [], applied: false};
      this.attempts.push(record); const transaction = new FakeTransaction(this, record);
      try {
        const result = await callback(transaction);
        await this.hooks.beforeCommit?.(record);
        const treeDeletes = record.writes.filter(w => w.type === 'delete' && w.ref.path.startsWith('circles/'));
        if (treeDeletes.length) this.treeDeleteCandidates++;
        if (treeDeletes.length && this.failTreeDeleteCommit === this.treeDeleteCandidates) {
          this.failTreeDeleteCommit = null;
          this.faultEvents.push({id, attempt, stage: 'tree-delete-commit', ordinal: this.treeDeleteCandidates,
            paths: treeDeletes.map(w => w.ref.path), before: copyStore(this.store), priorCommits: this.commits.length});
          throw new Error('synthetic tree delete commit failed');
        }
        if (!transaction.commit()) continue;
        record.result = result;
        await this.hooks.afterCommit?.(record);
        return result;
      } catch (error) { record.error = error.message; record.rejectedState = copyStore(this.store); throw error; }
    }
    throw new Error('transaction retry limit exceeded');
  }
  async recursiveDelete(ref) { this.recursiveDeletes.push(ref.path); throw new Error('UNFENCED_RECURSIVE_DELETE_FORBIDDEN'); }
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

function seedPremiumCircle(db, memberCount) {
  seedCircle(db);
  db.seed(`circles/${CIRCLE_ID}`, circle({ memberLimit: 30, memberCount }));
  const memberUids = [ADMIN_UID];
  for (let index = 1; index < memberCount; index += 1) {
    const uid = `premium-member-${index}`;
    db.seed(`circles/${CIRCLE_ID}/members/${uid}`, { role: 'member' });
    db.seed(`users/${uid}`, { activeCircleId: CIRCLE_ID });
    memberUids.push(uid);
  }
  return memberUids;
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
    checkRateLimit: async () => true,
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
  assertCompleteCircleDeletion(db, {caseName: 'sole admin deletes complete Circle tree'});
});

test('admin deletes Circle with multiple members', async () => {
  const db = seedCircle(new FakeFirestore(), { multipleMembers: true });
  await execute(db);
  assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
  assert.equal(db.data(`users/${ADMIN_UID}`).activeCircleId, null);
  assert.equal(db.data(`users/${MEMBER_UID}`).activeCircleId, null);
  assertCompleteCircleDeletion(db, {caseName: 'admin deletes Circle with multiple members'});
});

for (const memberCount of [1, 11, 30]) {
  test(`admin deletes Premium limit 30 Circle with ${memberCount} members`, async () => {
    const db = new FakeFirestore();
    const memberUids = seedPremiumCircle(db, memberCount);

    const result = await execute(db);

    assert.deepEqual(result.body, { deleted: true });
    assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
    assert.equal(db.data(markerPath()), undefined);
    assertCompleteCircleDeletion(db, {caseName: `admin deletes Premium limit 30 Circle with ${memberCount} members`});
    for (const uid of memberUids) {
      assert.equal(db.data(`circles/${CIRCLE_ID}/members/${uid}`), undefined);
      assert.equal(db.data(`users/${uid}`).activeCircleId, null);
    }
  });
}

test('legacy Premium memberLimit 10 remains deletable', async () => {
  const db = seedCircle(new FakeFirestore());
  db.seed(`circles/${CIRCLE_ID}`, circle({ memberLimit: 10 }));

  assert.deepEqual((await execute(db)).body, { deleted: true });
  assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
  assert.equal(db.data(`users/${ADMIN_UID}`).activeCircleId, null);
  assertCompleteCircleDeletion(db, {caseName: 'legacy Premium memberLimit 10 remains deletable'});
});

for (const memberLimit of [4, 29, 31]) {
  test(`invalid memberLimit ${memberLimit} fails closed without writes`, async () => {
    const db = seedCircle(new FakeFirestore());
    db.seed(`circles/${CIRCLE_ID}`, circle({ memberLimit }));
    const before = new Map(db.store);

    await assert.rejects(execute(db), (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'CIRCLE_STATE_CONFLICT');
      return true;
    });

    assert.deepEqual(db.store, before);
    assert.deepEqual(db.recursiveDeletes, []);
    assert.equal(db.data(markerPath()), undefined);
  });
}

test('31 memberships exceed structural maximum even with declared count 30', async () => {
  const db = new FakeFirestore();
  seedPremiumCircle(db, 31);
  db.seed(`circles/${CIRCLE_ID}`, circle({ memberLimit: 30, memberCount: 30 }));
  const before = new Map(db.store);

  await assert.rejects(execute(db), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'CIRCLE_STATE_CONFLICT');
    return true;
  });

  assert.deepEqual(db.store, before);
  assert.deepEqual(db.recursiveDeletes, []);
  assert.equal(db.data(markerPath()), undefined);
});

test('Premium Circle retry accepts deletion marker with 30 members', async () => {
  const db = new FakeFirestore();
  const memberUids = seedPremiumCircle(db, 30);
  db.failTreeDeleteCommit = 2;

  await assert.rejects(execute(db), /synthetic tree delete commit failed/);
  const originalMarker = assertInjectedPartialFailure(db, 'Premium Circle retry accepts deletion marker with 30 members');
  assert.equal(db.data(`circles/${CIRCLE_ID}`).deletionState, CIRCLE_DELETION_STATE);
  assert.deepEqual(db.data(markerPath()).memberUids, [...memberUids].sort());
  for (const uid of memberUids) {
    assert.equal(db.data(`users/${uid}`).activeCircleId, null);
  }

  assert.deepEqual(db.data(markerPath()), originalMarker);
  assert.deepEqual((await execute(db)).body, { deleted: true });
  assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
  assert.equal(db.data(markerPath()), undefined);
  assertCompleteCircleDeletion(db, {caseName: 'Premium Circle retry accepts deletion marker with 30 members'});
});

test('deletion marker with 31 member UIDs fails closed without writes', async () => {
  const db = new FakeFirestore();
  const memberUids = seedPremiumCircle(db, 31);
  db.seed(`circles/${CIRCLE_ID}`, {
    ...db.data(`circles/${CIRCLE_ID}`),
    deletionState: CIRCLE_DELETION_STATE,
  });
  db.seed(markerPath(), {
    version: 1,
    state: CIRCLE_DELETION_STATE,
    circleId: CIRCLE_ID,
    initiatedBy: ADMIN_UID,
    memberUids,
    createdAt: NOW,
  });
  const before = new Map(db.store);

  await assert.rejects(execute(db), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'CIRCLE_STATE_CONFLICT');
    return true;
  });

  assert.deepEqual(db.store, before);
  assert.deepEqual(db.recursiveDeletes, []);
});

test('activeCircleId is cleared for every matching member', async () => {
  const db = seedCircle(new FakeFirestore(), { multipleMembers: true });
  await execute(db);
  assert.equal(db.data(`users/${ADMIN_UID}`).activeCircleId, null);
  assert.equal(db.data(`users/${MEMBER_UID}`).activeCircleId, null);
  assertCompleteCircleDeletion(db, {caseName: 'activeCircleId is cleared for every matching member'});
});

test('user pointing to another Circle is never cleared', async () => {
  const db = seedCircle(new FakeFirestore(), { multipleMembers: true });
  db.seed(`users/${MEMBER_UID}`, { activeCircleId: 'circle-2' });
  await execute(db);
  assert.equal(db.data(`users/${MEMBER_UID}`).activeCircleId, 'circle-2');
  assertCompleteCircleDeletion(db, {caseName: 'user pointing to another Circle is never cleared'});
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
    assertCompleteCircleDeletion(db, {caseName: `${label} descendants are removed recursively`});
  });
}

test('Circle root does not exist after success', async () => {
  const db = seedCircle(new FakeFirestore());
  await execute(db);
  assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
  assertCompleteCircleDeletion(db, {caseName: 'Circle root does not exist after success'});
});

test('unrelated Circle remains intact', async () => {
  const db = seedCircle(new FakeFirestore());
  db.seed('circles/circle-2', circle({ adminId: OTHER_UID }));
  db.seed('circles/circle-2/members/other-1', { role: 'admin' });
  await execute(db);
  assert.ok(db.data('circles/circle-2'));
  assert.ok(db.data('circles/circle-2/members/other-1'));
  assertCompleteCircleDeletion(db, {caseName: 'unrelated Circle remains intact'});
});

test('retry after partial recursiveDelete failure converges safely', async () => {
  const db = seedCircle(new FakeFirestore(), { multipleMembers: true });
  db.failTreeDeleteCommit = 2;

  await assert.rejects(execute(db), /synthetic tree delete commit failed/);
  const originalMarker = assertInjectedPartialFailure(db, 'retry after partial recursiveDelete failure converges safely');
  assert.equal(db.data(`circles/${CIRCLE_ID}`).deletionState, CIRCLE_DELETION_STATE);
  assert.ok(db.data(markerPath()));
  assert.equal(db.data(`users/${ADMIN_UID}`).activeCircleId, null);
  assert.equal(db.data(`users/${MEMBER_UID}`).activeCircleId, null);

  assert.deepEqual(db.data(markerPath()), originalMarker);
  const result = await execute(db);
  assert.deepEqual(result.body, { deleted: true });
  assert.equal(db.data(`circles/${CIRCLE_ID}`), undefined);
  assert.equal(db.data(markerPath()), undefined);
  assertCompleteCircleDeletion(db, {caseName: 'retry after partial recursiveDelete failure converges safely'});
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
  assertCompleteCircleDeletion(db, {caseName: 'second call after completion returns stable CIRCLE_NOT_FOUND'});
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
  assertCompleteCircleDeletion(db, {caseName: 'Circle continua verificando o ID token com checkRevoked=true'});
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

function circleTree(store) {
  const path = `circles/${CIRCLE_ID}`;
  return [...store.keys()].filter(p => p === path || p.startsWith(path + '/')).sort();
}
function assertCompleteCircleDeletion(db, {externalRemovals = [], extraDocuments = [], caseName = 'additional adversarial case'} = {}) {
  assert.deepEqual(circleTree(db.store), [], 'success requires absence of the whole claimed tree');
  const originalTree = circleTree(db.initial);
  const expectedDeletes = [...originalTree.filter(p => !externalRemovals.includes(p)), ...extraDocuments, markerPath()].sort();
  const deletes = db.commits.flatMap(row => row.writes.filter(w => w.type === 'delete').map(w => w.ref.path));
  assert.deepEqual([...deletes].sort(), expectedDeletes, 'exact committed paths; no unrelated or duplicate deletion');
  assert.equal(new Set(deletes).size, deletes.length);
  assert.deepEqual(db.recursiveDeletes, [], 'no recursiveDelete RPC may authorize the cleanup');
  assert.deepEqual(db.nativeWrites, [], 'no native markerRef.delete or direct private write');
  const markerWrites = db.commits.flatMap(row => row.writes.filter(w => w.ref.path === markerPath() && w.type !== 'delete'));
  assert.equal(markerWrites.length, 1, 'the original marker is never replaced on retry');
  const membershipPrefix = `circles/${CIRCLE_ID}/members/`;
  const members = originalTree.filter(p => p.startsWith(membershipPrefix) && !p.slice(membershipPrefix.length).includes('/'))
    .map(p => p.slice(membershipPrefix.length)).sort();
  assert.deepEqual(markerWrites[0].data, {version: 1, state: CIRCLE_DELETION_STATE, circleId: CIRCLE_ID,
    initiatedBy: ADMIN_UID, memberUids: members, createdAt: markerWrites[0].data.createdAt});
  assert.ok(markerWrites[0].data.createdAt instanceof Timestamp);
  const closurePath = `circle_cleanup_guards/${CIRCLE_ID}`;
  const closure = db.data(closurePath);
  assert.deepEqual(closure, {version: 1, state: CIRCLE_DELETION_STATE, createdAt: markerWrites[0].data.createdAt});
  assert.equal(db.data(markerPath()), undefined);
  const terminal = db.commits.filter(row => row.writes.some(w => w.type === 'delete' && w.ref.path === markerPath()));
  assert.equal(terminal.length, 1);
  assert.deepEqual(circleTree(terminal[0].before), [], 'marker delete commits only after actual absence');
  assert.deepEqual(terminal[0].writes.map(w => [w.type, w.ref.path]), [['delete', markerPath()]]);
  for (const row of db.commits) for (const w of row.writes.filter(w => w.type === 'delete' && w.ref.path.startsWith(`circles/${CIRCLE_ID}`))) {
    assert.equal([...row.before.keys()].some(p => p.startsWith(w.ref.path + '/')), false, 'parents are removed only after descendants');
  }
  for (const [p, data] of db.initial) {
    if (members.some(uid => p === `users/${uid}`)) {
      const expected = data.activeCircleId === CIRCLE_ID ? {...data, activeCircleId: null} : data;
      assert.deepEqual(db.data(p), expected);
    } else if (!originalTree.includes(p) && p !== markerPath() && p !== closurePath) assert.deepEqual(db.data(p), data, 'outside data is preserved: ' + p);
  }
  for (const row of db.commits) {
    const firstWrite = row.io.findIndex(io => io.kind === 'write');
    assert.equal(row.io.some((io, index) => io.kind === 'read' && firstWrite !== -1 && index > firstWrite), false);
  }
  console.log(JSON.stringify({historicalCircleEvidence: 'complete-proof', caseName,
    originalPaths: originalTree, committedDeletes: deletes, markerWrites: markerWrites.length, markerDeletes: terminal.length,
    closureState: closure.state, residualPaths: circleTree(db.store), nativeWrites: db.nativeWrites.length, nativeRpc: db.recursiveDeletes.length}));
}
function assertInjectedPartialFailure(db, caseName = 'additional orphan case') {
  assert.equal(db.faultEvents.length, 1, 'the replacement fault injection actually fires');
  const fault = db.faultEvents[0];
  assert.equal(fault.stage, 'tree-delete-commit'); assert.equal(fault.ordinal, 2);
  const rejected = db.attempts.find(r => r.id === fault.id && r.attempt === fault.attempt);
  assert.equal(rejected.applied, false);
  assert.deepEqual(rejected.rejectedState, fault.before, 'the rejected transaction applies no partial write');
  assert.deepEqual(rejected.writes.map(w => [w.type, w.ref.path]), [['delete', fault.paths[0]]]);
  assert.equal(db.commits.flatMap(r => r.writes).filter(w => w.type === 'delete').length, 1, 'one earlier descendant commit remains recorded');
  assert.ok(fault.priorCommits >= 3, 'claim, profiles and first descendant already committed');
  assert.ok(db.data(markerPath())); assert.ok(db.data(`circle_cleanup_guards/${CIRCLE_ID}`));
  assert.equal(db.data(`circles/${CIRCLE_ID}`).deletionState, CIRCLE_DELETION_STATE);
  assert.deepEqual(db.nativeWrites, []); assert.deepEqual(db.recursiveDeletes, []);
  console.log(JSON.stringify({historicalCircleEvidence: 'fault-injection', caseName,
    stage: fault.stage, ordinal: fault.ordinal, paths: fault.paths, applied: rejected.applied,
    priorCommits: fault.priorCommits, markerPreserved: db.data(markerPath()) !== undefined,
    closurePreserved: db.data(`circle_cleanup_guards/${CIRCLE_ID}`) !== undefined}));
  return copyValue(db.data(markerPath()));
}

async function httpDelete(db, uid = ADMIN_UID) {
  return invoke({method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer synthetic',
    'x-firebase-appcheck': 'synthetic'}, body: {circleId: CIRCLE_ID}},
  {db, auth: {verifyIdToken: async (_, revoked) => {assert.equal(revoked, true); return {uid};}}});
}
async function retireThroughCore(db, uid) {
  const binding = {projectId: db.projectId, databaseId: db.databaseId, uid};
  let generated = 0;
  const controller = deletionControl.createController({db, binding, clock: () => NOW,
    uuid: () => {generated++; return '12345678-1234-4234-8234-123456789abc';},
    ports: {getAuthenticatedSubject: async () => binding, getAuthUser: async accountUid => {assert.equal(accountUid, uid); return {uid};}}});
  const result = await controller.admitBackend();
  assert.equal(result.status, 'ADMITTED'); assert.equal(result.destructiveAuthority, false); assert.equal(generated, 1);
  const controls = [`retired_auth_identities/${uid}`, `account_deletion_guards/${uid}`, `account_deletion_guards/${uid}/control/operation`];
  assert.deepEqual(db.commits.filter(r => r.writes.length === 3 && r.writes.every(w => controls.includes(w.ref.path)))
    .map(r => r.writes.map(w => w.ref.path)), [controls]);
  return {controller, controls};
}
function assertNoAck(response) { assert.notEqual(response.body.deleted, true); assert.notEqual(response.body.success, true); }
function assertBlocked(response) {
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {error: 'Conta indisponível para sincronização.', code: 'ACCOUNT_DELETION_BLOCKED', retryable: true});
  assertNoAck(response);
}

test('historical fixture: stable references and live metadata retain missing-parent descendants', async () => {
  const db = new FakeFirestore(), path = 'circles/probe/challenges/missing/progress/member';
  db.seed(path, {value: 1});
  assert.equal(db.collection('circles').doc('probe'), db.doc('circles/probe'));
  assert.equal(db.doc('circles/probe').collection('challenges'), db.collection('circles/probe/challenges'));
  assert.deepEqual((await db.doc('circles/probe').listCollections()).map(r => r.path), ['circles/probe/challenges']);
  assert.deepEqual((await db.collection('circles/probe/challenges').listDocuments()).map(r => r.path), ['circles/probe/challenges/missing']);
  assert.equal((await db.doc('circles/probe/challenges/missing').get()).exists, false);
  assert.deepEqual((await db.doc('circles/probe/challenges/missing').listCollections()).map(r => r.path), ['circles/probe/challenges/missing/progress']);
  db.seed(path, undefined);
  assert.deepEqual(await db.collection('circles/probe/challenges').listDocuments(), []);
  assert.deepEqual(await db.doc('circles/probe').listCollections(), []);
});
test('historical fixture: failed precondition never commits earlier buffered writes', async () => {
  const db = new FakeFirestore(); db.seed('probe/original', {value: 1}); const before = copyStore(db.store);
  await assert.rejects(db.runTransaction(async tx => {
    tx.set(db.doc('probe/new'), {value: 2}); tx.update(db.doc('probe/missing'), {value: 3});
  }), /missing update/);
  assert.deepEqual(db.store, before); assert.equal(db.commits.length, 0); assert.equal(db.attempts[0].applied, false);
});
test('historical fixture: reading after a buffered write rejects without partial state', async () => {
  const db = new FakeFirestore(); const before = copyStore(db.store);
  await assert.rejects(db.runTransaction(async tx => {tx.set(db.doc('probe/new'), {value: 1}); await tx.get(db.doc('probe/old'));}), /read after write/);
  assert.deepEqual(db.store, before); assert.equal(db.commits.length, 0);
});
test('historical fixture: query version conflicts rerun the real callback with a fresh snapshot', async () => {
  const db = new FakeFirestore(); let reached = false;
  db.hooks.beforeCommit = row => {
    if (!reached && row.queryReads.has('probe/root/items')) {reached = true; db.seed('probe/root/items/new', {value: 1});}
  };
  const count = await db.runTransaction(async tx => {
    const rows = await tx.get(db.collection('probe/root/items').limit(1)); tx.set(db.doc('probe/summary'), {count: rows.size}); return rows.size;
  });
  assert.equal(reached, true); assert.equal(count, 1); assert.deepEqual(db.data('probe/summary'), {count: 1});
  assert.equal(db.conflicts.length, 1); assert.equal(db.attempts.length, 2); assert.equal(db.commits.length, 1);
  assert.equal(db.attempts[0].applied, false); assert.equal(db.attempts[1].applied, true);
});

test('historical HTTP: failure before claim commit preserves every document and has no ACK', async () => {
  const db = seedCircle(new FakeFirestore(), {multipleMembers: true}), before = copyStore(db.store); let reached = 0;
  db.hooks.beforeCommit = row => {if (row.writes.some(w => w.ref.path === markerPath())) {reached++; throw new Error('synthetic-private-before-claim');}};
  const response = await httpDelete(db); assert.equal(response.statusCode, 500); assertNoAck(response); assert.equal(reached, 1);
  assert.deepEqual(db.store, before); assert.equal(db.commits.length, 0); assert.equal(db.data(markerPath()), undefined);
  assert.doesNotMatch(JSON.stringify(response), /synthetic-private/);
});
test('historical HTTP: failed final marker commit preserves closure and original marker for retry', async () => {
  const db = seedCircle(new FakeFirestore(), {multipleMembers: true}); let reached = 0;
  db.hooks.beforeCommit = row => {
    if (reached === 0 && row.writes.some(w => w.type === 'delete' && w.ref.path === markerPath())) {reached++; throw new Error('synthetic-private-marker-commit');}
  };
  const response = await httpDelete(db); assert.equal(response.statusCode, 500); assertNoAck(response); assert.equal(reached, 1);
  assert.deepEqual(circleTree(db.store), []);
  const marker = copyValue(db.data(markerPath())), closure = copyValue(db.data(`circle_cleanup_guards/${CIRCLE_ID}`));
  assert.ok(marker && closure); assert.equal(db.attempts.find(r => r.error === 'synthetic-private-marker-commit').applied, false);
  const retry = await httpDelete(db); assert.equal(retry.statusCode, 200); assert.deepEqual(retry.body, {deleted: true});
  assertCompleteCircleDeletion(db); assert.deepEqual(db.data(`circle_cleanup_guards/${CIRCLE_ID}`), closure);
  assert.equal(db.commits.filter(r => r.writes.some(w => w.type === 'set' && w.ref.path === markerPath())).length, 1);
  assert.equal(marker.initiatedBy, ADMIN_UID);
});
test('historical HTTP: thirty members distinguish active, retired-missing and external private roots', async () => {
  const db = new FakeFirestore(), members = seedPremiumCircle(db, 30);
  await retireThroughCore(db, members[1]); db.seed(`users/${members[1]}`, undefined);
  db.seed(`users/${OTHER_UID}`, {activeCircleId: 'circle-other', private: 'preserved'});
  const before = copyStore(db.store), response = await httpDelete(db);
  assert.equal(response.statusCode, 200); assert.deepEqual(response.body, {deleted: true, retiredMemberReferencesSkipped: 1});
  assert.equal(db.data(`users/${members[1]}`), undefined);
  assert.equal(db.commits.some(r => r.writes.some(w => w.ref.path === `users/${members[1]}`)), false);
  for (const uid of members.filter(uid => uid !== members[1])) assert.equal(db.data(`users/${uid}`).activeCircleId, null);
  assert.deepEqual(db.data(`users/${OTHER_UID}`), before.get(`users/${OTHER_UID}`));
  assert.deepEqual(circleTree(db.store), []); assert.equal(db.data(markerPath()), undefined);
  for (const [p, data] of before) if (p.startsWith('account_deletion_guards/') || p.startsWith('retired_auth_identities/')) assert.deepEqual(db.data(p), data);
});
test('historical HTTP: unknown target control is not silently skipped or acknowledged', async () => {
  const db = seedCircle(new FakeFirestore(), {multipleMembers: true}), before = copyStore(db.store); let reached = 0;
  db.hooks.afterRead = ({ref}) => {if (ref.path === `account_deletion_guards/${MEMBER_UID}/control/operation`) {reached++; throw new Error('synthetic-private-control-read');}};
  const response = await httpDelete(db); assertBlocked(response); assert.equal(reached, 1);
  for (const uid of [ADMIN_UID, MEMBER_UID]) assert.deepEqual(db.data(`users/${uid}`), before.get(`users/${uid}`));
  assert.equal(db.commits.some(r => r.writes.some(w => w.type === 'delete')), false);
  assert.ok(db.data(markerPath())); assert.ok(db.data(`circle_cleanup_guards/${CIRCLE_ID}`));
});
test('historical orphan parents: original marker still authorizes only its concrete surviving descendants', async () => {
  const db = seedCircle(new FakeFirestore(), {multipleMembers: true}); db.failTreeDeleteCommit = 2;
  await assert.rejects(execute(db), /synthetic tree delete commit failed/); assertInjectedPartialFailure(db);
  const originalMarker = copyValue(db.data(markerPath())), root = `circles/${CIRCLE_ID}`, challenge = root + '/challenges/challenge-1';
  db.seed(root, undefined); db.seed(challenge, undefined);
  assert.equal((await db.doc(challenge).get()).exists, false);
  assert.deepEqual((await db.doc(root).listCollections()).map(r => r.path), [root + '/challenges', root + '/members']);
  assert.deepEqual((await db.collection(root + '/challenges').listDocuments()).map(r => r.path), [challenge]);
  assert.deepEqual(db.data(markerPath()), originalMarker);
  const response = await httpDelete(db); assert.equal(response.statusCode, 200);
  assertCompleteCircleDeletion(db, {externalRemovals: [root, challenge]});
});
test('historical workload: 400 visits bound commits but not metadata response size and retry keeps the claim', async () => {
  const db = seedCircle(new FakeFirestore(), {multipleMembers: true});
  for (let i = 0; i < 410; i++) db.seed(`circles/${CIRCLE_ID}/challenges/challenge-1/processed_events/work-${i}`, {uid: ADMIN_UID});
  const response = await httpDelete(db); assert.equal(response.statusCode, 503); assert.equal(response.body.code, 'CIRCLE_DELETE_RETRY_REQUIRED'); assertNoAck(response);
  assert.equal(db.commits.flatMap(r => r.writes).filter(w => w.type === 'delete').length, 400);
  assert.ok(db.metadataCalls.some(c => c.method === 'listDocuments' && c.paths.length > 400), 'metadata size is not claimed to be bounded');
  const marker = copyValue(db.data(markerPath())), closure = copyValue(db.data(`circle_cleanup_guards/${CIRCLE_ID}`));
  assert.ok(circleTree(db.store).length > 0); assert.ok(marker && closure);
  const retry = await httpDelete(db); assert.equal(retry.statusCode, 200); assertCompleteCircleDeletion(db);
  assert.deepEqual(db.data(`circle_cleanup_guards/${CIRCLE_ID}`), closure);
  assert.equal(marker.initiatedBy, ADMIN_UID);
});
for (const stage of ['claim', 'descendant']) {
  test(`historical HTTP: real R5 actor retirement at ${stage} commit denies the retry`, async () => {
    const db = seedCircle(new FakeFirestore(), {multipleMembers: true}); let reached = 0, barrier, commitsAtBarrier, originalRecord;
    db.hooks.beforeCommit = async record => {
      const selected = stage === 'claim' ? record.writes.some(w => w.type === 'set' && w.ref.path === markerPath()) :
        record.writes.some(w => w.type === 'delete' && w.ref.path.startsWith(`circles/${CIRCLE_ID}/`));
      if (reached === 0 && selected) {
        reached++; originalRecord = record; await retireThroughCore(db, ADMIN_UID);
        barrier = copyStore(db.store); commitsAtBarrier = db.commits.length;
      }
    };
    const response = await httpDelete(db); assertBlocked(response); assert.equal(reached, 1);
    assert.deepEqual(db.store, barrier); assert.equal(db.commits.length, commitsAtBarrier); assert.equal(originalRecord.applied, false);
    assert.ok(db.conflicts.some(r => r.id === originalRecord.id && r.paths.includes(`retired_auth_identities/${ADMIN_UID}`)));
    assert.equal(db.attempts.filter(r => r.id === originalRecord.id).length, 2);
    if (stage === 'descendant') {assert.ok(db.data(markerPath())); assert.ok(db.data(`circle_cleanup_guards/${CIRCLE_ID}`));}
    console.log(JSON.stringify({historicalCircleEvidence: 'actor-retirement', stage, reached, conflicts: db.conflicts, postBarrierCommits: db.commits.length - commitsAtBarrier}));
  });
}
test('historical HTTP: real member retirement during profile commit never recreates its removed root', async () => {
  const db = seedCircle(new FakeFirestore(), {multipleMembers: true}); let reached = 0;
  db.hooks.beforeCommit = async record => {
    if (reached === 0 && record.writes.some(w => w.ref.path === `users/${MEMBER_UID}`)) {
      reached++; await retireThroughCore(db, MEMBER_UID); db.seed(`users/${MEMBER_UID}`, undefined);
    }
  };
  const response = await httpDelete(db); assert.equal(response.statusCode, 200); assert.deepEqual(response.body, {deleted: true, retiredMemberReferencesSkipped: 1});
  assert.equal(reached, 1); assert.equal(db.data(`users/${MEMBER_UID}`), undefined);
  assert.equal(db.commits.some(r => r.writes.some(w => w.ref.path === `users/${MEMBER_UID}`)), false);
  assert.ok(db.conflicts.some(r => r.paths.includes(`retired_auth_identities/${MEMBER_UID}`)));
  assert.deepEqual(circleTree(db.store), []); assert.equal(db.data(markerPath()), undefined);
  console.log(JSON.stringify({historicalCircleEvidence: 'target-retirement', reached, conflicts: db.conflicts, recreated: false}));
});
for (const kind of ['ownership', 'marker', 'closure']) {
  test(`historical HTTP: changed ${kind} during descendant commit refuses scope expansion`, async () => {
    const db = seedCircle(new FakeFirestore(), {multipleMembers: true}); let reached = 0, barrier;
    db.hooks.beforeCommit = record => {
      if (reached === 0 && record.writes.some(w => w.type === 'delete' && w.ref.path.startsWith(`circles/${CIRCLE_ID}/`))) {
        reached++;
        // Corrupt/replace an already legitimate claim only to prove refusal.
        if (kind === 'ownership') db.seed(`circles/${CIRCLE_ID}`, circle({adminId: OTHER_UID, deletionState: CIRCLE_DELETION_STATE, memberCount: 2}));
        else if (kind === 'marker') db.seed(markerPath(), {...db.data(markerPath()), initiatedBy: MEMBER_UID});
        else db.seed(`circle_cleanup_guards/${CIRCLE_ID}`, {...db.data(`circle_cleanup_guards/${CIRCLE_ID}`), version: 99});
        barrier = copyStore(db.store);
      }
    };
    const response = await httpDelete(db); assert.equal(response.statusCode, 409); assertNoAck(response);
    assert.equal(reached, 1); assert.deepEqual(db.store, barrier); assert.equal(db.commits.some(r => r.writes.some(w => w.type === 'delete')), false);
    assert.ok(db.conflicts.length > 0); assert.ok(db.data(markerPath()));
  });
}
test('historical HTTP: child created during traversal is observed without a false success and removed only on retry', async () => {
  const db = seedCircle(new FakeFirestore(), {multipleMembers: true}); let reached = 0;
  const late = `circles/${CIRCLE_ID}/challenges/challenge-1/processed_events/late-child`;
  db.hooks.afterCommit = record => {
    if (reached === 0 && record.writes.some(w => w.type === 'delete' && w.ref.path.startsWith(`circles/${CIRCLE_ID}/`))) {
      reached++; db.seed(late, {uid: ADMIN_UID});
    }
  };
  const response = await httpDelete(db); assert.equal(response.statusCode, 409); assertNoAck(response); assert.equal(reached, 1);
  assert.deepEqual(db.data(late), {uid: ADMIN_UID});
  const marker = copyValue(db.data(markerPath())); assert.ok(marker); assert.ok(db.data(`circle_cleanup_guards/${CIRCLE_ID}`));
  assert.equal((await httpDelete(db)).statusCode, 200); assertCompleteCircleDeletion(db, {extraDocuments: [late]});
  console.log(JSON.stringify({historicalCircleEvidence: 'late-child', reached, firstResponse: response.statusCode, retryRemoved: db.data(late) === undefined}));
});
for (const [name, challenge, event] of [
  ['prefixed task event', 'challenge-1', 'TASK_COMPLETION__' + 't'.repeat(128)],
  ['missing long Challenge', 'c'.repeat(129), 'orphan'],
  ['1500 UTF-8 bytes', 'challenge-1', '水'.repeat(500)],
  ['stored spaces', 'challenge-1', ' stored event '],
]) {
  test(`historical stored IDs: ${name} stays in the original authorized tree`, async () => {
    const db = seedCircle(new FakeFirestore()); db.seed(`circles/${CIRCLE_ID}/challenges/${challenge}/processed_events/${event}`, {uid: ADMIN_UID});
    assert.equal((await httpDelete(db)).statusCode, 200); assertCompleteCircleDeletion(db);
  });
}
for (const kind of ['foreign path', 'reserved namespace', 'slash']) {
  test(`historical metadata: ${kind} cannot redirect a stored reference`, async () => {
    const db = seedCircle(new FakeFirestore()); db.seed('circles/unrelated', circle({adminId: OTHER_UID}));
    const unrelated = copyValue(db.data('circles/unrelated')); let reached = 0;
    db.hooks.afterListDocuments = ({ref, result}) => {
      if (reached === 0 && ref.path === `circles/${CIRCLE_ID}/challenges`) {
        reached++;
        // Unexpected metadata is a denial case, never authority for a path.
        result.splice(0, result.length, kind === 'foreign path' ? db.doc('circles/unrelated') :
          {id: kind === 'reserved namespace' ? '__reserved__' : 'nested/id', path: ref.path + '/' + (kind === 'reserved namespace' ? '__reserved__' : 'nested/id')});
      }
    };
    const response = await httpDelete(db); assert.equal(response.statusCode, 409); assertNoAck(response); assert.equal(reached, 1);
    assert.deepEqual(db.data('circles/unrelated'), unrelated); assert.ok(db.data(markerPath())); assert.ok(db.data(`circle_cleanup_guards/${CIRCLE_ID}`));
    assert.equal(db.commits.some(r => r.writes.some(w => w.type === 'delete')), false);
  });
}
