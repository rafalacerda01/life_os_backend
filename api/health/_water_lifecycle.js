import {Timestamp} from 'firebase-admin/firestore';
import policy from './_water_policy.cjs';
import {createWaterGoals} from './_water_goal.js';
import {WATER_V2_ENABLED} from './_sync_water.js';
import {createWaterAdmissionIssuer, admissionError} from './_issue_water_admission.js';
import {createWaterProvisioner, provisioningError} from './_provision_water.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
class LifecycleError extends Error {
  constructor(code, status = 503) { super('Hidratação temporariamente indisponível.'); this.code = code; this.status = status; }
}
function fail(code, status) { throw new LifecycleError(code, status); }
const object = x => x && Object.getPrototypeOf(x) === Object.prototype;
const exact=(v,keys)=>object(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const after=(a,b)=>a.seconds>b.seconds || (a.seconds===b.seconds && a.nanoseconds>b.nanoseconds);
const dayAt = (millis, offset) => new Date(millis + offset * 60000).toISOString().slice(0, 10);
export function waterLifecycleError(error) {
  const mapped = admissionError(error), provision = provisioningError(error);
  if (mapped.code === 'ACCOUNT_DELETION_BLOCKED' || provision.code === 'ACCOUNT_DELETION_BLOCKED') {
    return {status:503, body:{error:'Conta indisponível para sincronização.', code:'ACCOUNT_DELETION_BLOCKED', retryable:true}};
  }
  const code = error instanceof LifecycleError ? error.code : 'WATER_PROVISIONING_PENDING';
  return {status:error instanceof LifecycleError ? error.status : 503,
    body:{error:'Hidratação temporariamente indisponível.', code, retryable:code !== 'WATER_INVALID_PAYLOAD'}};
}

// Server-owned dependencies; never constructed from req.body or decoded claims.
// Tests supply demo-life-os and a synthetic approved cohort through trusted code.
export function createWaterLifecycle({db, auth, cohort = policy.WATER_COHORT,
  enabled = WATER_V2_ENABLED, now = () => Timestamp.now()}) {
  const configured = Object.freeze({...cohort});
  async function blocked(tx, uid) {
    for (const ref of [db.collection('account_deletion_guards').doc(uid),
      db.collection('retired_auth_identities').doc(uid),
      db.collection('users').doc(uid).collection('runtime').doc('account_deletion')]) {
      if ((await tx.get(ref)).exists) fail('ACCOUNT_DELETION_BLOCKED');
    }
  }
  function identity(uid) {
    if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.trim() !== uid ||
        /[\u0000-\u001f\u007f/]/.test(uid) || ['.', '..'].includes(uid) || /^__.*__$/.test(uid)) fail('WATER_INVALID_PAYLOAD',400);
  }
  function open() {
    if (enabled !== true) fail('WATER_V2_DISABLED');
    try { policy.requireOpenCohort(configured, db.projectId); } catch (_) { fail('WATER_COHORT_CLOSED'); }
  }
  async function admission(uid, clock, firstDay) {
    const ledgerRef = db.collection('account_birth_decisions').doc(uid);
    const root = db.collection('users').doc(uid);
    // Live Auth is a consistency check, not generation proof or a Firestore fence.
    let user;
    try { user = await auth.getUser(uid); } catch (_) { fail('WATER_PROVISIONING_PENDING'); }
    if (user.uid !== uid || user.tenantId != null) fail('WATER_NOT_ELIGIBLE');
    const created = Date.parse(user.metadata?.creationTime);
    const read = async tx => {
      const get = ref => tx ? tx.get(ref) : ref.get();
      const doc = await get(ledgerRef), eligibility = await get(root.collection('water_protocol').doc('eligibility'));
      if (!doc.exists) fail('WATER_PROVISIONING_PENDING'); // no metadata/backfill fallback
      const r = doc.data();
      if (!exact(r,['version','uid','projectId','tenantId','authCreatedAt','sourceType','sourceEventId','eventAt','cohort','decisionId','originalIdentity','recordedAt','status']) || r.version !== 1 || r.uid !== uid || r.projectId !== configured.projectId ||
          r.tenantId !== null || r.sourceType !== 'FIREBASE_AUTH_CREATE' ||
          r.status !== 'RECORDED_COHORT_CLOSED' || !uuid.test(r.decisionId) ||
          typeof r.sourceEventId !== 'string' || !r.sourceEventId ||
          !(r.authCreatedAt instanceof Timestamp) || !(r.eventAt instanceof Timestamp) ||
          !(r.recordedAt instanceof Timestamp) || r.authCreatedAt.toMillis() < configured.cutoverMillis ||
          after(r.authCreatedAt,r.eventAt) || after(r.eventAt,r.recordedAt) ||
          after(r.recordedAt,clock) || !Number.isFinite(created) ||
          Math.floor(created / 1000) !== r.authCreatedAt.seconds ||
          !exact(r.cohort,['version','id','policy','state','cutoverAt']) || r.cohort.version!==1 || r.cohort.id !== configured.id || r.cohort.state !== 'CLOSED' ||
          r.cohort.policy !== configured.policy || !(r.cohort.cutoverAt instanceof Timestamp) ||
          r.cohort.cutoverAt.toMillis() !== configured.cutoverMillis ||
          !exact(r.originalIdentity,['uid','email','displayName','photoUrl']) || r.originalIdentity.uid !== uid) fail('WATER_NOT_ELIGIBLE');
      const initialHealthDay = eligibility.exists ? eligibility.data().initialHealthDay : firstDay;
      if (!initialHealthDay) fail('WATER_PROVISIONING_PENDING');
      return {identity:r.originalIdentity, decision:{uid, decisionId:r.decisionId,
        policy:configured.policy, legacyWritersExcluded:true, initialHealthDay}};
    };
    // Read authoritative time again for each step/transaction retry. A concurrent
    // winner may commit after the bootstrap clock used to select the civil day.
    return createWaterAdmissionIssuer({db, getTrustedAdmission:read, now}).issue();
  }
  return Object.freeze({
    async bootstrap(uid, body) {
      identity(uid);
      if (!object(body) || Object.keys(body).sort().join(',') !== 'operation,timeZoneOffsetMinutes,version' ||
          body.operation !== 'bootstrap_water' || body.version !== 2 ||
          !Number.isInteger(body.timeZoneOffsetMinutes) || Math.abs(body.timeZoneOffsetMinutes) > 840) fail('WATER_INVALID_PAYLOAD',400);
      await db.runTransaction(async tx => {
        await blocked(tx,uid);
        const root = await tx.get(db.collection('users').doc(uid));
        if (root.exists && Object.hasOwn(root.data(),'_serverAccountDeletion')) fail('ACCOUNT_DELETION_BLOCKED');
      });
      open();
      const clock = now(), day = dayAt(clock.toMillis(),body.timeZoneOffsetMinutes);
      const rootRef = db.collection('users').doc(uid);
      const state = await db.runTransaction(async tx => {
        await blocked(tx,uid);
        const root = await tx.get(rootRef), eligibility = await tx.get(rootRef.collection('water_protocol').doc('eligibility'));
        const birth = await tx.get(db.collection('account_birth_decisions').doc(uid));
        if (root.exists && Object.hasOwn(root.data(),'_serverAccountDeletion')) fail('ACCOUNT_DELETION_BLOCKED');
        if (root.exists && !eligibility.exists) return 'EXISTING_UNADMITTED';
        return null;
      });
      if (state) {
        let user;
        try {user=await auth.getUser(uid);} catch (_) {fail('WATER_PROVISIONING_PENDING');}
        const born=Date.parse(user.metadata?.creationTime);
        const legacy=user.uid===uid && user.tenantId==null && Number.isFinite(born) && born<configured.cutoverMillis;
        return {success:true,operation:'bootstrap_water',version:2,state:legacy ? 'LEGACY' : 'NOT_ELIGIBLE'};
      }
      // Earliest civil date at admission anchors offline travel across UTC-14..+14.
      const admitted = await admission(uid,clock,dayAt(clock.toMillis(),-840));
      const provisioner = createWaterProvisioner({db,uid,runId:admitted.runId,now});
      const first = await provisioner.initializeAccount();
      const snapshot = day === first.healthDay ? first : await provisioner.initializeDay(day);
      const goals=await createWaterGoals({db,cohort:configured,enabled}).read(uid);
      return {success:true, operation:'bootstrap_water', version:2, state:'READY',
        initialHealthDay:admitted.initialHealthDay,...goals,
        healthDay:day, epoch:snapshot.epoch, revision:snapshot.revision, waterIntakeMl:snapshot.waterIntakeMl};
    },
    async ensureAccount(uid) {
      identity(uid); open();
      const clock=now(),admitted=await admission(uid,clock);
      return createWaterProvisioner({db,uid,runId:admitted.runId,now}).initializeAccount();
    },
    async ensureDay(uid, day) {
      identity(uid); open();
      const clock=now(), admitted=await admission(uid,clock);
      const p=createWaterProvisioner({db,uid,runId:admitted.runId,now});
      await p.initializeAccount();
      return p.initializeDay(day);
    },
  });
}
