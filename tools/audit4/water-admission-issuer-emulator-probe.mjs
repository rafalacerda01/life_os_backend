// Explicit diagnostic only: node --test tools/audit4/water-admission-issuer-emulator-probe.mjs
// Requires a local demo-life-os Firestore emulator. Never imported by production.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { createWaterProvisioningTestHarness } from '../../api/health/_provision_water.js';
import { deleteAccount } from '../../api/account/delete.js';
import cleanup from '../../api/account/_circle_cleanup.cjs';
import { WATER_V2_ENABLED } from '../../api/health/_sync_water.js';

const PROJECT = 'demo-life-os';
const host = process.env.FIRESTORE_EMULATOR_HOST;
// Check before initializing a Firestore client, no fallback to production/ADC.
function assertEnvironment() {
  assert.match(host ?? '', /^(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}$/, 'LOOPBACK_EMULATOR_REQUIRED');
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, host, 'EMULATOR_HOST_CHANGED');
  assert.ok(Number(host.split(':')[1]) <= 65535, 'INVALID_EMULATOR_PORT');
  assert.equal(process.env.GCLOUD_PROJECT, PROJECT, 'EXACT_DEMO_PROJECT_REQUIRED');
  if (process.env.GOOGLE_CLOUD_PROJECT) assert.equal(process.env.GOOGLE_CLOUD_PROJECT, PROJECT);
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined, 'REAL_CREDENTIAL_FILE_FORBIDDEN');
  for (const name of ['FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_TOKEN']) {
    assert.equal(process.env[name], undefined, 'REAL_CREDENTIAL_ENV_FORBIDDEN');
  }
  if (process.env.FIREBASE_CONFIG) {
    assert.equal(JSON.parse(process.env.FIREBASE_CONFIG).projectId, PROJECT);
  }
}
assertEnvironment();
const app = initializeApp({ projectId: PROJECT }, `water-probe-${randomUUID()}`);
const db = getFirestore(app);
// Explicit synthetic emulator token. Do not discover ADC files or cloud metadata.
const emulatorAuth = new OAuth2Client();
emulatorAuth.setCredentials({ access_token: 'owner', expiry_date: Date.now() + 3600000 });
db.settings({ host, ssl: false, auth: new GoogleAuth({ projectId: PROJECT, authClient: emulatorAuth }) });
function guard() { assertEnvironment(); assert.equal(app.options.projectId, PROJECT); assert.equal(db.projectId, PROJECT); }
guard();
import { createWaterAdmissionIssuerTestHarness, issueWaterAdmission } from '../../api/health/_issue_water_admission.js';
const evidence = { round: 'H2-R3-F-A', projectId: PROJECT, host, node: process.version,
  run: randomUUID(), measurements: [], checks: [] };
