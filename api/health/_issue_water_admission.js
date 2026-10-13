import { createHash, randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { WATER_V2_ENABLED } from './_sync_water.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COUNTERS = ['habitsCount', 'tasksCount', 'goalsCount', 'subjectsCount', 'medicationsCount', 'transactionsCount'];
const PROOF_KEYS = ['version', 'uid', 'decisionId', 'runId', 'policy', 'legacyWritersExcluded', 'initialHealthDay', 'profileFingerprint'];
const ELIGIBILITY_KEYS = ['version', 'uid', 'runId', 'policy', 'legacyWritersExcluded', 'initialHealthDay', 'issuedAt'];
class IssuanceError extends Error {
  constructor(code) { super('Não foi possível admitir a conta para hidratação.'); this.code = code; }
}
function fail(code) { throw new IssuanceError(code); }
export function admissionError(error) {
  return { code: error instanceof IssuanceError ? error.code : 'WATER_ADMISSION_STORAGE_UNAVAILABLE',
    message: 'Não foi possível admitir a conta para hidratação.' };
}
function object(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v));
}
function exact(v, keys) { return object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)); }
function uid(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 && Buffer.byteLength(v, 'utf8') <= 128 &&
    v.trim() === v && !v.includes('/') && !['.', '..'].includes(v) && !/^__.*__$/.test(v) && !/[\u0000-\u001f\u007f]/.test(v);
}
function uuid(v) { return typeof v === 'string' && UUID.test(v); }
function day(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v < '0001-01-01') return false;
  const ms = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}
function time(v) { return v instanceof Timestamp && Number.isFinite(v.toMillis()); }
function after(a, b) { return a.seconds > b.seconds || (a.seconds === b.seconds && a.nanoseconds > b.nanoseconds); }
function text(v, max) { return typeof v === 'string' && v.trim() === v && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v); }
function fingerprint(profile) { return createHash('sha256').update(JSON.stringify(profile)).digest('hex'); }
function trustedContext(value) {
  if (!exact(value, ['identity', 'decision'])) fail('WATER_ADMISSION_UNAUTHORIZED');
  const i = value.identity, d = value.decision;
  if (!exact(i, ['uid', 'email', 'displayName', 'photoUrl']) || !uid(i.uid) || !text(i.email, 320) ||
      !text(i.displayName, 200) || !(i.photoUrl === null || text(i.photoUrl, 2048)) ||
      !exact(d, ['uid', 'decisionId', 'policy', 'legacyWritersExcluded', 'initialHealthDay']) ||
      d.uid !== i.uid || !uuid(d.decisionId) || d.policy !== 'NEW_ACCOUNT_V2_ONLY' ||
      d.legacyWritersExcluded !== true || !day(d.initialHealthDay)) fail('WATER_ADMISSION_UNAUTHORIZED');
  // Fixed server defaults, never balance/premium/counters selected by a caller.
  const profile = { email: i.email, displayName: i.displayName, photoUrl: i.photoUrl,
    isPremium: false, xp: 0, level: 1, streak: 0, ...Object.fromEntries(COUNTERS.map(k => [k, 0])) };
  return { uid: i.uid, decisionId: d.decisionId, initialHealthDay: d.initialHealthDay,
    profile, profileFingerprint: fingerprint(profile) };
}
function sameContext(a, b) {
  return a.uid === b.uid && a.decisionId === b.decisionId && a.initialHealthDay === b.initialHealthDay &&
    a.profileFingerprint === b.profileFingerprint;
}
function compatibleProfile(p) {
  // Replay permits legitimate later profile/progress/server fields; never resets them.
  return object(p) && typeof p.email === 'string' && typeof p.displayName === 'string' &&
    (p.photoUrl === null || typeof p.photoUrl === 'string') && typeof p.isPremium === 'boolean' &&
    Number.isSafeInteger(p.level) && p.level >= 1 &&
    ['xp', 'streak', ...COUNTERS].every(k => Number.isSafeInteger(p[k]) && p[k] >= 0);
}
function civilDayAt(timestamp, offset) { return new Date(timestamp.toMillis() + offset * 60000).toISOString().slice(0, 10); }
function coherentDay(healthDay, timestamp) {
  return healthDay >= civilDayAt(timestamp, -840) && healthDay <= civilDayAt(timestamp, 840);
}

// No public handler, environment activation, Firebase credentials or default DB.
export async function issueWaterAdmission() { fail('WATER_V2_DISABLED'); }

