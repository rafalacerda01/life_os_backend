import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import handler, { leaveCircle } from '../api/circles/leave.js';
import { readCircleProgressPlan, applyCircleProgressPlan } from '../api/focus/_circle_progress.js';
import { readActivityCircleProgressPlan, applyActivityCircleProgressPlan } from '../api/activity/_circle_progress.js';

const NOW = Timestamp.fromMillis(100000);
const rootPath = 'circles/circle';
const progressPath = (id, uid = 'member') => `${rootPath}/challenges/${id}/progress/${uid}`;

class Ref {
  constructor(db, path, limitValue) { Object.assign(this, { db, path, limitValue }); this.id = path.split('/').at(-1); }
  doc(id) { return new Ref(this.db, `${this.path}/${id}`); }
  collection(id) { return this.doc(id); }
  limit(limitValue) { return new Ref(this.db, this.path, limitValue); }
}
function snapshot(ref, store) {
  if (ref.path.split('/').length % 2 === 0) {
    const data = store.get(ref.path);
    return { ref, id: ref.id, exists: data !== undefined, data: () => data };
  }
  const docs = [...store.keys()].filter(path => path.startsWith(`${ref.path}/`) &&
    !path.slice(ref.path.length + 1).includes('/')).sort()
    .map(path => snapshot(new Ref(ref.db, path), store));
  return { docs: docs.slice(0, ref.limitValue ?? docs.length) };
}
class Db {
  constructor() { this.store = new Map(); this.commits = []; this.beforeCommit = null; this.retries = 0; this.getAllCalls = []; }
  collection(path) { return new Ref(this, path); }
  async runTransaction(callback) {
    for (;;) {
      const before = new Map(this.store);
      const writes = [];
      const tx = {
        get: async ref => { assert.equal(writes.length, 0, 'all reads precede writes'); return snapshot(ref, before); },
        getAll: async (...refs) => {
          assert.ok(refs.length > 0, 'getAll requires at least one reference');
          assert.equal(writes.length, 0, 'all reads precede writes');
          this.getAllCalls.push(refs.map(ref => ref.path));
          return refs.map(ref => snapshot(ref, before));
        },
        delete: ref => writes.push(['delete', ref]),
        update: (ref, data) => writes.push(['update', ref, data]),
        create: (ref, data) => writes.push(['create', ref, data]),
      };
      const result = await callback(tx);
      const hook = this.beforeCommit;
      this.beforeCommit = null;
      if (hook) await hook();
      if (!isDeepStrictEqual(before, this.store)) { this.retries++; continue; }
      const next = new Map(this.store);
      for (const [type, ref, data] of writes) {
        if (type === 'delete') next.delete(ref.path);
        else if (type === 'update') {
          assert.ok(next.has(ref.path)); next.set(ref.path, { ...next.get(ref.path), ...data });
        } else { assert.ok(!next.has(ref.path)); next.set(ref.path, data); }
      }
      this.store = next;
      this.commits.push(writes);
      return result;
    }
  }
}
function seed(count = 2) {
  const db = new Db();
  db.store.set(rootPath, { schemaVersion: 2, adminId: 'admin', memberCount: 2, memberLimit: 30,
    challengeCount: count, lastChallengeId: count ? 'c-0' : null,
    name: 'Circle', description: 'Circle fixture', createdAt: Timestamp.fromMillis(0), updatedAt: NOW });
  for (const uid of ['admin', 'member']) {
    db.store.set(`users/${uid}`, { activeCircleId: 'circle' });
    db.store.set(`${rootPath}/members/${uid}`, { role: uid === 'admin' ? 'admin' : 'member',
      displayNameSnapshot: 'Member', photoUrlSnapshot: null, joinedAt: Timestamp.fromMillis(0) });
  }
  for (let i = 0; i < count; i++) {
    db.store.set(`${rootPath}/challenges/c-${i}`, { schemaVersion: 2,
      type: i ? 'TASK_COMPLETIONS' : 'FOCUS_MINUTES', startAt: Timestamp.fromMillis(0), endAt: NOW });
    for (const uid of ['member', 'admin']) db.store.set(progressPath(`c-${i}`, uid), { uid, value: 2 });
    db.store.set(`${rootPath}/challenges/c-${i}/processed_events/old`, { uid: 'member' });
  }
  return db;
}
const execute = (db, uid = 'member') => leaveCircle({ db, uid, body: { circleId: 'circle' }, now: NOW });

