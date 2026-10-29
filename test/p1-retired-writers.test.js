import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createRequire} from 'node:module';
import test from 'node:test';
import {getApps, initializeApp} from 'firebase-admin/app';
import {getFirestore, Timestamp} from 'firebase-admin/firestore';
import control from '../api/account/_deletion_control.cjs';

// No credentials or network are used by this suite, including error paths.
const require = createRequire(import.meta.url);
const network = {connections: 0, adc: 0};
const forbidden = () => {network.connections++; throw new Error('NETWORK_FORBIDDEN');};
for (const name of ['node:http', 'node:https']) {
  const transport = require(name); transport.request = forbidden; transport.get = forbidden;
}
require('node:net').Socket.prototype.connect = forbidden;
require('node:tls').connect = forbidden;
require('node:http2').connect = forbidden;
globalThis.fetch = forbidden;
const {GoogleAuth} = require('google-auth-library');
for (const method of ['getClient', 'getApplicationDefault', 'getProjectId']) {
  GoogleAuth.prototype[method] = () => {network.adc++; throw new Error('ADC_FORBIDDEN');};
}
if (!getApps().length) initializeApp({projectId: 'demo-life-os-p1'});
const firestore = getFirestore();
const {syncHandler} = await import('../api/sync.js');
const {default: taskComplete} = await import('../api/activity/task-complete.js');
const {default: habitComplete} = await import('../api/activity/habit-complete.js');
const {default: focusStart} = await import('../api/focus/start.js');
const {default: focusFinish} = await import('../api/focus/finish.js');
const {default: focusCancel} = await import('../api/focus/cancel.js');
const {default: circleDeleteHandler} = await import('../api/circles/delete.js');
const {default: circleLeaveHandler} = await import('../api/circles/leave.js');

const UID = 'r6c1-owner', OTHER = 'r6c1-other';
const ID = '12345678-1234-4234-8234-123456789abc';
const mutationId = '22345678-1234-4234-8234-123456789abc';
const context = new AsyncLocalStorage();
const refs = uid => ({guard: `account_deletion_guards/${uid}`,
  retired: `retired_auth_identities/${uid}`, receipt: `account_deletion_guards/${uid}/control/operation`});
const root = uid => `users/${uid}`;
const now = () => Timestamp.now();
function clone(value) {
  if (value instanceof Timestamp) return value;
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  return value;
}
function stored(value) {
  if (value?.constructor?.name === 'ServerTimestampTransform') return now();
  if (Array.isArray(value)) return value.map(stored);
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stored(v)]));
  return clone(value);
}
const scalar = x => x instanceof Date ? x.getTime() : x instanceof Timestamp ? x.toMillis() : x;
const compare = (a, op, b) => op === '==' ? scalar(a) === scalar(b) : op === '>' ? scalar(a) > scalar(b) :
  op === '>=' ? scalar(a) >= scalar(b) : op === '<' ? scalar(a) < scalar(b) : op === '<=' ? scalar(a) <= scalar(b) : false;

// Optimistic MVCC: stable snapshots, missing-document and query-range versions,
// buffered atomic writes, preconditions, reads-before-writes and actual retries.
// It does not emulate Firestore's pessimistic locks or cloud IAM.
class MemoryDb {
  projectId = 'demo-life-os-p1'; databaseId = '(default)';
  docs = new Map(); versions = new Map(); attempts = []; conflicts = []; commits = [];
  hooks = {}; failRead = null; malformedRead = null; directWrites = 0; nextId = 0;
  put(path, data) {
    if (data === undefined) this.docs.delete(path); else this.docs.set(path, clone(data));
    for (const key of [path, 'q:' + path.slice(0, path.lastIndexOf('/'))]) this.versions.set(key, (this.versions.get(key) || 0) + 1);
  }
  doc(path) {
    const ref = {path, id: path.split('/').at(-1), collection: name => this.collection(path + '/' + name),
      get: async () => this.snapshot(ref, this.docs),
      listCollections: async () => {
        const names = new Set([...this.docs.keys()].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]));
        return [...names].sort().map(name => this.collection(path + '/' + name));
      }};
    for (const method of ['set', 'create', 'update', 'delete']) ref[method] = () => {this.directWrites++; throw new Error('DIRECT_WRITE_FORBIDDEN');};
    return ref;
  }
  collection(path, filters = [], bound = Infinity, cursor = null) {
    const ref = {path, kind: 'query', filters, bound, cursor,
      doc: (id = `generated-${++this.nextId}`) => this.doc(path + '/' + id),
      where: (field, op, value) => this.collection(path, [...filters, {field, op, value}], bound, cursor),
      limit: n => this.collection(path, filters, n, cursor), orderBy: () => ref,
      startAfter: snapshot => this.collection(path, filters, bound, snapshot.ref.path),
      get: async () => this.querySnapshot(ref, this.docs),
      listDocuments: async () => {
        const ids = new Set([...this.docs.keys()].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]));
        return [...ids].sort().map(id => this.doc(path + '/' + id));
      }};
    return ref;
  }
  snapshot(ref, state) {return {ref, id: ref.id, exists: state.has(ref.path), data: () => clone(state.get(ref.path))};}
  querySnapshot(ref, state) {
    const docs = [...state.keys()].sort().filter(p => p.startsWith(ref.path + '/') && !p.slice(ref.path.length + 1).includes('/') &&
      (!ref.cursor || p > ref.cursor) && ref.filters.every(f => compare(state.get(p)?.[f.field], f.op, f.value)))
      .slice(0, ref.bound).map(p => this.snapshot(this.doc(p), state));
    return {docs, size: docs.length, empty: docs.length === 0};
  }
  async runTransaction(callback) {
    const label = context.getStore();
    for (let attempt = 1; attempt <= 10; attempt++) {
      const state = new Map([...this.docs].map(([p, data]) => [p, clone(data)]));
      const versions = new Map(this.versions), reads = new Map(), pending = [];
      const record = {label, attempt, reads, pending, applied: false}; this.attempts.push(record);
      const write = (type, ref, data, options) => pending.push({type, path: ref.path, data: clone(data), options});
      let result;
      try {
        result = await callback({
          get: async ref => {
            assert.equal(pending.length, 0, 'all reads precede writes');
            const key = ref.kind === 'query' ? 'q:' + ref.path : ref.path;
            reads.set(key, versions.get(key) || 0);
            if (this.failRead === ref.path) throw Object.assign(new Error('synthetic-private-read-failure'), {code: 'UNAVAILABLE'});
            if (this.malformedRead === ref.path) return {exists: 'unknown', data: () => undefined};
            const result = ref.kind === 'query' ? this.querySnapshot(ref, state) : this.snapshot(ref, state);
            await this.hooks.afterRead?.({...record, ref});
            return result;
          },
          async getAll(...refs) {return Promise.all(refs.map(ref => this.get(ref)));},
          create: (ref, data) => write('create', ref, data), set: (ref, data, options) => write('set', ref, data, options),
          update: (ref, data) => write('update', ref, data), delete: ref => write('delete', ref),
        });
      } catch (error) {record.error = error; throw error;}
      await this.hooks.beforeCommit?.(record);
      const changed = [...reads].filter(([p, version]) => (this.versions.get(p) || 0) !== version).map(([p]) => p);
      if (changed.length) {this.conflicts.push({...record, changed}); continue;}
      for (const w of pending) {
        if (w.type === 'create') assert.equal(this.docs.has(w.path), false, 'create cannot replace');
        if (w.type === 'update') assert.equal(this.docs.has(w.path), true, 'update cannot recreate');
      }
      for (const w of pending) this.put(w.path, w.type === 'delete' ? undefined :
        w.type === 'update' || w.options?.merge ? {...this.docs.get(w.path), ...stored(w.data)} : stored(w.data));
      record.applied = true; this.commits.push(record);
      await this.hooks.afterCommit?.(record);
      return result;
    }
    throw new Error('MVCC_RETRY_EXHAUSTED');
  }
}
function gate() {
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  return {reached: reached.promise, release: release.resolve, async hold() {reached.resolve(); await release.promise;}};
}
function response() {return {statusCode: 200, headers: {}, setHeader(k, v) {this.headers[k] = v;},
  status(code) {this.statusCode = code; return this;}, json(body) {this.body = body; return this;}, end() {return this;}};}
