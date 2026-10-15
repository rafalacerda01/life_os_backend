import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { Timestamp } from 'firebase-admin/firestore';
import { createWaterProvisioningTestHarness, provisionWaterAccount, provisionWaterDay,
  provisioningError } from '../api/health/_provision_water.js';
import { syncWater, WATER_V2_ENABLED } from '../api/health/_sync_water.js';
import { deleteAccount } from '../api/account/delete.js';
import cleanup from '../api/account/_circle_cleanup.cjs';

const UID = 'demo-new-water-account';
const RUN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DAY = '2026-10-13';
const NEXT = '2026-10-14';
const ROOT = `users/${UID}`;
const A = `${ROOT}/water_protocol/activation`;
const E = `${ROOT}/water_protocol/eligibility`;
const M = `${ROOT}/water_protocol/provisioning`;
const G = `account_deletion_guards/${UID}`;
const S = day => `${ROOT}/water_state/${day}`;
const H = day => `${ROOT}/health_info/${day}`;
const R = `${ROOT}/water_increment_receipts/${ID}`;
const CREATED = Timestamp.fromDate(new Date(`${DAY}T10:00:00.000Z`));
const CLOCK = Timestamp.fromDate(new Date(`${NEXT}T12:00:00.000Z`));
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
      limit: n => this.query(path, group, filters, n), orderBy: () => q,
      get: async () => this.querySnapshot(q, this.docs, this.created) };
    return q;
  }
  collection(path) {
    return { ...this.query(path), doc: id => this.ref(`${path}/${id}`) };
  }
  collectionGroup(name) { return this.query(name, true); }
  ref(path) {
    return { path, kind: 'doc', collection: name => this.collection(`${path}/${name}`),
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
      q.filters.every(f => f.op === '==' && docs.get(p)?.[f.field] === f.value))
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
  async recursiveDelete(ref) {
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
function fixture() {
  const db = new FakeFirestore();
  db.put(ROOT, { activeCircleId: null });
  db.put(E, { version: 1, uid: UID, runId: RUN, policy: 'NEW_ACCOUNT_V2_ONLY',
    legacyWritersExcluded: true, initialHealthDay: DAY, issuedAt: CREATED });
  const api = createWaterProvisioningTestHarness({ db, uid: UID, runId: RUN, now: () => CLOCK });
  const call = (label = 'account') => context.run(label, api.initializeAccount);
  const next = (day = NEXT, label = 'day') => context.run(label, () => api.initializeDay(day));
  return { db, api, call, next };
}
const check = (name, fn) => test(name, { timeout: 5000 }, fn);
const rejected = (promise, code) => assert.rejects(promise, e => e.code === code);
const unchanged = (db, before, count = 0) => {
  assert.deepEqual([...db.docs], before); assert.equal(db.writes.length, count);
};
async function increment(f, id = ID, day = DAY) {
  return syncWater({ db: f.db, userId: UID, enabled: true, body: { operation: 'increment_water',
    version: 2, mutationId: id, healthDay: day, deltaMl: 250, occurredAt: `${day}T12:00:00.000Z`,
    timeZoneOffsetMinutes: 0, originEpoch: f.db.docs.get(A).epoch } });
}
const cycle = { isEnabled: true, lastPeriodStart: '2026-10-01', cycleLengthDays: 28, periodLengthDays: 5 };

check('first eligible account atomically creates exact A/S/H and stable manifest, zero receipts', async () => {
  const f = fixture(), result = await f.call();
  assert.match(result.epoch, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(f.db.docs.get(A), { protocolVersion: 2, epoch: result.epoch, status: 'ACTIVE', legacyWritesBlocked: true });
  assert.deepEqual(f.db.docs.get(S(DAY)), { protocolVersion: 2, epoch: result.epoch, revision: 0, waterIntakeMl: 0 });
  assert.deepEqual(f.db.docs.get(H(DAY)), { waterIntakeMl: 0, date: Timestamp.fromDate(new Date(`${DAY}T00:00:00.000Z`)) });
  assert.equal(f.db.docs.get(M).runId, RUN); assert.equal(f.db.writes.length, 4);
  assert.equal([...f.db.docs.keys()].some(p => /receipts|intents/.test(p)), false);
  const reconciled = await syncWater({ db: f.db, userId: UID, enabled: true,
    body: { operation: 'reconcile_water', version: 2, healthDay: DAY, pendingMutationIds: [] } });
  assert.equal(reconciled.waterIntakeMl, 0); assert.equal(reconciled.revision, 0);
});
for (const fields of [{ mood: 'happy' }, { hasTakenPillToday: true, menstrualCycle: cycle },
  { mood: 'calm', hasTakenPillToday: false, menstrualCycle: cycle }]) {
  check(`preserves legitimate Health/date ${JSON.stringify(fields)}`, async () => {
    const f = fixture(), original = { ...fields, date: CREATED }; f.db.put(H(DAY), original);
    await f.call(); assert.deepEqual(f.db.docs.get(H(DAY)), { ...original, waterIntakeMl: 0 });
    assert.equal(f.db.writes.find(w => w.ref.path === H(DAY)).type, 'update');
  });
}
check('missing root never recreated even with admission and orphan descendants', async () => {
  const f = fixture(); f.db.put(ROOT, undefined); const before = [...f.db.docs];
  await rejected(f.call(), 'WATER_USER_NOT_FOUND'); unchanged(f.db, before);
});
for (const guard of [{ state: 'IN_PROGRESS' }, { state: 'COMPLETE', retainUntil: Timestamp.fromMillis(1) }, {}, null]) {
  check(`any existing guard rejects ${JSON.stringify(guard)}`, async () => {
    const f = fixture(); f.db.put(G, guard); const before = [...f.db.docs];
    await rejected(f.call(), 'WATER_ACCOUNT_DELETING'); unchanged(f.db, before);
  });
}
check('root deletion state blocks even without global guard', async () => {
  const f = fixture(); f.db.put(ROOT, { _serverAccountDeletion: {} });
  await rejected(f.call(), 'WATER_ACCOUNT_DELETING'); assert.equal(f.db.writes.length, 0);
});
for (const change of [undefined, {}, { uid: 'other' }, { runId: OTHER }, { policy: 'LEGACY_EMPTY' },
  { legacyWritersExcluded: false }, { issuedAt: '2026-10-13' }, { initialHealthDay: '2026-02-30' }, { extra: true }]) {
  check(`remote admission absent/malformed/inconsistent ${JSON.stringify(change)}`, async () => {
    const f = fixture(); f.db.put(E, change === undefined ? undefined : { ...f.db.docs.get(E), ...change });
    if (change && Object.keys(change).length === 0) f.db.put(E, {});
    const before = [...f.db.docs]; await rejected(f.call(), 'WATER_PROVISION_UNAUTHORIZED'); unchanged(f.db, before);
  });
}
for (const source of ['root', 'admission']) check(`retrofit admission cannot prove a new account: ${source} creation time`, async () => {
  const f = fixture(); f.db.created.set(source === 'root' ? ROOT : E, Timestamp.fromMillis(CREATED.toMillis() - 1));
  await rejected(f.call(), 'WATER_PROVISION_UNAUTHORIZED'); assert.equal(f.db.writes.length, 0);
});
for (const uid of ['', '.', '..', '__reserved__', 'bad/path', ' owner ', 'x'.repeat(129), 'a\n', 'é'.repeat(70)]) {
  check(`canonical server UID rejects ${JSON.stringify(uid)}`, () => {
    assert.throws(() => createWaterProvisioningTestHarness({ db: new FakeFirestore(), uid, runId: RUN }),
      e => e.code === 'WATER_INVALID_PROVISION_INPUT');
  });
}
for (const path of [H(DAY), H('2026-10-12'), H('2026-10-14')]) {
  for (const waterIntakeMl of [0, 1250]) check(`any V1 water history refuses, including zero: ${path}/${waterIntakeMl}`, async () => {
    const f = fixture(); f.db.put(path, { date: CREATED, waterIntakeMl }); const before = [...f.db.docs];
    await rejected(f.call(), 'WATER_PROVISION_NOT_ELIGIBLE'); unchanged(f.db, before);
  });
}
for (const path of [S(DAY), S(NEXT), R, `${ROOT}/water_increment_intents/${ID}`]) {
  check(`known orphan state/receipt/intent is not a baseline: ${path}`, async () => {
    const f = fixture(); f.db.put(path, { healthDay: DAY }); const before = [...f.db.docs];
    await rejected(f.call(), 'WATER_PROVISION_NOT_ELIGIBLE'); unchanged(f.db, before);
  });
}
check('history bound overflow refuses rather than sampling empty water', async () => {
  const f = fixture();
  for (let i = 1; i <= 101; i++) f.db.put(H(new Date(Date.UTC(2025, 0, i)).toISOString().slice(0, 10)), { date: CREATED, mood: 'ok' });
  await rejected(f.call(), 'WATER_PROVISION_NOT_ELIGIBLE'); assert.equal(f.db.writes.length, 0);
});
for (const data of [{ mood: 'ok' }, { date: '2026-10-13', mood: 'ok' }, { date: CREATED, hasTakenPillToday: 'yes' },
  { date: CREATED, menstrualCycle: { ...cycle, periodLengthDays: 29 } }, { date: CREATED, extra: true }]) {
  check(`malformed Health/timestamp fails closed ${JSON.stringify(data)}`, async () => {
    const f = fixture(); f.db.put(H(DAY), data); const before = [...f.db.docs];
    await rejected(f.call(), 'WATER_INVALID_REMOTE_STATE'); unchanged(f.db, before);
  });
}
check('retry and subsequent first/day calls return same epoch with no writes', async () => {
  const f = fixture(), first = await f.call(), before = [...f.db.docs];
  assert.deepEqual(await f.call(), { ...first, alreadyProvisioned: true });
  assert.deepEqual(await f.next(DAY), { ...first, alreadyProvisioned: true }); unchanged(f.db, before, 4);
});
check('concurrent first calls commit one epoch, loser retries actual callback', async () => {
  const f = fixture(), hold = gate(); f.db.hooks.beforeCommit = async r => {
    if (r.label === 'A' && r.attempt === 1) await hold.hold();
  };
  const a = f.call('A'); await hold.reached; const b = await f.call('B'); hold.release();
  const result = await a; assert.equal(result.epoch, b.epoch); assert.equal(result.alreadyProvisioned, true);
  assert.equal(f.db.conflicts.length, 1); assert.equal(f.db.writes.length, 4);
});
check('commit confirmed but response lost reuses durable epoch/runId', async () => {
  const f = fixture(); f.db.hooks.afterCommit = () => { throw new Error('lost response'); };
  await assert.rejects(f.call(), /lost response/); const before = [...f.db.docs]; delete f.db.hooks.afterCommit;
  const result = await f.call(); assert.equal(result.epoch, f.db.docs.get(M).epoch); unchanged(f.db, before, 4);
});
check('advanced state and real receipts survive both initial/day retries without reset', async () => {
  const f = fixture(); await f.call(); await increment(f); await increment(f, OTHER);
  const before = [...f.db.docs], count = f.db.writes.length;
  for (const result of [await f.call(), await f.next(DAY)]) {
    assert.equal(result.revision, 2); assert.equal(result.waterIntakeMl, 500); assert.equal(result.alreadyProvisioned, true);
  }
  unchanged(f.db, before, count); assert.equal(f.db.docs.get(R).revision, 1);
});
for (const patch of [{ epoch: 'legacy' }, { epoch: RUN.toUpperCase() }, { legacyWritesBlocked: false },
  { protocolVersion: 1 }, { status: 'PREPARING' }, { extra: true }]) {
  check(`malformed/conflicting marker rejects without repair ${JSON.stringify(patch)}`, async () => {
    const f = fixture(); await f.call(); f.db.put(A, { ...f.db.docs.get(A), ...patch }); const before = [...f.db.docs];
    await rejected(f.call(), 'WATER_INVALID_REMOTE_STATE'); unchanged(f.db, before, 4);
  });
}
for (const path of [A, M, S(DAY), H(DAY)]) check(`partial initialized set is never reset: absent ${path}`, async () => {
  const f = fixture(); await f.call(); f.db.put(path, undefined); const before = [...f.db.docs];
  await rejected(f.call(), 'WATER_INVALID_REMOTE_STATE'); unchanged(f.db, before, 4);
});
for (const patch of [{ revision: -1 }, { revision: 0.5 }, { waterIntakeMl: 1 }, { waterIntakeMl: 1000001 },
  { epoch: OTHER }, { protocolVersion: 1 }, { extra: true }]) {
  check(`divergent state rejects ${JSON.stringify(patch)}`, async () => {
    const f = fixture(); await f.call(); f.db.put(S(DAY), { ...f.db.docs.get(S(DAY)), ...patch });
    await rejected(f.call(), 'WATER_INVALID_REMOTE_STATE'); assert.equal(f.db.writes.length, 4);
  });
}
check('H differing from confirmed S refuses and never adopts V1 total', async () => {
  const f = fixture(); await f.call(); await increment(f); f.db.put(H(DAY), { date: CREATED, waterIntakeMl: 500 });
  const before = [...f.db.docs]; await rejected(f.call(), 'WATER_INVALID_REMOTE_STATE'); unchanged(f.db, before, 7);
});
check('receipt at revision zero is conflicting, cannot fabricate baseline', async () => {
  const f = fixture(); await f.call(); f.db.put(R, { healthDay: DAY });
  await rejected(f.call(), 'WATER_INVALID_REMOTE_STATE'); assert.equal(f.db.writes.length, 4);
});
check('server next day preserves Health, reuses epoch and leaves previous advanced day intact', async () => {
  const f = fixture(); await f.call(); await increment(f); const previous = copy(f.db.docs.get(S(DAY)));
  f.db.put(H(NEXT), { date: CLOCK, mood: 'ok', hasTakenPillToday: true, menstrualCycle: cycle });
  const result = await f.next(); assert.equal(result.epoch, previous.epoch); assert.equal(result.revision, 0);
  assert.deepEqual(f.db.docs.get(S(DAY)), previous);
  assert.deepEqual(f.db.docs.get(H(NEXT)), { date: CLOCK, mood: 'ok', hasTakenPillToday: true, menstrualCycle: cycle, waterIntakeMl: 0 });
  const before = [...f.db.docs], count = f.db.writes.length; await increment(f, OTHER, NEXT);
  const advanced = [...f.db.docs]; assert.equal((await f.next()).waterIntakeMl, 250); unchanged(f.db, advanced, count + 3);
  assert.equal(before.find(([p]) => p === S(NEXT))[1].waterIntakeMl, 0);
});
check('next day cannot initialize an account with no ACTIVE marker', async () => {
  const f = fixture(); await rejected(f.next(), 'WATER_PROVISION_NOT_ELIGIBLE'); assert.equal(f.db.writes.length, 0);
});
for (const day of ['2026-10-12', '2026-10-16', '2026-02-30', '2026-1-1', '../other', '0000-01-01', undefined]) {
  check(`server day rejects history/future/noncanonical ${day}`, async () => {
    const f = fixture(); await f.call();
    const input = day === undefined ? undefined : day;
    await rejected(f.api.initializeDay(input), ['2026-10-12', '2026-10-16'].includes(day)
      ? 'WATER_PROVISION_NOT_ELIGIBLE' : 'WATER_INVALID_PROVISION_INPUT'); assert.equal(f.db.writes.length, 4);
  });
}
for (const waterIntakeMl of [0, 1250]) check(`missing future S does not make existing H water ${waterIntakeMl} new`, async () => {
  const f = fixture(); await f.call(); f.db.put(H(NEXT), { date: CLOCK, waterIntakeMl });
  const before = [...f.db.docs]; await rejected(f.next(), 'WATER_PROVISION_NOT_ELIGIBLE'); unchanged(f.db, before, 4);
});
check('orphan future receipt refuses new day', async () => {
  const f = fixture(); await f.call(); f.db.put(R, { healthDay: NEXT });
  await rejected(f.next(), 'WATER_PROVISION_NOT_ELIGIBLE'); assert.equal(f.db.writes.length, 4);
});
check('future day cannot hide missing original state', async () => {
  const f = fixture(); await f.call(); f.db.put(S(DAY), undefined);
  await rejected(f.next(), 'WATER_INVALID_REMOTE_STATE'); assert.equal(f.db.writes.length, 4);
});
for (const stage of ['read', 'commit']) check(`failure ${stage} leaves no partial ACTIVE and retry succeeds`, async () => {
  const f = fixture(), before = [...f.db.docs];
  if (stage === 'read') f.db.hooks.onRead = () => { throw new Error('storage secret'); };
  else f.db.hooks.beforeCommit = () => { throw new Error('storage secret'); };
  await assert.rejects(f.call(), /storage secret/); unchanged(f.db, before); f.db.hooks = {};
  assert.equal((await f.call()).alreadyProvisioned, false); assert.equal(f.db.writes.length, 4);
});
for (const race of ['guard', 'root', 'admission', 'health phantom', 'state phantom', 'receipt phantom', 'intent phantom', 'protocol phantom']) {
  check(`transaction retry revalidates ${race} before all writes`, async () => {
    const f = fixture(), hold = gate(); f.db.hooks.beforeCommit = async r => { if (r.label === 'account' && r.attempt === 1) await hold.hold(); };
    const pending = f.call(); await hold.reached;
    const expected = { guard: 'WATER_ACCOUNT_DELETING', root: 'WATER_USER_NOT_FOUND', admission: 'WATER_PROVISION_UNAUTHORIZED',
      'health phantom': 'WATER_PROVISION_NOT_ELIGIBLE', 'state phantom': 'WATER_PROVISION_NOT_ELIGIBLE',
      'receipt phantom': 'WATER_PROVISION_NOT_ELIGIBLE', 'intent phantom': 'WATER_PROVISION_NOT_ELIGIBLE',
      'protocol phantom': 'WATER_INVALID_REMOTE_STATE' }[race];
    if (race === 'guard') await cleanup.beginGuard(f.db, UID);
    if (race === 'root') f.db.put(ROOT, undefined);
    if (race === 'admission') f.db.put(E, { ...f.db.docs.get(E), runId: OTHER });
    if (race === 'health phantom') f.db.put(H('2026-10-12'), { date: CREATED, waterIntakeMl: 250 });
    if (race === 'state phantom') f.db.put(S(NEXT), {});
    if (race === 'receipt phantom') f.db.put(R, { healthDay: NEXT });
    if (race === 'intent phantom') f.db.put(`${ROOT}/water_increment_intents/${ID}`, {});
    if (race === 'protocol phantom') f.db.put(`${ROOT}/water_protocol/unknown`, {});
    const before = [...f.db.docs], count = f.db.writes.length; hold.release();
    await rejected(pending, expected); unchanged(f.db, before, count); assert.equal(f.db.conflicts.length, 1);
  });
}
check('concurrent Health mood update survives retry with unchanged epoch candidate', async () => {
  const f = fixture(), hold = gate(); f.db.put(H(DAY), { date: CREATED, mood: 'old' });
  let candidate; f.db.hooks.beforeCommit = async r => {
    if (r.attempt === 1) { candidate = r.pending.find(w => w.ref.path === A).data.epoch; await hold.hold(); }
  };
  const pending = f.call(); await hold.reached; f.db.put(H(DAY), { date: CREATED, mood: 'new' }); hold.release();
  assert.equal((await pending).epoch, candidate); assert.equal(f.db.docs.get(H(DAY)).mood, 'new');
  assert.equal(f.db.conflicts.length, 1); assert.equal(f.db.writes.length, 4);
});
check('next-day concurrent initialization and increment cannot reset another device', async () => {
  const f = fixture(); await f.call(); const hold = gate();
  f.db.hooks.beforeCommit = async r => { if (r.label === 'delayed' && r.attempt === 1) await hold.hold(); };
  const pending = f.next(NEXT, 'delayed'); await hold.reached; await f.next(); await increment(f, ID, NEXT);
  const before = [...f.db.docs], count = f.db.writes.length; hold.release();
  const result = await pending; assert.equal(result.revision, 1); assert.equal(result.waterIntakeMl, 250);
  unchanged(f.db, before, count); assert.equal(f.db.conflicts.length, 1);
});
function deletionAuth(calls = []) {
  let present = true;
  return {
    async getUser(uid) {
      assert.equal(uid, UID);
      if (!present) throw Object.assign(new Error('synthetic absent'), {code: 'auth/user-not-found'});
      return {uid, metadata: {creationTime: CREATED.toDate().toUTCString()}};
    },
    async deleteUser(uid) {assert.equal(uid, UID); calls.push(uid); present = false;},
  };
}
for (const partial of [false, true]) check(`real deleteAccount removes provisioned account tree; partial retry=${partial}`, async () => {
  const f = fixture(); await f.call(); await f.next(); await increment(f);
  f.db.put('users/other-account/health_info/2026-10-13', { date: CREATED, waterIntakeMl: 750 });
  const calls = [], auth = deletionAuth(calls);
  if (partial) {
    f.db.partialCleanup = true;
    await assert.rejects(deleteAccount({ db: f.db, auth, uid: UID }), /partial recursive cleanup/);
    assert.equal(f.db.docs.get(G).state, 'IN_PROGRESS'); assert.equal(f.db.docs.has(R), true);
    await rejected(f.call(), 'WATER_USER_NOT_FOUND');
  }
  const result = await deleteAccount({ db: f.db, auth, uid: UID });
  assert.equal(result.body.deleted, true); assert.equal(f.db.docs.get(G).state, 'COMPLETE');
  assert.equal([...f.db.docs.keys()].some(p => p === ROOT || p.startsWith(`${ROOT}/`)), false);
  assert.equal(f.db.docs.get('users/other-account/health_info/2026-10-13').waterIntakeMl, 750);
  assert.deepEqual(calls, Array(partial ? 2 : 1).fill(UID));
});
check('actual concurrent deletion wins, provision retries without resurrecting descendants', async () => {
  const f = fixture(), hold = gate(); f.db.hooks.beforeCommit = async r => {
    if (r.label === 'provision' && r.attempt === 1) await hold.hold();
  };
  const pending = f.call('provision'); await hold.reached;
  await deleteAccount({ db: f.db, auth: deletionAuth(), uid: UID });
  const before = [...f.db.docs], count = f.db.writes.length; hold.release();
  await rejected(pending, 'WATER_USER_NOT_FOUND'); unchanged(f.db, before, count);
  assert.equal(f.db.conflicts.length, 1); assert.equal(f.db.docs.has(A), false);
});
check('disabled production functions ignore request/env/options before touching Firestore', async t => {
  assert.equal(WATER_V2_ENABLED, false);
  const names = ['WATER_V2_ENABLED', 'WATER_PROVISIONING_ENABLED'];
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
  }));
  names.forEach(name => { process.env[name] = 'true'; });
  const db = { runTransaction: () => assert.fail('production IO'), collection: () => assert.fail('production IO') };
  for (const fn of [provisionWaterAccount, provisionWaterDay]) {
    await rejected(fn({ db, uid: 'victim', enabled: true, status: 'ACTIVE', epoch: RUN, waterIntakeMl: 1250,
      body: { enabled: true }, runtime: { waterV2Enabled: true } }), 'WATER_V2_DISABLED');
  }
});
check('no public handler/dispatcher integration, default Firebase initialization or V1 writer in new module', async () => {
  const source = await readFile(new URL('../api/health/_provision_water.js', import.meta.url), 'utf8');
  const sync = await readFile(new URL('../api/sync.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /export default|process\.env|initializeApp|getFirestore|createAccountHandler/);
  assert.doesNotMatch(sync, /_provision_water|provisionWater|initialize_water/);
  assert.ok(sync.includes("code: 'SYNC_OPERATION_REQUIRED'"));
  assert.equal(WATER_V2_ENABLED, false);
});
check('storage cannot forge domain error or leak internal identity in sanitized result', () => {
  assert.deepEqual(provisioningError(Object.assign(new Error('secret uid path token'), { code: 'WATER_ACCOUNT_DELETING' })),
    { code: 'WATER_PROVISION_STORAGE_UNAVAILABLE', message: 'Provisionamento de hidratação indisponível.' });
});
for (const change of [{ runId: OTHER }, { epoch: OTHER }, { initialHealthDay: NEXT },
  { accountCreatedAt: Timestamp.fromMillis(1) }, { provisionedAt: 'invalid' },
  { provisionedAt: Timestamp.fromMillis(CLOCK.toMillis() + 1) }, { extra: true }]) {
  check(`manifest identity/timestamps cannot be replaced ${JSON.stringify(change)}`, async () => {
    const f = fixture(); await f.call(); f.db.put(M, { ...f.db.docs.get(M), ...change }); const before = [...f.db.docs];
    await rejected(f.call(), 'WATER_INVALID_REMOTE_STATE'); unchanged(f.db, before, 4);
  });
}
for (const initialHealthDay of ['2026-10-10', '2026-10-16']) {
  check(`admission day must describe account creation, not historical/future reset ${initialHealthDay}`, async () => {
    const f = fixture(); f.db.put(E, { ...f.db.docs.get(E), initialHealthDay });
    await rejected(f.call(), 'WATER_PROVISION_UNAUTHORIZED'); assert.equal(f.db.writes.length, 0);
  });
}
for (const change of [{ fingerprint: 'tampered' }, { revision: 0 }, { epoch: OTHER },
  { appliedAt: 'invalid' }, { effectiveCreditMl: 0 }]) {
  check(`observed existing receipt must satisfy approved sync contract ${JSON.stringify(change)}`, async () => {
    const f = fixture(); await f.call(); await increment(f); f.db.put(R, { ...f.db.docs.get(R), ...change });
    const before = [...f.db.docs]; await rejected(f.call(), 'WATER_INVALID_REMOTE_STATE'); unchanged(f.db, before, 7);
  });
}
check('advanced revision without any daily receipt cannot be blessed by provisioning', async () => {
  const f = fixture(); await f.call(); await increment(f); f.db.put(R, undefined);
  const before = [...f.db.docs]; await rejected(f.call(), 'WATER_INVALID_REMOTE_STATE'); unchanged(f.db, before, 7);
});
check('admission revoked on read-only retry cannot authorize an idempotent result', async () => {
  const f = fixture(); await f.call(); const hold = gate(); f.db.hooks.beforeCommit = async r => {
    if (r.label === 'read-only' && r.attempt === 1) await hold.hold();
  };
  const pending = f.call('read-only'); await hold.reached;
  f.db.put(E, { ...f.db.docs.get(E), legacyWritersExcluded: false }); const before = [...f.db.docs]; hold.release();
  await rejected(pending, 'WATER_PROVISION_UNAUTHORIZED'); unchanged(f.db, before, 4); assert.equal(f.db.conflicts.length, 1);
});
check('saturation state and original receipt survive provisioning without artificial credits', async () => {
  const f = fixture(); await f.call();
  f.db.put(S(DAY), { ...f.db.docs.get(S(DAY)), waterIntakeMl: 1_000_000, revision: 4000 });
  f.db.put(H(DAY), { ...f.db.docs.get(H(DAY)), waterIntakeMl: 1_000_000 });
  await increment(f); const before = [...f.db.docs], count = f.db.writes.length;
  const result = await f.call(); assert.equal(result.waterIntakeMl, 1_000_000); assert.equal(result.revision, 4001);
  assert.equal(f.db.docs.get(R).effectiveCreditMl, 0); unchanged(f.db, before, count);
});
check('server clock/timestamp integrity is required even for a valid admission', async () => {
  for (const now of [() => '2026-10-14', () => Timestamp.fromMillis(CREATED.toMillis() - 1)]) {
    const f = fixture(), api = createWaterProvisioningTestHarness({ db: f.db, uid: UID, runId: RUN, now });
    await assert.rejects(api.initializeAccount()); assert.equal(f.db.writes.length, 0);
  }
});
check('actual public sync rejects client provisioning operations and flags without any Firestore call', async t => {
  const { getApps, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'demo-provisioning-no-network' });
  const { syncHandler } = await import('../api/sync.js');
  const db = getFirestore();
  t.mock.method(db, 'collection', () => assert.fail('public provisioning must not access Firestore'));
  t.mock.method(db, 'runTransaction', () => assert.fail('public provisioning must not start a transaction'));
  const runtime = { verifyAppCheckToken: async () => ({}),
    verifyIdToken: async (_, revoked) => { assert.equal(revoked, true); return { uid: UID }; },
    checkRateLimit: async () => true, waterV2Enabled: true };
  for (const operation of ['provision_water', 'initialize_water_account', 'initialize_water_day']) {
    const res = { setHeader() {}, status(status) { this.statusCode = status; return this; },
      json(body) { this.body = body; return this; } };
    await syncHandler({ method: 'POST', headers: { authorization: 'Bearer fixture',
      'x-firebase-appcheck': 'fixture' }, body: { operation, enabled: true, uid: 'victim', healthDay: DAY } }, res, runtime);
    assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'SYNC_OPERATION_REQUIRED');
  }
});

