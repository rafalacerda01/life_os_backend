import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Timestamp } from 'firebase-admin/firestore';
import { deleteAccount } from '../api/account/delete.js';
import { deleteCircle } from '../api/circles/delete.js';
import { prepare, finish } from '../api/account/_birth_ledger_cleanup.js';
import { createAccountHandler } from '../api/account/_shared.js';
import { sha256 } from '../api/billing/google/_reconciliation.js';
const UID = 'synthetic-owner', OTHER = 'synthetic-other';
const ROOT = `users/${UID}`, L = `account_birth_decisions/${UID}`, G = `account_deletion_guards/${UID}`;
const CREATED = Timestamp.fromDate(new Date('2026-10-13T10:00:00Z'));
const CLOCK = Timestamp.fromDate(new Date('2026-10-13T11:00:00Z'));
const context = new AsyncLocalStorage();
function copy(v) {
  if (v instanceof Timestamp) return v;
  if (Array.isArray(v)) return v.map(copy);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) !== Object.prototype) return v;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
  return v;
}
function gate() {
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  return { reached: reached.promise, release: release.resolve,
    async hold() { reached.resolve(); await release.promise; } };
}

// Stable snapshots, absent-document versions AND query-range versions. This
// optimistic fake retries the real callback, discards rejected buffered writes,
// and catches query phantoms. Real Admin Firestore normally uses pessimistic locks.
class FakeFirestore {
  projectId = "demo-life-os";
  docs = new Map(); versions = new Map(); created = new Map();
  attempts = []; conflicts = []; writes = []; hooks = {}; recursiveDeletes = [];
  query(path, group = false, filters = [], limit = Infinity) {
    const q = { path, kind: 'query', group, filters, bound: limit,
      where: (field, op, value) => this.query(path, group, [...filters, { field, op, value }], limit),
      limit: n => this.query(path, group, filters, n), orderBy: () => q, startAfter: snapshot => { q.cursor = snapshot.ref.path; return q; },
      get: async () => this.querySnapshot(q, this.docs, this.created) };
    return q;
  }
  collection(path) {
    return { ...this.query(path), doc: id => this.ref(`${path}/${id}`) };
  }
  collectionGroup(name) { return this.query(name, true); }
  ref(path) {
    return { path, kind: 'doc', listCollections: async () => {
      const names = [...new Set([...this.docs.keys()].filter(p => p.startsWith(path + "/"))
        .map(p => p.slice(path.length + 1).split("/")[0]))];
      return names.map(name => ({listDocuments: async () => [...new Set([...this.docs.keys()]
        .filter(p => p.startsWith(path + "/" + name + "/"))
        .map(p => p.slice(0, (path + "/" + name + "/").length) +
          p.slice((path + "/" + name + "/").length).split("/")[0]))]}));
    }, collection: name => this.collection(`${path}/${name}`),
      get: async () => this.snapshot(path, this.docs, this.created) };
  }
  snapshot(path, docs, created) {
    return { ref: this.ref(path), id: path.split('/').at(-1), exists: docs.has(path),
      createTime: created.get(path), data: () => copy(docs.get(path)) };
  }
  querySnapshot(q, docs, created) {
    const found = [...docs.keys()].sort().filter(p =>
      (q.group ? p.split('/').at(-2) === q.path : p.startsWith(`${q.path}/`) &&
        !p.slice(q.path.length + 1).includes('/')) &&
      (!q.cursor || p > q.cursor) && q.filters.every(f => f.op === '==' && docs.get(p)?.[f.field] === f.value))
      .slice(0, q.bound).map(p => this.snapshot(p, docs, created));
    return { docs: found, empty: found.length === 0, size: found.length };
  }
  put(path, data, createdAt = CREATED) {
    if (data === undefined) { this.docs.delete(path); this.created.delete(path); }
    else { this.docs.set(path, copy(data)); if (!this.created.has(path)) this.created.set(path, createdAt); }
    for (const key of [path, `query:${path.split('/').slice(0, -1).join('/')}`,
      `group:${path.split('/').at(-2)}`]) this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
  async runTransaction(callback) {
    const label = context.getStore();
    for (let attempt = 1; attempt <= 10; attempt++) {
      const docs = new Map([...this.docs].map(([p, d]) => [p, copy(d)]));
      const created = new Map(this.created), versions = new Map(this.versions), reads = new Map(), pending = [];
      const record = { label, attempt, reads, pending }; this.attempts.push(record);
      const buffer = (type, ref, data) => pending.push({ type, ref, data: copy(data) });
      const result = await callback({
        get: async ref => {
          assert.equal(pending.length, 0, 'read after write');
          const key = ref.kind === 'query' ? `${ref.group ? 'group' : 'query'}:${ref.path}` : ref.path;
          reads.set(key, versions.get(key) ?? 0);
          await this.hooks.onRead?.({ ...record, path: ref.path });
          return ref.kind === 'query' ? this.querySnapshot(ref, docs, created) : this.snapshot(ref.path, docs, created);
        },
        create: (ref, data) => buffer('create', ref, data),
        set: (ref, data) => buffer('set', ref, data),
        update: (ref, data) => buffer('update', ref, data),
        delete: ref => buffer('delete', ref),
      });
      await this.hooks.beforeCommit?.(record);
      const changed = [...reads].filter(([k, v]) => (this.versions.get(k) ?? 0) !== v).map(([k]) => k);
      if (changed.length) { this.conflicts.push({ label, attempt, changed }); continue; }
      // Validate every precondition before applying any write.
      for (const w of pending) {
        if (w.type === 'create') assert.equal(this.docs.has(w.ref.path), false);
        if (w.type === 'update') assert.equal(this.docs.has(w.ref.path), true);
      }
      for (const w of pending) {
        const data = w.data && Object.fromEntries(Object.entries(w.data).map(([k, v]) =>
          [k, v?.constructor?.name === 'ServerTimestampTransform' ? CLOCK : v]));
        this.put(w.ref.path, w.type === 'delete' ? undefined :
          w.type === 'update' ? { ...this.docs.get(w.ref.path), ...data } : data, CLOCK);
        this.writes.push(w);
      }
      await this.hooks.afterCommit?.(record);
      return result;
    }
    throw new Error('MVCC retry exhaustion');
  }
  batch() {
    const refs = []; const db = this;
    return {delete(ref) {refs.push(ref); return this;},
      commit: () => db.runTransaction(async tx => {for (const ref of refs) tx.delete(ref);})};
  }
  async recursiveDelete(ref) {
    await this.hooks.beforeRecursive?.(ref);
    this.recursiveDeletes.push(ref.path);
    const keys = [...this.docs.keys()].filter(p => p === ref.path || p.startsWith(`${ref.path}/`));
    if (this.partialCleanup) {
      this.partialCleanup = false;
      this.put(ref.path, undefined);
      throw new Error('partial recursive cleanup');
    }
    for (const p of keys) this.put(p, undefined);
  }
}
function ledger(owner = UID) {
  return {version: 1, uid: owner, projectId: 'demo-life-os', tenantId: null,
    authCreatedAt: CREATED, sourceType: 'FIREBASE_AUTH_CREATE', sourceEventId: 'synthetic-create',
    eventAt: CLOCK, cohort: {version: 1, id: 'closed-cohort', policy: 'NEW_ACCOUNT_V2_ONLY',
      state: 'CLOSED', cutoverAt: Timestamp.fromMillis(CREATED.toMillis() - 1000)},
    decisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    originalIdentity: {uid: owner, email: 'synthetic@example.invalid', displayName: 'Synthetic', photoUrl: null},
    recordedAt: CLOCK, status: 'RECORDED_COHORT_CLOSED'};
}
class FakeAuth {
  constructor() { this.now = Date.now(); this.present = true; this.deleteCalls = []; this.verifyCalls = []; this.hooks = {}; }
  async getUser(owner) {
    assert.equal(owner, UID);
    await this.hooks.get?.();
    if (!this.present) throw Object.assign(new Error('synthetic absent'), {code: 'auth/user-not-found'});
    return this.user ?? {uid: UID, metadata: {creationTime: CREATED.toDate().toUTCString()}};
  }
  async deleteUser(owner) {
    assert.equal(owner, UID); this.deleteCalls.push(owner);
    await this.hooks.beforeDelete?.();
    if (!this.present) throw Object.assign(new Error('synthetic absent'), {code: 'auth/user-not-found'});
    this.present = false;
    await this.hooks.afterDelete?.();
  }
  async verifyIdToken(token, checkRevoked) {
    this.verifyCalls.push({token, checkRevoked});
    assert.equal(checkRevoked, true);
    if (this.verifyError) throw this.verifyError;
    // Match installed Admin SDK: revocation verification requires live Auth.
    await this.getUser(UID);
    return {uid: UID, sub: UID, auth_time: this.authTime ?? (this.now - 1000) / 1000};
  }
}
function fixture({root = true, birth = true} = {}) {
  const db = new FakeFirestore(), auth = new FakeAuth();
  if (root) db.put(ROOT, {activeCircleId: null});
  if (birth) db.put(L, ledger());
  db.put(`users/${OTHER}`, {private: 'untouched'});
  db.put(`account_birth_decisions/${OTHER}`, ledger(OTHER));
  const beforeOther = [...db.docs].filter(([p]) => p.endsWith(`/${OTHER}`));
  return {db, auth, beforeOther,
    call: label => context.run(label ?? 'backend', () => deleteAccount({db, auth, uid: UID}))};
}
function integral(f) {
  assert.equal(f.db.docs.has(ROOT), false);
  assert.equal(f.db.docs.has(L), false);
  assert.equal(f.db.docs.get(G).state, 'COMPLETE');
  assert.equal(f.auth.present, false);
  assert.deepEqual([...f.db.docs].filter(([p]) => p.endsWith(`/${OTHER}`)), f.beforeOther);
  assert.equal(f.db.docs.has(`billing_google_accounts/${sha256(UID)}`), false);
}
function guarded(state = 'IN_PROGRESS') {
  return {version: 1, state, deletionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    startedAt: CLOCK, retainUntil: state === 'COMPLETE' ? Timestamp.now() : null};
}
function admit(f) { return prepare({db: f.db, auth: f.auth, uid: UID, preflight: async () => {}}); }
const conflict = promise => assert.rejects(promise, error => error.code === 'ACCOUNT_STATE_CONFLICT');
for (const [name, options] of [
  ['root and ledger', {}], ['ledger without root', {root: false}],
  ['Auth without root or ledger', {root: false, birth: false}], ['legacy without ledger', {birth: false}],
]) test(`integral deletion: ${name}`, async () => {
  const f = fixture(options);
  assert.deepEqual((await f.call()).body, {deleted: true, circleDeleted: false});
  integral(f);
  const atomic = f.db.attempts.find(a => a.pending.some(w => w.ref.path === L && w.type === 'delete'));
  if (options.birth !== false) {
    assert.ok(atomic.pending.some(w => w.ref.path === G && w.data.state === 'COMPLETE'));
  }
});

for (const [name, mutate] of [
  ['UID', r => r.uid = OTHER], ['project', r => r.projectId = 'other-project'],
  ['tenant', r => r.tenantId = 'other-tenant'], ['status', r => r.status = 'ADMITTED'],
  ['policy', r => r.cohort.policy = 'ADOPT_V1'], ['open cohort', r => r.cohort.state = 'OPEN'],
  ['unknown key', r => r.extra = true], ['bad UUID', r => r.decisionId = 'bad'],
  ['birth mismatch', r => r.authCreatedAt = Timestamp.fromMillis(CREATED.toMillis() - 1000)],
  ['future birth', r => r.authCreatedAt = Timestamp.fromMillis(Date.now() + 100000)],
  ['identity UID', r => r.originalIdentity.uid = OTHER], ['extra identity', r => r.originalIdentity.extra = true],
  ['bad time order', r => r.eventAt = Timestamp.fromMillis(CREATED.toMillis() - 1)],
  ['invalid timestamp', r => r.recordedAt = {}], ['invalid cutover', r => r.cohort.cutoverAt = CLOCK],
]) test(`closed ledger conflict: ${name}`, async () => {
  const f = fixture(); const r = ledger(); mutate(r); f.db.put(L, r);
  const before = [...f.db.docs];
  await conflict(f.call());
  assert.deepEqual([...f.db.docs], before);
  assert.equal(f.db.writes.length, 0);
  assert.equal(f.auth.deleteCalls.length, 0);
});

for (const state of ['IN_PROGRESS', 'COMPLETE']) test(`reuse same guard ${state} with Auth already removed`, async () => {
  const f = fixture(); const g = guarded(state); f.db.put(G, g); f.auth.present = false;
  await f.call(); integral(f);
  assert.equal(f.db.docs.get(G).deletionId, g.deletionId);
  assert.ok(f.db.docs.get(G).startedAt.isEqual(g.startedAt));
  if (state === 'COMPLETE') {
    assert.ok(f.db.writes.some(w => w.ref.path === G && w.data?.state === 'IN_PROGRESS'));
  }
});
test('live Auth with COMPLETE guard is quarantined', async () => {
  const f = fixture(); f.db.put(G, guarded('COMPLETE'));
  await conflict(f.call()); assert.equal(f.auth.deleteCalls.length, 0);
  assert.equal(f.db.writes.length, 0);
});
test('root recreated after original guard is quarantined without destructive effects', async () => {
  const f = fixture({root: false}); f.db.put(G, guarded());
  f.db.put(ROOT, {private: 'later root'}, Timestamp.fromMillis(CLOCK.toMillis() + 1));
  await conflict(f.call()); assert.equal(f.auth.deleteCalls.length, 0);
  assert.equal(f.db.writes.length, 0); assert.equal(f.db.docs.get(ROOT).private, 'later root');
});
test('Auth generation explicitly after guard is quarantined', async () => {
  const f = fixture({birth: false}); f.db.put(G, guarded());
  f.auth.user = {uid: UID, metadata: {creationTime: '2026-10-13T12:00:00.001Z'}};
  await conflict(f.call()); assert.equal(f.db.writes.length, 0);
});
for (const user of [{uid: OTHER}, {uid: UID, tenantId: 'tenant'}, {uid: UID, disabled: true},
  {uid: UID, metadata: {creationTime: 'invalid'}}]) test(`untrusted Auth identity refuses ${JSON.stringify(user)}`, async () => {
  const f = fixture(); f.auth.user = user;
  await conflict(f.call()); assert.equal(f.db.writes.length, 0);
});
test('Auth absent without a deletion guard cannot authorize a fresh job', async () => {
  const f = fixture({root: false}); f.auth.present = false;
  await conflict(f.call()); assert.equal(f.db.writes.length, 0);
});
test('invalid guard remains untouched', async () => {
  const f = fixture(); f.db.put(G, {...guarded(), deletionId: 'bad'});
  await conflict(f.call()); assert.equal(f.db.writes.length, 0);
});
test('ledger change after admission is not authorized by the old digest', async () => {
  const f = fixture(); const a = await admit(f); f.auth.present = false; f.db.put(ROOT, undefined);
  f.db.put(L, {...ledger(), sourceEventId: 'different-event'});
  await conflict(finish(f.db, f.auth, a));
  assert.equal(f.db.docs.get(G).state, 'IN_PROGRESS'); assert.ok(f.db.docs.has(L));
});
test('ledger absent at admission cannot authorize a later record', async () => {
  const f = fixture({birth: false}); const a = await admit(f);
  f.auth.present = false; f.db.put(ROOT, undefined); f.db.put(L, ledger());
  await conflict(finish(f.db, f.auth, a)); assert.ok(f.db.docs.has(L));
});
test('changed deletionId refuses finalization', async () => {
  const f = fixture(); const a = await admit(f); f.auth.present = false; f.db.put(ROOT, undefined);
  f.db.put(G, {...guarded(), deletionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});
  await conflict(finish(f.db, f.auth, a)); assert.ok(f.db.docs.has(L));
});
test('Auth delete failure leaves guard, ledger and profile recoverable', async () => {
  const f = fixture(); f.auth.hooks.beforeDelete = () => { throw new Error('synthetic Auth failure'); };
  await assert.rejects(f.call(), /synthetic Auth failure/);
  assert.equal(f.db.docs.get(G).state, 'IN_PROGRESS'); assert.ok(f.db.docs.has(L)); assert.ok(f.db.docs.has(ROOT));
  const id = f.db.docs.get(G).deletionId; f.auth.hooks = {};
  await f.call(); integral(f); assert.equal(f.db.docs.get(G).deletionId, id);
});
test('partial recursive deletion after Auth removal remains recoverable by admitted server work', async () => {
  const f = fixture(); f.db.partialCleanup = true;
  await assert.rejects(f.call(), /partial recursive cleanup/);
  assert.equal(f.auth.present, false); assert.ok(f.db.docs.has(L));
  assert.equal(f.db.docs.get(G).state, 'IN_PROGRESS');
  await f.call(); integral(f);
});
test('ledger delete commit failure cannot publish COMPLETE or deleted true', async () => {
  const f = fixture(); let failed = false;
  f.db.hooks.beforeCommit = a => {
    if (!failed && a.pending.some(w => w.ref.path === L && w.type === 'delete')) {
      failed = true; throw new Error('synthetic ledger commit failure');
    }
  };
  await assert.rejects(f.call(), /synthetic ledger commit failure/);
  assert.equal(f.db.docs.get(G).state, 'IN_PROGRESS'); assert.ok(f.db.docs.has(L));
  const id = f.db.docs.get(G).deletionId; f.db.hooks = {};
  await f.call(); integral(f); assert.equal(f.db.docs.get(G).deletionId, id);
});
test('lost commit response replays without a new deletionId or new ledger', async () => {
  const f = fixture(); let lost = false;
  f.db.hooks.afterCommit = a => {
    if (!lost && a.pending.some(w => w.ref.path === L && w.type === 'delete')) {
      lost = true; throw new Error('synthetic lost reply');
    }
  };
  await assert.rejects(f.call(), /synthetic lost reply/); integral(f);
  const id = f.db.docs.get(G).deletionId; f.db.hooks = {};
  await f.call(); integral(f); assert.equal(f.db.docs.get(G).deletionId, id);
  assert.equal(f.db.writes.filter(w => w.ref.path === L && w.type === 'delete').length, 1);
});
test('transaction conflict revalidates corrupted ledger before committing deletion', async () => {
  const f = fixture(); const a = await admit(f); f.auth.present = false; f.db.put(ROOT, undefined);
  let corrupted = false;
  f.db.hooks.beforeCommit = attempt => {
    if (!corrupted && attempt.pending.some(w => w.ref.path === L && w.type === 'delete')) {
      corrupted = true; f.db.put(L, {...ledger(), status: 'UNTRUSTED'});
    }
  };
  await conflict(finish(f.db, f.auth, a));
  assert.equal(f.db.conflicts.length, 1); assert.equal(f.db.docs.get(G).state, 'IN_PROGRESS');
  assert.ok(f.db.docs.has(L));
});
test('duplicate backend finalizations converge to one ledger deletion', async () => {
  const f = fixture(); const a = await admit(f); f.auth.present = false; f.db.put(ROOT, undefined);
  await Promise.all([finish(f.db, f.auth, a), finish(f.db, f.auth, a)]);
  await finish(f.db, f.auth, a); integral(f);
  assert.equal(f.db.writes.filter(w => w.ref.path === L && w.type === 'delete').length, 1);
  assert.ok(f.db.conflicts.length > 0);
});
function handler(f) {
  return createAccountHandler('delete', 'ACCOUNT_DELETE_FAILED', deleteAccount, {
    nowProvider: () => f.auth.now,
    getServices: () => ({db: f.db, auth: f.auth, appCheck: {verifyToken: async () => {
      if (f.appCheckFailure) throw new Error('synthetic app check'); return {appId: 'synthetic'};
    }}})});
}
async function http(f, body = {}, runtime = {}) {
  const res = {setHeader() {}, status(code) {this.code = code; return this;}, json(value) {this.body = value; return this;}};
  await handler(f)({method: 'POST', headers: {authorization: 'Bearer synthetic', 'x-firebase-appcheck': 'synthetic'}, body}, res,
    {checkRateLimit: async () => f.allowed !== false, ...runtime});
  return res;
}
for (const code of ['auth/id-token-revoked', 'auth/invalid-id-token', 'auth/user-not-found']) test(`HTTP rejects ${code} before any deletion`, async () => {
  const f = fixture({root: false}); f.auth.verifyError = Object.assign(new Error('private synthetic detail'), {code});
  const res = await http(f); assert.equal(res.code, 401); assert.equal(res.body.code, 'UNAUTHENTICATED');
  assert.equal(f.db.writes.length, 0); assert.equal(f.auth.deleteCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(res.body), /private|detail/);
});
test('HTTP rootless account with verified live Auth is deleted integrally', async () => {
  const f = fixture({root: false}); const res = await http(f);
  assert.equal(res.code, 200); assert.equal(res.body.deleted, true); integral(f);
});
test('HTTP post-Auth-removal retry stays 401, even with a valid server guard', async () => {
  const f = fixture(); f.auth.present = false; f.db.put(G, guarded());
  const before = [...f.db.docs]; const res = await http(f);
  assert.equal(res.code, 401); assert.equal(res.body.code, 'UNAUTHENTICATED');
  assert.deepEqual([...f.db.docs], before); assert.equal(f.auth.deleteCalls.length, 0);
});
test('client UID cannot select another account', async () => {
  const f = fixture(); const res = await http(f, {uid: OTHER});
  assert.equal(res.code, 400); assert.equal(res.body.code, 'INVALID_ACCOUNT_PAYLOAD');
  assert.equal(f.db.writes.length, 0);
});
for (const [name, configure, expected] of [
  ['App Check', f => f.appCheckFailure = true, 401],
  ['recent auth', f => f.auth.authTime = 0, 401],
  ['rate limit', f => f.allowed = false, 429],
]) test(`rootless deletion preserves ${name}`, async () => {
  const f = fixture({root: false}); configure(f); const res = await http(f);
  assert.equal(res.code, expected); assert.equal(f.db.writes.length, 0); assert.equal(f.auth.deleteCalls.length, 0);
});

// Exports are for an external read-only Functions interop probe, never ingress.
export {FakeFirestore, FakeAuth, fixture, ledger, integral, guarded, gate, context, UID, ROOT, L, G, CREATED, CLOCK};

test('invalid successful Admin lookup is not treated as Auth absence', async () => {
  const f = fixture(); f.db.put(G, guarded()); f.auth.getUser = async () => null;
  await conflict(f.call()); assert.equal(f.db.writes.length, 0);
});
test('explicit root replacement during Auth deletion is preserved', async () => {
  const f = fixture(); f.auth.hooks.afterDelete = () => {
    f.db.put(ROOT, undefined); f.db.put(ROOT, {private: 'conflicting root'}, Timestamp.fromMillis(Date.now() + 1000));
  };
  await conflict(f.call()); assert.equal(f.db.docs.get(ROOT).private, 'conflicting root');
  assert.ok(f.db.docs.has(L)); assert.equal(f.db.docs.get(G).state, 'IN_PROGRESS');
  assert.equal(f.db.recursiveDeletes.includes(ROOT), false);
});
test('explicit Auth reappearance is preserved before root removal', async () => {
  const f = fixture(); f.auth.hooks.afterDelete = () => {f.auth.present = true;};
  await conflict(f.call()); assert.ok(f.db.docs.has(ROOT)); assert.ok(f.db.docs.has(L));
  assert.equal(f.db.recursiveDeletes.includes(ROOT), false);
});
test('ledger corruption during Auth deletion cannot remove root or complete', async () => {
  const f = fixture(); f.auth.hooks.afterDelete = () => f.db.put(L, {...ledger(), sourceEventId: 'changed'});
  await conflict(f.call()); assert.ok(f.db.docs.has(ROOT)); assert.ok(f.db.docs.has(L));
  assert.equal(f.db.docs.get(G).state, 'IN_PROGRESS'); assert.equal(f.db.recursiveDeletes.includes(ROOT), false);
});
test('failure of Admin lookup is fail closed before root removal', async () => {
  const f = fixture(); f.auth.hooks.afterDelete = () => {f.auth.hooks.get = () => {throw new Error('synthetic lookup failure');};};
  await assert.rejects(f.call(), /synthetic lookup failure/);
  assert.ok(f.db.docs.has(ROOT)); assert.ok(f.db.docs.has(L)); assert.equal(f.db.recursiveDeletes.includes(ROOT), false);
});
test('authenticated token selects only its own UID even when another root exists', async () => {
  const f = fixture(); const original = f.db.docs.get(ROOT); const originalLedger = f.db.docs.get(L);
  f.auth.verifyIdToken = async (token, revoked) => {assert.equal(revoked, true); return {uid: OTHER, sub: OTHER, auth_time: (f.auth.now - 1000) / 1000};};
  f.auth.getUser = async owner => {
    assert.equal(owner, OTHER);
    if (!f.auth.present) throw Object.assign(new Error('absent'), {code: 'auth/user-not-found'});
    return {uid: OTHER, metadata: {creationTime: CREATED.toDate().toUTCString()}};
  };
  f.auth.deleteUser = async owner => {assert.equal(owner, OTHER); f.auth.deleteCalls.push(owner); f.auth.present = false;};
  const res = await http(f); assert.equal(res.code, 200);
  assert.deepEqual(f.db.docs.get(ROOT), original); assert.deepEqual(f.db.docs.get(L), originalLedger);
  assert.deepEqual(f.auth.deleteCalls, [OTHER]);
  assert.equal(f.db.docs.has(`account_birth_decisions/${OTHER}`), false);
});

// D2-A: private deterministic MVCC regression. Both attempts pass the real
// admission while Auth exists. Pause a preparatory commit, complete the first
// deletion (optionally run the real onDelete via an external read-only probe),
// then force the stale transaction to retry. No sleeps or services are used.
export async function runD2aRace(artifact, options = {}) {
  const f = fixture({root: options.root ?? true, birth: options.birth ?? true});
  const billingPath = `billing_google_accounts/${sha256(UID)}`;
  const runtimePath = `${ROOT}/runtime/account_deletion`;
  const target = artifact === 'billing' ? billingPath : runtimePath;
  const authGate = gate(), staleGate = gate(), finalGate = gate();
  let stalePaused = false, finalPaused = false;
  const lateWrites = [];
  f.auth.hooks.beforeDelete = async () => {
    if (context.getStore() === 'D2-A:first') await authGate.hold();
  };
  f.db.hooks.beforeCommit = async attempt => {
    if (attempt.label === 'D2-A:second' && !stalePaused &&
        attempt.pending.some(w => w.type === 'set' && w.ref.path === target)) {
      stalePaused = true; await staleGate.hold();
    }
    if (attempt.label === 'D2-A:first' && !finalPaused &&
        attempt.pending.some(w => w.ref.path === G && w.data?.state === 'COMPLETE')) {
      finalPaused = true; await finalGate.hold();
    }
  };
  f.db.hooks.afterCommit = attempt => {
    if (attempt.label === 'D2-A:second' && f.db.docs.get(G)?.state === 'COMPLETE' &&
        attempt.pending.some(w => w.type === 'set' && w.ref.path === target)) {
      lateWrites.push(target);
      throw new Error('D2A_RESPONSE_LOST_AFTER_PREPARATORY_COMMIT');
    }
  };
  // Attach rejection handlers before releasing any barrier.
  const first = f.call('D2-A:first').then(value => ({value}), error => ({error}));
  await authGate.reached;
  const id = f.db.docs.get(G).deletionId;
  const second = f.call('D2-A:second').then(value => ({value}), error => ({error}));
  await staleGate.reached;
  authGate.release();
  await finalGate.reached;
  if (options.onDelete) await options.onDelete(f);
  // COMPLETE is committed by the first backend attempt if no trigger was
  // injected. With a trigger, the same guard is already COMPLETE here.
  finalGate.release();
  const firstResult = await first;
  staleGate.release();
  const secondResult = await second;
  const evidence = {artifact, rootInitially: options.root ?? true, ledgerInitially: options.birth ?? true,
    first: firstResult.value?.body ?? {error: firstResult.error?.code},
    second: secondResult.value?.body ?? {error: secondResult.error?.code ?? secondResult.error?.message},
    guard: f.db.docs.get(G)?.state, sameDeletionId: f.db.docs.get(G)?.deletionId === id,
    rootPresent: f.db.docs.has(ROOT), ledgerPresent: f.db.docs.has(L),
    billingPresent: f.db.docs.has(billingPath), runtimePresent: f.db.docs.has(runtimePath),
    lateWrites, retries: f.db.conflicts.filter(c => c.label === 'D2-A:second').length};
  return {f, evidence};
}
for (const artifact of ['billing', 'runtime']) {
  for (const root of [true, false]) for (const birth of [true, false]) {
    test(`D2-A RED blocks stale ${artifact} commit after COMPLETE (root=${root}, ledger=${birth})`,
      {timeout: 10000}, async t => {
        const {f, evidence} = await runD2aRace(artifact, {root, birth});
        t.diagnostic(JSON.stringify(evidence));
        assert.equal(evidence.first.deleted, true);
        assert.equal(evidence.guard, 'COMPLETE');
        assert.equal(evidence.sameDeletionId, true);
        assert.equal(evidence.rootPresent, false);
        assert.equal(evidence.ledgerPresent, false);
        assert.deepEqual([...f.db.docs].filter(([p]) => p.endsWith(`/${OTHER}`)), f.beforeOther);
        assert.ok(evidence.retries > 0, 'must reexecute the real transaction after a read conflict');
        assert.equal(evidence.lateWrites.length, 0, 'COMPLETE must fence every preparatory commit');
        assert.equal(evidence.billingPresent, false, 'integral success cannot leave Billing UID');
        assert.equal(evidence.runtimePresent, false, 'integral success cannot leave a runtime marker');
      });
  }
}

// D2-A-R2: COMPLETE is a read-only terminal state, not deletion authority.
test('R2 empty COMPLETE retry performs zero writes and no recursive delete', async () => {
  const f = fixture({root: false, birth: false}); f.auth.present = false;
  const g = guarded('COMPLETE'); f.db.put(G, g);
  assert.equal((await f.call()).body.deleted, true);
  assert.deepEqual(f.db.docs.get(G), g);
  assert.equal(f.db.writes.length, 0); assert.deepEqual(f.db.recursiveDeletes, []);
});
for (const [name, path, data] of [
  ['billing', 'billing_google_accounts/' + sha256(UID), {uid: UID, state: 'DELETING'}],
  ['runtime', ROOT + '/runtime/account_deletion', {deletionId: guarded().deletionId}],
  ['orphan descendant', ROOT + '/unknown/missing/nested/private', {pii: 'synthetic'}],
  ['token', 'billing_google_tokens/residue', {accountHash: sha256(UID)}],
  ['membership', 'circles/elsewhere/members/' + UID, {role: 'member'}],
  ['history', 'circles/elsewhere/ranking/' + UID, {uid: UID}],
  ['global marker', 'circle_deletions/residue', {initiatedBy: UID}],
]) test('R2 historical COMPLETE refuses ' + name + ' without reopening or writes', async () => {
  const f = fixture({root: false, birth: false}); f.auth.present = false;
  f.db.put(G, guarded('COMPLETE')); f.db.put(path, data);
  const before = [...f.db.docs];
  await conflict(f.call());
  assert.deepEqual([...f.db.docs], before); assert.equal(f.db.writes.length, 0);
  assert.deepEqual(f.db.recursiveDeletes, []);
});
test('R2 IN_PROGRESS orphan descendants remain recoverable by recursive deletion', async () => {
  const f = fixture({root: false, birth: false}); f.auth.present = false;
  f.db.put(G, guarded()); f.db.put(ROOT + '/unknown/missing/nested/private', {pii: 'synthetic'});
  assert.equal((await f.call()).body.deleted, true); integral(f);
  assert.equal([...f.db.docs.keys()].some(p => p.startsWith(ROOT + '/')), false);
});
for (const artifact of ['runtime', 'membership', 'marker']) test('R2 final transaction retries and refuses late ' + artifact, async () => {
  const f = fixture(); let injected = false;
  f.db.hooks.beforeCommit = attempt => {
    if (injected || !attempt.pending.some(w => w.ref.path === G && w.data?.state === 'COMPLETE')) return;
    injected = true;
    if (artifact === 'runtime') f.db.put(ROOT + '/runtime/account_deletion', {pii: 'synthetic'});
    if (artifact === 'membership') f.db.put('circles/other/members/' + UID, {role: 'member'});
    if (artifact === 'marker') f.db.put('circle_deletions/late', {initiatedBy: UID});
  };
  await conflict(f.call());
  assert.equal(injected, true); assert.equal(f.db.docs.get(G).state, 'IN_PROGRESS');
  assert.ok(f.db.conflicts.length); assert.ok(f.db.docs.has(L));
});

for (const stage of ['billing', 'runtime']) test('R2 sentinel from ' + stage + ' alone never authorizes success', async () => {
  const f = fixture(); let injected = false;
  const path = stage === 'billing' ? 'billing_google_accounts/' + sha256(UID) : ROOT + '/runtime/account_deletion';
  f.db.hooks.beforeCommit = attempt => {
    if (!injected && attempt.pending.some(w => w.ref.path === path && w.type === 'set')) {
      injected = true;
      throw Object.assign(new Error('synthetic sentinel without terminal proof'), {code: 'ACCOUNT_CLEANUP_COMPLETE'});
    }
  };
  await conflict(f.call()); assert.equal(injected, true);
  assert.equal(f.db.docs.get(G).state, 'IN_PROGRESS');
  assert.ok(f.db.docs.has(ROOT)); assert.ok(f.db.docs.has(L));
  assert.equal(f.auth.deleteCalls.length, 0);
});

test('R2 admitted Circle deletion cannot recreate a marker containing the deleted UID', async () => {
  const f = fixture(), hold = gate(); let paused = false;
  f.db.put('circles/shared', {schemaVersion: 2, adminId: OTHER, memberLimit: 3, memberCount: 2});
  f.db.put('circles/shared/members/' + OTHER, {role: 'admin'});
  f.db.put('circles/shared/members/' + UID, {role: 'member'});
  f.beforeOther = [...f.db.docs].filter(([p]) => p.endsWith('/' + OTHER));
  f.db.hooks.beforeCommit = async attempt => {
    if (attempt.label === 'circle-request' && !paused && attempt.pending.some(w =>
      w.ref.path === 'circle_deletions/shared' && w.type === 'set')) {
      paused = true; await hold.hold();
    }
  };
  const oldRequest = context.run('circle-request', () => deleteCircle({
    db: f.db, uid: OTHER, body: {circleId: 'shared'}, now: CLOCK,
  })).then(() => null, error => error);
  await hold.reached;
  assert.equal((await f.call()).body.deleted, true); integral(f);
  const before = [...f.db.docs]; hold.release();
  assert.equal((await oldRequest).code, 'CIRCLE_STATE_CONFLICT');
  assert.deepEqual([...f.db.docs], before);
  assert.ok(f.db.conflicts.some(c => c.label === 'circle-request'));
  assert.equal(f.db.docs.has('circle_deletions/shared'), false);
});

const RETIRED = `retired_auth_identities/${UID}`;
const denyRecord = deletionId => ({version: 2, state: 'RESERVED', deletionId, origin: 'PRE_AUTH'});
const denyCreates = f => f.db.writes.filter(w => w.ref.path === RETIRED);
async function denyHttp(f, body = {}) {
  const handler = createAccountHandler('delete', 'ACCOUNT_DELETE_FAILED', deleteAccount, {
    nowProvider: () => f.auth.now,
    getServices: () => ({db: f.db, auth: f.auth,
      appCheck: {verifyToken: async token => {assert.equal(token, 'synthetic-app-check');}}}),
  });
  const res = {statusCode: 200, setHeader() {}, status(value) {this.statusCode = value; return this;},
    json(value) {this.body = value; return this;}};
  await handler({method: 'POST', headers: {authorization: 'Bearer synthetic-id-token',
    'x-firebase-appcheck': 'synthetic-app-check'}, body}, res, {checkRateLimit: async () => true});
  return res;
}

test('deny writer: authenticated own-UID request persists a minimal record before any destructive work', async () => {
  const f = fixture();
  f.auth.hooks.beforeDelete = () => {
    assert.deepEqual(f.db.docs.get(RETIRED), denyRecord(f.db.docs.get(G).deletionId));
  };
  const response = await denyHttp(f);
  assert.equal(response.statusCode, 200); assert.equal(response.body.deleted, true); integral(f);
  assert.deepEqual(f.db.docs.get(RETIRED), denyRecord(f.db.docs.get(G).deletionId));
  const marker = denyCreates(f);
  assert.equal(marker.length, 1); assert.equal(marker[0].type, 'create');
  const index = f.db.writes.indexOf(marker[0]);
  assert.ok(index >= 0);
  assert.ok(f.db.writes.slice(0, index).every(w => w.ref.path === G), 'only guard admission precedes retirement');
  const attempt = f.db.attempts.find(a => a.pending.includes(marker[0]));
  assert.ok(attempt.reads.has(G)); assert.ok(attempt.reads.has(RETIRED));
  assert.deepEqual(f.auth.verifyCalls, [{token: 'synthetic-id-token', checkRevoked: true}]);
});

test('deny writer: failed persistence prevents cleanup and the same authenticated request can retry', async () => {
  const f = fixture();
  f.db.hooks.beforeCommit = attempt => {
    if (attempt.pending.some(w => w.ref.path === RETIRED)) throw new Error('synthetic marker commit failed');
  };
  await assert.rejects(f.call(), /synthetic marker commit failed/);
  assert.equal(f.auth.present, true); assert.deepEqual(f.auth.deleteCalls, []);
  assert.deepEqual(f.db.recursiveDeletes, []); assert.ok(f.db.docs.has(ROOT)); assert.ok(f.db.docs.has(L));
  assert.equal(f.db.docs.has(RETIRED), false);
  assert.ok(f.db.writes.every(w => w.ref.path === G));
  const id = f.db.docs.get(G).deletionId;
  f.db.hooks = {};
  assert.equal((await denyHttp(f)).statusCode, 200); integral(f);
  assert.deepEqual(f.db.docs.get(RETIRED), denyRecord(id)); assert.equal(denyCreates(f).length, 1);
});

test('deny writer: lost persistence response keeps the marker and retry never overwrites it', async () => {
  const f = fixture(); let lost = false;
  f.db.hooks.afterCommit = attempt => {
    if (!lost && attempt.pending.some(w => w.ref.path === RETIRED)) {
      lost = true; throw new Error('synthetic lost marker response');
    }
  };
  await assert.rejects(f.call(), /synthetic lost marker response/);
  assert.equal(f.auth.present, true); assert.deepEqual(f.auth.deleteCalls, []);
  assert.ok(f.db.docs.has(RETIRED)); assert.deepEqual(f.db.recursiveDeletes, []);
  const marker = copy(f.db.docs.get(RETIRED)), created = f.db.created.get(RETIRED);
  f.db.hooks = {};
  assert.equal((await denyHttp(f)).statusCode, 200); integral(f);
  assert.deepEqual(f.db.docs.get(RETIRED), marker);
  assert.ok(f.db.created.get(RETIRED).isEqual(created)); assert.equal(denyCreates(f).length, 1);
});

test('deny writer: later failure with live Auth preserves authenticated continuation and the original marker', async () => {
  const f = fixture();
  f.auth.hooks.beforeDelete = () => {throw new Error('synthetic Auth transport failure');};
  await assert.rejects(f.call(), /synthetic Auth transport failure/);
  const marker = copy(f.db.docs.get(RETIRED));
  assert.ok(marker); assert.equal(f.auth.present, true); assert.ok(f.db.docs.has(ROOT));
  assert.equal(f.db.docs.get(G).state, 'IN_PROGRESS');
  f.auth.hooks = {};
  assert.equal((await denyHttp(f)).statusCode, 200); integral(f);
  assert.deepEqual(f.db.docs.get(RETIRED), marker); assert.equal(denyCreates(f).length, 1);
});

test('deny writer: identical preexisting marker and guard are idempotent', async () => {
  const f = fixture(), g = guarded(); f.db.put(G, g); f.db.put(RETIRED, denyRecord(g.deletionId));
  const created = f.db.created.get(RETIRED);
  assert.equal((await f.call()).body.deleted, true); integral(f);
  assert.deepEqual(f.db.docs.get(RETIRED), denyRecord(g.deletionId));
  assert.ok(f.db.created.get(RETIRED).isEqual(created)); assert.equal(denyCreates(f).length, 0);
});

for (const [label, make] of [
  ['different deletionId', () => denyRecord('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
  ['legacy V1', id => ({version: 1, state: 'RESERVED', deletionId: id, authCreatedAtMs: 1})],
  ['AUTH_EVENT origin', id => ({...denyRecord(id), origin: 'AUTH_EVENT'})],
  ['LEGACY_REVIEW origin', id => ({...denyRecord(id), origin: 'LEGACY_REVIEW'})],
  ['unknown state', id => ({...denyRecord(id), state: 'COMPLETE'})],
  ['extra field', id => ({...denyRecord(id), privateField: 'synthetic private data'})],
  ['empty marker', () => ({})],
]) test(`deny writer: ${label} is never adopted or overwritten`, async () => {
  const f = fixture(), g = guarded(); f.db.put(G, g); const record = make(g.deletionId); f.db.put(RETIRED, record);
  const before = [...f.db.docs];
  await conflict(f.call()); assert.deepEqual([...f.db.docs], before);
  assert.equal(f.db.writes.length, 0); assert.deepEqual(f.auth.deleteCalls, []);
  assert.deepEqual(f.db.recursiveDeletes, []);
});

for (const [label, value] of [
  ['malformed', {state: 'IN_PROGRESS'}], ['legacy', {version: 0}],
  ['COMPLETE with live Auth', guarded('COMPLETE')],
]) test(`deny writer: ${label} guard cannot authorize a reservation`, async () => {
  const f = fixture(); f.db.put(G, value); const before = [...f.db.docs];
  await conflict(f.call()); assert.deepEqual([...f.db.docs], before);
  assert.equal(f.db.docs.has(RETIRED), false); assert.deepEqual(f.auth.deleteCalls, []);
});

for (const change of ['different operation', 'COMPLETE', 'absent']) {
  test(`deny writer: guard becoming ${change} during marker commit forces fenced revalidation`, async () => {
    const f = fixture(); let changed = false;
    f.db.hooks.beforeCommit = attempt => {
      if (!changed && attempt.pending.some(w => w.ref.path === RETIRED)) {
        changed = true;
        f.db.put(G, change === 'absent' ? undefined : change === 'COMPLETE' ? guarded('COMPLETE') :
          {...guarded(), deletionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
      }
    };
    await conflict(f.call()); assert.equal(changed, true);
    assert.ok(f.db.conflicts.some(c => c.changed.includes(G)));
    assert.equal(f.db.docs.has(RETIRED), false); assert.deepEqual(f.auth.deleteCalls, []);
    assert.deepEqual(f.db.recursiveDeletes, []);
  });
}

test('deny writer: concurrent foreign reservation wins without being overwritten', async () => {
  const f = fixture(); let changed = false;
  const foreign = denyRecord('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  f.db.hooks.beforeCommit = attempt => {
    if (!changed && attempt.pending.some(w => w.ref.path === RETIRED)) {changed = true; f.db.put(RETIRED, foreign);}
  };
  await conflict(f.call()); assert.equal(changed, true);
  assert.ok(f.db.conflicts.some(c => c.changed.includes(RETIRED)));
  assert.deepEqual(f.db.docs.get(RETIRED), foreign); assert.equal(denyCreates(f).length, 0);
  assert.deepEqual(f.auth.deleteCalls, []); assert.deepEqual(f.db.recursiveDeletes, []);
});

test('deny writer: concurrent identical requests converge without duplicate retirement', async t => {
  const f = fixture(), hold = gate(); t.after(hold.release); let paused = false;
  f.db.hooks.beforeCommit = async attempt => {
    if (!paused && attempt.label === 'writer-first' && attempt.pending.some(w => w.ref.path === RETIRED)) {
      paused = true; await hold.hold();
    }
  };
  const first = f.call('writer-first').then(value => ({value}), error => ({error}));
  await Promise.race([hold.reached, first.then(() => assert.fail('request finished without reaching the retirement write'))]);
  assert.equal((await f.call('writer-second')).body.deleted, true);
  hold.release(); const outcome = await first; assert.equal(outcome.error, undefined);
  assert.equal(outcome.value.body.deleted, true); integral(f);
  assert.equal(denyCreates(f).length, 1); assert.ok(f.db.conflicts.length > 0);
});

test('deny writer: marker alone never authorizes a new guard or post-Auth cleanup', async () => {
  const f = fixture(); f.auth.present = false; f.db.put(RETIRED, denyRecord(guarded().deletionId));
  const before = [...f.db.docs]; await conflict(f.call());
  assert.deepEqual([...f.db.docs], before); assert.equal(f.db.writes.length, 0);
  assert.deepEqual(f.db.recursiveDeletes, []); assert.deepEqual(f.auth.deleteCalls, []);
});

test('deny writer: an old reservation without a guard cannot be rebound to a new deletion', async () => {
  const f = fixture(), record = denyRecord(guarded().deletionId);
  f.db.put(RETIRED, record);
  await conflict(f.call());
  assert.notEqual(f.db.docs.get(G).deletionId, record.deletionId);
  assert.deepEqual(f.db.docs.get(RETIRED), record);
  assert.ok(f.db.docs.has(ROOT)); assert.ok(f.db.docs.has(L));
  assert.ok(f.db.writes.every(w => w.ref.path === G));
  assert.deepEqual(f.auth.deleteCalls, []); assert.deepEqual(f.db.recursiveDeletes, []);
});

test('deny writer: caller-selected UID is rejected before persistence', async () => {
  const f = fixture(); const before = [...f.db.docs];
  const response = await denyHttp(f, {uid: OTHER});
  assert.equal(response.statusCode, 400); assert.deepEqual([...f.db.docs], before);
  assert.deepEqual(f.auth.deleteCalls, []); assert.equal(f.db.writes.length, 0);
});

test('deny writer: record read failure stops before cleanup and HTTP details remain sanitized', async t => {
  const f = fixture(), logs = [];
  t.mock.method(console, 'error', (...values) => logs.push(values.join(' ')));
  f.db.hooks.onRead = attempt => {
    if (attempt.path === RETIRED) throw new Error('PRIVATE-RETIREMENT-STORAGE-DETAIL');
  };
  const response = await denyHttp(f);
  assert.equal(response.statusCode, 500); assert.notEqual(response.body.deleted, true);
  assert.doesNotMatch(JSON.stringify({response, logs}), /PRIVATE-RETIREMENT-STORAGE-DETAIL/);
  assert.equal(f.db.docs.has(RETIRED), false);
  assert.ok(f.db.writes.every(w => w.ref.path === G));
  assert.equal(f.auth.present, true); assert.deepEqual(f.auth.deleteCalls, []);
  assert.deepEqual(f.db.recursiveDeletes, []);
});

test('deny writer: a matching record cannot bypass an invalid guard', async () => {
  const f = fixture();
  f.db.put(G, {...guarded(), retainUntil: Timestamp.now()});
  f.db.put(RETIRED, denyRecord(guarded().deletionId));
  const before = [...f.db.docs]; await conflict(f.call());
  assert.deepEqual([...f.db.docs], before); assert.equal(f.db.writes.length, 0);
  assert.deepEqual(f.auth.deleteCalls, []); assert.deepEqual(f.db.recursiveDeletes, []);
});

test('deny writer: legacy post-Auth continuation does not fabricate PRE_AUTH or acquire new authority', async () => {
  const f = fixture(); f.auth.present = false; f.db.put(G, guarded());
  assert.equal((await f.call()).body.deleted, true); integral(f);
  assert.equal(f.db.docs.has(RETIRED), false); assert.equal(denyCreates(f).length, 0);
});

test('deny writer: COMPLETE replay never backfills a marker and durable records outlive guard removal', async () => {
  const empty = fixture({root: false, birth: false}); empty.auth.present = false;
  empty.db.put(G, guarded('COMPLETE'));
  assert.equal((await empty.call()).body.deleted, true);
  assert.equal(empty.db.docs.has(RETIRED), false); assert.equal(empty.db.writes.length, 0);
  const f = fixture(); await f.call(); const marker = copy(f.db.docs.get(RETIRED)); assert.ok(marker);
  const writes = f.db.writes.length; await f.call();
  assert.deepEqual(f.db.docs.get(RETIRED), marker); assert.equal(f.db.writes.length, writes);
  f.db.put(G, undefined); assert.deepEqual(f.db.docs.get(RETIRED), marker);
});