function seed(db, uid) {
  const at = now().toMillis(), circle = 'r6c1-circle-' + uid;
  db.put(root(uid), {tasksCount: 0, habitsCount: 0, transactionsCount: 0, medicationsCount: 0, subjectsCount: 0, goalsCount: 0, activeCircleId: circle});
  db.put(root(uid) + '/tasks/task-1', {title: 'Synthetic task', priority: 'high', isCompleted: true});
  db.put(root(uid) + '/habits/habit-1', {title: 'Synthetic habit', completedDates: []});
  db.put(root(uid) + '/subjects/subject-1', {cardsToReview: 1});
  db.put(root(uid) + '/review_queue/card-1', {subjectId: 'subject-1', lastReviewed: null});
  db.put(root(uid) + '/study_info/main', {progress: 0, reviewQueue: 1, streak: 0});
  db.put('circles/' + circle, {schemaVersion: 2, name: 'Synthetic', description: 'Local only', adminId: 'r6c1-admin', memberCount: 2,
    memberLimit: 3, createdAt: Timestamp.fromMillis(at - 1_000_000), updatedAt: Timestamp.fromMillis(at - 1_000)});
  db.put(`circles/${circle}/members/${uid}`, {role: 'member', displayNameSnapshot: 'Synthetic', photoUrlSnapshot: null, joinedAt: Timestamp.fromMillis(at - 500_000)});
  for (const type of ['TASK_COMPLETIONS', 'HABIT_COMPLETIONS', 'FOCUS_MINUTES']) db.put(`circles/${circle}/challenges/${type}`, {
    schemaVersion: 2, type, startAt: Timestamp.fromMillis(at - 1_000_000), endAt: Timestamp.fromMillis(at + 1_000_000)});
}
function session(db, uid, kind) {
  const startedAt = Timestamp.fromMillis(now().toMillis() - (kind === 'finish' ? 120_000 : 10_000));
  const plannedDurationSeconds = kind === 'finish' ? 60 : 600;
  const data = {schemaVersion: 1, sessionId: 'session-1', uid, targetId: 'task-1', targetType: 'TASK', plannedDurationSeconds,
    status: 'RUNNING', startedAt, expiresAt: Timestamp.fromMillis(startedAt.toMillis() + (plannedDurationSeconds + 600) * 1000)};
  db.put(root(uid) + '/verified_focus_sessions/session-1', data);
  const {schemaVersion, sessionId, targetId, targetType, expiresAt} = data;
  db.put(root(uid) + '/runtime/active_focus', {schemaVersion, sessionId, targetId, targetType, plannedDurationSeconds, startedAt, expiresAt});
}
const entries = [
  {name: 'Sync create_task', type: 'sync', handler: syncHandler, body: () => ({operation: 'create_task', taskId: 'new-task', title: 'New', priority: 'high', date: new Date().toISOString()})},
  {name: 'Activity task-complete', type: 'activity', handler: taskComplete, body: () => ({taskId: 'task-1'})},
  {name: 'Focus start', type: 'focus', handler: focusStart, body: () => ({targetId: 'task-1', targetType: 'TASK', plannedDurationSeconds: 60})},
  {name: 'Focus finish', type: 'focus', handler: focusFinish, setup: (db, uid) => session(db, uid, 'finish'), body: () => ({sessionId: 'session-1'})},
  {name: 'Focus cancel', type: 'focus', handler: focusCancel, setup: (db, uid) => session(db, uid, 'cancel'), body: () => ({sessionId: 'session-1'})},
];
function fixture(t, entry, uid = UID) {
  const db = new MemoryDb(); seed(db, UID); seed(db, OTHER); entry.setup?.(db, uid);
  t.mock.method(firestore, 'collection', db.collection.bind(db));
  t.mock.method(firestore, 'runTransaction', db.runTransaction.bind(db));
  const calls = {auth: [], appCheck: [], rate: []};
  const auth = {verifyIdToken: async (token, revoked) => {calls.auth.push({token, revoked}); assert.equal(revoked, true); return {uid};}};
  const appCheck = {verifyToken: async token => {calls.appCheck.push(token); return {appId: 'synthetic'};}};
  const runtime = {getServices: () => ({db, auth, appCheck}), verifyIdToken: auth.verifyIdToken,
    verifyAppCheckToken: appCheck.verifyToken, checkRateLimit: async args => {calls.rate.push(args.uid); return true;}};
  const invoke = async (body = entry.body(), overrides = {}, headers = {}) => {
    const res = response(); const error = console.error; console.error = () => {};
    try {await entry.handler({method: 'POST', headers: {authorization: 'Bearer synthetic-id-token', 'x-firebase-appcheck': 'synthetic-app-check', ...headers}, body}, res, {...runtime, ...overrides});}
    finally {console.error = error;}
    return res;
  };
  return {db, invoke, calls, uid};
}
function blocked(res, entry) {
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'ACCOUNT_DELETION_BLOCKED');
  assert.equal(res.body.error, 'Conta indisponível para sincronização.');
  assert.notEqual(res.body.success, true, 'blocked Sync never ACKs');
  assert.equal(Object.hasOwn(res.body, 'operation'), false);
  if (entry.type !== 'sync') assert.equal(res.body.retryable, true);
  // Sync intentionally preserves its existing JSON; HTTP 503 is the Flutter
  // retry contract, so its queue is not marked acknowledged/rejected.
  assert.equal(JSON.stringify(res.body).includes('synthetic-private'), false);
}
function guard(state = 'IN_PROGRESS', expired = false) {return {version: 1, state, deletionId: ID,
  startedAt: Timestamp.fromMillis(1), retainUntil: state === 'COMPLETE' ? Timestamp.fromMillis(expired ? 2 : now().toMillis() + 60_000) : null};}
function receipt(uid, state) {
  const data = {version: 1, projectId: 'demo-life-os-p1', databaseId: '(default)', uid, deletionId: ID, state,
    origin: state === 'REVIEW_REQUIRED' ? 'LEGACY_REVIEW' : 'PRE_AUTH', sourceEventId: null,
    scope: state === 'REVIEW_REQUIRED' ? null : {policyVersion: 'ACCOUNT_DELETE_SCOPE_V1', privateRoot: root(uid),
      guardStartedAt: Timestamp.fromMillis(1), billingAccountHash: require('node:crypto').createHash('sha256').update(uid).digest('hex'), birthDecisionId: null, birthDigest: null},
    completedAt: state === 'COMPLETE' ? now() : null};
  control.validateControl(data, {projectId: 'demo-life-os-p1', databaseId: '(default)', uid});
  return data;
}
const conditions = [
  ['PRE_AUTH reservation', (db, uid) => db.put(refs(uid).retired, {version: 2, state: 'RESERVED', deletionId: ID, origin: 'PRE_AUTH'})],
  ['guard IN_PROGRESS', (db, uid) => db.put(refs(uid).guard, guard())],
  ['guard COMPLETE', (db, uid) => db.put(refs(uid).guard, guard('COMPLETE'))],
  ['receipt IN_PROGRESS without parent', (db, uid) => db.put(refs(uid).receipt, receipt(uid, 'IN_PROGRESS'))],
  ['receipt COMPLETE without parent', (db, uid) => db.put(refs(uid).receipt, receipt(uid, 'COMPLETE'))],
  ['receipt REVIEW_REQUIRED', (db, uid) => db.put(refs(uid).receipt, receipt(uid, 'REVIEW_REQUIRED'))],
  ['expired COMPLETE guard', (db, uid) => db.put(refs(uid).guard, guard('COMPLETE', true))],
  ...['guard', 'retired', 'receipt'].map(kind => ['malformed ' + kind, (db, uid) => db.put(refs(uid)[kind], {version: 999, private: 'synthetic-private-control'})]),
];
for (const entry of entries) {
  test(`R6C1 ${entry.name}: active UID uses all three reads in the mutation transaction`, async t => {
    const f = fixture(t, entry); const response = await f.invoke();
    assert.equal(response.statusCode, 200);
    assert.equal(f.db.directWrites, 0);
    const writes = f.db.commits.filter(r => r.pending.length);
    assert.ok(writes.length > 0);
    for (const tx of writes) for (const ref of Object.values(refs(UID))) assert.ok(tx.reads.has(ref), ref);
    assert.equal([...f.db.docs.keys()].some(p => Object.values(refs(UID)).includes(p)), false, 'writer never creates a deletion control');
    assert.deepEqual(f.calls.rate, [UID]); assert.equal(f.calls.auth.length, 1); assert.equal(f.calls.appCheck.length, 1);
    t.diagnostic(JSON.stringify({r6c1Evidence: 'active-transaction', entry: entry.name,
      readSets: writes.map(row => [...row.reads.keys()]), writes: writes.map(row => row.pending.map(w => w.path)), directWrites: f.db.directWrites}));
  });
  for (const [label, install] of conditions) test(`R6C1 ${entry.name}: ${label} blocks without writes or ACK`, async t => {
    const f = fixture(t, entry); install(f.db, UID); const before = new Map(f.db.docs);
    blocked(await f.invoke(), entry); assert.deepEqual(f.db.docs, before); assert.equal(f.db.directWrites, 0);
    assert.equal(f.db.commits.some(r => r.pending.length), false);
  });
  for (const kind of ['guard', 'retired', 'receipt']) test(`R6C1 ${entry.name}: unavailable ${kind} is not absence`, async t => {
    const f = fixture(t, entry); f.db.failRead = refs(UID)[kind]; const before = new Map(f.db.docs);
    blocked(await f.invoke(), entry); assert.deepEqual(f.db.docs, before); assert.equal(f.db.commits.length, 0);
  });
  test(`R6C1 ${entry.name}: ambiguous snapshot fails closed`, async t => {
    const f = fixture(t, entry); f.db.malformedRead = refs(UID).receipt;
    blocked(await f.invoke(), entry); assert.equal(f.db.commits.length, 0);
  });
  test(`R6C1 ${entry.name}: other UID controls do not transfer or block this request`, async t => {
    const f = fixture(t, entry); for (const [, install] of conditions.slice(0, 3)) install(f.db, OTHER);
    const before = new Map([...f.db.docs].filter(([p]) => p.includes(OTHER)));
    assert.equal((await f.invoke()).statusCode, 200);
    for (const [p, data] of before) assert.deepEqual(f.db.docs.get(p), data);
    assert.equal(f.db.commits.some(tx => tx.pending.some(w => w.path.includes(OTHER))), false);
  });
  test(`R6C1 ${entry.name}: authenticated other UID stays independent of retired UID`, async t => {
    const f = fixture(t, entry, OTHER); conditions[0][1](f.db, UID);
    const before = new Map([...f.db.docs].filter(([p]) => p.includes(UID)));
    assert.equal((await f.invoke()).statusCode, 200);
    for (const [p, data] of before) assert.deepEqual(f.db.docs.get(p), data);
    assert.equal(f.db.commits.some(tx => tx.pending.some(w => w.path.includes(UID))), false);
  });
  test(`R6C1 ${entry.name}: missing parent and private root cannot release durable receipt`, async t => {
    const f = fixture(t, entry); f.db.put(root(UID), undefined); f.db.put(refs(UID).receipt, receipt(UID, 'COMPLETE'));
    const before = new Map(f.db.docs); blocked(await f.invoke(), entry); assert.deepEqual(f.db.docs, before);
  });
  test(`R6C1 ${entry.name}: App Check and Auth still precede any account mutation`, async t => {
    const f = fixture(t, entry); const original = new Map(f.db.docs);
    assert.equal((await f.invoke(undefined, {verifyAppCheckToken: async () => {throw new Error('synthetic invalid');}})).statusCode, 401);
    const failingAuth = {verifyIdToken: async () => {throw new Error('synthetic revoked');}};
    assert.equal((await f.invoke(undefined, {verifyIdToken: failingAuth.verifyIdToken,
      getServices: () => ({db: f.db, auth: failingAuth, appCheck: {verifyToken: async () => ({})}})})).statusCode, 401);
    assert.deepEqual(f.db.docs, original); assert.equal(f.db.attempts.length, 0);
  });
  test(`R6C1 ${entry.name}: body UID cannot choose the writer identity`, async t => {
    const f = fixture(t, entry); const before = new Map(f.db.docs);
    const result = await f.invoke({...entry.body(), uid: OTHER});
    assert.ok([200, 400].includes(result.statusCode));
    // Preserve each endpoint's existing payload policy: either reject the
    // extra field, or ignore it and operate exclusively for the verified UID.
    for (const [p, data] of before) if (p.includes(OTHER)) assert.deepEqual(f.db.docs.get(p), data);
    assert.equal(f.db.commits.some(tx => tx.pending.some(w => w.path.includes(OTHER))), false);
    if (result.statusCode === 400) assert.deepEqual(f.db.docs, before);
    else for (const row of f.db.commits) for (const path of Object.values(refs(UID))) assert.ok(row.reads.has(path));
  });
  test(`R6C1 ${entry.name}: verified UID stays bound across the rate-limit await`, async t => {
    const f = fixture(t, entry), decoded = {uid: UID};
    const before = new Map([...f.db.docs].filter(([p]) => p.includes(OTHER)));
    const auth = {verifyIdToken: async (_, revoked) => {assert.equal(revoked, true); return decoded;}};
    const res = await f.invoke(undefined, {verifyIdToken: auth.verifyIdToken,
      getServices: () => ({db: f.db, auth, appCheck: {verifyToken: async () => ({})}}),
      checkRateLimit: async args => {assert.equal(args.uid, UID); decoded.uid = OTHER; return true;}});
    assert.equal(res.statusCode, 200);
    for (const [p, data] of before) assert.deepEqual(f.db.docs.get(p), data);
    for (const tx of f.db.commits.filter(row => row.pending.length)) {
      for (const path of Object.values(refs(UID))) assert.ok(tx.reads.has(path));
      assert.equal(tx.pending.some(w => w.path.includes(OTHER)), false);
    }
  });
}

