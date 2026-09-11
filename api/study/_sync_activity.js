import { FieldValue } from 'firebase-admin/firestore';

import { updateStudyStreakHistory } from './_streak_history.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SUBJECT_ID_LENGTH = 128;
const MIN_TIME_ZONE_OFFSET_MINUTES = -840;
const MAX_TIME_ZONE_OFFSET_MINUTES = 840;
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

export function validateStudyActivityPayload(body) {
  const allowedKeys = new Set([
    'operation',
    'mutationId',
    'subjectId',
    'progressDelta',
    'occurredAt',
    'timeZoneOffsetMinutes',
  ]);

  if (!isPlainObject(body) || !hasExactKeys(body, allowedKeys)) {
    return { valid: false, error: 'Payload de atividade de estudo inválido.' };
  }

  const {
    mutationId,
    subjectId,
    progressDelta,
    occurredAt,
    timeZoneOffsetMinutes,
  } = body;

  if (typeof mutationId !== 'string' || !UUID_V4_PATTERN.test(mutationId)) {
    return { valid: false, error: 'mutationId inválido.' };
  }

  if (
    subjectId !== null &&
    (typeof subjectId !== 'string' ||
      subjectId.trim().length === 0 ||
      subjectId.length > MAX_SUBJECT_ID_LENGTH ||
      subjectId.includes('/'))
  ) {
    return { valid: false, error: 'subjectId inválido.' };
  }

  if (
    typeof progressDelta !== 'number' ||
    !Number.isFinite(progressDelta) ||
    progressDelta <= 0 ||
    progressDelta > 1
  ) {
    return { valid: false, error: 'Delta de progresso inválido.' };
  }

  if (
    typeof occurredAt !== 'string' ||
    !EXPLICIT_TIME_ZONE_PATTERN.test(occurredAt) ||
    !Number.isFinite(Date.parse(occurredAt))
  ) {
    return { valid: false, error: 'Data da atividade de estudo inválida.' };
  }

  if (
    !Number.isInteger(timeZoneOffsetMinutes) ||
    timeZoneOffsetMinutes < MIN_TIME_ZONE_OFFSET_MINUTES ||
    timeZoneOffsetMinutes > MAX_TIME_ZONE_OFFSET_MINUTES
  ) {
    return { valid: false, error: 'Fuso horário da atividade inválido.' };
  }

  return {
    valid: true,
    value: {
      mutationId,
      subjectId: subjectId === null ? null : subjectId.trim(),
      progressDelta,
      occurredAt: new Date(occurredAt),
      timeZoneOffsetMinutes,
    },
  };
}

function domainError(code, message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  return error;
}

function stateInvalid() {
  return domainError(
    'STUDY_ACTIVITY_STATE_INVALID',
    'O estado remoto de estudos está inconsistente.',
  );
}

function subjectNotFound() {
  return domainError(
    'STUDY_ACTIVITY_SUBJECT_NOT_FOUND',
    'A matéria da atividade de estudo não foi encontrada.',
  );
}

function readProgress(data, { required = false } = {}) {
  if (!Object.hasOwn(data, 'progress')) {
    if (required) throw stateInvalid();
    return 0;
  }
  if (
    typeof data.progress !== 'number' ||
    !Number.isFinite(data.progress) ||
    data.progress < 0 ||
    data.progress > 1
  ) {
    throw stateInvalid();
  }
  return data.progress;
}

function readNonNegativeInteger(data, field, { required = false } = {}) {
  if (!Object.hasOwn(data, field)) {
    if (required) throw stateInvalid();
    return 0;
  }

  const value = data[field];
  if (!Number.isInteger(value) || value < 0) throw stateInvalid();
  return value;
}