test('member leaves atomically: all progress removed, other members and events preserved', async () => {
  const db = seed(240);
  const before = new Map(db.store);
  assert.deepEqual(await execute(db), { body: { left: true } });
  assert.equal(db.store.has(`${rootPath}/members/member`), false);
  assert.equal(db.store.get(rootPath).memberCount, 1);
  assert.equal(db.store.get(rootPath).updatedAt, NOW);
  assert.equal(db.store.get('users/member').activeCircleId, null);
  assert.equal(db.commits.length, 1);
  assert.equal(db.commits[0].length, 243);
  assert.equal(db.getAllCalls.length, 1);
  assert.deepEqual(new Set(db.getAllCalls[0]), new Set(Array.from({ length: 240 }, (_, i) => progressPath(`c-${i}`))));
  for (let i = 0; i < 240; i++) {
    assert.equal(db.store.has(progressPath(`c-${i}`)), false);
    for (const path of [progressPath(`c-${i}`, 'admin'), `${rootPath}/challenges/c-${i}/processed_events/old`]) {
      assert.deepEqual(db.store.get(path), before.get(path));
    }
  }
});
test('leave with zero Challenges skips getAll and completes normally', async () => {
  const db = seed(0);
  assert.deepEqual(await execute(db), { body: { left: true } });
  assert.deepEqual(db.getAllCalls, []);
  assert.equal(db.store.has(`${rootPath}/members/member`), false);
  assert.equal(db.store.get(rootPath).memberCount, 1);
  assert.equal(db.store.get('users/member').activeCircleId, null);
  assert.equal(db.commits.length, 1);
  assert.equal(db.commits[0].length, 3);
});
test('retry after a lost response succeeds without a second decrement', async () => {
  const db = seed();
  await execute(db);
  const before = new Map(db.store);
  assert.deepEqual(await execute(db), { body: { left: true } });
  assert.deepEqual(db.store, before);
  assert.ok(db.commits[1].every(([type]) => type === 'delete'));
});
test('already-left state clears orphan progress without changing count', async () => {
  const db = seed();
  db.store.delete(`${rootPath}/members/member`);
  db.store.set('users/member', { activeCircleId: null });
  db.store.set(rootPath, { ...db.store.get(rootPath), memberCount: 1 });
  await execute(db);
  assert.equal(db.store.has(progressPath('c-0')), false);
  assert.equal(db.store.get(rootPath).memberCount, 1);
});
test('two concurrent leaves retry without decrementing twice', async () => {
  const db = seed();
  const results = await Promise.all([execute(db), execute(db)]);
  assert.deepEqual(results, [{ body: { left: true } }, { body: { left: true } }]);
  assert.equal(db.store.get(rootPath).memberCount, 1);
  assert.ok(db.retries > 0);
});
test('transaction failure before commit preserves membership, progress and user reference', async () => {
  const db = seed(); const before = new Map(db.store);
  db.beforeCommit = () => { throw Error('private-commit-marker'); };
  await assert.rejects(execute(db), /private-commit-marker/);
  assert.deepEqual(db.store, before); assert.equal(db.commits.length, 0);
});
for (const count of [30, 31]) {
  test(`${count} actual memberships ${count === 30 ? 'are supported' : 'exceed the hard bound'}`, async () => {
    const db = seed();
    const membership = db.store.get(`${rootPath}/members/member`);
    for (let i = 2; i < count; i++) db.store.set(`${rootPath}/members/other-${i}`, { ...membership });
    db.store.set(rootPath, { ...db.store.get(rootPath), memberCount: 30 });
    const before = new Map(db.store);
    if (count === 31) {
      await assert.rejects(execute(db), { code: 'CIRCLE_STATE_CONFLICT' });
      assert.deepEqual(db.store, before);
    } else {
      await execute(db); assert.equal(db.store.get(rootPath).memberCount, 29);
    }
  });
}
for (const memberLimit of [3, 10]) {
  test(`memberLimit ${memberLimit} remains supported`, async () => {
    const db = seed(); db.store.set(rootPath, { ...db.store.get(rootPath), memberLimit });
    assert.deepEqual(await execute(db), { body: { left: true } });
  });
}
test('admin cannot use normal leave', async () => {
  const db = seed(); const before = new Map(db.store);
  await assert.rejects(execute(db, 'admin'), { code: 'CIRCLE_ADMIN_CANNOT_LEAVE', statusCode: 403 });
  assert.deepEqual(db.store, before);
});
for (const [label, mutate] of [
  ['missing user', db => db.store.delete('users/member')],
  ['nonmember with active reference', db => db.store.delete(`${rootPath}/members/member`)],
  ['other active Circle', db => db.store.set('users/member', { activeCircleId: 'other' })],
  ['active member without reference', db => db.store.set('users/member', { activeCircleId: null })],
  ['missing active reference', db => db.store.set('users/member', {})],
  ['missing admin membership', db => db.store.delete(`${rootPath}/members/admin`)],
  ['invalid member role', db => db.store.set(`${rootPath}/members/member`, { role: 'admin' })],
  ['invalid admin role', db => db.store.set(`${rootPath}/members/admin`, { role: 'member' })],
  ['mismatched membership uid', db => db.store.set(`${rootPath}/members/member`, { ...db.store.get(`${rootPath}/members/member`), uid: 'other' })],
  ['incomplete admin membership', db => db.store.set(`${rootPath}/members/admin`, { role: 'admin' })],
  ['invalid member timestamp', db => db.store.set(`${rootPath}/members/member`, { ...db.store.get(`${rootPath}/members/member`), joinedAt: null })],
  ['inconsistent memberCount', db => db.store.set(rootPath, { ...db.store.get(rootPath), memberCount: 3 })],
  ['invalid memberLimit', db => db.store.set(rootPath, { ...db.store.get(rootPath), memberLimit: 11 })],
  ['invalid schema', db => db.store.set(rootPath, { ...db.store.get(rootPath), schemaVersion: 1 })],
  ['deletion state', db => db.store.set(rootPath, { ...db.store.get(rootPath), deletionState: 'SERVER_DELETING' })],
  ['inconsistent challengeCount', db => db.store.set(rootPath, { ...db.store.get(rootPath), challengeCount: 1 })],
  ['missing challengeCount', db => { const data = { ...db.store.get(rootPath) }; delete data.challengeCount; db.store.set(rootPath, data); }],
  ['declared challengeCount above 240', db => db.store.set(rootPath, { ...db.store.get(rootPath), challengeCount: 241 })],
  ['invalid last ID', db => db.store.set(rootPath, { ...db.store.get(rootPath), lastChallengeId: ' bad ' })],
  ['invalid challenge ID', db => {
    db.store.set(`${rootPath}/challenges/ bad `, {});
    db.store.set(rootPath, { ...db.store.get(rootPath), challengeCount: 3 });
  }],
  ['over 240 Challenges', db => {
    for (let i = 2; i < 241; i++) db.store.set(`${rootPath}/challenges/c-${i}`, {});
    db.store.set(rootPath, { ...db.store.get(rootPath), challengeCount: 240 });
  }],
]) {
  test(`${label} fails closed without any write`, async () => {
    const db = seed(); mutate(db); const before = new Map(db.store);
    await assert.rejects(execute(db), { code: 'CIRCLE_STATE_CONFLICT' });
    assert.deepEqual(db.store, before); assert.equal(db.commits.length, 0);
  });
}