async function retire(db, uid = UID) {
  const binding = {projectId: db.projectId, databaseId: db.databaseId, uid};
  const controller = control.createController({db, binding, clock: now, uuid: () => ID,
    ports: {getAuthenticatedSubject: async () => binding, getAuthUser: async () => ({uid})}});
  const admission = await controller.admitBackend(); assert.equal(admission.status, 'ADMITTED');
  return {controller, admission};
}
for (const entry of entries) {
  test(`R6C1 ${entry.name}: real R5 reservation wins before writer commit and retry refuses`, async t => {
    const f = fixture(t, entry), hold = gate(); t.after(hold.release); let paused = false;
    f.db.hooks.beforeCommit = async row => {
      if (!paused && row.label === 'writer' && row.pending.length) {paused = true; await hold.hold();}
    };
    const execution = context.run('writer', () => f.invoke());
    await Promise.race([hold.reached, execution.then(() => assert.fail('writer did not reach pending commit'))]);
    assert.equal(f.db.commits.some(row => row.label === 'writer'), false);
    await context.run('retirement', () => retire(f.db));
    const retired = new Map(f.db.docs); hold.release(); blocked(await execution, entry);
    assert.deepEqual(f.db.docs, retired); assert.equal(f.db.commits.some(row => row.label === 'writer'), false);
    assert.ok(f.db.conflicts.some(row => row.label === 'writer' && Object.values(refs(UID)).every(p => row.reads.has(p))));
    const attempts = f.db.attempts.filter(row => row.label === 'writer');
    assert.equal(attempts.length, 2); assert.ok(attempts[0].pending.length > 0); assert.equal(attempts[1].pending.length, 0);
    assert.equal(f.db.directWrites, 0);
    t.diagnostic(JSON.stringify({r6c1Evidence: 'retirement-wins', entry: entry.name, paused,
      writerAttempts: attempts.map(row => ({attempt: row.attempt, reads: [...row.reads.keys()], pendingWrites: row.pending.length, applied: row.applied})),
      conflicts: f.db.conflicts.map(row => row.changed), retirementCommits: f.db.commits.filter(row => row.label === 'retirement').map(row => row.pending.map(w => w.path)),
      writerCommits: f.db.commits.filter(row => row.label === 'writer').length}));
  });
  test(`R6C1 ${entry.name}: writer serialized before retirement succeeds once then stops`, async t => {
    const f = fixture(t, entry); assert.equal((await f.invoke()).statusCode, 200);
    await retire(f.db); const before = new Map(f.db.docs), commits = f.db.commits.length;
    blocked(await f.invoke(), entry); assert.deepEqual(f.db.docs, before); assert.equal(f.db.commits.length, commits);
  });
  test(`R6C1 ${entry.name}: unrelated conflict rereads controls without duplicate events or progress`, async t => {
    const f = fixture(t, entry); let conflicted = false;
    const target = entry.type === 'sync' ? root(UID) : root(UID) + (entry.name === 'Focus start' || entry.type === 'activity' ? '/tasks/task-1' : '/verified_focus_sessions/session-1');
    f.db.hooks.beforeCommit = row => {
      if (!conflicted && row.pending.length) {assert.ok(row.reads.has(target)); conflicted = true; f.db.put(target, {...f.db.docs.get(target), syntheticRace: true});}
    };
    assert.equal((await f.invoke()).statusCode, 200); assert.equal(conflicted, true); assert.equal(f.db.conflicts.length, 1);
    assert.equal(f.db.attempts.length, 2);
    for (const attempt of f.db.attempts) for (const path of Object.values(refs(UID))) assert.ok(attempt.reads.has(path));
    const events = [...f.db.docs].filter(([p]) => p.startsWith(`circles/r6c1-circle-${UID}/challenges/`) && p.includes('/processed_events/'));
    if (entry.type === 'activity' || entry.name === 'Focus finish') {
      assert.equal(events.length, 1); const progress = [...f.db.docs].filter(([p]) => p.startsWith(`circles/r6c1-circle-${UID}/challenges/`) && p.endsWith('/progress/' + UID));
      assert.equal(progress.length, 1); assert.equal(progress[0][1].value, 1);
    }
    if (entry.name === 'Focus start') assert.equal([...f.db.docs.keys()].filter(p => p.startsWith(root(UID) + '/verified_focus_sessions/')).length, 1);
    if (entry.type === 'sync') assert.equal(f.db.docs.get(root(UID)).tasksCount, 1);
    assert.equal(f.db.commits.filter(row => row.pending.length).length, 1);
    t.diagnostic(JSON.stringify({r6c1Evidence: 'conflict-no-duplicate', entry: entry.name, conflicts: f.db.conflicts.length,
      attempts: f.db.attempts.length, committedMutations: f.db.commits.filter(row => row.pending.length).length,
      processedEvents: events.length, progress: [...f.db.docs].filter(([p]) => p.startsWith(`circles/r6c1-circle-${UID}/challenges/`) && p.endsWith('/progress/' + UID)).map(([, data]) => data.value)}));
  });
}

const entityConfigs = [
  ['task', 'tasks', 'tasksCount', 'taskId', {title: 'Task', priority: 'high', date: new Date().toISOString()}],
  ['habit', 'habits', 'habitsCount', 'habitId', {title: 'Habit', completedDates: []}],
  ['transaction', 'transactions', 'transactionsCount', 'transactionId', {title: 'Transaction', amount: 10, type: 'expense', category: 'Other', date: new Date().toISOString()}],
  ['medication', 'medications', 'medicationsCount', 'medicationId', {name: 'Medication', startDate: new Date().toISOString(), durationDays: null, endDate: null}],
  ['subject', 'subjects', 'subjectsCount', 'subjectId', {title: 'Subject', hasExam: false, examDate: null}],
  ['goal', 'goals', 'goalsCount', 'goalId', {title: 'Goal', period: 'MENSAL', targetValue: 5, createdAt: new Date().toISOString()}],
];
const syncEntries = [];
for (const [entity, collection, counter, idField, data] of entityConfigs) for (const action of ['create', 'delete']) syncEntries.push({
  name: `Sync ${action}_${entity}`, type: 'sync', handler: syncHandler,
  setup: (db, uid) => {if (action === 'delete') {db.put(root(uid), {...db.docs.get(root(uid)), [counter]: 1}); db.put(`${root(uid)}/${collection}/entity-new`, data);}},
  body: () => ({operation: `${action}_${entity}`, [idField]: 'entity-new', ...(action === 'create' ? data : {})}),
});
const occurredAt = new Date(Date.now() - 1000).toISOString();
for (const body of [
  {operation: 'update_task', taskId: 'task-1', isCompleted: true},
  {operation: 'update_habit', habitId: 'habit-1', completedDates: []},
  {operation: 'update_habit_completion', habitId: 'habit-1', completedDates: [new Date().toISOString().slice(0, 10)], competitiveCompletionId: mutationId},
  {operation: 'apply_study_activity', mutationId, subjectId: null, progressDelta: 0.1, occurredAt, timeZoneOffsetMinutes: 0},
  {operation: 'apply_study_progress_reset', mutationId, occurredAt},
  {operation: 'apply_study_review', cardId: 'card-1', subjectId: 'subject-1', occurredAt, timeZoneOffsetMinutes: 0},
]) syncEntries.push({name: 'Sync ' + body.operation, type: 'sync', handler: syncHandler, body: () => body});
for (const entry of syncEntries) {
  test(`R6C1 reachable ${entry.name}: active path performs only fenced writes`, async t => {
    const f = fixture(t, entry); const res = await f.invoke(); assert.equal(res.statusCode, 200);
    const commits = f.db.commits.filter(row => row.pending.length); assert.ok(commits.length > 0);
    for (const row of commits) for (const path of Object.values(refs(UID))) assert.ok(row.reads.has(path));
    assert.equal(f.db.directWrites, 0);
  });
  test(`R6C1 reachable ${entry.name}: parentless receipt forbids success or ACK`, async t => {
    const f = fixture(t, entry); f.db.put(refs(UID).receipt, receipt(UID, 'COMPLETE')); const before = new Map(f.db.docs);
    blocked(await f.invoke(), entry); assert.deepEqual(f.db.docs, before); assert.equal(f.db.commits.length, 0);
  });
}
test('R6C1 legacy Sync stays disabled and never uses direct document writes', async t => {
  const f = fixture(t, entries[0]);
  for (const body of [{}, {tasks: []}, {habits: [], finances: []}, {operation: 'unknown'}]) {
    const res = await f.invoke(body); assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'SYNC_OPERATION_REQUIRED');
  }
  assert.equal(f.db.directWrites, 0); assert.equal(f.db.attempts.length, 0);
});
test('R6C1 retired habit endpoint remains 410 without mutation', async t => {
  const entry = {type: 'activity', handler: habitComplete, body: () => ({habitId: 'habit-1'})};
  const f = fixture(t, entry); f.db.put(refs(UID).retired, {version: 999});
  const res = await f.invoke(); assert.equal(res.statusCode, 410); assert.equal(res.body.code, 'HABIT_ACTIVITY_ENDPOINT_RETIRED');
  assert.equal(f.db.attempts.length, 0); assert.equal(f.db.directWrites, 0);
});
test('R6C1 normal writer facade has no cleanup capability or destructive method', async t => {
  const db = new MemoryDb(), fenced = control.withNormalWriterTransactions(db, UID);
  assert.deepEqual(Object.keys(fenced).sort(), ['collection', 'runTransaction']);
  for (const name of ['recursiveDelete', 'batch', 'admitBackend', 'authorizeCleanup', 'finalize', 'handle']) assert.equal(fenced[name], undefined);
  const {controller} = await retire(db);
  await assert.rejects(controller.authorizeCleanup(fenced), {code: 'INVALID_CAPABILITY'});
  assert.equal(db.commits.some(row => row.pending.some(w => w.type === 'delete')), false);
  t.diagnostic(JSON.stringify({r6c1Evidence: 'network-adc', ...network}));
});
test.after(() => {assert.deepEqual(network, {connections: 0, adc: 0});});

