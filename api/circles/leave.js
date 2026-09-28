import { Timestamp } from 'firebase-admin/firestore';
import { CircleHttpError, createCircleLeaveHandler, normalizeCircleId } from './_shared.js';

export const MAX_CIRCLE_LEAVE_CHALLENGES = 240;
const MAX_CIRCLE_MEMBERS = 30;

function conflict() {
  return new CircleHttpError(409, 'CIRCLE_STATE_CONFLICT', 'Nao foi possivel validar o Circle para saida.');
}

function validatePath(snapshot, path) {
  if (normalizeCircleId(snapshot.id) === null || snapshot.ref.path !== `${path}/${snapshot.id}`) {
    throw conflict();
  }
}

function validMembership(data, role) {
  if (!data || data.role !== role || typeof data.displayNameSnapshot !== 'string' ||
      data.displayNameSnapshot.trim().length === 0 || data.displayNameSnapshot.length > 50 ||
      !(data.photoUrlSnapshot === null || (typeof data.photoUrlSnapshot === 'string' && data.photoUrlSnapshot.length <= 2048))) return false;
  try {
    return data.joinedAt != null && typeof data.joinedAt.toMillis === 'function' && Number.isFinite(data.joinedAt.toMillis());
  } catch (_) { return false; }
}

export async function leaveCircle({ body, db, uid, now = Timestamp.now() }) {
  const circleId = normalizeCircleId(body.circleId);
  if (circleId === null || normalizeCircleId(uid) === null) throw conflict();
  const circleRef = db.collection('circles').doc(circleId);
  const userRef = db.collection('users').doc(uid);
  return db.runTransaction(async (transaction) => {
    const user = await transaction.get(userRef);
    const root = await transaction.get(circleRef);
    if (!user.exists) throw conflict();
    if (!root.exists) throw new CircleHttpError(404, 'CIRCLE_NOT_FOUND', 'Circle nao encontrado.');
    const circle = root.data();
    if (circle.schemaVersion !== 2 || Object.hasOwn(circle, 'deletionState') ||
        normalizeCircleId(circle.adminId) === null ||
        !Number.isInteger(circle.memberCount) || circle.memberCount < 1 ||
        ![3, 10, 30].includes(circle.memberLimit) || circle.memberCount > circle.memberLimit ||
        !Number.isInteger(circle.challengeCount) || circle.challengeCount < 0 ||
        circle.challengeCount > MAX_CIRCLE_LEAVE_CHALLENGES ||
        !Object.hasOwn(circle, 'lastChallengeId') ||
        !(circle.lastChallengeId === null || normalizeCircleId(circle.lastChallengeId) !== null)) {
      throw conflict();
    }
    if (circle.adminId === uid) {
      throw new CircleHttpError(403, 'CIRCLE_ADMIN_CANNOT_LEAVE', 'O administrador deve usar as acoes administrativas do Circle.');
    }

    // Query reads stay inside the transaction: joins, new Challenges and writers conflict normally.
    const members = await transaction.get(circleRef.collection('members').limit(MAX_CIRCLE_MEMBERS + 1));
    const challenges = await transaction.get(circleRef.collection('challenges').limit(MAX_CIRCLE_LEAVE_CHALLENGES + 1));
    if (members.docs.length !== circle.memberCount || members.docs.length > MAX_CIRCLE_MEMBERS ||
        challenges.docs.length !== circle.challengeCount || challenges.docs.length > MAX_CIRCLE_LEAVE_CHALLENGES) {
      throw conflict();
    }
    let adminPresent = false;
    let memberRef;
    for (const member of members.docs) {
      validatePath(member, `${circleRef.path}/members`);
      const data = member.data();
      if (!validMembership(data, member.id === circle.adminId ? 'admin' : 'member') ||
          (Object.hasOwn(data, 'uid') && data.uid !== member.id)) throw conflict();
      if (member.id === circle.adminId) adminPresent = true;
      if (member.id === uid) memberRef = member.ref;
    }
    if (!adminPresent) throw conflict();
    const activeCircleId = user.data().activeCircleId;
    const alreadyLeft = memberRef === undefined && activeCircleId === null;
    if (!alreadyLeft && (memberRef === undefined || activeCircleId !== circleId || circle.memberCount < 2)) {
      throw conflict();
    }
    const progressRefs = [];
    for (const challenge of challenges.docs) {
      validatePath(challenge, `${circleRef.path}/challenges`);
      progressRefs.push(challenge.ref.collection('progress').doc(uid));
    }
    // Read the target documents before any writes, including absent progress.
    if (progressRefs.length > 0) await transaction.getAll(...progressRefs);
    for (const reference of progressRefs) transaction.delete(reference);
    if (!alreadyLeft) {
      transaction.delete(memberRef);
      transaction.update(circleRef, { memberCount: circle.memberCount - 1, updatedAt: now });
      transaction.update(userRef, { activeCircleId: null });
    }
    return { body: { left: true } };
  });
}

export default createCircleLeaveHandler(leaveCircle);