const dayAt = ms => new Date(ms).toISOString().slice(0, 10);
function fresh() {
  const uid = `probe-issuer-${evidence.run}-${randomUUID()}`;
  const day = dayAt(Date.now() - 840 * 60000);
  return { identity: { uid, email: 'synthetic@example.invalid', displayName: 'Synthetic', photoUrl: null },
    decision: { uid, decisionId: randomUUID(), policy: 'NEW_ACCOUNT_V2_ONLY', legacyWritersExcluded: true, initialHealthDay: day } };
}
function refs(c) {
  guard(); const root = db.collection('users').doc(c.identity.uid), day = c.decision.initialHealthDay;
  return { root, E: root.collection('water_protocol').doc('eligibility'), P: root.collection('runtime').doc('water_admission'),
    A: root.collection('water_protocol').doc('activation'), S: root.collection('water_state').doc(day),
    H: root.collection('health_info').doc(day), G: db.collection('account_deletion_guards').doc(c.identity.uid) };
}
function issuer(c, store = db) {
  guard(); return createWaterAdmissionIssuerTestHarness({ db: store, getTrustedAdmission: async () => c });
}
async function snapshot(c) {
  const r = refs(c), paths = [r.root, r.G];
  for (const name of ['water_protocol', 'runtime', 'water_state', 'health_info', 'water_increment_receipts']) {
    paths.push(...await r.root.collection(name).listDocuments());
  }
  const docs = await db.getAll(...paths);
  return docs.map(d => [d.ref.path, d.exists ? { data: d.data(), createTime: d.createTime, updateTime: d.updateTime } : null])
    .sort((a, b) => a[0].localeCompare(b[0]));
}
async function rejectUnchanged(c, code, fn = () => issuer(c).issue()) {
  const before = await snapshot(c); await assert.rejects(fn(), e => e.code === code);
  assert.deepEqual(await snapshot(c), before);
}
function aborted() { return Object.assign(new Error('probe deterministic ABORTED'), { code: 10 }); }
// Real SDK adapter: no fabricated snapshots/timestamps, no mocks of storage.
function controlled(hooks = {}) {
  let attempts = 0;
  return { collection: db.collection.bind(db), runTransaction: async fn => {
    guard(); const value = await db.runTransaction(async tx => {
      const attempt = ++attempts; await hooks.beforeExecute?.(attempt);
      const result = await fn(tx); await hooks.beforeCommit?.(attempt, result); return result;
    }); await hooks.afterCommit?.(); return value;
  }, get attempts() { return attempts; } };
}
function pause() {
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  return { reached: reached.promise, release: release.resolve, async hold() { reached.resolve(); await release.promise; } };
}
function stamp(t) { return { seconds: t.seconds, nanoseconds: t.nanoseconds }; }
test('F-A real issuer / Admin SDK / loopback emulator', { timeout: 180000 }, async t => {
  t.after(async () => {
    if (process.env.WATER_PROBE_OUTPUT) await writeFile(process.env.WATER_PROBE_OUTPUT, JSON.stringify(evidence, null, 2) + '\n');
    await db.terminate(); await deleteApp(app);
  });
  guard();
  await new Promise((resolve, reject) => {
    const socket = connect({ host: host.split(':')[0], port: Number(host.split(':')[1]) }); socket.setTimeout(5000);
    socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject(new Error('EMULATOR_UNAVAILABLE')); });
  });
  assert.equal(WATER_V2_ENABLED, false);
  await assert.rejects(issueWaterAdmission(), e => e.code === 'WATER_V2_DISABLED');
  const other = fresh(); await issuer(other).issue(); const otherBefore = await snapshot(other);
  await t.test('real atomic birth uses server timestamps, exact Flutter defaults and creates no water', async () => {
    const c = fresh(), r = refs(c), result = await issuer(c).issue();
    assert.equal(result.alreadyIssued, false); assert.match(result.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const [root, e, p] = await db.getAll(r.root, r.E, r.P);
    assert.deepEqual(root.data(), { email: c.identity.email, displayName: 'Synthetic', photoUrl: null,
      isPremium: false, xp: 0, level: 1, streak: 0, habitsCount: 0, tasksCount: 0, goalsCount: 0,
      subjectsCount: 0, medicationsCount: 0, transactionsCount: 0 });
    assert.ok(root.createTime.isEqual(e.createTime) && root.createTime.isEqual(p.createTime));
    assert.ok(e.data().issuedAt instanceof Timestamp); assert.equal(e.data().runId, result.runId);
    assert.equal(p.data().decisionId, c.decision.decisionId); assert.equal(p.data().runId, result.runId);
    assert.ok((await db.getAll(r.A, r.S, r.H)).every(d => !d.exists));
    assert.equal((await r.root.collection('water_protocol').get()).size, 1);
    evidence.measurements.push({ uid: c.identity.uid, runId: result.runId, root: stamp(root.createTime),
      eligibility: stamp(e.createTime), proof: stamp(p.createTime), issuedAt: stamp(e.data().issuedAt), noWater: true });
    const before = await snapshot(c); assert.deepEqual(await issuer(c).issue(), { ...result, alreadyIssued: true });
    assert.deepEqual(await snapshot(c), before);
  });
  await t.test('natural issuer admission provisions exactly one epoch, zero balance/revision and preserves later profile', async () => {
    const c = fresh(), r = refs(c), admission = await issuer(c).issue();
    const api = createWaterProvisioningTestHarness({ db, uid: c.identity.uid, runId: admission.runId });
    const first = await api.initializeAccount(); assert.equal(first.waterIntakeMl, 0); assert.equal(first.revision, 0);
    const before = await snapshot(c);
    assert.deepEqual(await api.initializeAccount(), { ...first, alreadyProvisioned: true });
    assert.deepEqual(await snapshot(c), before);
    await r.root.update({ xp: 500, level: 3, isPremium: true, displayName: ' Updated '.repeat(40), photoUrl: ' avatar '.repeat(300), tasksCount: 2, hasCompletedOnboarding: true });
    const advanced = await snapshot(c); assert.deepEqual(await issuer(c).issue(), { ...admission, alreadyIssued: true });
    assert.deepEqual(await snapshot(c), advanced);
    evidence.checks.push({ scenario: 'issuer-to-provisioner', runId: admission.runId, epoch: first.epoch, water: 0, revision: 0 });
  });
  await t.test('simultaneous legitimate emissions commit one runId with real SDK contention', async () => {
    const c = fresh(), entered = Promise.withResolvers(); let arrivals = 0;
    const store = controlled({ beforeExecute: async () => {
      if (++arrivals <= 2) { if (arrivals === 2) entered.resolve(); await entered.promise; }
    } });
    const results = await Promise.all([issuer(c, store).issue(), issuer(c, store).issue()]);
    assert.equal(results[0].runId, results[1].runId); assert.equal(results.filter(r => !r.alreadyIssued).length, 1);
    assert.equal((await refs(c).root.collection('runtime').get()).size, 1);
    evidence.checks.push({ scenario: 'concurrent-emission', attempts: store.attempts, runId: results[0].runId });
  });
  await t.test('different privileged decisions competing for one UID cannot share authority', async () => {
    const c = fresh(), d = structuredClone(c); d.decision.decisionId = randomUUID();
    const results = await Promise.allSettled([issuer(c).issue(), issuer(d).issue()]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'WATER_ADMISSION_CONFLICT');
  });
  await t.test('SDK callback retry preserves server candidate runId and commits only once', async () => {
    const c = fresh(), candidates = [], store = controlled({ beforeCommit: (attempt, value) => {
      candidates.push(value.runId); if (attempt === 1) throw aborted();
    } });
    const result = await issuer(c, store).issue(); assert.equal(store.attempts, 2);
    assert.deepEqual(candidates, [result.runId, result.runId]);
    assert.equal((await refs(c).E.get()).data().runId, result.runId);
    evidence.checks.push({ scenario: 'SDK-retry', attempts: store.attempts, sameCandidate: true });
  });
  await t.test('lost actual commit response replays persisted admission without writes', async () => {
    const c = fresh(), store = controlled({ afterCommit: () => { throw new Error('lost actual response'); } });
    await assert.rejects(issuer(c, store).issue(), /lost actual response/);
    const before = await snapshot(c), runId = (await refs(c).E.get()).data().runId;
    const replay = await issuer(c).issue(); assert.equal(replay.runId, runId); assert.equal(replay.alreadyIssued, true);
    assert.deepEqual(await snapshot(c), before);
  });
  for (const data of [{ state: 'IN_PROGRESS' }, { state: 'COMPLETE' }, {}]) {
    await t.test(`existing guard blocks issuance ${JSON.stringify(data)}`, async () => {
      const c = fresh(); await refs(c).G.create(data); await rejectUnchanged(c, 'WATER_ACCOUNT_DELETING');
      assert.equal((await refs(c).root.get()).exists, false);
    });
  }
  await t.test('guard committed before delayed first read blocks issuance', async () => {
    const c = fresh(), hold = pause(), store = controlled({ beforeExecute: n => n === 1 ? hold.hold() : undefined });
    const pending = issuer(c, store).issue(); await hold.reached;
    await refs(c).G.create({ state: 'IN_PROGRESS' }); hold.release();
    await assert.rejects(pending, e => e.code === 'WATER_ACCOUNT_DELETING');
    assert.equal((await refs(c).root.get()).exists, false);
  });
  await t.test('guard after rolled-back first callback is revalidated on real SDK retry', async () => {
    const c = fresh(), store = controlled({ beforeCommit: n => { if (n === 1) throw aborted(); },
      beforeExecute: async n => { if (n === 2) await refs(c).G.create({ state: 'IN_PROGRESS' }); } });
    await assert.rejects(issuer(c, store).issue(), e => e.code === 'WATER_ACCOUNT_DELETING');
    assert.equal(store.attempts, 2); assert.equal((await refs(c).root.get()).exists, false);
  });
  await t.test('client-created root wins before first read, no retrofit or overwrite', async () => {
    const c = fresh(), r = refs(c), hold = pause(), store = controlled({ beforeExecute: n => n === 1 ? hold.hold() : undefined });
    const pending = issuer(c, store).issue(); await hold.reached; await r.root.create({ displayName: 'Legacy', xp: 500 });
    const before = await snapshot(c); hold.release(); await assert.rejects(pending, e => e.code === 'WATER_ADMISSION_CONFLICT');
    assert.deepEqual(await snapshot(c), before);
  });
  await t.test('orphan eligibility and root recreation cannot acquire new admission', async () => {
    for (const mode of ['orphan', 'recreated']) {
      const c = fresh(), r = refs(c); await issuer(c).issue(); const profile = (await r.root.get()).data();
      await r.root.delete(); if (mode === 'recreated') await r.root.create(profile);
      await rejectUnchanged(c, 'WATER_ADMISSION_CONFLICT');
    }
  });
  for (const field of ['uid', 'runId']) {
    await t.test(`divergent eligibility ${field} fails closed`, async () => {
      const c = fresh(), r = refs(c); await issuer(c).issue();
      await r.E.update({ [field]: field === 'uid' ? 'synthetic-other-uid' : randomUUID() });
      await rejectUnchanged(c, 'WATER_ADMISSION_CONFLICT');
    });
  }
  await t.test('legacy Health orphan and deletion context block an absent root', async () => {
    const c = fresh(), r = refs(c); await r.H.create({ waterIntakeMl: 1000, mood: 'calm' });
    await rejectUnchanged(c, 'WATER_ADMISSION_CONFLICT');
    const d = fresh(); await refs(d).root.collection('runtime').doc('account_deletion').create({ state: 'IN_PROGRESS' });
    await rejectUnchanged(d, 'WATER_ACCOUNT_DELETING');
  });
  await t.test('partial buffered creates never commit on exception, explicit retry creates whole admission', async () => {
    const c = fresh(), store = controlled({ beforeCommit: () => { throw new Error('partial callback failure'); } });
    await assert.rejects(issuer(c, store).issue(), /partial callback failure/);
    assert.ok((await db.getAll(refs(c).root, refs(c).E, refs(c).P)).every(d => !d.exists));
    assert.equal((await issuer(c).issue()).alreadyIssued, false);
  });
  await t.test('privileged identity changing UID during SDK retry fails without any account', async () => {
    const c = fresh(), d = fresh(); let value = c;
    const store = controlled({ beforeCommit: n => { if (n === 1) throw aborted(); }, beforeExecute: n => { if (n === 2) value = d; } });
    const api = createWaterAdmissionIssuerTestHarness({ db: store, getTrustedAdmission: async () => value });
    await assert.rejects(api.issue(), e => e.code === 'WATER_ADMISSION_UNAUTHORIZED');
    assert.ok((await db.getAll(refs(c).root, refs(c).E, refs(d).root, refs(d).E)).every(doc => !doc.exists));
  });
  await t.test('other UID remains unchanged', async () => assert.deepEqual(await snapshot(other), otherBefore));
  evidence.result = 'F_A_EMULATOR_CONFIRMED'; console.log(`PROBE_DECISION ${evidence.result}`);
});
