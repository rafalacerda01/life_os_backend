import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { Timestamp } from 'firebase-admin/firestore';
import { createWaterAdmissionIssuerTestHarness, issueWaterAdmission, admissionError } from '../api/health/_issue_water_admission.js';
import { createWaterProvisioningTestHarness } from '../api/health/_provision_water.js';
import { WATER_V2_ENABLED } from '../api/health/_sync_water.js';
const UID = 'new-synthetic-owner', DAY = '2026-10-13';
const DECISION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROOT = `users/${UID}`, E = `${ROOT}/water_protocol/eligibility`;
const P = `${ROOT}/runtime/water_admission`, G = `account_deletion_guards/${UID}`;
const CREATED = Timestamp.fromDate(new Date(`${DAY}T10:00:00.000Z`));
const CLOCK = Timestamp.fromDate(new Date(`${DAY}T10:05:00.000Z`));
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
function authority(uid = UID, decisionId = DECISION) {
  return { identity: { uid, email: 'synthetic@example.invalid', displayName: 'Synthetic', photoUrl: null },
    decision: { uid, decisionId, policy: 'NEW_ACCOUNT_V2_ONLY', legacyWritersExcluded: true, initialHealthDay: DAY } };
}
function fixture() {
  const db = new FakeFirestore(); let admission = authority(); let calls = 0;
  const resolve = () => { calls++; return copy(admission); };
  const api = createWaterAdmissionIssuerTestHarness({ db, getTrustedAdmission: resolve, now: () => CLOCK });
  return { db, api, get calls() { return calls; }, set admission(value) { admission = value; },
    call: (label = 'issue') => context.run(label, api.issue),
    again: () => createWaterAdmissionIssuerTestHarness({ db, getTrustedAdmission: resolve, now: () => CLOCK }).issue() };
}
const check = (name, fn) => test(name, { timeout: 5000 }, fn);
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
function unchanged(f, before, writes = 0) { assert.deepEqual([...f.db.docs], before); assert.equal(f.db.writes.length, writes); }
const profile = { email: 'synthetic@example.invalid', displayName: 'Synthetic', photoUrl: null,
  isPremium: false, xp: 0, level: 1, streak: 0, habitsCount: 0, tasksCount: 0, goalsCount: 0,
  subjectsCount: 0, medicationsCount: 0, transactionsCount: 0 };