// H2-R3-D-F1: a provisioned later day must also prove the initial committed set.
async function f1AdvancedDays() {
  const f = fixture();
  f.db.put(H(DAY), { date: CREATED, mood: 'initial', hasTakenPillToday: true, menstrualCycle: cycle });
  await f.call(); await increment(f);
  f.db.put(H(NEXT), { date: CLOCK, mood: 'later', hasTakenPillToday: false, menstrualCycle: cycle });
  await f.next(); await increment(f, OTHER, NEXT);
  f.db.put('users/f1-other-account/health_info/2026-10-13', { date: CREATED, waterIntakeMl: 750, mood: 'other' });
  return f;
}
async function f1Rejected(promise) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'WATER_INVALID_REMOTE_STATE');
    assert.deepEqual(provisioningError(error), { code: 'WATER_INVALID_REMOTE_STATE',
      message: 'Provisionamento de hidratação indisponível.' });
    assert.doesNotMatch(error.message, /demo-new-water-account|users\/|epoch|secret/);
    return true;
  });
}
check('F1 provisioned later day accepts advanced consistent initial day without writes or duplicate reads', async () => {
  const f = await f1AdvancedDays(), before = [...f.db.docs], count = f.db.writes.length, reads = [];
  f.db.hooks.onRead = ({ path }) => reads.push(path);
  const result = await f.next();
  assert.equal(result.alreadyProvisioned, true); assert.equal(result.revision, 1);
  assert.equal(result.waterIntakeMl, 250); assert.equal(result.epoch, f.db.docs.get(A).epoch);
  assert.equal(f.db.docs.get(S(DAY)).revision, 1); assert.equal(f.db.docs.get(R).revision, 1);
  assert.equal(f.db.docs.get(`${ROOT}/water_increment_receipts/${OTHER}`).revision, 1);
  assert.equal(reads.filter(p => p === S(DAY)).length, 1);
  assert.equal(reads.filter(p => p === H(DAY)).length, 1);
  unchanged(f.db, before, count);
});
const f1Corruptions = [
  ['missing initial S', db => db.put(S(DAY), undefined)],
  ['missing initial H', db => db.put(H(DAY), undefined)],
  ['wrong initial epoch', db => db.put(S(DAY), { ...db.docs.get(S(DAY)), epoch: OTHER })],
  ['divergent initial totals', db => db.put(H(DAY), { ...db.docs.get(H(DAY)), waterIntakeMl: 500 })],
  ['malformed initial state schema', db => db.put(S(DAY), { ...db.docs.get(S(DAY)), extra: true })],
  ['invalid initial revision', db => db.put(S(DAY), { ...db.docs.get(S(DAY)), revision: -1 })],
  ['malformed initial Health timestamp', db => db.put(H(DAY), { ...db.docs.get(H(DAY)), date: 'invalid' })],
];
for (const [name, corrupt] of f1Corruptions) {
  check(`F1 provisioned later day refuses ${name}, preserving receipts/Health/other UID`, async () => {
    const f = await f1AdvancedDays(); corrupt(f.db);
    const before = [...f.db.docs], count = f.db.writes.length;
    await f1Rejected(f.next()); unchanged(f.db, before, count);
    assert.ok(f.db.attempts.at(-1).reads.has(S(DAY)));
    assert.ok(f.db.attempts.at(-1).reads.has(H(DAY)));
    assert.equal(f.db.attempts.at(-1).pending.length, 0);
  });
}
for (const [name, corrupt] of f1Corruptions.slice(0, 4)) {
  check(`F1 initial-day race ${name} retries idempotent later-day callback and fails closed`, async () => {
    const f = await f1AdvancedDays(), hold = gate();
    f.db.hooks.beforeCommit = async record => {
      if (record.label === 'F1-existing-day' && record.attempt === 1) await hold.hold();
    };
    const pending = f.next(NEXT, 'F1-existing-day'); await hold.reached;
    corrupt(f.db); const before = [...f.db.docs], count = f.db.writes.length; hold.release();
    await f1Rejected(pending); unchanged(f.db, before, count);
    assert.equal(f.db.conflicts.length, 1);
    assert.ok(f.db.conflicts[0].changed.some(p => p === S(DAY) || p === H(DAY)));
    const attempts = f.db.attempts.filter(r => r.label === 'F1-existing-day');
    assert.equal(attempts.length, 2); assert.ok(attempts.every(r => r.pending.length === 0));
  });
}
check('F1 opening a new later day validates initial S/H once and retains advanced state', async () => {
  const f = fixture(); await f.call(); await increment(f);
  const initial = [copy(f.db.docs.get(S(DAY))), copy(f.db.docs.get(H(DAY))), copy(f.db.docs.get(R))], reads = [];
  f.db.hooks.onRead = ({ path }) => reads.push(path);
  const result = await f.next(); assert.equal(result.alreadyProvisioned, false);
  assert.equal(reads.filter(p => p === S(DAY)).length, 1);
  assert.equal(reads.filter(p => p === H(DAY)).length, 1);
  assert.deepEqual([f.db.docs.get(S(DAY)), f.db.docs.get(H(DAY)), f.db.docs.get(R)], initial);
});