// Trusted-code seam only; not an ingress or proof that an arbitrary payload is verified.
// The future privileged layer must persist its immutable decision and original
// sanitized identity, prove genuine V2-only account birth, and return them here.
// Auth/App Check/own UID/rate limits are required before any future HTTP wiring.
export function createWaterAdmissionIssuerTestHarness(options) {
  if (!object(options) || !Object.keys(options).every(k => ['db', 'getTrustedAdmission', 'now'].includes(k)) ||
      typeof options.db?.collection !== 'function' || typeof options.db?.runTransaction !== 'function' ||
      typeof options.getTrustedAdmission !== 'function' || (options.now !== undefined && typeof options.now !== 'function')) {
    fail('WATER_ADMISSION_INVALID_CONFIGURATION');
  }
  if (WATER_V2_ENABLED !== false) fail('WATER_V2_DISABLED');
  const { db, getTrustedAdmission, now = () => Timestamp.now() } = options;
  return Object.freeze({ async issue(...args) {
    if (args.length) fail('WATER_ADMISSION_UNAUTHORIZED');
    const bound = trustedContext(await getTrustedAdmission());
    const root = db.collection('users').doc(bound.uid);
    const eligibility = root.collection('water_protocol').doc('eligibility');
    // Kept outside water_protocol: the approved provisioner expects its exact namespace.
    const proof = root.collection('runtime').doc('water_admission');
    const deletion = root.collection('runtime').doc('account_deletion');
    const guard = db.collection('account_deletion_guards').doc(bound.uid);
    let candidateRunId;
    return db.runTransaction(async tx => {
      const current = trustedContext(await getTrustedAdmission());
      if (!sameContext(bound, current)) fail('WATER_ADMISSION_UNAUTHORIZED');
      const clock = now(); if (!time(clock)) fail('WATER_ADMISSION_UNAUTHORIZED');
      const rootDoc = await tx.get(root);
      const guardDoc = await tx.get(guard);
      const eligibilityDoc = await tx.get(eligibility);
      const proofDoc = await tx.get(proof);
      const deletionDoc = await tx.get(deletion);
      if (guardDoc.exists || deletionDoc.exists || (rootDoc.exists && Object.hasOwn(rootDoc.data(), '_serverAccountDeletion'))) {
        fail('WATER_ACCOUNT_DELETING');
      }
      if (rootDoc.exists || eligibilityDoc.exists || proofDoc.exists) {
        const e = eligibilityDoc.data(), p = proofDoc.data();
        if (!rootDoc.exists || !eligibilityDoc.exists || !proofDoc.exists || !compatibleProfile(rootDoc.data()) ||
            !time(rootDoc.createTime) || !time(eligibilityDoc.createTime) || !time(proofDoc.createTime) ||
            !rootDoc.createTime.isEqual(eligibilityDoc.createTime) || !rootDoc.createTime.isEqual(proofDoc.createTime) ||
            !exact(e, ELIGIBILITY_KEYS) || e.version !== 1 || e.uid !== bound.uid || !uuid(e.runId) ||
            e.policy !== 'NEW_ACCOUNT_V2_ONLY' || e.legacyWritersExcluded !== true || e.initialHealthDay !== bound.initialHealthDay ||
            !time(e.issuedAt) || after(e.issuedAt, clock) || !coherentDay(e.initialHealthDay, e.issuedAt) ||
            !exact(p, PROOF_KEYS) || p.version !== 1 || p.uid !== bound.uid || p.decisionId !== bound.decisionId ||
            p.runId !== e.runId || p.policy !== e.policy || p.legacyWritersExcluded !== true ||
            p.initialHealthDay !== e.initialHealthDay || p.profileFingerprint !== bound.profileFingerprint) {
          fail('WATER_ADMISSION_CONFLICT');
        }
        // Existing admission belongs to this exact decision. No profile/eligibility
        // rewrite, no fresh grant, no epoch or water creation, even after a lost reply.
        return { uid: bound.uid, runId: e.runId, initialHealthDay: e.initialHealthDay, alreadyIssued: true };
      }
      if (!coherentDay(bound.initialHealthDay, clock)) fail('WATER_ADMISSION_UNAUTHORIZED');
      // Root absence alone is never evidence. Conservatively refuse known remote
      // Water/runtime remnants; the authority must also exclude offline V1 clients.
      for (const name of ['water_protocol', 'health_info', 'water_state', 'water_increment_receipts', 'water_increment_intents', 'runtime']) {
        if (!(await tx.get(root.collection(name).limit(1))).empty) fail('WATER_ADMISSION_CONFLICT');
      }
      const runId = candidateRunId ??= randomUUID();
      tx.create(root, bound.profile);
      tx.create(eligibility, { version: 1, uid: bound.uid, runId, policy: 'NEW_ACCOUNT_V2_ONLY',
        legacyWritersExcluded: true, initialHealthDay: bound.initialHealthDay, issuedAt: FieldValue.serverTimestamp() });
      tx.create(proof, { version: 1, uid: bound.uid, decisionId: bound.decisionId, runId,
        policy: 'NEW_ACCOUNT_V2_ONLY', legacyWritersExcluded: true, initialHealthDay: bound.initialHealthDay,
        profileFingerprint: bound.profileFingerprint });
      return { uid: bound.uid, runId, initialHealthDay: bound.initialHealthDay, alreadyIssued: false };
    });
  } });
}