async function credit(db, kind) {
  return db.runTransaction(async transaction => {
    if (kind === 'focus') {
      const session = { sessionId: 'new-event', verifiedDurationSeconds: 60,
        startedAt: Timestamp.fromMillis(1000), completedAt: NOW, targetType: 'SUBJECT' };
      const plan = await readCircleProgressPlan({ transaction, db, uid: 'member',
        userRef: db.collection('users').doc('member'), session });
      applyCircleProgressPlan({ transaction, plan, uid: 'member', session, processedAt: NOW });
    } else {
      const event = { type: 'TASK_COMPLETION', resourceId: 'task', occurredAt: NOW };
      const activityEventId = 'TASK_COMPLETION__task';
      const userSnapshot = await transaction.get(db.collection('users').doc('member'));
      const plan = await readActivityCircleProgressPlan({ transaction, db, uid: 'member', userSnapshot, event, activityEventId });
      applyActivityCircleProgressPlan({ transaction, plan, uid: 'member', event, activityEventId, processedAt: NOW });
    }
  });
}
for (const kind of ['focus', 'activity']) {
  test(`${kind} concurrent writer retries after leave and cannot recreate progress`, async () => {
    const db = seed(); db.beforeCommit = () => execute(db);
    await credit(db, kind);
    assert.equal(db.retries, 1);
    for (const id of ['c-0', 'c-1']) assert.equal(db.store.has(progressPath(id)), false);
    assert.equal(db.store.get('users/member').activeCircleId, null);
  });
  test(`leave retries after ${kind} commits and removes the new contribution`, async () => {
    const db = seed(); db.beforeCommit = () => credit(db, kind);
    await execute(db);
    assert.equal(db.retries, 1);
    for (const id of ['c-0', 'c-1']) assert.equal(db.store.has(progressPath(id)), false);
    assert.equal(db.store.get(rootPath).memberCount, 1);
  });
}

