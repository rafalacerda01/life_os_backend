import { Timestamp } from 'firebase-admin/firestore';
import circleCleanup from './_circle_cleanup.cjs';
import {
  establishBillingDeletionBarrier,
  finishBillingDeletion,
} from '../billing/google/_reconciliation.js';

import {
  AccountHttpError,
  createAccountHandler,
  hasExactKeys,
  isPlainObject,
  normalizeSafeDocumentId,
} from './_shared.js';

const CIRCLE_SCHEMA_VERSION = 2;
const MAX_CIRCLE_MEMBERS = 30;
const DELETION_STATE_FIELD = '_serverAccountDeletion';
const DELETION_STATE_VERSION = 1;
const SOLE_ADMIN_MODE = 'SOLE_ADMIN_CIRCLE';
const EXTERNAL_CLEANUP_MARKER_VERSION = 2;
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
    (circle.memberLimit !== 3 &&
      circle.memberLimit !== 10 &&
      circle.memberLimit !== 30) ||
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
  const keys = ['version', 'state', 'circleDeleted', 'activeCircleId', 'completedAt'];
  if (marker?.version === 2) keys.push('scope', 'deletionId');
  if (
    !hasExactKeys(marker, keys) ||
    ![1, EXTERNAL_CLEANUP_MARKER_VERSION].includes(marker.version) ||
    (marker.version === 2 && (marker.scope !== 'GLOBAL_CIRCLE_UID' ||
      typeof marker.deletionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(marker.deletionId))) ||
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
    version: marker.version,
    deletionId: marker.deletionId,
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

async function resolveCircleMembership({ db, uid, circleId, commit, transaction: existingTransaction }) {
  const userRef = db.collection('users').doc(uid);
  const circleRef = db.collection('circles').doc(circleId);
  const membersRef = circleRef.collection('members');
  const memberRef = membersRef.doc(uid);

  const resolve = async (transaction) => {
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
      const closureRef = db.collection('circle_cleanup_guards').doc(circleId);
      const closure = await transaction.get(closureRef);
      if (closure.exists) {
        const data = closure.data();
        if (!hasExactKeys(data, ['version', 'state', 'createdAt']) ||
            data.version !== 1 || data.state !== 'SERVER_DELETING' ||
            !isTimestamp(data.createdAt)) throw stateConflict();
      } else {
        transaction.set(closureRef, {version: 1, state: 'SERVER_DELETING', createdAt: Timestamp.now()});
      }
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
  };
  return existingTransaction ? resolve(existingTransaction) : db.runTransaction(resolve);
}

async function finishSoleAdminRetry({ db, circleId }) {
  const circleRef = db.collection('circles').doc(circleId);
  const closureRef = db.collection('circle_cleanup_guards').doc(circleId);
  await db.runTransaction(async (transaction) => {
    const root = await transaction.get(circleRef);
    const closure = await transaction.get(closureRef);
    if (root.exists) throw stateConflict();
    if (closure.exists) {
      const data = closure.data();
      if (!hasExactKeys(data, ['version', 'state', 'createdAt']) ||
          data.version !== 1 || data.state !== 'SERVER_DELETING' ||
          !isTimestamp(data.createdAt)) throw stateConflict();
    } else {
      // Legacy retries also need a durable reservation before recursiveDelete.
      transaction.set(closureRef, {version: 1, state: 'SERVER_DELETING', createdAt: Timestamp.now()});
    }
  });
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

  const committed = await resolveCircleMembership({
    db,
    uid,
    circleId,
    commit: true,
  });

  if (committed.kind === 'ADMIN_SOLE_MEMBER') {
    return finishSoleAdminRetry({ db, circleId });
  }

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

async function ensureExternalCleanupMarker({ db, uid, userRef, guard }) {
  const markerRef = accountDeletionMarkerRef(userRef);
  const markerSnapshot = await markerRef.get();
  let cleanup;
  if (markerSnapshot.exists) {
    const marker = validateExternalCleanupMarker(markerSnapshot.data());
    if (marker.version === 2 && marker.deletionId !== guard.deletionId) throw stateConflict();
    if (await markerStillProvesExternalCleanup({ db, uid, userRef, marker })) {
      cleanup = marker;
    }
  }

  const pendingCircleDeleted = await circleCleanup.cleanupPendingMarkers(db, uid, guard);
  if (!cleanup) cleanup = await cleanupExternalAccountData({ db, uid });
  const ownedDeleted = await circleCleanup.cleanupOwned(db, uid, guard, false);
  cleanup.circleDeleted ||= pendingCircleDeleted || ownedDeleted;
  await circleCleanup.cleanupMemberships(db, uid, guard);
  await circleCleanup.cleanupHistory(db, uid, guard);
  await circleCleanup.verifyReferences(db, uid);
  await db.runTransaction(async (transaction) => {
    await circleCleanup.requireGuard(transaction, db, uid, guard);
    await circleCleanup.assertEmpty(transaction, db, uid);
    const user = await transaction.get(userRef);
    const activeCircleId = validateActiveCircleId(user.data());
    if (activeCircleId !== null && activeCircleId !== cleanup.activeCircleId) throw stateConflict();
    if (activeCircleId !== null) {
      const circleRef = db.collection('circles').doc(activeCircleId);
      const root = await transaction.get(circleRef);
      const member = await transaction.get(circleRef.collection('members').doc(uid));
      if (member.exists || (cleanup.circleDeleted && root.exists)) throw stateConflict();
    }
    transaction.set(markerRef, {
      version: EXTERNAL_CLEANUP_MARKER_VERSION,
      state: EXTERNAL_CLEANUP_COMPLETE,
      scope: 'GLOBAL_CIRCLE_UID',
      deletionId: guard.deletionId,
      circleDeleted: cleanup.circleDeleted,
      activeCircleId,
      completedAt: Timestamp.now(),
    });
  });
  return cleanup;
}

export async function deleteAccount({ db, auth, uid }) {
  const userRef = db.collection('users').doc(uid);
  try {
    const guard = await circleCleanup.beginGuard(db, uid, async (transaction) => {
      const user = await transaction.get(userRef);
      const marker = await transaction.get(accountDeletionMarkerRef(userRef));
      if (!user.exists && !marker.exists) throw stateConflict();
      if (marker.exists && validateExternalCleanupMarker(marker.data()).version === 2) throw stateConflict();
      const data = user.data() ?? {};
      const deletionState = validateDeletionState(data);
      const circleId = validateActiveCircleId(data);
      await circleCleanup.preflightOwned(transaction, db, uid);
      if (deletionState !== null) {
        if (circleId !== null && circleId !== deletionState.circleId) throw stateConflict();
        if ((await transaction.get(db.collection('circles').doc(deletionState.circleId))).exists) throw stateConflict();
      } else if (circleId !== null) {
        await resolveCircleMembership({ db, uid, circleId, commit: false, transaction });
      }
    });
    await establishBillingDeletionBarrier({ db, uid });
    const cleanup = await ensureExternalCleanupMarker({ db, uid, userRef, guard });
    try {
      await auth.deleteUser(uid);
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
    await db.recursiveDelete(userRef);
    await finishBillingDeletion({ db, uid });
    await circleCleanup.completeGuard(db, uid, guard);
    return { body: { deleted: true, circleDeleted: cleanup.circleDeleted } };
  } catch (error) {
    if (!(error instanceof AccountHttpError) && error?.code === 'ACCOUNT_STATE_CONFLICT') {
      throw stateConflict();
    }
    if (!(error instanceof AccountHttpError) && error?.code === 'CIRCLE_ADMIN_ACTION_REQUIRED') {
      throw adminActionRequired();
    }
    throw error;
  }
}

export default createAccountHandler(
  'delete',
  'ACCOUNT_DELETE_FAILED',
  deleteAccount,
);