// H2-R3-E-F2: creation metadata proves the atomic origin; issuedAt is informational.
for (const issuedAt of [Timestamp.fromMillis(CREATED.toMillis() - 2), Timestamp.fromMillis(CREATED.toMillis() + 2),
  new Timestamp(CREATED.seconds, CREATED.nanoseconds + 1), new Timestamp(CREATED.seconds - 1, 999999999)]) {
  check(`F2 equal createTimes admit distinct issuedAt ${issuedAt.seconds}/${issuedAt.nanoseconds}`, async () => {
    const f = fixture(); f.db.put(E, { ...f.db.docs.get(E), issuedAt });
    const first = await f.call(), before = [...f.db.docs];
    assert.equal(first.alreadyProvisioned, false); assert.equal(first.revision, 0); assert.equal(first.waterIntakeMl, 0);
    assert.equal((await f.call()).epoch, first.epoch); unchanged(f.db, before, 4);
    assert.equal(f.db.created.get(ROOT).isEqual(f.db.created.get(E)), true);
    assert.equal(issuedAt.isEqual(f.db.created.get(ROOT)), false);
  });
}
for (const issuedAt of ['malformed', Timestamp.fromMillis(CLOCK.toMillis() + 1), new Timestamp(CLOCK.seconds, CLOCK.nanoseconds + 1)]) {
  check(`F2 malformed/future issuedAt refuses ${JSON.stringify(issuedAt)}`, async () => {
    const f = fixture(); f.db.put(E, { ...f.db.docs.get(E), issuedAt }); const before = [...f.db.docs];
    await rejected(f.call(), 'WATER_PROVISION_UNAUTHORIZED'); unchanged(f.db, before);
  });
}
check('F2 equal millis but different creation nanos cannot admit a later eligibility', async () => {
  const f = fixture(); f.db.created.set(E, new Timestamp(CREATED.seconds, CREATED.nanoseconds + 1));
  assert.equal(f.db.created.get(E).toMillis(), f.db.created.get(ROOT).toMillis());
  const before = [...f.db.docs]; await rejected(f.call(), 'WATER_PROVISION_UNAUTHORIZED'); unchanged(f.db, before);
});
check('F2 root recreated with old eligibility refuses without repairing any document', async () => {
  const f = fixture(); f.db.put(ROOT, undefined); f.db.put(ROOT, {}, Timestamp.fromMillis(CREATED.toMillis() + 1));
  const before = [...f.db.docs]; await rejected(f.call(), 'WATER_PROVISION_UNAUTHORIZED'); unchanged(f.db, before);
});
check('F2 valid distinct issuedAt cannot authorize another UID or runId', async () => {
  for (const change of [{ uid: 'other-owner' }, { runId: OTHER }]) {
    const f = fixture(); f.db.put(E, { ...f.db.docs.get(E), issuedAt: Timestamp.fromMillis(CREATED.toMillis() - 1), ...change });
    const before = [...f.db.docs]; await rejected(f.call(), 'WATER_PROVISION_UNAUTHORIZED'); unchanged(f.db, before);
  }
});
check('F2 valid distinct issuedAt cannot bypass a deletion guard or V1 history', async () => {
  for (const kind of ['guard', 'V1']) {
    const f = fixture(); f.db.put(E, { ...f.db.docs.get(E), issuedAt: Timestamp.fromMillis(CREATED.toMillis() - 1) });
    f.db.put('users/f2-other/health_info/2026-10-13', { date: CREATED, waterIntakeMl: 750 });
    if (kind === 'guard') f.db.put(G, {}); else f.db.put(H(DAY), { date: CREATED, waterIntakeMl: 0 });
    const before = [...f.db.docs]; await rejected(f.call(), kind === 'guard' ? 'WATER_ACCOUNT_DELETING' : 'WATER_PROVISION_NOT_ELIGIBLE');
    unchanged(f.db, before);
  }
});
