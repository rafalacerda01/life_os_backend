import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { syncWater, WATER_V2_ENABLED } from './_sync_water.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HISTORY_LIMIT = 100;
const CODES = new Set(['WATER_V2_DISABLED', 'WATER_PROVISION_UNAUTHORIZED',
  'WATER_USER_NOT_FOUND', 'WATER_ACCOUNT_DELETING', 'WATER_PROVISION_NOT_ELIGIBLE',
  'WATER_INVALID_REMOTE_STATE', 'WATER_INVALID_PROVISION_INPUT']);
class ProvisionError extends Error {
  constructor(code) { super('Provisionamento de hidratação indisponível.'); this.code = code; }
}
function fail(code) { throw new ProvisionError(code); }
export function provisioningError(error) {
  if (error instanceof ProvisionError && error.code === 'WATER_ACCOUNT_DELETING') {
    return { status: 503, code: 'ACCOUNT_DELETION_BLOCKED', retryable: true,
      message: 'Provisionamento de hidratação indisponível.' };
  }
  return { code: error instanceof ProvisionError && CODES.has(error.code)
    ? error.code : 'WATER_PROVISION_STORAGE_UNAVAILABLE',
  message: 'Provisionamento de hidratação indisponível.' };
}
function object(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v));
}
function exact(v, keys) {
  return object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
function uuid(v) { return typeof v === 'string' && UUID.test(v); }
function uidValid(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 &&
    Buffer.byteLength(v, 'utf8') <= 128 && v.trim() === v && !v.includes('/') &&
    !['.', '..'].includes(v) && !/^__.*__$/.test(v) && !/[\u0000-\u001f\u007f]/.test(v);
}
function dayValid(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v < '0001-01-01') return false;
  const ms = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}
function time(v) { return v instanceof Timestamp && Number.isFinite(v.toMillis()); }
function healthValid(h) {
  if (!object(h) || !time(h.date) ||
      !Object.keys(h).every(k => ['date', 'mood', 'hasTakenPillToday', 'menstrualCycle', 'waterIntakeMl'].includes(k)) ||
      (Object.hasOwn(h, 'mood') && typeof h.mood !== 'string') ||
      (Object.hasOwn(h, 'hasTakenPillToday') && typeof h.hasTakenPillToday !== 'boolean')) return false;
  if (!Object.hasOwn(h, 'menstrualCycle')) return true;
  const c = h.menstrualCycle;
  return exact(c, ['isEnabled', 'lastPeriodStart', 'cycleLengthDays', 'periodLengthDays']) &&
    typeof c.isEnabled === 'boolean' && typeof c.lastPeriodStart === 'string' &&
    Number.isInteger(c.cycleLengthDays) && c.cycleLengthDays >= 1 && c.cycleLengthDays <= 120 &&
    Number.isInteger(c.periodLengthDays) && c.periodLengthDays >= 1 && c.periodLengthDays <= c.cycleLengthDays;
}
function stateValid(s, epoch) {
  return exact(s, ['protocolVersion', 'epoch', 'revision', 'waterIntakeMl']) &&
    s.protocolVersion === 2 && s.epoch === epoch && Number.isSafeInteger(s.revision) && s.revision >= 0 &&
    Number.isSafeInteger(s.waterIntakeMl) && s.waterIntakeMl >= 0 && s.waterIntakeMl <= 1_000_000 &&
    (s.revision !== 0 || s.waterIntakeMl === 0);
}
function activationValid(a) {
  return exact(a, ['protocolVersion', 'epoch', 'status', 'legacyWritesBlocked']) &&
    a.protocolVersion === 2 && uuid(a.epoch) && a.status === 'ACTIVE' && a.legacyWritesBlocked === true;
}

// No HTTP handler, credentials, default Firestore connection or environment gate.
// The production entries remain closed even when callers supply enabled/body options.
export async function provisionWaterAccount(options) {
  if (!WATER_V2_ENABLED) fail('WATER_V2_DISABLED');
  return createWaterProvisioner(options).initializeAccount();
}
export async function provisionWaterDay(options, day) {
  if (!WATER_V2_ENABLED) fail('WATER_V2_DISABLED');
  return createWaterProvisioner(options).initializeDay(day);
}