// R6C2A: real HTTP Circle endpoints. Create/join/challenge creation are Client
// SDK + Rules paths outside this backend allowlist; no fictitious route here.
const C2 = {circle: 'r6c2a-circle', admin: 'r6c2a-admin', member: 'r6c2a-member', other: 'r6c2a-other'};
const circlePath = 'circles/' + C2.circle;
const circleMarker = 'circle_deletions/' + C2.circle;
const circleClosure = 'circle_cleanup_guards/' + C2.circle;
function circleFixture(t, operation = 'delete', members = [C2.admin, C2.member, C2.other]) {
  const db = new MemoryDb(), uid = operation === 'leave' ? C2.member : C2.admin;
  db.put(circlePath, {schemaVersion: 2, adminId: C2.admin, memberCount: members.length, memberLimit: 30,
    challengeCount: 2, lastChallengeId: 'TASK_COMPLETIONS', name: 'Synthetic', description: 'Offline', createdAt: now(), updatedAt: now()});
  for (const member of members) {
    db.put(root(member), {activeCircleId: C2.circle, tasksCount: 0});
    db.put(circlePath + '/members/' + member, {role: member === C2.admin ? 'admin' : 'member',
      displayNameSnapshot: 'Synthetic', photoUrlSnapshot: null, joinedAt: now()});
  }
  for (const type of ['TASK_COMPLETIONS', 'FOCUS_MINUTES']) {
    const challenge = circlePath + '/challenges/' + type;
    db.put(challenge, {schemaVersion: 2, type, startAt: Timestamp.fromMillis(1), endAt: Timestamp.fromMillis(now().toMillis() + 10_000)});
    for (const member of members) db.put(challenge + '/progress/' + member, {uid: member, value: 2});
    db.put(challenge + '/processed_events/event-1', {uid: C2.member});
  }
  db.put('circles/unrelated', {schemaVersion: 2, adminId: 'unrelated-admin', memberCount: 1});
  db.put('circles/unrelated/members/unrelated-admin', {role: 'admin'});
  const calls = {auth: [], appCheck: [], rate: []};
  const decoded = {uid};
  const auth = {verifyIdToken: async (token, revoked) => {calls.auth.push({token, revoked}); assert.equal(revoked, true); return decoded;}};
  const appCheck = {verifyToken: async token => {calls.appCheck.push(token); return {appId: 'synthetic'};}};
  const handler = operation === 'leave' ? circleLeaveHandler : circleDeleteHandler;
  async function invoke(body = {circleId: C2.circle}, override = {}) {
    const res = response();
    await handler({method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer synthetic', 'x-firebase-appcheck': 'synthetic'}, body}, res, {
      getServices: () => ({db, auth, appCheck}), checkRateLimit: async args => {calls.rate.push(args.uid); return true;}, ...override,
    });
    return res;
  }
  return {db, uid, calls, decoded, invoke};
}
function circleBlocked(result) {
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, {error: 'Conta indisponível para sincronização.', code: 'ACCOUNT_DELETION_BLOCKED', retryable: true});
  assert.notEqual(result.body.deleted, true); assert.notEqual(result.body.left, true);
}
function actorReadSets(f) {
  const paths = Object.values(refs(f.uid));
  for (const row of f.db.commits.filter(r => r.pending.length)) assert.deepEqual([...row.reads.keys()].slice(0, 3), paths);
  assert.equal(f.db.directWrites, 0);
}
function unrelatedIntact(f, before) {
  for (const [p, data] of before) if (p.startsWith('circles/unrelated')) assert.deepEqual(f.db.docs.get(p), data);
}
for (const operation of ['leave', 'delete']) {
  test(`R6C2A ${operation}: active actor commits legitimate shared changes with transactional controls`, async t => {
    const f = circleFixture(t, operation), before = new Map(f.db.docs);
    const res = await f.invoke(); assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, operation === 'leave' ? {left: true} : {deleted: true});
    actorReadSets(f); unrelatedIntact(f, before);
    if (operation === 'leave') {
      assert.equal(f.db.docs.get(circlePath).memberCount, 2);
      assert.equal(f.db.docs.has(circlePath + '/members/' + f.uid), false);
      assert.equal(f.db.docs.get(root(f.uid)).activeCircleId, null);
      for (const type of ['TASK_COMPLETIONS', 'FOCUS_MINUTES']) {
        assert.equal(f.db.docs.has(`${circlePath}/challenges/${type}/progress/${f.uid}`), false);
        assert.deepEqual(f.db.docs.get(`${circlePath}/challenges/${type}/progress/${C2.other}`), before.get(`${circlePath}/challenges/${type}/progress/${C2.other}`));
        assert.deepEqual(f.db.docs.get(`${circlePath}/challenges/${type}/processed_events/event-1`), before.get(`${circlePath}/challenges/${type}/processed_events/event-1`));
      }
    } else {
      assert.equal([...f.db.docs.keys()].some(p => p === circlePath || p.startsWith(circlePath + '/')), false);
      assert.equal(f.db.docs.has(circleMarker), false);
      assert.deepEqual(Object.keys(f.db.docs.get(circleClosure)).sort(), ['createdAt', 'state', 'version']);
      assert.equal(f.db.docs.get(circleClosure).state, 'SERVER_DELETING');
      for (const uid of [C2.admin, C2.member, C2.other]) assert.equal(f.db.docs.get(root(uid)).activeCircleId, null);
    }
    t.diagnostic(JSON.stringify({r6c2aEvidence: 'active', operation, commits: f.db.commits.map(r => ({reads: [...r.reads.keys()], writes: r.pending.map(w => w.path)})), directWrites: f.db.directWrites}));
  });
  for (const [label, install] of conditions) test(`R6C2A ${operation}: retired actor ${label} has no normal writes or ACK`, async t => {
    const f = circleFixture(t, operation); install(f.db, f.uid); const before = new Map(f.db.docs);
    circleBlocked(await f.invoke()); assert.deepEqual(f.db.docs, before); assert.equal(f.db.commits.length, 0); assert.equal(f.db.directWrites, 0);
  });
  for (const kind of ['guard', 'retired', 'receipt']) test(`R6C2A ${operation}: actor ${kind} unavailable fails closed`, async t => {
    const f = circleFixture(t, operation); f.db.failRead = refs(f.uid)[kind]; const before = new Map(f.db.docs);
    circleBlocked(await f.invoke()); assert.deepEqual(f.db.docs, before); assert.equal(f.db.commits.length, 0);
  });
  test(`R6C2A ${operation}: ambiguous actor snapshot fails closed`, async t => {
    const f = circleFixture(t, operation); f.db.malformedRead = refs(f.uid).receipt;
    circleBlocked(await f.invoke()); assert.equal(f.db.commits.length, 0);
  });
  test(`R6C2A ${operation}: authenticated UID stays captured across rate limit`, async t => {
    const f = circleFixture(t, operation), captured = f.uid;
    assert.equal((await f.invoke(undefined, {checkRateLimit: async args => {
      assert.equal(args.uid, captured); f.decoded.uid = 'forged-actor'; return true;
    }})).statusCode, 200);
    actorReadSets(f);
    assert.equal(f.db.attempts.some(r => [...r.reads.keys()].some(p => p.includes('forged-actor'))), false);
  });
  for (const body of [{circleId: C2.circle, uid: C2.admin}, {circleId: C2.circle, isAdmin: true}, {circleId: '../other'}, {circleId: 'unrelated', userId: C2.admin}]) {
    test(`R6C2A ${operation}: strict payload ${JSON.stringify(body)} cannot select authority`, async t => {
      const f = circleFixture(t, operation), before = new Map(f.db.docs);
      assert.equal((await f.invoke(body)).statusCode, 400); assert.deepEqual(f.db.docs, before); assert.equal(f.calls.auth.length, 0);
    });
  }
  for (const gate of ['Auth', 'App Check']) test(`R6C2A ${operation}: ${gate} rejection precedes every write`, async t => {
    const f = circleFixture(t, operation), before = new Map(f.db.docs);
    const denied = async () => {throw new Error('synthetic-private');};
    const override = gate === 'Auth' ? {getServices: () => ({db: f.db, auth: {verifyIdToken: denied}, appCheck: {verifyToken: async () => ({})}})} : {verifyAppCheckToken: denied};
    assert.equal((await f.invoke(undefined, override)).statusCode, 401); assert.deepEqual(f.db.docs, before); assert.equal(f.db.commits.length, 0);
  });
  test(`R6C2A ${operation}: real R5 actor retirement wins before first commit`, async t => {
    const f = circleFixture(t, operation), held = gate(); t.after(held.release); let reached = false;
    f.db.hooks.beforeCommit = async row => {
      if (row.label === 'circle-writer' && row.pending.length && !reached) {reached = true; await held.hold();}
    };
    const execution = context.run('circle-writer', () => f.invoke());
    await Promise.race([held.reached, execution.then(() => assert.fail('Circle writer never reached its pending commit'))]);
    await context.run('retirement', () => retire(f.db, f.uid));
    const barrier = new Map(f.db.docs); held.release(); circleBlocked(await execution);
    assert.deepEqual(f.db.docs, barrier); assert.equal(reached, true);
    const attempts = f.db.attempts.filter(r => r.label === 'circle-writer');
    assert.equal(attempts.length, 2); assert.ok(attempts[0].pending.length > 0); assert.equal(attempts[1].pending.length, 0);
    assert.equal(f.db.commits.some(r => r.label === 'circle-writer'), false);
    assert.ok(f.db.conflicts.some(r => r.label === 'circle-writer' && Object.values(refs(f.uid)).every(p => r.changed.includes(p))));
    t.diagnostic(JSON.stringify({r6c2aEvidence: 'actor-retirement-wins', operation, reached,
      attempts: attempts.map(r => ({reads: [...r.reads.keys()], writes: r.pending.map(w => w.path), applied: r.applied})), writerCommits: 0}));
  });
  test(`R6C2A ${operation}: writer before retirement stays valid and repeat denies`, async t => {
    const f = circleFixture(t, operation);
    assert.equal((await f.invoke()).statusCode, 200); await retire(f.db, f.uid);
    const barrier = new Map(f.db.docs), commits = f.db.commits.length;
    circleBlocked(await f.invoke()); assert.deepEqual(f.db.docs, barrier); assert.equal(f.db.commits.length, commits);
  });
}

