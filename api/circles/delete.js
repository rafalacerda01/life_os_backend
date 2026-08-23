import { Timestamp } from 'firebase-admin/firestore';

import {
  CircleHttpError,
  createCircleDeleteHandler,
  hasExactKeys,
  normalizeCircleId,
} from './_shared.js';

export const CIRCLE_DELETION_COLLECTION = 'circle_deletions';
export const CIRCLE_DELETION_STATE = 'SERVER_DELETING';
export const CIRCLE_DELETION_MARKER_VERSION = 1;
export const MAX_CIRCLE_MEMBERS = 10;

function stateConflict(message = 'O estado do Circle esta inconsistente.') {
  return new CircleHttpError(409, 'CIRCLE_STATE_CONFLICT', message);
}

function isTimestamp(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.toMillis === 'function' &&
    Number.isFinite(value.toMillis())
  );
}

function validateMarker(marker, circleId) {
  if (
    !hasExactKeys(marker, [
      'version',
      'state',
      'circleId',
      'initiatedBy',
      'memberUids',
      'createdAt',
    ]) ||
    marker.version !== CIRCLE_DELETION_MARKER_VERSION ||
    marker.state !== CIRCLE_DELETION_STATE ||
    marker.circleId !== circleId ||
    normalizeCircleId(marker.initiatedBy) !== marker.initiatedBy ||
    !Array.isArray(marker.memberUids) ||
    marker.memberUids.length < 1 ||
    marker.memberUids.length > MAX_CIRCLE_MEMBERS ||
    !isTimestamp(marker.createdAt)
  ) {
    throw stateConflict('O marker de exclusao do Circle esta inconsistente.');
  }

  const memberUids = marker.memberUids.map((value) => {
    const normalized = normalizeCircleId(value);
    if (normalized === null) {
      throw stateConflict('A lista de membros do Circle esta inconsistente.');
    }
    return normalized;
  });
  if (
    new Set(memberUids).size !== memberUids.length ||
    !memberUids.includes(marker.initiatedBy)
  ) {
    throw stateConflict('A lista de membros do Circle esta inconsistente.');
  }

  return {
    initiatedBy: marker.initiatedBy,
    memberUids: Object.freeze([...memberUids]),
  };
}

function validateCircle(circle, uid, memberCount) {
  if (
    circle?.schemaVersion !== 2 ||
    normalizeCircleId(circle.adminId) !== circle.adminId ||
    !Number.isInteger(circle.memberCount) ||
    circle.memberCount < 1 ||
    circle.memberCount > MAX_CIRCLE_MEMBERS ||
    (circle.memberLimit !== 3 && circle.memberLimit !== 10) ||
    circle.memberCount > circle.memberLimit ||
    circle.memberCount !== memberCount
  ) {
    throw stateConflict();
  }
  if (circle.adminId !== uid) {
    throw new CircleHttpError(
      403,
      'CIRCLE_ADMIN_REQUIRED',
      'Somente o administrador pode excluir o Circle.',
    );
  }
  if (
    circle.deletionState !== undefined &&
    circle.deletionState !== CIRCLE_DELETION_STATE
  ) {
    throw stateConflict();
  }
}

function validateMember(snapshot, adminUid) {
  const uid = normalizeCircleId(snapshot.id);
  const data = snapshot.data();
  if (
    uid === null ||
    (data?.role !== 'admin' && data?.role !== 'member') ||
    (uid === adminUid && data.role !== 'admin') ||
    (uid !== adminUid && data.role !== 'member')
  ) {
    throw stateConflict('A membership do Circle esta inconsistente.');
  }
  return uid;
}

async function beginCircleDeletion({ db, uid, circleId, now }) {
  const circleRef = db.collection('circles').doc(circleId);
  const markerRef = db.collection(CIRCLE_DELETION_COLLECTION).doc(circleId);
  const listedMembers = await circleRef
    .collection('members')
    .limit(MAX_CIRCLE_MEMBERS + 1)
    .get();

  return db.runTransaction(async (transaction) => {
    const markerSnapshot = await transaction.get(markerRef);
    const circleSnapshot = await transaction.get(circleRef);

    if (markerSnapshot.exists) {
      const marker = validateMarker(markerSnapshot.data(), circleId);
      if (marker.initiatedBy !== uid) {
        throw new CircleHttpError(
          403,
          'CIRCLE_ADMIN_REQUIRED',
          'Somente o administrador que iniciou a exclusao pode retoma-la.',
        );
      }
      if (circleSnapshot.exists) {
        const circle = circleSnapshot.data();
        if (
          circle?.adminId !== uid ||
          circle?.deletionState !== CIRCLE_DELETION_STATE
        ) {
          throw stateConflict();
        }
      }
      return { circleRef, markerRef, memberUids: marker.memberUids };
    }

    if (!circleSnapshot.exists) {
      throw new CircleHttpError(
        404,
        'CIRCLE_NOT_FOUND',
        'Circle nao encontrado.',
      );
    }
    if (
      listedMembers.docs.length < 1 ||
      listedMembers.docs.length > MAX_CIRCLE_MEMBERS
    ) {
      throw stateConflict('A quantidade de membros do Circle esta inconsistente.');
    }

    const listedUids = listedMembers.docs.map((snapshot) =>
      validateMember(snapshot, circleSnapshot.data()?.adminId),
    );
    validateCircle(circleSnapshot.data(), uid, listedUids.length);

    const transactionalMembers = await Promise.all(
      listedUids.map((memberUid) =>
        transaction.get(circleRef.collection('members').doc(memberUid)),
      ),
    );
    for (const snapshot of transactionalMembers) {
      if (!snapshot.exists) {
        throw stateConflict('A membership do Circle mudou durante a exclusao.');
      }
      validateMember(snapshot, uid);
    }

    const memberUids = Object.freeze([...listedUids].sort());
    const marker = {
      version: CIRCLE_DELETION_MARKER_VERSION,
      state: CIRCLE_DELETION_STATE,
      circleId,
      initiatedBy: uid,
      memberUids: [...memberUids],
      createdAt: now,
    };
    transaction.set(markerRef, marker);
    transaction.update(circleRef, { deletionState: CIRCLE_DELETION_STATE });
    return { circleRef, markerRef, memberUids };
  });
}

async function clearMemberCircleReferences({ db, circleId, memberUids }) {
  await db.runTransaction(async (transaction) => {
    const userRefs = memberUids.map((uid) => db.collection('users').doc(uid));
    const snapshots = await Promise.all(
      userRefs.map((reference) => transaction.get(reference)),
    );
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index];
      if (snapshot.exists && snapshot.data()?.activeCircleId === circleId) {
        transaction.update(userRefs[index], { activeCircleId: null });
      }
    }
  });
}

export async function deleteCircle({
  body,
  db,
  uid,
  now = Timestamp.now(),
}) {
  const circleId = body.circleId;
  const deletion = await beginCircleDeletion({
    db,
    uid,
    circleId,
    now,
  });

  await clearMemberCircleReferences({
    db,
    circleId,
    memberUids: deletion.memberUids,
  });
  await db.recursiveDelete(deletion.circleRef);
  await deletion.markerRef.delete();

  return { body: { deleted: true } };
}

export default createCircleDeleteHandler(deleteCircle);
