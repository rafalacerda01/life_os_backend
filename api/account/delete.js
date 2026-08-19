import { Timestamp } from 'firebase-admin/firestore';

import {
  AccountHttpError,
  createAccountHandler,
  hasExactKeys,
  isPlainObject,
  MAX_CIRCLE_CHALLENGES_TO_SCAN,
  MAX_PROCESSED_EVENTS_PER_CHALLENGE,
  normalizeSafeDocumentId,
  PROCESSED_EVENT_DELETE_PAGE_SIZE,
} from './_shared.js';

const CIRCLE_SCHEMA_VERSION = 2;
const MAX_CIRCLE_MEMBERS = 10;
const DELETION_STATE_FIELD = '_serverAccountDeletion';
const DELETION_STATE_VERSION = 1;
const SOLE_ADMIN_MODE = 'SOLE_ADMIN_CIRCLE';
const EXTERNAL_CLEANUP_MARKER_VERSION = 1;
const EXTERNAL_CLEANUP_COMPLETE = 'EXTERNAL_CLEANUP_COMPLETE';
const ACCOUNT_DELETION_MARKER_ID = 'account_deletion';

function stateConflict(message = 'O estado da conta esta inconsistente.') {
  return new AccountHttpError(409, 'ACCOUNT_STATE_CONFLICT', message);
}

function adminActionRequired() {
  return new AccountHttpError(
    409,
    'CIRCLE_ADMIN_ACTION_REQUIRED',
    'Acoes administrativas do Circle sao necessarias antes da exclusao da conta.',
  );
}

function countDocs(snapshot) {
  return snapshot?.docs?.length ?? 0;
}

function documentIdFromPath(ref) {
  const parts = ref.path.split('/');
  return parts.at(-1);
}

function isTimestamp(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.toMillis === 'function' &&
    Number.isFinite(value.toMillis())
  );
}

function validateCircleCore(circle, uid) {
  if (
    !isPlainObject(circle) ||
    circle.schemaVersion !== CIRCLE_SCHEMA_VERSION ||
    normalizeSafeDocumentId(circle.adminId) !== circle.adminId ||
    !Number.isInteger(circle.memberCount) ||
    circle.memberCount < 1
  ) {
    throw stateConflict();
  }

  // adminId is authoritative even if membership/counters are partially broken.
  if (circle.adminId === uid && circle.memberCount > 1) {
    throw adminActionRequired();
  }

  if (
    (circle.memberLimit !== 3 && circle.memberLimit !== 10) ||
    circle.memberCount > circle.memberLimit
  ) {
    throw stateConflict();
  }

  return circle;
}

function validateDeletionState(userData) {
  const state = userData?.[DELETION_STATE_FIELD];
  if (state === undefined) return null;

  if (
    !isPlainObject(state) ||
    state.version !== DELETION_STATE_VERSION ||
    state.mode !== SOLE_ADMIN_MODE ||
    normalizeSafeDocumentId(state.circleId) !== state.circleId ||
    !isTimestamp(state.startedAt)
  ) {
    throw stateConflict();
  }

  return state;
}

function validateExternalCleanupMarker(marker) {
  if (
    !hasExactKeys(marker, [
      'version',
      'state',
      'circleDeleted',
      'activeCircleId',
      'completedAt',
    ]) ||
    marker.version !== EXTERNAL_CLEANUP_MARKER_VERSION ||
    marker.state !== EXTERNAL_CLEANUP_COMPLETE ||
    typeof marker.circleDeleted !== 'boolean' ||
    !(
      marker.activeCircleId === null ||
      normalizeSafeDocumentId(marker.activeCircleId) === marker.activeCircleId
    ) ||
    !isTimestamp(marker.completedAt)
  ) {
    throw stateConflict();
  }

  return {
    circleDeleted: marker.circleDeleted,
    activeCircleId: marker.activeCircleId,
  };
}

function validateActiveCircleId(userData) {
  const activeCircleId = userData?.activeCircleId;
  if (activeCircleId === undefined || activeCircleId === null) return null;
  if (normalizeSafeDocumentId(activeCircleId) !== activeCircleId) {
    throw stateConflict('O activeCircleId da conta esta inconsistente.');
  }
  return activeCircleId;
}

function findMemberSnapshot(membersSnapshot, uid) {
  return membersSnapshot.docs.find(
    (snapshot) => documentIdFromPath(snapshot.ref) === uid,
  );
}

function validateAdminMembership(membersSnapshot, circle) {
  const adminSnapshot = findMemberSnapshot(membersSnapshot, circle.adminId);
  if (!adminSnapshot || adminSnapshot.data()?.role !== 'admin') {
    throw stateConflict();
  }
}

