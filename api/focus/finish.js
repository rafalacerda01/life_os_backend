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
import {
  applyCircleProgressPlan,
  readCircleProgressPlan,
} from './_circle_progress.js';

function completedResponse(session, replayed) {
  return {
    sessionId: session.sessionId,
    status: FOCUS_STATUS.COMPLETED,
    verifiedDurationSeconds: session.verifiedDurationSeconds,
    completedAt: timestampToIso(session.completedAt),
    replayed,
  };
}

export async function finishFocus({ body, db, uid }) {
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

    let action;
    let completedSession;

    if (session.status === FOCUS_STATUS.COMPLETED) {
      assertCompletedSessionIntegrity(session);
      action = 'REPLAY';
      completedSession = session;
    } else if (session.status === FOCUS_STATUS.CANCELLED) {
      throw new FocusHttpError(
        409,
        'FOCUS_SESSION_CANCELLED',
        'A sessão Focus foi cancelada.',
      );
    } else if (session.status === FOCUS_STATUS.EXPIRED) {
      throw new FocusHttpError(
        409,
        'FOCUS_SESSION_EXPIRED',
        'A sessão Focus expirou.',
      );
    } else {
      if (session.status !== FOCUS_STATUS.RUNNING) throw stateConflict();

      const activeSnapshot = await transaction.get(activeRef);
      if (!activeSnapshot.exists) throw stateConflict();
      assertPointerMatchesSession(activeSnapshot.data(), session);

      const now = getNowTimestamp();
      const finishAction = decideFinishAction({
        status: session.status,
        startedAtMillis: session.startedAt.toMillis(),
        expiresAtMillis: session.expiresAt.toMillis(),
        plannedDurationSeconds: session.plannedDurationSeconds,
        nowMillis: now.toMillis(),
      });

      if (finishAction === 'NOT_READY') {
        throw new FocusHttpError(
          409,
          'SESSION_NOT_READY',
          'A duração planejada ainda não foi concluída.',
        );
      }
      if (finishAction === 'STATE_CONFLICT') throw stateConflict();
      if (finishAction === 'MARK_EXPIRED') {
        transaction.update(sessionRef, { status: FOCUS_STATUS.EXPIRED });
        transaction.delete(activeRef);
        return { action: 'EXPIRED' };
      }
      if (finishAction !== 'COMPLETE') throw stateConflict();

      action = 'COMPLETED';
      completedSession = {
        ...session,
        status: FOCUS_STATUS.COMPLETED,
        verifiedDurationSeconds: session.plannedDurationSeconds,
        completedAt: now,
      };
    }

    const circleProgressPlan = await readCircleProgressPlan({
      transaction,
      db,
      userRef,
      uid,
      session: completedSession,
    });
    const circleProcessedAt =
      action === 'COMPLETED' ? completedSession.completedAt : getNowTimestamp();

    // Write phase: all Focus and Circle reads above are complete.
    if (action === 'COMPLETED') {
      transaction.update(sessionRef, {
        status: completedSession.status,
        verifiedDurationSeconds: completedSession.verifiedDurationSeconds,
        completedAt: completedSession.completedAt,
      });
      transaction.delete(activeRef);
    }
    applyCircleProgressPlan({
      transaction,
      plan: circleProgressPlan,
      uid,
      session: completedSession,
      processedAt: circleProcessedAt,
    });

    return { action, session: completedSession };
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