for (const [label, install] of conditions) for (const missing of [false, true]) {
  test(`R6C2A delete: target ${label}, missing profile=${missing}, skips only retired private update`, async t => {
    const f = circleFixture(t); install(f.db, C2.member);
    if (missing) f.db.put(root(C2.member), undefined);
    const profile = f.db.docs.get(root(C2.member)), controls = new Map(Object.values(refs(C2.member)).map(p => [p, f.db.docs.get(p)]));
    const result = await f.invoke(); assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {deleted: true, retiredMemberReferencesSkipped: 1});
    assert.deepEqual(f.db.docs.get(root(C2.member)), profile);
    for (const [p, value] of controls) assert.deepEqual(f.db.docs.get(p), value);
    assert.equal(f.db.commits.some(r => r.pending.some(w => w.path === root(C2.member))), false);
    assert.equal([...f.db.docs.keys()].some(p => p === circlePath || p.startsWith(circlePath + '/')), false);
    assert.equal(f.db.docs.get(root(C2.other)).activeCircleId, null); assert.equal(f.db.docs.has(circleMarker), false);
    actorReadSets(f);
  });
}
for (const kind of ['guard', 'retired', 'receipt', 'ambiguous']) {
  test(`R6C2A delete: target ${kind} unknown aborts profile updates and shared cleanup without ACK`, async t => {
    const f = circleFixture(t), before = new Map(f.db.docs);
    if (kind === 'ambiguous') f.db.malformedRead = refs(C2.member).receipt;
    else f.db.failRead = refs(C2.member)[kind];
    circleBlocked(await f.invoke());
    for (const uid of [C2.admin, C2.member, C2.other]) assert.deepEqual(f.db.docs.get(root(uid)), before.get(root(uid)));
    for (const [p, data] of before) if (p.startsWith(circlePath + '/')) assert.deepEqual(f.db.docs.get(p), data);
    assert.equal(f.db.docs.get(circlePath).deletionState, 'SERVER_DELETING'); assert.equal(f.db.docs.has(circleMarker), true);
    assert.equal(f.db.commits.some(r => r.pending.some(w => w.type === 'delete')), false);
    // Clearing an injected read error permits explicit retry of the same marker.
    const marker = f.db.docs.get(circleMarker); f.db.failRead = null; f.db.malformedRead = null;
    assert.equal((await f.invoke()).statusCode, 200); assert.equal(f.db.docs.has(circleMarker), false);
    assert.equal(marker.initiatedBy, C2.admin);
  });
}
test('R6C2A delete: missing active profile stays missing and profile pointing elsewhere is preserved', async t => {
  const f = circleFixture(t); f.db.put(root(C2.member), undefined); f.db.put(root(C2.other), {activeCircleId: 'unrelated'});
  const other = f.db.docs.get(root(C2.other));
  const res = await f.invoke(); assert.equal(res.statusCode, 200); assert.deepEqual(res.body, {deleted: true, missingMemberProfiles: 1});
  assert.equal(f.db.docs.has(root(C2.member)), false); assert.deepEqual(f.db.docs.get(root(C2.other)), other);
});
test('R6C2A leave: retirement of another member does not block legitimate leave or alter its private data', async t => {
  const f = circleFixture(t, 'leave'); await retire(f.db, C2.other); const before = new Map(f.db.docs);
  assert.equal((await f.invoke()).statusCode, 200); assert.equal(f.db.docs.get(circlePath).memberCount, 2);
  for (const [p, data] of before) if (p.includes(C2.other)) assert.deepEqual(f.db.docs.get(p), data);
  assert.equal(f.db.docs.has(circlePath + '/members/' + C2.other), true);
});
test('R6C2A delete: real target retirement before profile commit conflicts then skips without resurrection', async t => {
  const f = circleFixture(t), held = gate(); t.after(held.release); let reached = false;
  f.db.hooks.beforeCommit = async row => {
    if (!reached && row.pending.some(w => w.path === root(C2.member))) {reached = true; await held.hold();}
  };
  const execution = context.run('circle-writer', () => f.invoke());
  await Promise.race([held.reached, execution.then(() => assert.fail('profile update hook not reached'))]);
  await context.run('retirement', () => retire(f.db, C2.member));
  // Synthetic original account cleanup removes the target root while paused.
  f.db.put(root(C2.member), undefined); held.release();
  const result = await execution; assert.equal(result.statusCode, 200); assert.deepEqual(result.body, {deleted: true, retiredMemberReferencesSkipped: 1});
  assert.equal(reached, true); assert.equal(f.db.docs.has(root(C2.member)), false);
  assert.equal(f.db.commits.some(r => r.pending.some(w => w.path === root(C2.member))), false);
  assert.ok(f.db.conflicts.some(r => r.changed.includes(refs(C2.member).retired)));
  for (const path of Object.values(refs(C2.member))) assert.equal(f.db.docs.has(path), true);
  t.diagnostic(JSON.stringify({r6c2aEvidence: 'target-retirement-wins', reached, targetRootRecreated: false,
    conflicts: f.db.conflicts.map(r => r.changed), skipped: result.body.retiredMemberReferencesSkipped}));
});
for (const stage of ['profiles', 'descendant', 'marker']) {
  test(`R6C2A delete: actor retirement at ${stage} stage prevents every later writer commit`, async t => {
    const f = circleFixture(t), held = gate(); t.after(held.release); let reached = false;
    f.db.hooks.beforeCommit = async row => {
      const matches = stage === 'profiles' ? row.pending.some(w => w.path === root(C2.member)) : stage === 'marker' ?
        row.pending.some(w => w.type === 'delete' && w.path === circleMarker) :
        row.pending.some(w => w.type === 'delete' && w.path.startsWith(circlePath + '/'));
      if (!reached && matches) {reached = true; await held.hold();}
    };
    const execution = context.run('circle-writer', () => f.invoke());
    await Promise.race([held.reached, execution.then(() => assert.fail('stage hook not reached: ' + stage))]);
    await context.run('retirement', () => retire(f.db, C2.admin));
    const barrier = new Map(f.db.docs), commits = f.db.commits.length; held.release();
    circleBlocked(await execution); assert.equal(reached, true); assert.deepEqual(f.db.docs, barrier); assert.equal(f.db.commits.length, commits);
    assert.equal(f.db.docs.has(circleMarker), true); assert.equal(f.db.docs.has(circleClosure), true);
    t.diagnostic(JSON.stringify({r6c2aEvidence: 'actor-mid-delete', stage, reached, postBarrierCommits: f.db.commits.length - commits,
      rootPresent: f.db.docs.has(circlePath), markerPreserved: true, closurePreserved: true}));
  });
}
test('R6C2A delete: partial shared deletion rejects ACK and retry removes orphan descendants under the same marker', async t => {
  const f = circleFixture(t); let failed = false;
  f.db.hooks.beforeCommit = row => {
    if (!failed && row.pending.some(w => w.type === 'delete' && w.path.endsWith('/members/' + C2.other))) {failed = true; throw new Error('synthetic-private-partial');}
  };
  const res = await f.invoke(); assert.equal(res.statusCode, 500); assert.notEqual(res.body.deleted, true); assert.doesNotMatch(JSON.stringify(res), /synthetic-private/);
  const marker = f.db.docs.get(circleMarker), closure = f.db.docs.get(circleClosure);
  assert.equal(failed, true); assert.equal(marker.initiatedBy, C2.admin);
  // Missing Circle and Challenge parents must not hide surviving descendants.
  f.db.put(circlePath, undefined); f.db.put(circlePath + '/challenges/TASK_COMPLETIONS', undefined);
  f.db.put(circlePath + '/challenges/TASK_COMPLETIONS/progress/orphan', {uid: C2.member});
  assert.equal((await f.invoke()).statusCode, 200);
  assert.equal([...f.db.docs.keys()].some(p => p === circlePath || p.startsWith(circlePath + '/')), false);
  assert.equal(f.db.docs.has(circleMarker), false); assert.deepEqual(f.db.docs.get(circleClosure), closure);
});
test('R6C2A delete: a bounded partial invocation leaves closure and marker and returns retryable failure', async t => {
  const f = circleFixture(t);
  for (let i = 0; i < 410; i++) f.db.put(`${circlePath}/challenges/large/processed_events/${i}`, {uid: C2.member});
  const res = await f.invoke(); assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'CIRCLE_DELETE_RETRY_REQUIRED'); assert.notEqual(res.body.deleted, true);
  const marker = f.db.docs.get(circleMarker), closure = f.db.docs.get(circleClosure);
  assert.ok(marker && closure); assert.equal((await f.invoke()).statusCode, 200);
  assert.equal([...f.db.docs.keys()].some(p => p === circlePath || p.startsWith(circlePath + '/')), false);
  assert.equal(f.db.docs.has(circleMarker), false); assert.deepEqual(f.db.docs.get(circleClosure), closure);
});
test('R6C2A delete: thirty memberships keep active, retired and missing private profiles distinct', async t => {
  const members = [C2.admin, ...Array.from({length: 29}, (_, i) => 'r6c2a-premium-' + i)];
  const f = circleFixture(t, 'delete', members); await retire(f.db, members[1]); f.db.put(root(members[2]), undefined);
  const retiredProfile = f.db.docs.get(root(members[1]));
  const res = await f.invoke(); assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {deleted: true, retiredMemberReferencesSkipped: 1, missingMemberProfiles: 1});
  assert.deepEqual(f.db.docs.get(root(members[1])), retiredProfile); assert.equal(f.db.docs.has(root(members[2])), false);
  for (const uid of members.filter(uid => uid !== members[1] && uid !== members[2])) assert.equal(f.db.docs.get(root(uid)).activeCircleId, null);
});
for (const kind of ['owner', 'marker', 'closure']) {
  test(`R6C2A delete: concurrent ${kind} conflict never authorizes an unrelated destructive scope`, async t => {
    const f = circleFixture(t), held = gate(); t.after(held.release); let reached = false;
    f.db.hooks.beforeCommit = async row => {
      if (!reached && row.pending.some(w => w.type === 'delete')) {reached = true; await held.hold();}
    };
    const execution = f.invoke();
    await Promise.race([held.reached, execution.then(() => assert.fail('delete hook not reached'))]);
    if (kind === 'owner') f.db.put(circlePath, {...f.db.docs.get(circlePath), adminId: C2.other});
    else if (kind === 'marker') f.db.put(circleMarker, {...f.db.docs.get(circleMarker), initiatedBy: C2.other});
    else f.db.put(circleClosure, {version: 9});
    const barrier = new Map(f.db.docs); held.release();
    const res = await execution; assert.equal(res.statusCode, 409); assert.notEqual(res.body.deleted, true); assert.deepEqual(f.db.docs, barrier);
    assert.equal(f.db.docs.has(circleMarker), true); assert.equal(f.db.docs.has(circleClosure), true);
  });
}
test('R6C2A normal Circle endpoints cannot borrow account-cleaner authority', async t => {
  const f = circleFixture(t), admitted = await retire(f.db, C2.admin);
  const before = new Map(f.db.docs); circleBlocked(await f.invoke()); assert.deepEqual(f.db.docs, before);
  const normal = control.withNormalWriterTransactions(f.db, C2.admin);
  await assert.rejects(admitted.controller.authorizeCleanup(normal), {code: 'INVALID_CAPABILITY'});
  for (const key of ['recursiveDelete', 'admitBackend', 'finalize', 'handle']) assert.equal(normal[key], undefined);
});

