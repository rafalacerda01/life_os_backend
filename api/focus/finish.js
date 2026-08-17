import {
  assertCompletedSessionIntegrity,
  assertPointerMatchesSession,
  assertStoredSessionIntegrity,
  createFocusHandler,
  decideFinishAction,
  FOCUS_STATUS,
  FocusHttpError,
  getNowTimestamp,
  stateConflict,
  timestampToIso,
  validateSessionPayload,
} from './_shared.js';

function completedResponse(session, replayed) {
  return {
    sessionId: session.sessionId,
    status: FOCUS_STATUS.COMPLETED,
    verifiedDurationSeconds: session.verifiedDurationSeconds,
    completedAt: timestampToIso(session.completedAt),
    replayed,
  };
}

async function finishFocus({ body, db, uid }) {
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

    if (session.status === FOCUS_STATUS.COMPLETED) {
      assertCompletedSessionIntegrity(session);
      return { action: 'REPLAY', session };
    }
    if (session.status === FOCUS_STATUS.CANCELLED) {
      throw new FocusHttpError(
        409,
        'FOCUS_SESSION_CANCELLED',
        'A sessão Focus foi cancelada.',
      );
    }
    if (session.status === FOCUS_STATUS.EXPIRED) {
      throw new FocusHttpError(
        409,
        'FOCUS_SESSION_EXPIRED',
        'A sessão Focus expirou.',
      );
    }
    if (session.status !== FOCUS_STATUS.RUNNING) throw stateConflict();

    const activeSnapshot = await transaction.get(activeRef);
    if (!activeSnapshot.exists) throw stateConflict();
    assertPointerMatchesSession(activeSnapshot.data(), session);

    const now = getNowTimestamp();
    const action = decideFinishAction({
      status: session.status,
      startedAtMillis: session.startedAt.toMillis(),
      expiresAtMillis: session.expiresAt.toMillis(),
      plannedDurationSeconds: session.plannedDurationSeconds,
      nowMillis: now.toMillis(),
    });

    if (action === 'NOT_READY') {
      throw new FocusHttpError(
        409,
        'SESSION_NOT_READY',
        'A duração planejada ainda não foi concluída.',
      );
    }
    if (action === 'STATE_CONFLICT') throw stateConflict();
    if (action === 'MARK_EXPIRED') {
      transaction.update(sessionRef, { status: FOCUS_STATUS.EXPIRED });
      transaction.delete(activeRef);
      return { action: 'EXPIRED' };
    }
    if (action !== 'COMPLETE') throw stateConflict();

    const completedSession = {
      ...session,
      status: FOCUS_STATUS.COMPLETED,
      verifiedDurationSeconds: session.plannedDurationSeconds,
      completedAt: now,
    };
    transaction.update(sessionRef, {
      status: completedSession.status,
      verifiedDurationSeconds: completedSession.verifiedDurationSeconds,
      completedAt: completedSession.completedAt,
    });
    transaction.delete(activeRef);
    return { action: 'COMPLETED', session: completedSession };
  });

  if (result.action === 'EXPIRED') {
    throw new FocusHttpError(
      409,
      'FOCUS_SESSION_EXPIRED',
      'A sessão Focus expirou.',
    );
  }

  return {
    body: completedResponse(result.session, result.action === 'REPLAY'),
  };
}

export default createFocusHandler(
  'finish',
  'FOCUS_FINISH_FAILED',
  finishFocus,
);
