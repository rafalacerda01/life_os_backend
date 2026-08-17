import {
  assertPointerMatchesSession,
  assertStoredSessionIntegrity,
  calculateExpiresAt,
  createFocusHandler,
  decideStartAction,
  FOCUS_SCHEMA_VERSION,
  FOCUS_STATUS,
  FocusHttpError,
  getNowTimestamp,
  startActionRequiresTarget,
  stateConflict,
  targetCollectionFor,
  timestampToIso,
  validateStartPayload,
} from './_shared.js';

async function startFocus({ body, db, uid }) {
  const request = validateStartPayload(body);
  const userRef = db.collection('users').doc(uid);
  const targetRef = userRef
    .collection(targetCollectionFor(request.targetType))
    .doc(request.targetId);
  const sessionsRef = userRef.collection('verified_focus_sessions');
  const newSessionRef = sessionsRef.doc();
  const activeRef = userRef.collection('runtime').doc('active_focus');

  const result = await db.runTransaction(async (transaction) => {
    const activeSnapshot = await transaction.get(activeRef);
    const now = getNowTimestamp();
    const pointer = activeSnapshot.exists ? activeSnapshot.data() : null;
    const action = decideStartAction({
      pointer,
      request,
      nowMillis: now.toMillis(),
    });


    if (action === 'STATE_CONFLICT') throw stateConflict();
    if (action === 'ACTIVE_CONFLICT') {
      throw new FocusHttpError(
        409,
        'ACTIVE_FOCUS_SESSION_EXISTS',
        'Já existe uma sessão Focus ativa.',
      );
    }

    let previousRef;
    if (action === 'REUSE' || action === 'REPLACE_EXPIRED') {
      previousRef = sessionsRef.doc(pointer.sessionId);
      const previousSnapshot = await transaction.get(previousRef);
      if (!previousSnapshot.exists) throw stateConflict();

      const previousSession = previousSnapshot.data();
      assertStoredSessionIntegrity(previousSession, uid, pointer.sessionId);
      assertPointerMatchesSession(pointer, previousSession);

      // A terminal session referenced by active_focus is corruption. Fail
      // closed rather than silently repairing an ambiguous security state.
      if (previousSession.status !== FOCUS_STATUS.RUNNING) {
        throw stateConflict();
      }
      if (action === 'REUSE') {
        return { reused: true, session: previousSession };
      }

    }

    const targetSnapshot = startActionRequiresTarget(action)
      ? await transaction.get(targetRef)
      : null;

    if (targetSnapshot !== null && !targetSnapshot.exists) {
      throw new FocusHttpError(
        404,
        'TARGET_NOT_FOUND',
        'O alvo da sessão Focus não foi encontrado.',
      );
    }

    if (action === 'REPLACE_EXPIRED') {
      transaction.update(previousRef, { status: FOCUS_STATUS.EXPIRED });
    }

    const expiresAt = calculateExpiresAt(now, request.plannedDurationSeconds);
    const session = {
      sessionId: newSessionRef.id,
      uid,
      targetId: request.targetId,
      targetType: request.targetType,
      plannedDurationSeconds: request.plannedDurationSeconds,
      status: FOCUS_STATUS.RUNNING,
      startedAt: now,
      expiresAt,
      schemaVersion: FOCUS_SCHEMA_VERSION,
    };
    const activePointer = {
      sessionId: session.sessionId,
      targetId: session.targetId,
      targetType: session.targetType,
      plannedDurationSeconds: session.plannedDurationSeconds,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      schemaVersion: FOCUS_SCHEMA_VERSION,
    };

    transaction.create(newSessionRef, session);
    if (activeSnapshot.exists) {
      transaction.set(activeRef, activePointer);
    } else {
      transaction.create(activeRef, activePointer);
    }

    return { reused: false, session };
  });

  return {
    body: {
      sessionId: result.session.sessionId,
      status: FOCUS_STATUS.RUNNING,
      plannedDurationSeconds: result.session.plannedDurationSeconds,
      startedAt: timestampToIso(result.session.startedAt),
      expiresAt: timestampToIso(result.session.expiresAt),
      reused: result.reused,
    },
  };
}

export default createFocusHandler(
  'start',
  'FOCUS_START_FAILED',
  startFocus,
);