test('R6C2A delete: ambiguous target profile is not an absent or safely skippable profile', async t => {
  const f = circleFixture(t); f.db.malformedRead = root(C2.member);
  const before = new Map(f.db.docs); circleBlocked(await f.invoke());
  for (const uid of [C2.admin, C2.member, C2.other]) assert.deepEqual(f.db.docs.get(root(uid)), before.get(root(uid)));
  assert.equal(f.db.commits.some(r => r.pending.some(w => w.type === 'delete')), false);
  assert.equal(f.db.docs.has(circleMarker), true);
});
test('R6C2A delete: profile read failure propagates as retryable denial without partial profile commit', async t => {
  const f = circleFixture(t); f.db.failRead = root(C2.member);
  const before = new Map(f.db.docs); circleBlocked(await f.invoke());
  for (const uid of [C2.admin, C2.member, C2.other]) assert.deepEqual(f.db.docs.get(root(uid)), before.get(root(uid)));
  assert.equal(f.db.commits.some(r => r.pending.some(w => w.type === 'delete')), false);
});
test('R6C2A delete: ambiguous descendant never becomes permission to delete', async t => {
  const f = circleFixture(t);
  const target = circlePath + '/challenges/FOCUS_MINUTES/processed_events/event-1';
  f.db.malformedRead = target;
  const original = f.db.docs.get(target); circleBlocked(await f.invoke());
  assert.deepEqual(f.db.docs.get(target), original);
  assert.equal(f.db.commits.some(r => r.pending.some(w => w.type === 'delete' && w.path === target)), false);
  assert.equal(f.db.docs.has(circleMarker), true);
});
test('R6C2A delete: valid unrelated Circle cannot be selected without ownership', async t => {
  const f = circleFixture(t);
  f.db.put('circles/unrelated', {schemaVersion: 2, adminId: 'unrelated-admin', memberCount: 1, memberLimit: 30});
  const before = new Map(f.db.docs); const res = await f.invoke({circleId: 'unrelated'});
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'CIRCLE_ADMIN_REQUIRED'); assert.deepEqual(f.db.docs, before);
});
test('R6C2A delete: a target switching activeCircleId before commit keeps its new link on retry', async t => {
  const f = circleFixture(t); let reached = false;
  f.db.hooks.beforeCommit = row => {
    if (!reached && row.pending.some(w => w.path === root(C2.member))) {
      reached = true; f.db.put(root(C2.member), {activeCircleId: 'new-circle', untouched: true});
    }
  };
  assert.equal((await f.invoke()).statusCode, 200); assert.equal(reached, true);
  assert.deepEqual(f.db.docs.get(root(C2.member)), {activeCircleId: 'new-circle', untouched: true});
  assert.ok(f.db.conflicts.some(r => r.changed.includes(root(C2.member))));
  assert.equal(f.db.commits.some(r => r.pending.some(w => w.path === root(C2.member))), false);
});
test('R6C2A leave: two actual HTTP requests conflict without duplicate memberCount changes', async t => {
  const f = circleFixture(t, 'leave'), before = new Map(f.db.docs);
  const results = await Promise.all([f.invoke(), f.invoke()]);
  assert.ok(results.every(r => r.statusCode === 200 && r.body.left === true));
  assert.equal(f.db.docs.get(circlePath).memberCount, 2); assert.ok(f.db.conflicts.length > 0);
  assert.equal(f.db.commits.filter(r => r.pending.some(w => w.path === circlePath)).length, 1);
  for (const uid of [C2.admin, C2.other]) {
    assert.deepEqual(f.db.docs.get(root(uid)), before.get(root(uid)));
    assert.deepEqual(f.db.docs.get(circlePath + '/members/' + uid), before.get(circlePath + '/members/' + uid));
  }
});
test('R6C2A delete: inventory permission failure preserves pending marker and never emits success', async t => {
  const f = circleFixture(t), doc = f.db.doc.bind(f.db);
  f.db.doc = path => {const ref = doc(path); if (path === circlePath) ref.listCollections = async () => {throw Object.assign(new Error('synthetic-private-inventory'), {code: 7});}; return ref;};
  const res = await f.invoke(); assert.equal(res.statusCode, 500); assert.notEqual(res.body.deleted, true);
  assert.doesNotMatch(JSON.stringify(res), /synthetic-private-inventory/);
  assert.equal(f.db.docs.has(circleMarker), true); assert.equal(f.db.docs.has(circleClosure), true);
  assert.equal(f.db.commits.some(r => r.pending.some(w => w.type === 'delete')), false);
});

test('R6C2A delete: confirmed retired target needs no private profile read to remove shared resources', async t => {
  const f = circleFixture(t); await context.run('retirement', () => retire(f.db, C2.member));
  const profile = f.db.docs.get(root(C2.member)); f.db.failRead = root(C2.member);
  const result = await f.invoke(); assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {deleted: true, retiredMemberReferencesSkipped: 1});
  assert.deepEqual(f.db.docs.get(root(C2.member)), profile);
  assert.equal(f.db.attempts.some(r => r.label !== 'retirement' && r.reads.has(root(C2.member))), false);
});

for (const [kind, challengeId, eventId] of [
  ['long verified task event', 'TASK_COMPLETIONS', 'TASK_COMPLETION__' + 't'.repeat(128)],
  ['missing long Challenge parent', 'c'.repeat(129), 'orphan-event'],
  ['stored whitespace ID', 'TASK_COMPLETIONS', ' stored event '],
]) test(`R6C2A delete: ${kind} remains in the authorized tree and leaves no residue`, async t => {
  const f = circleFixture(t), stored = `${circlePath}/challenges/${challengeId}/processed_events/${eventId}`;
  f.db.put(stored, {uid: C2.member});
  const res = await f.invoke(); assert.equal(res.statusCode, 200); assert.deepEqual(res.body, {deleted: true});
  assert.equal(f.db.docs.has(stored), false);
  assert.equal([...f.db.docs.keys()].some(p => p === circlePath || p.startsWith(circlePath + '/')), false);
  assert.equal(f.db.docs.has(circleMarker), false); assert.equal(f.db.docs.has(circleClosure), true);
});

// R6C2B uses the same MVCC store and real R5 controller as the earlier writers.
const { default: billingVerifyHandler } = await import('../api/billing/google/verify.js');
const { default: billingRtdnHandler } = await import('../api/billing/google/rtdn.js');
const { sha256: billingHash } = await import('../api/billing/google/_reconciliation.js');
const billingToken = uid => 'synthetic-private-purchase-' + uid;
const billingPaths = uid => ({ root: root(uid), billing: root(uid) + '/billing/google_play',
  token: root(uid) + '/billing/google_play/tokens/' + billingHash(billingToken(uid)),
  index: 'billing_google_tokens/' + billingHash(billingToken(uid)), account: 'billing_google_accounts/' + billingHash(uid) });