// Explicit trusted-code test seam, analogous to the sync helper's runtime seam.
// NEVER wire this factory to a request or an environment variable. A future
// production ingress requires a separately reviewed gate/auth/App Check policy.
// uid/runId/clock belong to the server job, not to a client payload. The remote
// admission is revalidated on every transaction attempt, including read-only retries.
export function createWaterProvisioner({ db, uid, runId, now = () => Timestamp.now() }) {
  if (!uidValid(uid) || !uuid(runId) || typeof now !== 'function' ||
      typeof db?.runTransaction !== 'function' || typeof db?.collection !== 'function') {
    fail('WATER_INVALID_PROVISION_INPUT');
  }
  const user = db.collection('users').doc(uid);
  const protocol = user.collection('water_protocol');
  const admissionRef = protocol.doc('eligibility');
  const manifestRef = protocol.doc('provisioning');
  const activationRef = protocol.doc('activation');
  const guardRef = db.collection('account_deletion_guards').doc(uid);
  const retiredRef = db.collection('retired_auth_identities').doc(uid);
  const deletionRef = user.collection('runtime').doc('account_deletion');
  const health = user.collection('health_info');
  const states = user.collection('water_state');
  const receipts = user.collection('water_increment_receipts');
  // Reserved server-only namespace: no intents are fabricated by provisioning.
  const intents = user.collection('water_increment_intents');

  async function initialize(requestedDay, first) {
    if ((!first && !dayValid(requestedDay)) || (first && requestedDay !== undefined)) {
      fail('WATER_INVALID_PROVISION_INPUT');
    }
    // Created lazily once for a fresh invocation, stable across transaction retries.
    // Idempotent calls and concurrent losers obtain the committed epoch instead.
    let candidateEpoch;
    return db.runTransaction(async tx => {
      const root = await tx.get(user);
      const guard = await tx.get(guardRef);
      const retired = await tx.get(retiredRef);
      const deletion = await tx.get(deletionRef);
      const admissionDoc = await tx.get(admissionRef);
      const activationDoc = await tx.get(activationRef);
      const manifestDoc = await tx.get(manifestRef);
      const protocolDocs = await tx.get(protocol.limit(4));
      // A deleted root never downgrades an authoritative deny to a 404 or ACK.
      if (guard.exists || retired.exists || deletion.exists ||
          (root.exists && Object.hasOwn(root.data(), '_serverAccountDeletion'))) fail('WATER_ACCOUNT_DELETING');
      if (!root.exists) fail('WATER_USER_NOT_FOUND');
      const admission = admissionDoc.data();
      const clock = now();
      if (!time(clock)) fail('WATER_INVALID_PROVISION_INPUT');
      // Sole accepted proof: a protected admission issued in the SAME commit as
      // the root by an account-creation policy that never admitted legacy clients.
      // Absence of remote water cannot establish the offline-device invariant.
      // There is deliberately no issuer/backfill/reset for existing accounts here.
      if (!exact(admission, ['version', 'uid', 'runId', 'policy', 'legacyWritersExcluded',
        'initialHealthDay', 'issuedAt']) || admission.version !== 1 || admission.uid !== uid ||
        admission.runId !== runId || admission.policy !== 'NEW_ACCOUNT_V2_ONLY' ||
        admission.legacyWritersExcluded !== true || !dayValid(admission.initialHealthDay) ||
        !time(admission.issuedAt) || !time(root.createTime) || !time(admissionDoc.createTime) ||
        !admissionDoc.createTime.isEqual(root.createTime) ||
        admission.issuedAt.seconds > clock.seconds ||
        (admission.issuedAt.seconds === clock.seconds && admission.issuedAt.nanoseconds > clock.nanoseconds)) {
        fail('WATER_PROVISION_UNAUTHORIZED');
      }
      // issuedAt is the server's processing time, not creation metadata. It must
      // be valid/non-future; atomic origin is checked by the two exact createTimes.
      const createdDayMin = new Date(admission.issuedAt.toMillis() - 840 * 60_000).toISOString().slice(0, 10);
      const createdDayMax = new Date(admission.issuedAt.toMillis() + 840 * 60_000).toISOString().slice(0, 10);
      if (admission.initialHealthDay < createdDayMin || admission.initialHealthDay > createdDayMax) {
        fail('WATER_PROVISION_UNAUTHORIZED');
      }
      const healthDay = first ? admission.initialHealthDay : requestedDay;
      // Civil day comes from the server job/admission, never a retry client clock.
      // UTC+14 is the latest possible civil date, not evidence of a new account.
      const latestDay = new Date(clock.toMillis() + 840 * 60_000).toISOString().slice(0, 10);
      if (healthDay < admission.initialHealthDay || healthDay > latestDay) fail('WATER_PROVISION_NOT_ELIGIBLE');
      if (protocolDocs.docs.some(d => !['eligibility', 'activation', 'provisioning'].includes(d.id))) {
        fail('WATER_INVALID_REMOTE_STATE');
      }
      const stateRef = states.doc(healthDay);
      const projectionRef = health.doc(healthDay);
      const stateDoc = await tx.get(stateRef);
      const projectionDoc = await tx.get(projectionRef);
      const dayReceipts = await tx.get(receipts.where('healthDay', '==', healthDay).limit(1));
      const knownIntents = await tx.get(intents.limit(1));
      if (!knownIntents.empty) fail('WATER_PROVISION_NOT_ELIGIBLE');
      const h = projectionDoc.data();
      if (projectionDoc.exists && !healthValid(h)) fail('WATER_INVALID_REMOTE_STATE');
      let epoch;
      if (activationDoc.exists || manifestDoc.exists) {
        const a = activationDoc.data();
        const m = manifestDoc.data();
        if (!activationDoc.exists || !manifestDoc.exists || !activationValid(a) ||
            !exact(m, ['version', 'runId', 'epoch', 'initialHealthDay', 'accountCreatedAt', 'provisionedAt']) ||
            m.version !== 1 || m.runId !== runId || m.epoch !== a.epoch ||
            m.initialHealthDay !== admission.initialHealthDay || !time(m.accountCreatedAt) ||
            !m.accountCreatedAt.isEqual(root.createTime) || !time(m.provisionedAt) ||
            m.provisionedAt.toMillis() < admission.issuedAt.toMillis() ||
            m.provisionedAt.toMillis() > clock.toMillis()) fail('WATER_INVALID_REMOTE_STATE');
        epoch = a.epoch;
        // Every later day depends on the original committed set, even on replay.
        if (healthDay > admission.initialHealthDay) {
          const initialS = await tx.get(states.doc(admission.initialHealthDay));
          const initialH = await tx.get(health.doc(admission.initialHealthDay));
          if (!initialS.exists || !stateValid(initialS.data(), epoch) || !initialH.exists ||
              !healthValid(initialH.data()) || initialH.data().waterIntakeMl !== initialS.data().waterIntakeMl) {
            fail('WATER_INVALID_REMOTE_STATE');
          }
        }
        if (stateDoc.exists) {
          const s = stateDoc.data();
          if (!stateValid(s, epoch) || !projectionDoc.exists || h.waterIntakeMl !== s.waterIntakeMl ||
              (s.revision === 0 && !dayReceipts.empty) || (s.revision > 0 && dayReceipts.empty)) {
            fail('WATER_INVALID_REMOTE_STATE');
          }
          // Validate the observed receipt using the APPROVED read-only contract,
          // within this same transaction. Do not invent a weaker receipt parser.
          // This sanity check is not a complete audit of historical receipts.
          if (!dayReceipts.empty) {
            try {
              await syncWater({ db: { collection: db.collection.bind(db), runTransaction: fn => fn(tx) },
                userId: uid, enabled: true, body: { operation: 'reconcile_water', version: 2,
                  healthDay, pendingMutationIds: [dayReceipts.docs[0].id], expectedEpoch: epoch,
                  expectedRevision: s.revision } });
            } catch (error) {
              if (['WATER_INVALID_PAYLOAD', 'WATER_INVALID_REMOTE_STATE', 'WATER_SNAPSHOT_MISMATCH'].includes(error.code)) {
                fail('WATER_INVALID_REMOTE_STATE');
              }
              throw error;
            }
          }
          // Existing confirmed state is authoritative; never rewrite it.
          return { version: 2, healthDay, epoch, revision: s.revision,
            waterIntakeMl: s.waterIntakeMl, alreadyProvisioned: true };
        }
        // The initial day cannot disappear and be reconstructed as a fresh day.
        if (first || healthDay === admission.initialHealthDay) fail('WATER_INVALID_REMOTE_STATE');
      } else {
        if (!first) fail('WATER_PROVISION_NOT_ELIGIBLE');
        // Bounded whole-account history check INSIDE the committing transaction.
        // Overflow refuses; it never samples and declares an account empty.
        const allHealth = await tx.get(health.limit(HISTORY_LIMIT + 1));
        const anyState = await tx.get(states.limit(1));
        const anyReceipt = await tx.get(receipts.limit(1));
        if (allHealth.size > HISTORY_LIMIT || !anyState.empty || !anyReceipt.empty ||
            allHealth.docs.some(d => !dayValid(d.id) || !healthValid(d.data()) ||
              Object.hasOwn(d.data(), 'waterIntakeMl'))) fail('WATER_PROVISION_NOT_ELIGIBLE');
        epoch = candidateEpoch ??= randomUUID();
      }
      if (stateDoc.exists || (projectionDoc.exists && Object.hasOwn(h, 'waterIntakeMl')) || !dayReceipts.empty) {
        fail('WATER_PROVISION_NOT_ELIGIBLE');
      }
      // All reads/authorization precede all writes. Never replace legitimate Health.
      if (!activationDoc.exists) {
        tx.create(activationRef, { protocolVersion: 2, epoch, status: 'ACTIVE', legacyWritesBlocked: true });
        tx.create(manifestRef, { version: 1, runId, epoch, initialHealthDay: healthDay,
          accountCreatedAt: root.createTime, provisionedAt: clock });
      }
      tx.create(stateRef, { protocolVersion: 2, epoch, revision: 0, waterIntakeMl: 0 });
      if (projectionDoc.exists) tx.update(projectionRef, { waterIntakeMl: 0 });
      else tx.create(projectionRef, { waterIntakeMl: 0,
        date: Timestamp.fromMillis(Date.parse(`${healthDay}T00:00:00.000Z`)) });
      return { version: 2, healthDay, epoch, revision: 0, waterIntakeMl: 0, alreadyProvisioned: false };
    });
  }
  // Gate is deliberately not a boolean/function supplied by a request.
  return Object.freeze({ initializeAccount: () => initialize(undefined, true),
    initializeDay: healthDay => initialize(healthDay, false) });
}

export function createWaterProvisioningTestHarness(options) {
  if (WATER_V2_ENABLED !== false) fail('WATER_V2_DISABLED');
  return createWaterProvisioner(options);
}
