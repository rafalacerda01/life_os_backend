import { FieldValue } from 'firebase-admin/firestore';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPLICIT_TIME_ZONE_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/i;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.size && actualKeys.every((key) => keys.has(key));
}

export function validateStudyProgressResetPayload(body) {
  const allowedKeys = new Set(['operation', 'mutationId', 'occurredAt']);
  if (!isPlainObject(body) || !hasExactKeys(body, allowedKeys)) {
    return { valid: false, error: 'Payload de reset de progresso inválido.' };
  }

  if (typeof body.mutationId !== 'string' || !UUID_V4_PATTERN.test(body.mutationId)) {
    return { valid: false, error: 'mutationId inválido.' };
  }
  if (
    typeof body.occurredAt !== 'string' ||
    !EXPLICIT_TIME_ZONE_PATTERN.test(body.occurredAt) ||
    !Number.isFinite(Date.parse(body.occurredAt))
  ) {
    return { valid: false, error: 'Data do reset de progresso inválida.' };
  }

  return {
    valid: true,
    value: {
      mutationId: body.mutationId,
      occurredAt: new Date(body.occurredAt),
    },
  };
}

function stateInvalid() {
  const error = new Error('O estado remoto do progresso de estudos está inconsistente.');
  error.statusCode = 409;
  error.code = 'STUDY_PROGRESS_STATE_INVALID';
  return error;
}

function readDate(value) {
  const date = value instanceof Date
    ? value
    : typeof value?.toDate === 'function'
      ? value.toDate()
      : null;
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw stateInvalid();
  }
  return date;
}

function readProgress(data) {
  if (!Object.hasOwn(data, 'progress')) return 0;
  const value = data.progress;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw stateInvalid();
  }
  return value;
}

function readLastResetAt(snapshot) {
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (!isPlainObject(data) || !hasExactKeys(data, new Set(['lastResetAt']))) {
    throw stateInvalid();
  }
  return readDate(data.lastResetAt);
}

function readProgressEvent(snapshot) {
  const data = snapshot.data();
  if (
    !isPlainObject(data) ||
    !hasExactKeys(data, new Set(['kind', 'progressDelta', 'occurredAt', 'createdAt'])) ||
    (data.kind !== 'study_activity' && data.kind !== 'review') ||
    typeof data.progressDelta !== 'number' ||
    !Number.isFinite(data.progressDelta) ||
    data.progressDelta <= 0 ||
    data.progressDelta > 1
  ) {
    throw stateInvalid();
  }
  readDate(data.occurredAt);
  readDate(data.createdAt);
  return data.progressDelta;
}

export async function applyStudyProgressReset({
  db,
  userId,
  mutationId,
  occurredAt,
  serverTimestamp = FieldValue.serverTimestamp,
}) {
  const userRef = db.collection('users').doc(userId);
  const receiptRef = userRef
    .collection('study_progress_reset_receipts')
    .doc(mutationId);
  const studyInfoRef = userRef.collection('study_info').doc('main');
  const progressStateRef = userRef.collection('study_progress_state').doc('main');
  const progressEventsQuery = userRef
    .collection('study_progress_events')
    .where('occurredAt', '>', occurredAt);

  return db.runTransaction(async (transaction) => {
    const [
      userSnapshot,
      receiptSnapshot,
      studyInfoSnapshot,
      progressStateSnapshot,
      progressEventsSnapshot,
    ] = await Promise.all([
      transaction.get(userRef),
      transaction.get(receiptRef),
      transaction.get(studyInfoRef),
      transaction.get(progressStateRef),
      transaction.get(progressEventsQuery),
    ]);

    if (!userSnapshot.exists) {
      const error = new Error('Usuário não encontrado.');
      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';
      throw error;
    }
    if (receiptSnapshot.exists) {
      return { alreadyApplied: true, skippedAsStale: false };
    }

    const studyInfoData = studyInfoSnapshot.data() ?? {};
    const currentProgress = readProgress(studyInfoData);
    const lastResetAt = readLastResetAt(progressStateSnapshot);

    if (lastResetAt !== null && occurredAt.getTime() <= lastResetAt.getTime()) {
      transaction.set(receiptRef, { appliedAt: serverTimestamp() });
      return {
        alreadyApplied: false,
        skippedAsStale: true,
        progress: currentProgress,
      };
    }

    let progress = 0;
    for (const eventSnapshot of progressEventsSnapshot.docs) {
      progress = Math.min(1, progress + readProgressEvent(eventSnapshot));
    }

    transaction.set(studyInfoRef, { progress }, { merge: true });
    transaction.set(progressStateRef, { lastResetAt: occurredAt });
    transaction.set(receiptRef, { appliedAt: serverTimestamp() });

    return {
      alreadyApplied: false,
      skippedAsStale: false,
      progress,
    };
  });
}