check('issuer atomically creates compatible root, exact eligibility and durable decision proof only', async () => {
  const f = fixture(), result = await f.call(); assert.equal(result.alreadyIssued, false);
  assert.match(result.runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(f.db.docs.get(ROOT), profile);
  assert.deepEqual(f.db.docs.get(E), { version: 1, uid: UID, runId: result.runId, policy: 'NEW_ACCOUNT_V2_ONLY',
    legacyWritersExcluded: true, initialHealthDay: DAY, issuedAt: CLOCK });
  assert.equal(f.db.docs.get(P).decisionId, DECISION); assert.equal(f.db.docs.get(P).runId, result.runId);
  assert.match(f.db.docs.get(P).profileFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(f.db.created.get(ROOT).isEqual(f.db.created.get(E)) && f.db.created.get(ROOT).isEqual(f.db.created.get(P)));
  assert.deepEqual(f.db.writes.map(w => w.type), ['create', 'create', 'create']); assert.equal(f.calls, 2);
  assert.equal([...f.db.docs.keys()].some(p => /water_state|activation|health_info|receipts/.test(p)), false);
});
check('issuer replay survives new harness/process-like instance with original decision and runId, zero writes', async () => {
  const f = fixture(), first = await f.call(), before = [...f.db.docs];
  assert.deepEqual(await f.again(), { ...first, alreadyIssued: true }); unchanged(f, before, 3);
});
check('lost reply after confirmed issuer commit recovers same runId and profile without another grant', async () => {
  const f = fixture(); f.db.hooks.afterCommit = () => { throw new Error('lost reply'); };
  await assert.rejects(f.call(), /lost reply/); const before = [...f.db.docs], runId = f.db.docs.get(E).runId;
  f.db.hooks = {}; assert.equal((await f.again()).runId, runId); unchanged(f, before, 3);
});
check('legitimate updates to profile, XP, premium, counters and other modules remain untouched on replay', async () => {
  const f = fixture(); await f.call();
  f.db.put(ROOT, { ...profile, displayName: 'Edited', photoUrl: 'avatar_neural', xp: 500, level: 3,
    isPremium: true, tasksCount: 2, selectedFocusAreas: ['health'], hasCompletedOnboarding: true });
  f.db.put(`${ROOT}/tasks/keep`, { title: 'Task' }); const before = [...f.db.docs];
  assert.equal((await f.again()).alreadyIssued, true); unchanged(f, before, 3);
});
check('Rules-compatible name/photo updates do not inherit birth identity text restrictions on replay', async () => {
  const f = fixture(); await f.call();
  f.db.put(ROOT, { ...profile, displayName: ' Updated '.repeat(40), photoUrl: ' avatar '.repeat(300),
    selectedFocusAreas: ['health'], hasCompletedOnboarding: true, activeCircleId: null });
  const before = [...f.db.docs]; assert.equal((await f.again()).alreadyIssued, true); unchanged(f, before, 3);
});
check('issuer naturally feeds unchanged provisioner without creating epoch/water itself', async () => {
  const f = fixture(), admitted = await f.call(); assert.equal(f.db.docs.has(`${ROOT}/water_protocol/activation`), false);
  const prov = createWaterProvisioningTestHarness({ db: f.db, uid: UID, runId: admitted.runId, now: () => CLOCK });
  const initialized = await prov.initializeAccount(); assert.equal(initialized.waterIntakeMl, 0); assert.equal(initialized.revision, 0);
  const before = [...f.db.docs]; assert.equal((await f.again()).runId, admitted.runId); unchanged(f, before, 7);
  assert.equal((await prov.initializeAccount()).epoch, initialized.epoch); unchanged(f, before, 7);
});
for (const different of [false, true]) check(`two simultaneous issuers: ${different ? 'different decisions fail loser' : 'same decision replays one winner'}`, async () => {
  const f = fixture(), hold = gate();
  f.db.hooks.beforeCommit = async r => { if (r.label === 'A' && r.attempt === 1) await hold.hold(); };
  const pending = f.call('A'); await hold.reached;
  const other = createWaterAdmissionIssuerTestHarness({ db: f.db,
    getTrustedAdmission: () => authority(UID, different ? OTHER : DECISION), now: () => CLOCK });
  const winner = await context.run('B', other.issue); hold.release();
  if (different) await rejected(pending, 'WATER_ADMISSION_CONFLICT');
  else { const result = await pending; assert.equal(result.runId, winner.runId); assert.equal(result.alreadyIssued, true); }
  assert.equal(f.db.writes.length, 3); assert.equal(f.db.conflicts.length, 1); assert.equal(f.db.docs.size, 3);
});
check('transaction retry revalidates absence and reuses its single generated candidate runId', async () => {
  const f = fixture(); let runId;
  f.db.hooks.beforeCommit = r => {
    if (r.attempt === 1) { runId = r.pending.find(w => w.ref.path === E).data.runId; f.db.put(G, {}); f.db.put(G, undefined); }
  };
  assert.equal((await f.call()).runId, runId); assert.equal(f.db.conflicts.length, 1); assert.equal(f.db.writes.length, 3);
});
for (const data of [{ state: 'IN_PROGRESS' }, { state: 'COMPLETE', retainUntil: Timestamp.fromMillis(1) }, {}, null]) {
  check(`any existing deletion guard blocks issuance ${JSON.stringify(data)}`, async () => {
    const f = fixture(); f.db.put(G, data); const before = [...f.db.docs];
    await rejected(f.call(), 'WATER_ACCOUNT_DELETING'); unchanged(f, before);
  });
}
check('guard created after reads before commit forces retry then rejects all buffered creates', async () => {
  const f = fixture(), hold = gate(); f.db.hooks.beforeCommit = async r => { if (r.attempt === 1) await hold.hold(); };
  const pending = f.call(); await hold.reached; f.db.put(G, { state: 'IN_PROGRESS' }); const before = [...f.db.docs]; hold.release();
  await rejected(pending, 'WATER_ACCOUNT_DELETING'); unchanged(f, before); assert.equal(f.db.conflicts.length, 1);
});
check('client root wins a concurrent creation; issuer cannot retrofit eligibility', async () => {
  const f = fixture(), hold = gate(); f.db.hooks.beforeCommit = async r => { if (r.attempt === 1) await hold.hold(); };
  const pending = f.call(); await hold.reached; f.db.put(ROOT, profile); const before = [...f.db.docs]; hold.release();
  await rejected(pending, 'WATER_ADMISSION_CONFLICT'); unchanged(f, before); assert.equal(f.db.docs.has(E), false);
});
for (const name of ['water_protocol/activation', 'health_info/2026-10-13', 'water_state/2026-10-13',
  'water_increment_receipts/orphan', 'water_increment_intents/orphan', 'runtime/other']) {
  check(`root absent with known footprint ${name} refuses adoption`, async () => {
    const f = fixture(); f.db.put(`${ROOT}/${name}`, {}); const before = [...f.db.docs];
    await rejected(f.call(), 'WATER_ADMISSION_CONFLICT'); unchanged(f, before);
  });
}
for (const name of [ROOT, E, P]) check(`partial existing issuance never repaired: only ${name}`, async () => {
  const f = fixture(); f.db.put(name, name === ROOT ? profile : {}); const before = [...f.db.docs];
  await rejected(f.call(), 'WATER_ADMISSION_CONFLICT'); unchanged(f, before);
});
for (const name of [ROOT, E, P]) check(`confirmed issuance missing ${name} fails closed`, async () => {
  const f = fixture(); await f.call(); f.db.put(name, undefined); const before = [...f.db.docs];
  await rejected(f.call(), 'WATER_ADMISSION_CONFLICT'); unchanged(f, before, 3);
});
check('root recreated cannot reuse old eligibility/proof or overwrite another UID', async () => {
  const f = fixture(); await f.call(); f.db.put(ROOT, undefined); f.db.put(ROOT, profile, Timestamp.fromMillis(CLOCK.toMillis() + 1));
  f.db.put('users/other-user', profile); const before = [...f.db.docs];
  await rejected(f.call(), 'WATER_ADMISSION_CONFLICT'); unchanged(f, before, 3);
});
for (const path of [ROOT, E, P]) check(`creation metadata mismatch in ${path} fails exact, including nanos`, async () => {
  const f = fixture(); await f.call(); f.db.created.set(path, new Timestamp(CLOCK.seconds, CLOCK.nanoseconds + 1));
  const before = [...f.db.docs]; await rejected(f.call(), 'WATER_ADMISSION_CONFLICT'); unchanged(f, before, 3);
});
for (const [path, change] of [[E, { uid: 'other-user' }], [E, { runId: OTHER }], [E, { policy: 'V1' }],
  [E, { issuedAt: 'bad' }], [E, { issuedAt: new Timestamp(CLOCK.seconds, CLOCK.nanoseconds + 1) }],
  [P, { runId: OTHER }], [P, { decisionId: OTHER }], [P, { uid: 'other-user' }], [P, { profileFingerprint: 'tampered' }],
  [P, { extra: true }], [ROOT, { xp: -1 }], [ROOT, { tasksCount: 0.5 }], [ROOT, { _serverAccountDeletion: {} }]]) {
  check(`divergent stored proof/profile ${path} ${JSON.stringify(change)} refuses`, async () => {
    const f = fixture(); await f.call(); f.db.put(path, { ...f.db.docs.get(path), ...change }); const before = [...f.db.docs];
    await rejected(f.call(), path === ROOT && Object.hasOwn(change, '_serverAccountDeletion') ? 'WATER_ACCOUNT_DELETING' : 'WATER_ADMISSION_CONFLICT');
    unchanged(f, before, 3);
  });
}
check('different immutable decision or birth profile cannot replay someone else admission', async () => {
  const f = fixture(); await f.call(); const before = [...f.db.docs];
  f.admission = authority(UID, OTHER); await rejected(f.call(), 'WATER_ADMISSION_CONFLICT');
  f.admission = { ...authority(), identity: { ...authority().identity, displayName: 'Different birth' } };
  await rejected(f.call(), 'WATER_ADMISSION_CONFLICT'); unchanged(f, before, 3);
});
for (const stage of ['read', 'commit']) check(`failure at ${stage} never leaves partial profile/admission; retry recovers`, async () => {
  const f = fixture(), before = [...f.db.docs];
  if (stage === 'read') f.db.hooks.onRead = () => { throw new Error('storage failure'); };
  else f.db.hooks.beforeCommit = () => { throw new Error('commit failure'); };
  await assert.rejects(f.call()); unchanged(f, before); f.db.hooks = {};
  assert.equal((await f.call()).alreadyIssued, false); assert.equal(f.db.writes.length, 3);
});
for (const change of ['uid', 'decision', 'policy']) check(`privileged authority change ${change} is revalidated on retry`, async () => {
  const f = fixture(); f.db.hooks.beforeCommit = r => {
    if (r.attempt !== 1) return;
    f.admission = change === 'uid' ? authority('other-user') : change === 'decision' ? authority(UID, OTHER)
      : { ...authority(), decision: { ...authority().decision, policy: 'V1' } };
    f.db.put(G, {}); f.db.put(G, undefined);
  };
  await rejected(f.call(), 'WATER_ADMISSION_UNAUTHORIZED'); assert.equal(f.db.writes.length, 0); assert.equal(f.db.docs.size, 0);
});
for (const invalid of [undefined, {}, { identity: {}, decision: {} },
  { ...authority(), decision: { ...authority().decision, policy: 'V1' } },
  { ...authority(), decision: { ...authority().decision, legacyWritersExcluded: false } },
  { ...authority(), decision: { ...authority().decision, uid: 'other-user' } },
  { ...authority(), decision: { ...authority().decision, decisionId: 'local-1' } },
  { ...authority(), decision: { ...authority().decision, runId: OTHER } },
  { ...authority(), identity: { ...authority().identity, isPremium: true } }]) {
  check(`unverified/malformed/extra authority cannot enable issuer ${JSON.stringify(invalid)}`, async () => {
    const f = fixture(); f.admission = invalid; await rejected(f.call(), 'WATER_ADMISSION_UNAUTHORIZED'); assert.equal(f.db.attempts.length, 0);
  });
}
for (const bad of ['', 'uid/other', '.', '..', '__reserved__', 'x'.repeat(129), 'é'.repeat(70), 'bad\n', ' uid ']) {
  check(`canonical UID rejects ${JSON.stringify(bad)}`, async () => {
    const f = fixture(); f.admission = authority(bad); await rejected(f.call(), 'WATER_ADMISSION_UNAUTHORIZED'); assert.equal(f.db.attempts.length, 0);
  });
}
check('caller payload cannot override UID/runId or activate test seam via enabled option', async () => {
  const f = fixture(); await rejected(f.api.issue({ uid: 'victim', runId: OTHER, enabled: true }), 'WATER_ADMISSION_UNAUTHORIZED');
  assert.equal(f.calls, 0);
  assert.throws(() => createWaterAdmissionIssuerTestHarness({ db: f.db, getTrustedAdmission: () => authority(), enabled: true }),
    e => e.code === 'WATER_ADMISSION_INVALID_CONFIGURATION');
  assert.throws(() => createWaterAdmissionIssuerTestHarness({ db: f.db, getTrustedAdmission: authority() }),
    e => e.code === 'WATER_ADMISSION_INVALID_CONFIGURATION');
});
check('production entry remains disabled with environment and request flags, no DB access', async t => {
  const previous = process.env.WATER_V2_ENABLED; process.env.WATER_V2_ENABLED = 'true';
  t.after(() => { if (previous === undefined) delete process.env.WATER_V2_ENABLED; else process.env.WATER_V2_ENABLED = previous; });
  assert.equal(WATER_V2_ENABLED, false);
  await rejected(issueWaterAdmission({ enabled: true, uid: UID, getTrustedAdmission: () => assert.fail('authority bypass') }), 'WATER_V2_DISABLED');
});
check('storage errors cannot forge issuer domain errors or leak details', () => {
  assert.deepEqual(admissionError(Object.assign(new Error('secret-token user private-path'), { code: 'WATER_ACCOUNT_DELETING' })),
    { code: 'WATER_ADMISSION_STORAGE_UNAVAILABLE', message: 'Não foi possível admitir a conta para hidratação.' });
});
check('issuer has no endpoint/default DB/credentials/env and dispatcher never imports it', async () => {
  const source = await readFile(new URL('../api/health/_issue_water_admission.js', import.meta.url), 'utf8');
  const sync = await readFile(new URL('../api/sync.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /export default|process\.env|initializeApp|getFirestore|createAccountHandler/);
  assert.doesNotMatch(sync, /_issue_water_admission|issueWaterAdmission/);
});