function decideCurrentMemberState({ circle, membersSnapshot, memberSnapshot, uid }) {
  const membersCount = countDocs(membersSnapshot);
  if (membersCount > MAX_CIRCLE_MEMBERS) throw stateConflict();

  if (circle.adminId === uid) {
    if (
      circle.memberCount !== 1 ||
      membersCount !== 1 ||
      !memberSnapshot.exists ||
      memberSnapshot.data()?.role !== 'admin'
    ) {
      throw stateConflict();
    }
    return { kind: 'ADMIN_SOLE_MEMBER' };
  }

  validateAdminMembership(membersSnapshot, circle);

  if (memberSnapshot.exists) {
    if (
      memberSnapshot.data()?.role !== 'member' ||
      circle.memberCount <= 1 ||
      membersCount !== circle.memberCount
    ) {
      throw stateConflict();
    }
    return { kind: 'MEMBER_ACTIVE' };
  }

  if (membersCount === circle.memberCount) {
    return { kind: 'MEMBER_ALREADY_REMOVED' };
  }

  if (membersCount >= 1 && membersCount + 1 === circle.memberCount) {
    return { kind: 'MEMBER_COUNTER_STALE' };
  }

  throw stateConflict();
}

async function resolveCircleMembership({ db, uid, circleId, commit }) {
  const userRef = db.collection('users').doc(uid);
  const circleRef = db.collection('circles').doc(circleId);
  const membersRef = circleRef.collection('members');
  const memberRef = membersRef.doc(uid);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    if (!userSnapshot.exists) throw stateConflict();

    const userData = userSnapshot.data();
    if (validateDeletionState(userData) !== null) throw stateConflict();
    if (validateActiveCircleId(userData) !== circleId) throw stateConflict();

    const circleSnapshot = await transaction.get(circleRef);
    if (!circleSnapshot.exists) throw stateConflict();

    const circle = validateCircleCore(circleSnapshot.data(), uid);
    const membersSnapshot = await transaction.get(
      membersRef.limit(MAX_CIRCLE_MEMBERS + 1),
    );
    const memberSnapshot = await transaction.get(memberRef);
    const memberState = decideCurrentMemberState({
      circle,
      membersSnapshot,
      memberSnapshot,
      uid,
    });

    if (!commit) return { circleRef, kind: memberState.kind };

    if (memberState.kind === 'ADMIN_SOLE_MEMBER') {
      transaction.update(userRef, {
        [DELETION_STATE_FIELD]: {
          version: DELETION_STATE_VERSION,
          mode: SOLE_ADMIN_MODE,
          circleId,
          startedAt: Timestamp.now(),
        },
      });
      // Removing the root blocks a concurrent join. Descendants are retried
      // using the server-owned marker if recursiveDelete later fails.
      transaction.delete(circleRef);
      return { circleRef, kind: memberState.kind };
    }

    if (memberState.kind === 'MEMBER_ACTIVE') {
      transaction.delete(memberRef);
      transaction.update(circleRef, {
        memberCount: countDocs(membersSnapshot) - 1,
        updatedAt: Timestamp.now(),
      });
    } else if (memberState.kind === 'MEMBER_COUNTER_STALE') {
      transaction.update(circleRef, {
        memberCount: countDocs(membersSnapshot),
        updatedAt: Timestamp.now(),
      });
    }

    return { circleRef, kind: memberState.kind };
  });
}

async function listChallengeRefs(circleRef) {
  // Deliberately scoped to root documents in the active Circle. A global
  // collectionGroup sweep could cross unrelated Circles and require broader
  // index/ownership guarantees. Orphan subcollections below a missing
  // challenge root are therefore not discoverable by this bounded query.
  const snapshot = await circleRef
    .collection('challenges')
    .limit(MAX_CIRCLE_CHALLENGES_TO_SCAN + 1)
    .get();
  if (countDocs(snapshot) > MAX_CIRCLE_CHALLENGES_TO_SCAN) {
    throw stateConflict('O Circle excede o limite seguro de processamento.');
  }
  return snapshot.docs.map((challengeSnapshot) => challengeSnapshot.ref);
}

async function commitDeletes(db, refs) {
  if (refs.length === 0) return;
  const batch = db.batch();
  for (const ref of refs) batch.delete(ref);
  await batch.commit();
}

