import {assertPointerMatchesSession, assertStoredSessionIntegrity,
  createFocusHandler, FOCUS_STATUS, FocusHttpError, getNowTimestamp,
  stateConflict, validateSessionPayload} from './_shared.js';
async function status({body,db,uid}) {
  const {sessionId}=validateSessionPayload(body),root=db.collection('users').doc(uid);
  const value=await db.runTransaction(async tx=>{
    const snap=await tx.get(root.collection('verified_focus_sessions').doc(sessionId));
    if(!snap.exists)throw new FocusHttpError(404,'FOCUS_SESSION_NOT_FOUND','A sessão Focus não foi encontrada.');
    const s=snap.data();assertStoredSessionIntegrity(s,uid,sessionId);
    let status=s.status,remainingSeconds=0;
    if(status===FOCUS_STATUS.RUNNING){
      const pointer=await tx.get(root.collection('runtime').doc('active_focus'));
      if(!pointer.exists)throw stateConflict();assertPointerMatchesSession(pointer.data(),s);
      const now=getNowTimestamp().toMillis();
      if(now>s.expiresAt.toMillis())status=FOCUS_STATUS.EXPIRED;
      else remainingSeconds=Math.max(0,Math.ceil((s.startedAt.toMillis()+s.plannedDurationSeconds*1000-now)/1000));
    }
    return {sessionId,status,targetId:s.targetId,targetType:s.targetType,
      plannedDurationSeconds:s.plannedDurationSeconds,remainingSeconds};
  });
  return {body:value};
}
export default createFocusHandler('status','FOCUS_STATUS_FAILED',status);
