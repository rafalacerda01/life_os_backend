import deletionControl from '../account/_deletion_control.cjs';
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
export const MAX_CIRCLE_MEMBERS = 30;

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
    (circle.memberLimit !== 3 && circle.memberLimit !== 10 && circle.memberLimit !== 30) ||
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
    const closureRef = db.collection('circle_cleanup_guards').doc(circleId);
    const closure = await transaction.get(closureRef);
    validateClosure(closure);

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
      if (!closure.exists) transaction.set(closureRef, {version: 1, state: CIRCLE_DELETION_STATE, createdAt: now});
      return { circleRef, markerRef, memberUids: marker.memberUids, createdAt: markerSnapshot.data().createdAt };
    }

    if (closure.exists && circleSnapshot.exists) throw stateConflict();
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
    transaction.set(closureRef, {version: 1, state: CIRCLE_DELETION_STATE, createdAt: now});
    transaction.set(markerRef, marker);
    transaction.update(circleRef, { deletionState: CIRCLE_DELETION_STATE });
    return { circleRef, markerRef, memberUids, createdAt: now };
  });
}

async function clearMemberCircleReferences({ db, uid, circleId, deletion }) {
  return db.runTransaction(async (transaction) => {
    await readDeletionContext(transaction, db, uid, circleId, deletion);
    const retired = [];
    for (const memberUid of deletion.memberUids) retired.push(await memberIsRetired(transaction, db, memberUid));
    const userRefs = deletion.memberUids.map((memberUid) => db.collection('users').doc(memberUid));
    let snapshots;
    try {
      snapshots = await Promise.all(userRefs.map((reference, index) =>
        retired[index] ? null : transaction.get(reference)));
      for (const snapshot of snapshots) if (snapshot !== null) assertKnownDocument(snapshot);
    } catch (_) {
      throw new deletionControl.DeletionControlError('ACCOUNT_DELETION_BLOCKED');
    }
    let retiredMemberReferencesSkipped = 0;
    let missingMemberProfiles = 0;
    for (let index = 0; index < snapshots.length; index++) {
      if (retired[index]) { retiredMemberReferencesSkipped++; continue; }
      if (!snapshots[index].exists) { missingMemberProfiles++; continue; }
      if (snapshots[index].data()?.activeCircleId === circleId) transaction.update(userRefs[index], {activeCircleId: null});
    }
    return {retiredMemberReferencesSkipped, missingMemberProfiles};
  });
}

function assertKnownDocument(snapshot) {
  if (!snapshot || typeof snapshot.data !== 'function' || ![true, false].includes(snapshot.exists)) {
    throw new deletionControl.DeletionControlError('ACCOUNT_DELETION_BLOCKED');
  }
  const data = snapshot.data();
  if (snapshot.exists ? data === null || typeof data !== 'object' || Array.isArray(data) : data !== undefined) {
    throw new deletionControl.DeletionControlError('ACCOUNT_DELETION_BLOCKED');
  }
}

function validateClosure(snapshot) {
  if (snapshot.exists && (!hasExactKeys(snapshot.data(), ['version', 'state', 'createdAt']) ||
      snapshot.data().version !== 1 || snapshot.data().state !== CIRCLE_DELETION_STATE ||
      !isTimestamp(snapshot.data().createdAt))) throw stateConflict();
}

async function readDeletionContext(transaction, db, uid, circleId, deletion) {
  const marker = await transaction.get(deletion.markerRef);
  const root = await transaction.get(deletion.circleRef);
  const closureRef = db.collection('circle_cleanup_guards').doc(circleId);
  const closure = await transaction.get(closureRef);
  if (!marker.exists || !closure.exists) throw stateConflict();
  validateClosure(closure);
  const value = marker.data();
  const validated = validateMarker(value, circleId);
  if (validated.initiatedBy !== uid ||
      JSON.stringify(validated.memberUids) !== JSON.stringify(deletion.memberUids) ||
      typeof value.createdAt.isEqual !== 'function' || !value.createdAt.isEqual(deletion.createdAt)) throw stateConflict();
  if (root.exists && (root.data()?.adminId !== uid ||
      root.data()?.deletionState !== CIRCLE_DELETION_STATE)) throw stateConflict();
  return root;
}