async function cleanupChallengeData({ db, uid, challengeRef }) {
  await commitDeletes(db, [challengeRef.collection('progress').doc(uid)]);

  const processedEvents = challengeRef.collection('processed_events');
  let deletedEvents = 0;
  while (true) {
    const snapshot = await processedEvents
      .where('uid', '==', uid)
      .limit(PROCESSED_EVENT_DELETE_PAGE_SIZE)
      .get();
    if (countDocs(snapshot) === 0) return;

    if (deletedEvents + countDocs(snapshot) > MAX_PROCESSED_EVENTS_PER_CHALLENGE) {
      throw stateConflict('O volume de processed_events excede o limite seguro.');
    }

    await commitDeletes(
      db,
      snapshot.docs.map((eventSnapshot) => eventSnapshot.ref),
    );
    deletedEvents += countDocs(snapshot);
  }
}

async function cleanupMemberCircleData({ db, uid, challengeRefs }) {
  for (const challengeRef of challengeRefs) {
    await cleanupChallengeData({ db, uid, challengeRef });
  }
}

async function finishSoleAdminRetry({ db, circleId }) {
  const circleRef = db.collection('circles').doc(circleId);
  const circleSnapshot = await circleRef.get();
  if (circleSnapshot.exists) throw stateConflict();
  await db.recursiveDelete(circleRef);
  return { circleDeleted: true, activeCircleId: circleId };
}

async function cleanupExternalAccountData({ db, uid }) {
  const userRef = db.collection('users').doc(uid);
  const userSnapshot = await userRef.get();
  if (!userSnapshot.exists) throw stateConflict();

  const userData = userSnapshot.data();
  const deletionState = validateDeletionState(userData);
  if (deletionState !== null) {
    const activeCircleId = validateActiveCircleId(userData);
    if (activeCircleId !== null && activeCircleId !== deletionState.circleId) {
      throw stateConflict();
    }
    return finishSoleAdminRetry({
      db,
      circleId: deletionState.circleId,
    });
  }

  const circleId = validateActiveCircleId(userData);
  if (circleId === null) {
    return { circleDeleted: false, activeCircleId: null };
  }

  const preflight = await resolveCircleMembership({
    db,
    uid,
    circleId,
    commit: false,
  });

  let challengeRefs = [];
  if (preflight.kind !== 'ADMIN_SOLE_MEMBER') {
    challengeRefs = await listChallengeRefs(preflight.circleRef);
  }

  const committed = await resolveCircleMembership({
    db,
    uid,
    circleId,
    commit: true,
  });

  if (committed.kind === 'ADMIN_SOLE_MEMBER') {
    return finishSoleAdminRetry({ db, circleId });
  }

  await cleanupMemberCircleData({ db, uid, challengeRefs });
  return { circleDeleted: false, activeCircleId: circleId };
}

function accountDeletionMarkerRef(userRef) {
  return userRef.collection('runtime').doc(ACCOUNT_DELETION_MARKER_ID);
}

async function markerStillProvesExternalCleanup({ db, uid, userRef, marker }) {
  const userSnapshot = await userRef.get();
  if (!userSnapshot.exists) return true;

  const activeCircleId = validateActiveCircleId(userSnapshot.data());
  if (activeCircleId !== marker.activeCircleId) return false;
  if (activeCircleId === null) return true;

  const circleRef = db.collection('circles').doc(activeCircleId);
  if (marker.circleDeleted) {
    const circleSnapshot = await circleRef.get();
    return !circleSnapshot.exists;
  }

  const memberSnapshot = await circleRef.collection('members').doc(uid).get();
  return !memberSnapshot.exists;
}

async function ensureExternalCleanupMarker({ db, uid, userRef }) {
  const markerRef = accountDeletionMarkerRef(userRef);
  const markerSnapshot = await markerRef.get();
  if (markerSnapshot.exists) {
    const marker = validateExternalCleanupMarker(markerSnapshot.data());
    if (await markerStillProvesExternalCleanup({ db, uid, userRef, marker })) {
      return marker;
    }
  }

  const cleanup = await cleanupExternalAccountData({ db, uid });
  // runtime/* is denied to clients by the current Firestore Rules. Only the
  // Admin SDK writes this evidence, and recursiveDelete removes it at the end.
  await markerRef.set({
    version: EXTERNAL_CLEANUP_MARKER_VERSION,
    state: EXTERNAL_CLEANUP_COMPLETE,
    circleDeleted: cleanup.circleDeleted,
    activeCircleId: cleanup.activeCircleId,
    completedAt: Timestamp.now(),
  });
  return cleanup;
}

export async function deleteAccount({ db, auth, uid }) {
  const userRef = db.collection('users').doc(uid);
  const cleanup = await ensureExternalCleanupMarker({ db, uid, userRef });

  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error;
  }

  await db.recursiveDelete(userRef);

  return {
    body: {
      deleted: true,
      circleDeleted: cleanup.circleDeleted,
    },
  };
}

export default createAccountHandler(
  'delete',
  'ACCOUNT_DELETE_FAILED',
  deleteAccount,
);