function billingState(db, uid) {
  const paths = billingPaths(uid);
  return new Map([...db.docs].filter(([p]) => p === paths.root || p.startsWith(paths.root + '/') || p === paths.index || p === paths.account));
}
async function billingFixture(t, mode) {
  const db = new MemoryDb(), at = now().toMillis(), calls = { google: [], ack: [], auth: [], appCheck: [] }, logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  for (const uid of [UID, OTHER]) db.put(root(uid), { displayName: 'Synthetic billing ' + uid });
  const f = { db, mode, at, calls, logs, pending: false, onGoogle: null, onAck: null };
  function runtime(uid) {
    return { getServices: () => ({ db }), nowProvider: () => at,
      verifyIdToken: async (_, revoked) => { assert.equal(revoked, true); calls.auth.push(uid); return { uid }; },
      verifyAppCheckToken: async () => { calls.appCheck.push(uid); return {}; }, checkRateLimit: async ({ uid: actor }) => { assert.equal(actor, uid); return true; },
      getGooglePlaySubscription: async token => {
        calls.google.push(token); if (f.onGoogle) await f.onGoogle(token);
        const owner = token === billingToken(OTHER) ? OTHER : UID;
        return { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
          acknowledgementState: owner === UID && f.pending ? 'ACKNOWLEDGEMENT_STATE_PENDING' : 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
          externalAccountIdentifiers: { obfuscatedExternalAccountId: billingHash(owner) },
          lineItems: [{ productId: 'life_os_premium', offerDetails: { basePlanId: 'monthly' }, expiryTime: new Date(at + 86_400_000).toISOString() }] };
      },
      acknowledgeGooglePlaySubscription: async token => { calls.ack.push(token); await f.onAck?.(token); },
      serverTimestamp: now, timestampFromDate: Timestamp.fromDate,
      audience: 'synthetic-audience', serviceAccountEmail: 'push@example.test', subscriptionName: 'synthetic-subscription',
      oidcClient: { verifyIdToken: async ({ audience }) => { assert.equal(audience, 'synthetic-audience'); return { getPayload: () => ({ aud: audience,
        email: 'push@example.test', email_verified: true, iss: 'https://accounts.google.com' }) }; } },
    };
  }
  f.invoke = async (entry = mode, uid = UID, extra = {}) => {
    const res = response();
    if (entry === 'verify') await billingVerifyHandler({ method: 'POST', headers: {
      authorization: 'Bearer synthetic-private-id-token', 'x-firebase-appcheck': 'synthetic-check' },
      body: { purchaseToken: billingToken(uid), ...extra } }, res, runtime(uid));
    else await billingRtdnHandler({ method: 'POST', headers: { authorization: 'Bearer synthetic-private-push-jwt' },
      body: { subscription: 'synthetic-subscription', message: { messageId: 'synthetic-message', data: Buffer.from(JSON.stringify({
        version: '1.0', packageName: 'com.rafalacerda.lifeos', subscriptionNotification: { version: '1.0', notificationType: 1,
          purchaseToken: billingToken(uid) }, ...extra })).toString('base64') } } }, res, runtime(uid));
    return res;
  };
  assert.equal((await f.invoke('verify', OTHER)).statusCode, 200);
  if (mode === 'rtdn') assert.equal((await f.invoke('verify')).statusCode, 200);
  f.otherBefore = billingState(db, OTHER);
  f.start = db.commits.length;
  return f;
}
function assertBillingIsolation(f) {
  assert.deepEqual(billingState(f.db, OTHER), f.otherBefore);
  assert.equal(f.db.directWrites, 0);
  for (const commit of f.db.commits.slice(f.start).filter(row => row.label === 'billing-writer')) {
    for (const w of commit.pending) {
      assert.equal(Object.values(billingPaths(OTHER)).includes(w.path), false);
      assert.equal(Object.values(refs(UID)).includes(w.path), false, 'normal writer cannot mutate R5 controls');
    }
  }
  const text = f.logs.join(' ');
  for (const secret of [billingToken(UID), billingToken(OTHER), UID, OTHER, 'synthetic-private-id-token',
    'synthetic-private-push-jwt', billingHash(UID), billingHash(billingToken(UID)), 'synthetic-private-read-failure']) {
    assert.equal(text.includes(secret), false, 'sanitized domain logs');
  }
}
function assertBillingBlocked(res, mode, terminal = false) {
  assert.equal(res.statusCode, mode === 'rtdn' && terminal ? 204 : 503);
  if (res.statusCode === 503) assert.equal(res.body.code, mode === 'rtdn' ? 'RTDN_RECONCILIATION_RETRY' : 'ACCOUNT_DELETION_BLOCKED');
  assert.equal(res.body?.isPremium, undefined); assert.equal(res.body?.deleted, undefined);
}
for (const mode of ['verify', 'rtdn']) {
  test(`R6C2B MVCC ${mode}: active actor has all controls in every mutation read set`, async t => {
    const f = await billingFixture(t, mode); f.pending = true;
    assert.equal((await context.run('billing-writer', () => f.invoke())).statusCode, mode === 'verify' ? 200 : 204);
    const writes = f.db.commits.slice(f.start).filter(row => row.pending.length);
    assert.ok(writes.length >= 3);
    for (const tx of writes) for (const p of Object.values(refs(UID))) assert.ok(tx.reads.has(p), p);
    assert.equal(f.db.docs.get(root(UID)).isPremium, true); assertBillingIsolation(f);
    t.diagnostic(JSON.stringify({ r6c2bEvidence: 'four-fences', mode,
      transactions: f.db.commits.slice(f.start).map(row => ({ reads: [...row.reads.keys()], writes: row.pending.map(w => w.path) })) }));
  });
  for (const [label, install] of [...conditions, ['AUTH_EVENT reservation', (db, uid) => db.put(refs(uid).retired,
    { version: 2, state: 'RESERVED', deletionId: ID, origin: 'AUTH_EVENT' })]]) {
    test(`R6C2B MVCC ${mode}: ${label} cannot write domain data`, async t => {
      const f = await billingFixture(t, mode); install(f.db, UID); const before = new Map(f.db.docs);
      const terminal = label.startsWith('receipt COMPLETE') || label.startsWith('receipt REVIEW_REQUIRED');
      assertBillingBlocked(await context.run('billing-writer', () => f.invoke()), mode, terminal);
      assert.deepEqual(f.db.docs, before); assert.equal(f.db.commits.slice(f.start).some(row => row.pending.length), false);
      assertBillingIsolation(f);
    });
  }
  for (const kind of ['guard', 'retired', 'receipt']) for (const failure of ['unavailable', 'ambiguous']) {
    test(`R6C2B MVCC ${mode}: ${failure} ${kind} is not terminal retirement`, async t => {
      const f = await billingFixture(t, mode), before = new Map(f.db.docs);
      f.db[failure === 'unavailable' ? 'failRead' : 'malformedRead'] = refs(UID)[kind];
      assertBillingBlocked(await f.invoke(), mode); assert.deepEqual(f.db.docs, before); assertBillingIsolation(f);
    });
  }
  test(`R6C2B MVCC ${mode}: real R5 retirement blocks with no new scope or receipt`, async t => {
    const f = await billingFixture(t, mode); await context.run('retirement', () => retire(f.db));
    const before = new Map(f.db.docs), googleCalls = f.calls.google.length;
    assertBillingBlocked(await f.invoke(), mode, true); assert.deepEqual(f.db.docs, before);
    assert.equal(f.calls.google.length, googleCalls); assertBillingIsolation(f);
  });
  for (const phase of ['reservation', 'commit', 'pre-ACK', 'post-ACK']) {
    test(`R6C2B MVCC ${mode}: R5 admission wins ${phase} commit and SDK-style retry refuses`, async t => {
      const f = await billingFixture(t, mode), hold = gate(), paths = billingPaths(UID); f.pending = true;
      t.after(hold.release); let reached = 0;
      const isPhase = row => phase === 'reservation' ? row.pending.length === 1 && row.pending[0].path === paths.billing
        : phase === 'commit' ? row.pending.some(w => w.path === paths.root)
          : phase === 'pre-ACK' ? row.pending.length === 0 && row.reads.has(paths.billing)
            : row.pending.length === 1 && row.pending[0].path === paths.token && row.pending[0].type === 'update';
      f.db.hooks.beforeCommit = async row => { if (row.label === 'billing-writer' && !reached && isPhase(row)) { reached++; await hold.hold(); } };
      const execution = context.run('billing-writer', () => f.invoke());
      await Promise.race([hold.reached, execution.then(() => assert.fail('selected fence was not reached'))]);
      await context.run('retirement', () => retire(f.db));
      const retired = new Map(f.db.docs), cut = f.db.commits.length; hold.release();
      assertBillingBlocked(await execution, mode, true); assert.equal(reached, 1);
      assert.deepEqual(f.db.docs, retired);
      assert.equal(f.db.commits.slice(cut).some(row => row.pending.length), false);
      assert.ok(f.db.conflicts.some(row => row.label === 'billing-writer' && Object.values(refs(UID)).every(p => row.reads.has(p))));
      assert.equal(f.calls.ack.filter(token => token === billingToken(UID)).length, phase === 'post-ACK' ? 1 : 0);
      assertBillingIsolation(f);
      t.diagnostic(JSON.stringify({ r6c2bEvidence: 'retirement-wins', mode, phase, reached,
        conflicts: f.db.conflicts.map(row => ({ changed: row.changed, reads: [...row.reads.keys()], attempted: row.pending.map(w => w.path) })),
        laterDomainCommits: f.db.commits.slice(cut).filter(row => row.pending.length).length,
        originalOperation: f.db.docs.get(refs(UID).receipt).state }));
    });
  }
  test(`R6C2B MVCC ${mode}: writer serializes first, then R5 retains original scope and denies replay`, async t => {
    const f = await billingFixture(t, mode);
    assert.equal((await f.invoke()).statusCode, mode === 'verify' ? 200 : 204);
    const commercial = billingState(f.db, UID), { controller, admission } = await retire(f.db);
    assert.equal(admission.status, 'ADMITTED'); assert.deepEqual(billingState(f.db, UID), commercial);
    const operation = f.db.docs.get(refs(UID).receipt), before = new Map(f.db.docs);
    assert.equal(operation.scope.privateRoot, root(UID)); assert.equal(operation.scope.billingAccountHash, billingHash(UID));
    assertBillingBlocked(await f.invoke(), mode, true); assert.deepEqual(f.db.docs, before);
    assert.equal((await controller.admitBackend()).status, 'RESUMED'); assert.deepEqual(f.db.docs.get(refs(UID).receipt), operation);
    assertBillingIsolation(f);
  });
  for (const phase of ['GET', 'before ACK', 'during ACK', 'failed ACK']) {
    test(`R6C2B MVCC ${mode}: real retirement ${phase} prevents later writes and new external effects`, async t => {
      const f = await billingFixture(t, mode), hold = gate(); f.pending = true; t.after(hold.release);
      let reached = 0;
      const retireNow = async () => { reached++; await context.run('retirement', () => retire(f.db)); f.barrierSnapshot = new Map(f.db.docs); };
      if (phase === 'GET') f.onGoogle = retireNow;
      if (phase === 'before ACK') f.db.hooks.afterCommit = async row => {
        if (row.label === 'billing-writer' && row.pending.some(w => w.path === root(UID))) await retireNow();
      };
      if (phase.includes('during') || phase === 'failed ACK') f.onAck = async () => {
        await hold.hold(); if (phase === 'failed ACK') throw Error('synthetic-private-ambiguous-ack');
      };
      const googleBefore = f.calls.google.length;
      const execution = context.run('billing-writer', () => f.invoke());
      if (phase.includes('during') || phase === 'failed ACK') {
        await Promise.race([hold.reached, execution.then(() => assert.fail('ACK did not start'))]);
        await retireNow(); hold.release();
      }
      assertBillingBlocked(await execution, mode, true); assert.equal(reached, 1);
      assert.equal(f.calls.google.length, googleBefore + 1, 'no new Google reread after retirement');
      const retirementIndex = f.db.commits.findIndex(row => row.label === 'retirement' &&
        row.pending.some(w => w.path === refs(UID).retired));
      assert.deepEqual(f.db.docs, f.barrierSnapshot);
      assert.deepEqual(new Set(f.db.commits[retirementIndex]?.pending.map(w => w.path)), new Set(Object.values(refs(UID))));
      assert.ok(retirementIndex >= 0); assert.equal(f.db.commits.slice(retirementIndex + 1).some(row => row.pending.length), false);
      assert.equal(f.db.docs.get(refs(UID).receipt).state, 'IN_PROGRESS');
      assert.equal(f.db.docs.get(refs(UID).guard).state, 'IN_PROGRESS'); assertBillingIsolation(f);
      t.diagnostic(JSON.stringify({ r6c2bEvidence: 'external-effect', mode, phase, reached,
        acknowledgementsForA: f.calls.ack.filter(token => token === billingToken(UID)).length,
        newGoogleReads: f.calls.google.length - googleBefore, laterWrites: 0 }));
    });
  }
}
test('R6C2B MVCC: RTDN payload UID cannot move a retired purchase to active B', async t => {
  const f = await billingFixture(t, 'rtdn'); await retire(f.db); const before = new Map(f.db.docs);
  assert.equal((await f.invoke('rtdn', UID, { uid: OTHER, email: 'irrelevant@example.test' })).statusCode, 204);
  assert.deepEqual(f.db.docs, before); assertBillingIsolation(f);
});
test('R6C2B MVCC: verify rejects client UID selection before domain mutation', async t => {
  const f = await billingFixture(t, 'verify'), before = new Map(f.db.docs);
  assert.equal((await f.invoke('verify', UID, { uid: OTHER })).statusCode, 400);
  assert.deepEqual(f.db.docs, before); assertBillingIsolation(f);
});

