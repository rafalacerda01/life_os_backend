// Explicit diagnostic only: node --test tools/audit4/water-provisioning-emulator-probe.mjs
// Requires a local demo-life-os Firestore emulator. Never imported by production.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { createWaterProvisioningTestHarness, provisionWaterAccount, provisionWaterDay } from '../../api/health/_provision_water.js';
import { deleteAccount } from '../../api/account/delete.js';
import cleanup from '../../api/account/_circle_cleanup.cjs';
import { syncWater, WATER_V2_ENABLED } from '../../api/health/_sync_water.js';
import {createWaterLifecycle} from '../../api/health/_water_lifecycle.js';
import {createWaterGoals} from '../../api/health/_water_goal.js';

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
const evidence = { projectId: PROJECT, host, node: process.version, run: randomUUID(),
  round: 'H2-R3-E-F2', historicalERun: '1a02ed6a-073d-4540-8a04-35ff85ba3592',
  measurements: [], acceptedUids: [], checks: [], decision: 'C' };
function stamp(t) { return { seconds: t.seconds, nanoseconds: t.nanoseconds, toMillis: t.toMillis(), iso: t.toDate().toISOString() }; }
const dayAt = ms => new Date(ms).toISOString().slice(0, 10);
const nextDay = day => dayAt(Date.parse(`${day}T00:00:00.000Z`) + 86400000);
const cycle = { isEnabled: true, lastPeriodStart: '2026-10-01', cycleLengthDays: 28, periodLengthDays: 5 };
function refs(uid, day) {
  guard(); const root = db.collection('users').doc(uid);
  return { root, E: root.collection('water_protocol').doc('eligibility'),
    A: root.collection('water_protocol').doc('activation'), M: root.collection('water_protocol').doc('provisioning'),
    S: root.collection('water_state').doc(day), H: root.collection('health_info').doc(day),
    R: root.collection('water_increment_receipts'), G: db.collection('account_deletion_guards').doc(uid) };
}
function harness(f, store = db) {
  guard(); return createWaterProvisioningTestHarness({ db: store, uid: f.uid, runId: f.runId });
}
async function account(mode = 'transaction', retries = 0) {
  const uid = `probe-f2-${evidence.run}-${randomUUID()}`, runId = randomUUID();
  // Server-selected earliest possible civil day, not a fabricated timestamp.
  const day = dayAt(Date.now() - 840 * 60000), r = refs(uid, day);
  const admission = { version: 1, uid, runId, policy: 'NEW_ACCOUNT_V2_ONLY', legacyWritersExcluded: true,
    initialHealthDay: day, issuedAt: FieldValue.serverTimestamp() };
  let attempts = 0;
  guard();
  if (mode === 'batch') {
    const batch = db.batch(); batch.create(r.root, { activeCircleId: null }); batch.create(r.E, admission);
    await batch.commit(); attempts = 1;
  } else {
    await db.runTransaction(async tx => {
      guard(); attempts++;
      // Exercise genuine SDK retry with deterministic ABORTED callback errors.
      // No fake snapshots or fake timestamps. No writes commit on these attempts.
      if (attempts <= retries) throw Object.assign(new Error('probe synthetic ABORTED'), { code: 10 });
      tx.create(r.root, { activeCircleId: null }); tx.create(r.E, admission);
    });
  }
  guard(); const [root, eligibility] = await db.getAll(r.root, r.E);
  const issuedAt = eligibility.data().issuedAt;
  assert.ok(root.createTime instanceof Timestamp && eligibility.createTime instanceof Timestamp && issuedAt instanceof Timestamp);
  const measurement = { uid, runId, mode, requestedRetries: retries, attempts, day,
    rootCreateTime: stamp(root.createTime), eligibilityCreateTime: stamp(eligibility.createTime), issuedAt: stamp(issuedAt),
    rootEqualsEligibility: root.createTime.isEqual(eligibility.createTime),
    rootEqualsIssuedAt: root.createTime.isEqual(issuedAt), eligibilityEqualsIssuedAt: eligibility.createTime.isEqual(issuedAt) };
  measurement.exact = measurement.rootEqualsEligibility && measurement.rootEqualsIssuedAt && measurement.eligibilityEqualsIssuedAt;
  evidence.measurements.push(measurement); console.log(`TIMESTAMPS ${JSON.stringify(measurement)}`);
  measurement.creationMetadataEqual = measurement.rootEqualsEligibility;
  return { uid, runId, day, ...r, creationMetadataEqual: measurement.creationMetadataEqual };
}
async function completeSnapshot(f) {
  guard(); const paths = [f.root, ...await f.root.collection('water_protocol').listDocuments(),
    ...await f.root.collection('water_state').listDocuments(), ...await f.root.collection('health_info').listDocuments(),
    ...await f.R.listDocuments()];
  const docs = await db.getAll(...paths);
  return docs.map(d => [d.ref.path, d.exists ? { data: d.data(), createTime: d.createTime, updateTime: d.updateTime } : null]).sort((a, b) => a[0].localeCompare(b[0]));
}
async function increment(f, day = f.day, mutationId = randomUUID(), store = db) {
  guard(); const a = await f.A.get();
  const body = { operation: 'increment_water', version: 2, mutationId, healthDay: day, deltaMl: 250,
    occurredAt: `${day}T12:00:00.000Z`, timeZoneOffsetMinutes: 0, originEpoch: a.data().epoch };
  return { result: await syncWater({ db: store, userId: f.uid, body, enabled: true }), body };
}
// Real SDK/transaction adapter for deterministic commit-boundary races and lost
// response injection. It never supplies snapshots or changes production callbacks.
function controlled(hooks = {}) {
  let attempts = 0;
  return { collection: db.collection.bind(db), runTransaction: async fn => {
    guard(); const value = await db.runTransaction(async tx => {
      const attempt = ++attempts;
      await hooks.beforeExecute?.(attempt);
      const result = await fn(tx); await hooks.beforeCommit?.(attempt); return result;
    });
    await hooks.afterCommit?.(); return value;
  }, get attempts() { return attempts; } };
}
async function refusal(f, code, call = () => harness(f).initializeAccount()) {
  const before = await completeSnapshot(f);
  await assert.rejects(call(), e => e.code === code);
  assert.deepEqual(await completeSnapshot(f), before);
}