// Targets need a three-way decision: confirmed active, confirmed control
// presence (skip only the private update), or unavailable/ambiguous (retry).
async function memberIsRetired(transaction, db, uid) {
  try {
    const guard = db.collection('account_deletion_guards').doc(uid);
    const references = [guard, db.collection('retired_auth_identities').doc(uid),
      guard.collection('control').doc('operation')];
    let retired = false;
    for (const ref of references) {
      const snapshot = await transaction.get(ref);
      if (!snapshot || typeof snapshot.data !== 'function' ||
          ![true, false].includes(snapshot.exists) ||
          (snapshot.exists === false && snapshot.data() !== undefined)) {
        throw new Error('AMBIGUOUS_MEMBER_CONTROL');
      }
      retired ||= snapshot.exists;
    }
    return retired;
  } catch (_) {
    throw new deletionControl.DeletionControlError('ACCOUNT_DELETION_BLOCKED');
  }
}

// Public SDK inventory includes missing parent documents with descendants.
// Each actual deletion is a small actor-fenced transaction, never BulkWriter
// or recursiveDelete outside the transaction. Keep the durable Circle closure.
// Stored descendants are not request Circle IDs or UIDs. Their scope comes
// from the immediate parent/path check, not a 128-character user-ID bound.
function storedSegment(value) {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 1500 && !value.includes('/') &&
    value !== '.' && value !== '..' && !/^__.*__$/.test(value);
}

async function deleteClosedCircleTree({db, uid, circleId, deletion}) {
  let remaining = 400;
  async function visit(ref) {
    for (const childCollection of await ref.listCollections()) {
      if (childCollection.path.slice(0, childCollection.path.lastIndexOf('/')) !== ref.path ||
          !storedSegment(childCollection.path.split('/').at(-1))) throw stateConflict();
      for (const child of await childCollection.listDocuments()) {
        if (!storedSegment(child.id) || child.path !== `${childCollection.path}/${child.id}`) throw stateConflict();
        await visit(child);
      }
    }
    if (--remaining < 0) {
      throw new CircleHttpError(503, 'CIRCLE_DELETE_RETRY_REQUIRED', 'A exclusao do Circle precisa ser retomada.');
    }
    await db.runTransaction(async transaction => {
      await readDeletionContext(transaction, db, uid, circleId, deletion);
      const current = await transaction.get(ref);
      assertKnownDocument(current);
      // Queries track new children in every collection found by the inventory.
      for (const childCollection of await ref.listCollections()) {
        const children = await transaction.get(childCollection.limit(1));
        if (children.docs.length > 0 || (await childCollection.listDocuments()).length > 0) throw stateConflict();
      }
      if (current.exists) transaction.delete(ref);
    });
  }
  await visit(deletion.circleRef);
  await db.runTransaction(async transaction => {
    const root = await readDeletionContext(transaction, db, uid, circleId, deletion);
    if (root.exists || (await deletion.circleRef.listCollections()).length > 0) throw stateConflict();
    transaction.delete(deletion.markerRef);
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

  const profiles = await clearMemberCircleReferences({db, uid, circleId, deletion});
  await deleteClosedCircleTree({db, uid, circleId, deletion});
  return {body: {deleted: true,
    ...(profiles.retiredMemberReferencesSkipped ? {retiredMemberReferencesSkipped: profiles.retiredMemberReferencesSkipped} : {}),
    ...(profiles.missingMemberProfiles ? {missingMemberProfiles: profiles.missingMemberProfiles} : {}),
  }};
}

export default createCircleDeleteHandler(deleteCircle);
