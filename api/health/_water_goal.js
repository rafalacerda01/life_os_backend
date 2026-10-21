import {Timestamp} from 'firebase-admin/firestore';
import {WATER_V2_ENABLED} from './_sync_water.js';
import policy from './_water_policy.cjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const goal = v => Number.isSafeInteger(v) && v >= 250 && v <= 10000 && v % 250 === 0;
class GoalError extends Error {
  constructor(code) { super('Meta de hidratação indisponível.'); this.code=code; }
}
const fail = code => {throw new GoalError(code);};
export function goalErrorResponse(error) {
  const code = error instanceof GoalError ? error.code : 'WATER_PROVISIONING_PENDING';
  return {status:code === 'WATER_INVALID_PAYLOAD' ? 400 : 503,
    body:{error:'Meta de hidratação indisponível.',code,retryable:code !== 'WATER_INVALID_PAYLOAD'}};
}
export function validateGoalPayload(body) {
  if (!exact(body,['operation','version','mutationId','originEpoch','goalMl']) ||
      body.operation !== 'set_water_goal' || body.version !== 2 || !uuid.test(body.mutationId) ||
      !uuid.test(body.originEpoch) || !goal(body.goalMl)) fail('WATER_INVALID_PAYLOAD');
}
function preference(value,epoch) {
  if (!exact(value,['version','epoch','goalMl','revision']) || value.version !== 2 ||
      value.epoch !== epoch || !goal(value.goalMl) || !Number.isSafeInteger(value.revision) ||
      value.revision < 1) fail('WATER_INVALID_REMOTE_STATE');
  return value;
}

// Server dependencies only. Receipts are account-wide and never reset by a retry.
export function createWaterGoals({db,cohort=policy.WATER_COHORT,enabled=WATER_V2_ENABLED}) {
  async function operate(uid,body) {
    if (typeof uid !== 'string' || !uid || uid.trim() !== uid || uid.length>128 || /[/\u0000-\u001f]/.test(uid)) fail('WATER_INVALID_PAYLOAD');
    if (body) validateGoalPayload(body);
    if (enabled !== true) fail('WATER_V2_DISABLED');
    try {policy.requireOpenCohort(cohort,db.projectId);} catch (_) {fail('WATER_COHORT_CLOSED');}
    const root=db.collection('users').doc(uid), settings=root.collection('health_settings').doc('water_v2');
    return db.runTransaction(async tx => {
      const user=await tx.get(root);
      const denied=[];
      for (const ref of [db.collection('account_deletion_guards').doc(uid),
        db.collection('retired_auth_identities').doc(uid),root.collection('runtime').doc('account_deletion')]) denied.push(await tx.get(ref));
      const eligibility=await tx.get(root.collection('water_protocol').doc('eligibility'));
      const active=await tx.get(root.collection('water_protocol').doc('activation'));
      const existing=await tx.get(settings);
      const receiptRef=body ? root.collection('water_goal_receipts').doc(body.mutationId) : null;
      const receipt=receiptRef ? await tx.get(receiptRef) : null;
      if (denied.some(d=>d.exists) || (user.exists && Object.hasOwn(user.data(),'_serverAccountDeletion'))) fail('ACCOUNT_DELETION_BLOCKED');
      const a=active.data(),e=eligibility.data();
      if (!user.exists || !eligibility.exists || e.uid!==uid || e.legacyWritersExcluded!==true ||
          e.policy!=='NEW_ACCOUNT_V2_ONLY' || !user.createTime?.isEqual(eligibility.createTime) ||
          !exact(a,['protocolVersion','epoch','status','legacyWritesBlocked']) ||
          a.protocolVersion!==2 || !uuid.test(a.epoch) || a.status!=='ACTIVE' || a.legacyWritesBlocked!==true) fail('WATER_NOT_ELIGIBLE');
      let state=existing.exists ? preference(existing.data(),a.epoch) : {version:2,epoch:a.epoch,goalMl:3000,revision:0};
      let appliedRevision=null;
      if (body) {
        if (body.originEpoch!==a.epoch) fail('WATER_EPOCH_MISMATCH');
        if (receipt.exists) {
          const r=receipt.data();
          if (!exact(r,['version','mutationId','epoch','goalMl','appliedRevision','appliedAt']) ||
              r.version!==2 || r.mutationId!==body.mutationId || r.epoch!==a.epoch || r.goalMl!==body.goalMl ||
              !(r.appliedAt instanceof Timestamp) || !Number.isSafeInteger(r.appliedRevision) ||
              r.appliedRevision<1 || r.appliedRevision>state.revision) fail('WATER_MUTATION_CONFLICT');
          appliedRevision=r.appliedRevision;
        } else {
          if (state.revision>=Number.MAX_SAFE_INTEGER) fail('WATER_INVALID_REMOTE_STATE');
          state={...state,goalMl:body.goalMl,revision:state.revision+1};
          appliedRevision=state.revision;
          tx.set(settings,state);
          tx.create(receiptRef,{version:2,mutationId:body.mutationId,epoch:a.epoch,goalMl:body.goalMl,
            appliedRevision,appliedAt:Timestamp.now()});
        }
      }
      // Replaying an old receipt returns the current preference, never old state.
      return {goalMl:state.goalMl,goalRevision:state.revision,...(body ?
        {success:true,operation:'set_water_goal',version:2,mutationId:body.mutationId,
          requestedGoalMl:body.goalMl,epoch:a.epoch,appliedRevision}: {})};
    });
  }
  return Object.freeze({read:uid=>operate(uid),set:(uid,body)=>operate(uid,body)});
}