function pause() {
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  return { reached: reached.promise, release: release.resolve,
    async hold() { reached.resolve(); await release.promise; } };
}
async function fresh() {
  const f = await account(); assert.equal(f.creationMetadataEqual, true); return f;
}
async function activate() {
  const f = await fresh(); await harness(f).initializeAccount(); return f;
}
function aborted() { return Object.assign(new Error('probe deterministic ABORTED'), { code: 10 }); }

test('F2 real Admin SDK / local emulator provisioning', { timeout: 180000 }, async t => {
  t.after(async () => {
    if (process.env.WATER_PROBE_OUTPUT) await writeFile(process.env.WATER_PROBE_OUTPUT, JSON.stringify(evidence, null, 2) + '\n');
    await db.terminate(); await deleteApp(app);
  });
  guard();
  await new Promise((resolve, reject) => {
    const socket = connect({ host: host.split(':')[0], port: Number(host.split(':')[1]) });
    socket.setTimeout(5000);
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject); socket.once('timeout', () => { socket.destroy(); reject(new Error('EMULATOR_UNAVAILABLE')); });
  });
  assert.equal(WATER_V2_ENABLED, false);
  await assert.rejects(provisionWaterAccount(), e => e.code === 'WATER_V2_DISABLED');
  await assert.rejects(provisionWaterDay(), e => e.code === 'WATER_V2_DISABLED');
  const accounts = [];
  for (let i = 0; i < 8; i++) accounts.push(await account());
  for (let i = 0; i < 3; i++) accounts.push(await account('batch'));
  accounts.push(await account('transaction', 1), await account('transaction', 2));
  evidence.initialMeasurementCount = accounts.length;
  await t.test('13 natural admissions preserve Health and atomically provision A/S/H/manifest with persistent epoch', async () => {
    for (const f of accounts) {
      assert.equal(f.creationMetadataEqual, true);
      guard(); await f.H.create({ date: FieldValue.serverTimestamp(), mood: 'calm', hasTakenPillToday: true, menstrualCycle: cycle });
      const beforeH = (await f.H.get()).data(), first = await harness(f).initializeAccount();
      assert.match(first.epoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(first.revision, 0); assert.equal(first.waterIntakeMl, 0);
      const [a, s, h, m] = await db.getAll(f.A, f.S, f.H, f.M);
      assert.deepEqual(a.data(), { protocolVersion: 2, epoch: first.epoch, status: 'ACTIVE', legacyWritesBlocked: true });
      assert.deepEqual(s.data(), { protocolVersion: 2, epoch: first.epoch, revision: 0, waterIntakeMl: 0 });
      assert.deepEqual(h.data(), { ...beforeH, waterIntakeMl: 0 }); assert.equal(m.data().epoch, first.epoch);
      assert.ok(a.createTime.isEqual(s.createTime) && a.createTime.isEqual(m.createTime) && a.updateTime.isEqual(h.updateTime));
      assert.equal((await f.R.get()).empty, true);
      const before = await completeSnapshot(f);
      assert.deepEqual(await harness(f).initializeAccount(), { ...first, alreadyProvisioned: true });
      assert.deepEqual(await completeSnapshot(f), before); evidence.acceptedUids.push(f.uid);
    }
  });
  const other = accounts[1]; await increment(other);
  const otherBefore = await completeSnapshot(other);
  await t.test('increment, receipt, reconcile at revision 1, same UUID replay and advanced later-day replay', async () => {
    const f = accounts.at(-1), api = harness(f), day = nextDay(f.day);
    const first = await increment(f); assert.equal(first.result.revision, 1); assert.equal(first.result.waterIntakeMl, 250);
    const receipt = (await f.R.doc(first.body.mutationId).get()).data();
    assert.equal(receipt.effectiveCreditMl, 250); assert.ok(receipt.appliedAt instanceof Timestamp);
    const confirmed = await syncWater({ db, userId: f.uid, enabled: true, body: { operation: 'reconcile_water', version: 2,
      healthDay: f.day, pendingMutationIds: [first.body.mutationId], expectedEpoch: first.result.epoch, expectedRevision: 1 } });
    assert.equal(confirmed.recognized.length, 1); assert.equal(confirmed.recognized[0].appliedRevision, 1);
    const next = await api.initializeDay(day); assert.equal(next.epoch, first.result.epoch); assert.equal(next.revision, 0);
    const before = await completeSnapshot(f); await api.initializeDay(day); assert.deepEqual(await completeSnapshot(f), before);
    const later = await increment(f, day), afterCredit = await completeSnapshot(f);
    const replay = await syncWater({ db, userId: f.uid, enabled: true, body: later.body });
    assert.equal(replay.alreadyApplied, true); assert.equal(replay.waterIntakeMl, 250); assert.equal(replay.revision, 1);
    const result = await api.initializeDay(day); assert.equal(result.revision, 1); assert.equal(result.waterIntakeMl, 250);
    assert.deepEqual(await completeSnapshot(f), afterCredit);
    evidence.dayFlow = { initialRevision: 1, initialWater: 250, laterRevision: 1, laterWater: 250, sameEpoch: result.epoch === next.epoch };
  });
  await t.test('lost response after provisioning commit returns original epoch without writes', async () => {
    const f = await fresh(), store = controlled({ afterCommit: () => { throw new Error('lost provision response'); } });
    await assert.rejects(harness(f, store).initializeAccount(), /lost provision response/);
    const before = await completeSnapshot(f), epoch = (await f.A.get()).data().epoch;
    assert.equal((await harness(f).initializeAccount()).epoch, epoch); assert.deepEqual(await completeSnapshot(f), before);
  });
  await t.test('lost increment response replays same payload/UUID and recognizes exactly one real receipt', async () => {
    const f = await activate(), id = randomUUID(), lost = controlled({ afterCommit: () => { throw new Error('lost increment response'); } });
    await assert.rejects(increment(f, f.day, id, lost), /lost increment response/);
    const before = await completeSnapshot(f), replay = await increment(f, f.day, id);
    assert.equal(replay.result.alreadyApplied, true); assert.equal(replay.result.revision, 1); assert.equal(replay.result.waterIntakeMl, 250);
    const confirmed = await syncWater({ db, userId: f.uid, enabled: true, body: { operation: 'reconcile_water', version: 2,
      healthDay: f.day, pendingMutationIds: [id], expectedEpoch: replay.result.epoch, expectedRevision: 1 } });
    assert.equal(confirmed.recognized.length, 1); assert.equal((await f.R.get()).size, 1);
    assert.deepEqual(await completeSnapshot(f), before);
  });
  await t.test('two concurrent initializations use real Firestore contention/retries and commit one epoch', async () => {
    const f = await fresh(), entered = Promise.withResolvers(); let arrivals = 0;
    const store = controlled({ beforeExecute: async () => {
      if (++arrivals <= 2) { if (arrivals === 2) entered.resolve(); await entered.promise; }
    } });
    const api = harness(f, store), results = await Promise.all([api.initializeAccount(), api.initializeAccount()]);
    assert.equal(results[0].epoch, results[1].epoch);
    assert.equal(results.filter(r => !r.alreadyProvisioned).length, 1);
    assert.equal((await f.root.collection('water_protocol').get()).size, 3);
    assert.equal((await f.root.collection('water_state').get()).size, 1);
    assert.equal((await f.R.get()).size, 0);
    evidence.concurrentInitialization = { attempts: store.attempts, epochs: results.map(r => r.epoch), oneCreation: true };
  });
  await t.test('concurrent mood writer wins before first read and provisioning preserves it', async () => {
    const f = await fresh(); await f.H.create({ date: FieldValue.serverTimestamp(), mood: 'old', hasTakenPillToday: true, menstrualCycle: cycle });
    const hold = pause(), store = controlled({ beforeExecute: attempt => attempt === 1 ? hold.hold() : undefined });
    const pending = harness(f, store).initializeAccount(); await hold.reached;
    await f.H.update({ mood: 'new' }); const beforeH = (await f.H.get()).data(); hold.release(); await pending;
    assert.deepEqual((await f.H.get()).data(), { ...beforeH, waterIntakeMl: 0 });
    evidence.concurrentMood = { orderedBeforeFirstRead: true, preserved: true, attempts: store.attempts };
  });
  await t.test('guard committed before delayed provisioning transaction blocks all creation', async () => {
    const f = await fresh(), hold = pause();
    const store = controlled({ beforeExecute: attempt => attempt === 1 ? hold.hold() : undefined });
    const pending = harness(f, store).initializeAccount(); await hold.reached;
    await cleanup.beginGuard(db, f.uid); const before = await completeSnapshot(f); hold.release();
    await assert.rejects(pending, e => e.code === 'WATER_ACCOUNT_DELETING'); assert.deepEqual(await completeSnapshot(f), before);
    assert.equal((await f.A.get()).exists, false);
  });
  await t.test('day initialization versus increment refuses unprepared day, then explicit increment succeeds', async () => {
    const f = await activate(), day = nextDay(f.day), hold = pause();
    const store = controlled({ beforeExecute: attempt => attempt === 1 ? hold.hold() : undefined });
    const pending = harness(f, store).initializeDay(day); await hold.reached;
    await assert.rejects(increment(f, day), e => e.code === 'WATER_MIGRATION_NOT_READY');
    assert.equal((await f.R.get()).size, 0); hold.release(); await pending;
    const accepted = await increment(f, day); assert.equal(accepted.result.waterIntakeMl, 250); assert.equal(accepted.result.revision, 1);
  });
  await t.test('increment wins before delayed idempotent day read; initializer never resets advanced state', async () => {
    const f = await activate(), day = nextDay(f.day); await harness(f).initializeDay(day);
    const hold = pause(), store = controlled({ beforeExecute: attempt => attempt === 1 ? hold.hold() : undefined });
    const pending = harness(f, store).initializeDay(day); await hold.reached;
    await increment(f, day); const before = await completeSnapshot(f); hold.release(); const result = await pending;
    assert.equal(result.alreadyProvisioned, true); assert.equal(result.revision, 1); assert.equal(result.waterIntakeMl, 250);
    assert.deepEqual(await completeSnapshot(f), before);
  });
  for (const corruption of ['missing initial S', 'missing initial H', 'divergent initial H']) {
    await t.test(`${corruption} fails on already provisioned later day after SDK retry`, async () => {
      const f = await activate(), day = nextDay(f.day); await increment(f); await harness(f).initializeDay(day); await increment(f, day);
      const store = controlled({ beforeCommit: attempt => { if (attempt === 1) throw aborted(); },
        beforeExecute: async attempt => {
          // SDK has rolled back/released locks before this second callback.
          if (attempt !== 2) return;
          if (corruption === 'missing initial S') await f.S.delete();
          if (corruption === 'missing initial H') await f.H.delete();
          if (corruption === 'divergent initial H') await f.H.update({ waterIntakeMl: 500 });
        } });
      await assert.rejects(harness(f, store).initializeDay(day), e => e.code === 'WATER_INVALID_REMOTE_STATE');
      assert.equal(store.attempts, 2);
      const before = await completeSnapshot(f);
      await refusal(f, 'WATER_INVALID_REMOTE_STATE', () => harness(f).initializeDay(day));
      assert.deepEqual(await completeSnapshot(f), before);
      const later = refs(f.uid, day); assert.equal((await later.S.get()).data().waterIntakeMl, 250);
      assert.equal((await f.R.get()).size, 2);
      evidence.checks.push({ scenario: corruption, attempts: store.attempts, syntheticAbort: true, realDocuments: true });
    });
  }
  await t.test('root without admission refuses before bootstrap', async () => {
    const f = { uid: `probe-f2-absent-${randomUUID()}`, runId: randomUUID(), day: dayAt(Date.now()) };
    Object.assign(f, refs(f.uid, f.day)); await f.root.create({}); await refusal(f, 'WATER_PROVISION_UNAUTHORIZED');
  });
  await t.test('eligibility created later and root recreated with stale eligibility both refuse', async () => {
    const f = { uid: `probe-f2-late-${randomUUID()}`, runId: randomUUID(), day: dayAt(Date.now()) };
    Object.assign(f, refs(f.uid, f.day)); await f.root.create({});
    await f.E.create({ version: 1, uid: f.uid, runId: f.runId, policy: 'NEW_ACCOUNT_V2_ONLY',
      legacyWritersExcluded: true, initialHealthDay: f.day, issuedAt: FieldValue.serverTimestamp() });
    await refusal(f, 'WATER_PROVISION_UNAUTHORIZED');
    const g = await fresh(); await g.root.delete(); await g.root.create({}); await refusal(g, 'WATER_PROVISION_UNAUTHORIZED');
  });
  await t.test('existing guards IN_PROGRESS/COMPLETE expired/malformed always refuse', async () => {
    const f = accounts[0];
    for (const data of [{ state: 'IN_PROGRESS' }, { state: 'COMPLETE', retainUntil: Timestamp.fromMillis(1) }, {}]) {
      await f.G.set(data); await refusal(f, 'WATER_ACCOUNT_DELETING');
    }
  });
  await t.test('provision-first then actual deleteAccount recursively removes real demo Water descendants', async () => {
    const f = await activate(); await increment(f); await harness(f).initializeDay(nextDay(f.day));
    const deletes = [];
    let authPresent=true;
    const auth={
      getUser:async uid=>{
        if(!authPresent) throw Object.assign(new Error('synthetic absence'),{code:'auth/user-not-found'});
        return {uid,tenantId:null};
      },
      deleteUser:async uid=>{deletes.push(uid);authPresent=false;},
    };
    const result = await deleteAccount({ db, uid: f.uid, auth });
    assert.equal(result.body.deleted, true); assert.deepEqual(deletes, [f.uid]);
    const docs = await db.getAll(f.root, f.E, f.A, f.M, f.S, f.H, refs(f.uid, nextDay(f.day)).S);
    assert.ok(docs.every(d => !d.exists)); assert.equal((await f.R.get()).size, 0); assert.equal((await f.G.get()).data().state, 'COMPLETE');
    await assert.rejects(harness(f).initializeAccount(), e => e.code === 'WATER_ACCOUNT_DELETING');
  });

  await t.test('full managed receipt lifecycle uses real createTimes, concurrent login, day and goal receipts',async()=>{
    guard();
    const uid='water-full-local-'+randomUUID(),born=Timestamp.fromMillis(Math.floor(Date.now()/1000)*1000);
    const cohort={version:1,id:'local-full',projectId:PROJECT,policy:'NEW_ACCOUNT_V2_ONLY',state:'OPEN',
      cutoverMillis:born.toMillis()-1000,administrativePolicyVerified:true,writerFencesVerified:true};
    const ledger=db.collection('account_birth_decisions').doc(uid);
    await ledger.create({version:1,uid,projectId:PROJECT,tenantId:null,authCreatedAt:born,
      sourceType:'FIREBASE_AUTH_CREATE',sourceEventId:'emulator-managed-fixture',eventAt:born,
      cohort:{version:1,id:cohort.id,policy:cohort.policy,state:'CLOSED',cutoverAt:Timestamp.fromMillis(cohort.cutoverMillis)},
      decisionId:randomUUID(),originalIdentity:{uid,email:'synthetic@example.invalid',displayName:'Synthetic',photoUrl:null},
      recordedAt:FieldValue.serverTimestamp(),status:'RECORDED_COHORT_CLOSED'});
    let present=true;
    const auth={
      getUser:async queried=>{
        assert.equal(queried,uid);
        if(!present) throw Object.assign(new Error('synthetic absence'),{code:'auth/user-not-found'});
        return {uid,metadata:{creationTime:born.toDate().toUTCString()}};
      },
      deleteUser:async queried=>{assert.equal(queried,uid);present=false;},
    };
    const life=createWaterLifecycle({db,auth,cohort,enabled:true,now:()=>Timestamp.fromMillis(Date.now()+10000)});
    const body={operation:'bootstrap_water',version:2,timeZoneOffsetMinutes:0};
    const [a,b]=await Promise.all([life.bootstrap(uid,body),life.bootstrap(uid,body)]);
    assert.equal(a.epoch,b.epoch);assert.equal(a.state,'READY');assert.equal(a.waterIntakeMl,0);
    const root=db.collection('users').doc(uid),e=await root.collection('water_protocol').doc('eligibility').get();
    const profile=await root.get(),proof=await root.collection('runtime').doc('water_admission').get();
    assert.ok(profile.createTime.isEqual(e.createTime) && e.createTime.isEqual(proof.createTime));
    const r=refs(uid,a.healthDay),mutationId=randomUUID();
    await increment({uid,...r},a.healthDay,mutationId);
    const current=await life.bootstrap(uid,body);
    assert.equal(current.waterIntakeMl,250);assert.equal(current.revision,1);
    const goals=createWaterGoals({db,cohort,enabled:true}),goal={operation:'set_water_goal',version:2,mutationId:randomUUID(),originEpoch:a.epoch,goalMl:2250};
    const [one,two]=await Promise.all([goals.set(uid,goal),goals.set(uid,goal)]);
    assert.equal(one.goalRevision,1);assert.equal(two.goalRevision,1);
    assert.equal((await life.bootstrap(uid,body)).goalMl,2250);
    const removed=await deleteAccount({db,uid,auth});
    assert.equal(removed.body.deleted,true);
    assert.equal((await root.get()).exists,false);
    assert.equal((await ledger.get()).exists,false);
    assert.equal((await root.collection('health_settings').doc('water_v2').get()).exists,false);
    assert.equal((await root.collection('water_goal_receipts').get()).empty,true);
    await assert.rejects(life.bootstrap(uid,body),error=>error.code==='ACCOUNT_DELETION_BLOCKED');
    evidence.fullLifecycle={uid,atomicCreateTimes:true,oneEpoch:true,idempotentGoal:true,retirementBlocks:true};
  });
  await t.test('independent UID and all its state/Health metadata remain unchanged', async () => {
    assert.deepEqual(await completeSnapshot(other), otherBefore);
  });
  evidence.decision = 'F2_EMULATOR_CONFIRMED';
  console.log(`PROBE_DECISION ${evidence.decision}`);
});
