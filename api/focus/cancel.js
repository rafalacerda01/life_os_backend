import {
  assertCancelledSessionIntegrity,
  assertPointerMatchesSession,
  assertStoredSessionIntegrity,
  createFocusHandler,
  decideCancelAction,
  FOCUS_STATUS,
  FocusHttpError,
  getNowTimestamp,
  stateConflict,
  timestampToIso,
  validateSessionPayload,
} from './_shared.js';

function cancelledResponse(session, replayed) {
  return {
    sessionId: session.sessionId,
    status: FOCUS_STATUS.CANCELLED,
    cancelledAt: timestampToIso(session.cancelledAt),
    replayed,
  };
}

async function cancelFocus({ body, db, uid }) {
  const { sessionId } = validateSessionPayload(body);
  const userRef = db.collection('users').doc(uid);
  const sessionRef = userRef
    .collection('verified_focus_sessions')
    .doc(sessionId);
  const activeRef = userRef.collection('runtime').doc('active_focus');

  const result = await db.runTransaction(async (transaction) => {
    const sessionSnapshot = await transaction.get(sessionRef);
    if (!sessionSnapshot.exists) {
      throw new FocusHttpError(
        404,
        'FOCUS_SESSION_NOT_FOUND',
        'A sessão Focus não foi encontrada.',
      );
    }

    const session = sessionSnapshot.data();
    assertStoredSessionIntegrity(session, uid, sessionId);
    const action = session.status === FOCUS_STATUS.RUNNING
      ? 'RUNNING'
      : decideCancelAction({ status: session.status });

    if (action === 'REPLAY') {
      assertCancelledSessionIntegrity(session);
      return { action, session };
    }
    if (action === 'EXPIRED') {
      throw new FocusHttpError(
        409,
        'FOCUS_SESSION_EXPIRED',
        'A sessão Focus expirou.',
      );
    }
    if (action === 'COMPLETED' || action === 'STATE_CONFLICT') {
      throw stateConflict();
    }

    const activeSnapshot = await transaction.get(activeRef);
    if (!activeSnapshot.exists) throw stateConflict();
    assertPointerMatchesSession(activeSnapshot.data(), session);

    const now = getNowTimestamp();
    const runningAction = decideCancelAction({
      status: session.status,
      nowMillis: now.toMillis(),
      expiresAtMillis: session.expiresAt.toMillis(),
    });
    if (runningAction === 'MARK_EXPIRED') {
      transaction.update(sessionRef, { status: FOCUS_STATUS.EXPIRED });
      transaction.delete(activeRef);
      return { action: 'EXPIRED' };
    }
    if (runningAction !== 'CANCEL') throw stateConflict();

    const cancelledAt = now;
    const cancelledSession = {
      ...session,
      status: FOCUS_STATUS.CANCELLED,
      cancelledAt,
    };
    transaction.update(sessionRef, {
      status: cancelledSession.status,
      cancelledAt,
    });
    transaction.delete(activeRef);
    return { action: 'CANCELLED', session: cancelledSession };
  });

  if (result.action === 'EXPIRED') {
    throw new FocusHttpError(
      409,
      'FOCUS_SESSION_EXPIRED',
      'A sessão Focus expirou.',
    );
  }

  return {
    body: cancelledResponse(result.session, result.action === 'REPLAY'),
  };
}

export default createFocusHandler(
  'cancel',
  'FOCUS_CANCEL_FAILED',
  cancelFocus,
);