function readOptionalDate(data, field) {
  if (!Object.hasOwn(data, field)) return null;
  const value = data[field];
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

function readProgressState(snapshot) {
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (
    !isPlainObject(data) ||
    !hasExactKeys(data, new Set(['lastResetAt']))
  ) {
    throw stateInvalid();
  }
  return readOptionalDate(data, 'lastResetAt');
}

export async function applyStudyActivity({
  db,
  userId,
  mutationId,
  subjectId,
  progressDelta,
  occurredAt,
  timeZoneOffsetMinutes,
  serverTimestamp = FieldValue.serverTimestamp,
}) {
  const userRef = db.collection('users').doc(userId);
  const receiptRef = userRef.collection('study_activity_receipts').doc(mutationId);
  const studyInfoRef = userRef.collection('study_info').doc('main');
  const progressStateRef = userRef.collection('study_progress_state').doc('main');
  const progressEventRef = userRef
    .collection('study_progress_events')
    .doc(mutationId);
  const subjectRef = subjectId === null
    ? null
    : userRef.collection('subjects').doc(subjectId);

  return db.runTransaction(async (transaction) => {
    const [
      userSnapshot,
      receiptSnapshot,
      studyInfoSnapshot,
      progressStateSnapshot,
      subjectSnapshot,
    ] = await Promise.all([
        transaction.get(userRef),
        transaction.get(receiptRef),
        transaction.get(studyInfoRef),
        transaction.get(progressStateRef),
        subjectRef === null ? Promise.resolve(null) : transaction.get(subjectRef),
      ]);

    if (!userSnapshot.exists) {
      const error = new Error('Usuário não encontrado.');
      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';
      throw error;
    }

    if (receiptSnapshot.exists) {
      return { alreadyApplied: true };
    }

    if (subjectRef !== null && !subjectSnapshot?.exists) {
      throw subjectNotFound();
    }

    const studyInfoData = studyInfoSnapshot.data() ?? {};
    const remoteLastStudyDate = readOptionalDate(studyInfoData, 'lastStudyDate');
    const currentStreak = readNonNegativeInteger(studyInfoData, 'streak', {
      required: remoteLastStudyDate !== null,
    });
    const currentProgress = readProgress(studyInfoData);
    const lastResetAt = readProgressState(progressStateSnapshot);
    const shouldCreditGlobalProgress =
      lastResetAt === null || occurredAt.getTime() > lastResetAt.getTime();
    const streakHistory = await updateStudyStreakHistory({
      transaction,
      userRef,
      occurredAt,
      timeZoneOffsetMinutes,
      currentStreak,
      legacyLastStudyDate: remoteLastStudyDate,
      stateInvalid,
    });
    const lastStudyDate =
      remoteLastStudyDate !== null &&
      remoteLastStudyDate.getTime() > occurredAt.getTime()
        ? remoteLastStudyDate
        : occurredAt;
    const newProgress = shouldCreditGlobalProgress
      ? Math.min(1, currentProgress + progressDelta)
      : currentProgress;

    let newSubjectProgress = null;
    let subjectStreakDays = null;
    if (subjectSnapshot !== null) {
      const subjectData = subjectSnapshot.data() ?? {};
      newSubjectProgress = Math.min(
        1,
        readProgress(subjectData, { required: true }) + progressDelta,
      );
      subjectStreakDays = readNonNegativeInteger(subjectData, 'streakDays', {
        required: true,
      });
      if (!streakHistory.isHistorical) {
        subjectStreakDays = streakHistory.streak;
      }
    }

    transaction.set(
      studyInfoRef,
      {
        progress: newProgress,
        streak: streakHistory.streak,
        lastStudyDate,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    if (shouldCreditGlobalProgress) {
      transaction.set(progressEventRef, {
        kind: 'study_activity',
        progressDelta,
        occurredAt,
        createdAt: serverTimestamp(),
      });
    }

    if (subjectRef !== null) {
      transaction.update(subjectRef, {
        progress: newSubjectProgress,
        streakDays: subjectStreakDays,
        updatedAt: serverTimestamp(),
      });
    }

    transaction.set(receiptRef, { appliedAt: serverTimestamp() });

    return {
      alreadyApplied: false,
      progress: newProgress,
      streak: streakHistory.streak,
      lastStudyDate,
      subjectProgress: newSubjectProgress,
    };
  });
}