async function invoke({ body = { circleId: 'circle' }, headers = {}, runtime = {}, db = seed() } = {}) {
  const authCalls = []; const rateCalls = [];
  const response = { statusCode: null, body: null, setHeader() {}, end() {},
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method: 'POST', body, headers: { 'content-type': 'application/json',
    authorization: 'Bearer test-token', 'x-firebase-appcheck': 'test-app-check', ...headers } }, response, {
    getServices: () => ({ db, auth: { verifyIdToken: async (...args) => { authCalls.push(args); return { uid: 'member' }; } } }),
    verifyAppCheckToken: async () => ({}),
    checkRateLimit: async options => { rateCalls.push(options); return true; }, ...runtime,
  });
  return { response, db, authCalls, rateCalls };
}
test('handler authenticates with revocation check and distributed leave rate-limit scope', async () => {
  const { response, authCalls, rateCalls } = await invoke();
  assert.equal(response.statusCode, 200); assert.deepEqual(response.body, { left: true });
  assert.deepEqual(authCalls, [['test-token', true]]);
  assert.equal(rateCalls[0].scope, 'circle_leave'); assert.equal(rateCalls[0].limit, 5);
});
for (const body of [{}, { circleId: 'circle', uid: 'admin' }, { circleId: ' bad ' }, { circleId: 'bad/id' }, { circleId: 'x'.repeat(129) }]) {
  test(`malformed payload ${JSON.stringify(body)} is rejected before authentication/writes`, async () => {
    const db = seed(); const before = new Map(db.store);
    const { response, authCalls } = await invoke({ db, body });
    assert.equal(response.statusCode, 400); assert.equal(response.body.code, 'INVALID_CIRCLE_LEAVE_PAYLOAD');
    assert.deepEqual(authCalls, []); assert.deepEqual(db.store, before);
  });
}
for (const [label, options, status, code] of [
  ['missing App Check', { headers: { 'x-firebase-appcheck': '' } }, 401, 'APP_CHECK_REQUIRED'],
  ['invalid App Check', { runtime: { verifyAppCheckToken: async () => { throw Error('private-marker'); } } }, 401, 'APP_CHECK_INVALID'],
  ['missing Auth', { headers: { authorization: '' } }, 401, 'UNAUTHENTICATED'],
  ['revoked Auth', { runtime: { getServices: () => ({ auth: { verifyIdToken: async () => { throw Error('private-marker'); } } }) } }, 401, 'UNAUTHENTICATED'],
  ['rate limited', { runtime: { checkRateLimit: async () => false } }, 429, 'RATE_LIMITED'],
  ['rate storage failure', { runtime: { checkRateLimit: async () => { throw Error('private-marker'); } } }, 503, 'RATE_LIMIT_UNAVAILABLE'],
  ['oversized body', { headers: { 'content-length': '257' } }, 413, 'INVALID_CIRCLE_LEAVE_PAYLOAD'],
  ['wrong content type', { headers: { 'content-type': 'text/plain' } }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
]) {
  test(`${label} fails safely without mutation`, async () => {
    const db = seed(); const before = new Map(db.store);
    const { response } = await invoke({ ...options, db });
    assert.equal(response.statusCode, status); assert.equal(response.body.code, code);
    assert.ok(!JSON.stringify(response.body).includes('private-marker')); assert.deepEqual(db.store, before);
  });
}
test('unexpected transaction failure has a fixed sanitized response', async () => {
  const db = seed(); db.runTransaction = async () => { throw Error('private-marker'); };
  const { response } = await invoke({ db });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { code: 'CIRCLE_LEAVE_FAILED', error: 'Nao foi possivel sair do Circle.' });
});