for (const mode of ['verify', 'rtdn']) {
  test(`R6C2B MVCC ${mode}: B remains operational while A retries after retirement`, async t => {
    const f = await billingFixture(t, mode); await retire(f.db);
    assertBillingBlocked(await f.invoke(), mode, true); assertBillingIsolation(f);
    const controls = new Map(Object.values(refs(UID)).map(p => [p, clone(f.db.docs.get(p))]));
    assert.equal((await f.invoke('verify', OTHER)).statusCode, 200);
    assert.equal(f.db.docs.get(root(OTHER)).isPremium, true);
    f.otherBefore = billingState(f.db, OTHER);
    assertBillingBlocked(await f.invoke(), mode, true); assertBillingIsolation(f);
    for (const [p, data] of controls) assert.deepEqual(f.db.docs.get(p), data);
  });
  for (const phase of ['before ACK', 'after ACK']) test(`R6C2B MVCC ${mode}: unavailable control ${phase} preserves error and pending ACK`, async t => {
    const f = await billingFixture(t, mode); f.pending = true; let failedState;
    const fail = () => { f.db.failRead = refs(UID).receipt; failedState = new Map(f.db.docs); };
    if (phase === 'before ACK') f.db.hooks.afterCommit = row => {
      if (row.label === 'billing-writer' && row.pending.some(w => w.path === root(UID))) fail();
    };
    else f.onAck = fail;
    assertBillingBlocked(await context.run('billing-writer', () => f.invoke()), mode);
    assert.deepEqual(f.db.docs, failedState); assertBillingIsolation(f);
    assert.equal(f.calls.ack.filter(token => token === billingToken(UID)).length, phase === 'after ACK' ? 1 : 0);
    assert.equal(f.db.docs.get(billingPaths(UID).token).acknowledgementState, 'ACKNOWLEDGEMENT_STATE_PENDING');
  });
}

// R6C4-A: same real route, original MVCC and real R5 controller used above.
const cardCreateEntry = {name:'Sync create_review_card',type:'sync',handler:syncHandler,
  body:()=>({operation:'create_review_card',version:1,cardId:'created-card',subjectId:'subject-1',
    question:'Synthetic question',answer:'Synthetic answer',createdAt:'2026-10-28T12:34:56.123456Z'})};
const cardReceipt = uid => root(uid) + '/study_card_create_receipts/created-card';
test('R6C4-A real entry: create and replay read all three R5 controls; exactly four writes once',async t=>{
  const f=fixture(t,cardCreateEntry);
  const first=await f.invoke();assert.equal(first.statusCode,200);assert.equal(first.body.outcome,'APPLIED');
  const second=await f.invoke();assert.equal(second.statusCode,200);assert.equal(second.body.outcome,'REPLAYED');
  assert.equal(f.db.commits.length,2);assert.equal(f.db.commits[0].pending.length,4);assert.equal(f.db.commits[1].pending.length,0);
  for(const tx of f.db.commits)for(const path of Object.values(refs(UID)))assert.ok(tx.reads.has(path),path);
  assert.equal(f.db.docs.get(root(UID)+'/study_info/main').reviewQueue,2);
  assert.equal(f.db.docs.get(root(UID)+'/subjects/subject-1').cardsToReview,2);
  assert.equal(f.db.directWrites,0);
  t.diagnostic(JSON.stringify({r6c4A:'create-replay-readsets',transactions:f.db.commits.map(tx=>({reads:[...tx.reads.keys()],writes:tx.pending.map(w=>w.path)}))}));
});
for(const replay of [false,true])for(const [label,install]of conditions)test('R6C4-A '+label+' denies '+(replay?'receipt replay':'creation')+' without account writes/ACK',async t=>{
  const f=fixture(t,cardCreateEntry);if(replay)assert.equal((await f.invoke()).statusCode,200);
  install(f.db,UID);const before=new Map(f.db.docs),commits=f.db.commits.length;
  blocked(await f.invoke(),cardCreateEntry);assert.deepEqual(f.db.docs,before);assert.equal(f.db.commits.length,commits);assert.equal(f.db.directWrites,0);
});
for(const replay of [false,true])for(const kind of ['guard','retired','receipt'])test('R6C4-A unreadable '+kind+' denies '+(replay?'replay':'create'),async t=>{
  const f=fixture(t,cardCreateEntry);if(replay)assert.equal((await f.invoke()).statusCode,200);
  f.db.failRead=refs(UID)[kind];const before=new Map(f.db.docs),count=f.db.commits.length;
  blocked(await f.invoke(),cardCreateEntry);assert.deepEqual(f.db.docs,before);assert.equal(f.db.commits.length,count);
});
test('R6C4-A real R5 reservation wins before four-write commit: retry refuses all effects',async t=>{
  const f=fixture(t,cardCreateEntry),hold=gate();t.after(hold.release);let paused=false;
  f.db.hooks.beforeCommit=async row=>{if(!paused&&row.label==='card-writer'&&row.pending.length){paused=true;assert.equal(row.pending.length,4);await hold.hold();}};
  const execution=context.run('card-writer',()=>f.invoke());
  await Promise.race([hold.reached,execution.then(()=>assert.fail('writer did not reach commit barrier'))]);
  const admitted=await context.run('card-retirement',()=>retire(f.db));assert.equal(admitted.admission.status,'ADMITTED');
  const before=new Map(f.db.docs);hold.release();blocked(await execution,cardCreateEntry);assert.deepEqual(f.db.docs,before);
  assert.equal(f.db.docs.has(cardReceipt(UID)),false);assert.equal(f.db.commits.some(tx=>tx.label==='card-writer'),false);
  const attempts=f.db.attempts.filter(tx=>tx.label==='card-writer');assert.equal(attempts.length,2);assert.equal(attempts[1].pending.length,0);
  for(const path of Object.values(refs(UID)))assert.ok(attempts[0].reads.has(path));
  assert.ok(attempts[1].reads.has(refs(UID).guard));
  t.diagnostic(JSON.stringify({r6c4A:'real-controller-retirement-first',conflicts:f.db.conflicts.map(r=>r.changed),attempts:attempts.map(r=>({reads:[...r.reads.keys()],writes:r.pending.map(w=>w.path),applied:r.applied}))}));
});
test('R6C4-A writer wins while real R5 admission is in flight; later replay cannot bypass retirement',async t=>{
  const f=fixture(t,cardCreateEntry),hold=gate();t.after(hold.release);let paused=false;
  f.db.hooks.beforeCommit=async row=>{if(!paused&&row.label==='card-retirement'&&row.pending.length){paused=true;await hold.hold();}};
  const retirement=context.run('card-retirement',()=>retire(f.db));
  await Promise.race([hold.reached,retirement.then(()=>assert.fail('controller did not reach barrier'))]);
  assert.equal((await context.run('card-writer',()=>f.invoke())).body.outcome,'APPLIED');
  const receiptBefore=clone(f.db.docs.get(cardReceipt(UID)));hold.release();await retirement;
  const before=new Map(f.db.docs);blocked(await f.invoke(),cardCreateEntry);assert.deepEqual(f.db.docs,before);
  assert.deepEqual(f.db.docs.get(cardReceipt(UID)),receiptBefore);assert.equal(f.db.commits.filter(tx=>tx.label==='card-writer'&&tx.pending.length).length,1);
  t.diagnostic(JSON.stringify({r6c4A:'real-controller-writer-first',commits:f.db.commits.map(tx=>({label:tx.label,writes:tx.pending.map(w=>w.path)}))}));
});
test('R6C4-A real R5 admission conflicts with read-only receipt replay before its ACK',async t=>{
  const f=fixture(t,cardCreateEntry);assert.equal((await f.invoke()).statusCode,200);
  const hold=gate();t.after(hold.release);let paused=false;
  f.db.hooks.beforeCommit=async row=>{if(!paused&&row.label==='card-replay'&&row.reads.has(cardReceipt(UID))){paused=true;assert.equal(row.pending.length,0);await hold.hold();}};
  const execution=context.run('card-replay',()=>f.invoke());await Promise.race([hold.reached,execution.then(()=>assert.fail('replay did not reach barrier'))]);
  await context.run('card-retirement',()=>retire(f.db));const before=new Map(f.db.docs);hold.release();blocked(await execution,cardCreateEntry);
  assert.deepEqual(f.db.docs,before);assert.equal(f.db.commits.some(tx=>tx.label==='card-replay'),false);
  const attempt=f.db.attempts.find(tx=>tx.label==='card-replay');for(const ref of Object.values(refs(UID)))assert.ok(attempt.reads.has(ref));
  t.diagnostic(JSON.stringify({r6c4A:'real-controller-replay-race',readSet:[...attempt.reads.keys()],conflicts:f.db.conflicts.map(tx=>tx.changed)}));
});
test('R6C4-A retirement of A cannot affect B or transfer the creation receipt',async t=>{
  const f=fixture(t,cardCreateEntry,OTHER);
  assert.equal((await f.invoke(undefined,{verifyIdToken:async()=>({uid:UID})})).statusCode,200);
  const a=clone(f.db.docs.get(cardReceipt(UID)));await retire(f.db,UID);const before=new Map([...f.db.docs].filter(([p])=>p.startsWith(root(UID))));
  const response=await f.invoke();assert.equal(response.statusCode,200);assert.equal(response.body.uid,OTHER);assert.notEqual(response.body.fingerprint,a.payloadFingerprint);
  for(const [path,data]of before)assert.deepEqual(f.db.docs.get(path),data);
  assert.equal(f.db.docs.get(cardReceipt(OTHER)).uid,OTHER);assert.equal(f.db.directWrites,0);
});
