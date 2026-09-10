import { FieldValue } from 'firebase-admin/firestore';

const MAX_ID_LENGTH = 128;
const MIN_TIME_ZONE_OFFSET_MINUTES = -840;
const MAX_TIME_ZONE_OFFSET_MINUTES = 840;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
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

function isValidId(value) {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !value.includes('/');
}

export function validateStudyReviewPayload(body) {
  const allowedKeys = new Set([
    'operation',
    'cardId',
    'subjectId',
    'occurredAt',
    'timeZoneOffsetMinutes',
  ]);
  if (!isPlainObject(body) || !hasExactKeys(body, allowedKeys)) {
    return { valid: false, error: 'Payload de revisão de estudo inválido.' };
  }

  if (!isValidId(body.cardId) || !isValidId(body.subjectId)) {
    return { valid: false, error: 'Identificador da revisão inválido.' };
  }
  if (
    typeof body.occurredAt !== 'string' ||
    !EXPLICIT_TIME_ZONE_PATTERN.test(body.occurredAt) ||
    !Number.isFinite(Date.parse(body.occurredAt))
  ) {
    return { valid: false, error: 'Data da revisão de estudo inválida.' };
  }
  if (
    !Number.isInteger(body.timeZoneOffsetMinutes) ||
    body.timeZoneOffsetMinutes < MIN_TIME_ZONE_OFFSET_MINUTES ||
    body.timeZoneOffsetMinutes > MAX_TIME_ZONE_OFFSET_MINUTES
  ) {
    return { valid: false, error: 'Fuso horário da revisão inválido.' };
  }

  return {
    valid: true,
    value: {
      cardId: body.cardId.trim(),
      subjectId: body.subjectId.trim(),
      occurredAt: new Date(body.occurredAt),
      timeZoneOffsetMinutes: body.timeZoneOffsetMinutes,
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
    'STUDY_REVIEW_STATE_INVALID',
    'O estado remoto da revisão de estudo está inconsistente.',
  );
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

function readOptionalDate(data, field) {
  if (!Object.hasOwn(data, field) || data[field] === null) return null;
  return readDate(data[field]);
}

function readOptionalStrictDate(data, field) {
  if (!Object.hasOwn(data, field)) return null;
  return readDate(data[field]);
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

function localDayOrdinal(date, timeZoneOffsetMinutes) {
  const localTime = new Date(date.getTime() + timeZoneOffsetMinutes * 60 * 1000);
  return Math.floor(
    Date.UTC(
      localTime.getUTCFullYear(),
      localTime.getUTCMonth(),
      localTime.getUTCDate(),
    ) / MILLISECONDS_PER_DAY,
  );
}

function nextStudyState({
  currentStreak,
  remoteLastStudyDate,
  occurredAt,
  timeZoneOffsetMinutes,
}) {
  if (remoteLastStudyDate === null) {
    return { streak: 1, lastStudyDate: occurredAt };
  }

  const eventDay = localDayOrdinal(occurredAt, timeZoneOffsetMinutes);
  const remoteDay = localDayOrdinal(
    remoteLastStudyDate,
    timeZoneOffsetMinutes,
  );
  const dayDifference = eventDay - remoteDay;

  if (dayDifference < 0) {
    return {
      streak: currentStreak,
      lastStudyDate: remoteLastStudyDate,
    };
  }
  if (dayDifference === 0) {
    return {
      streak: currentStreak,
      lastStudyDate:
        occurredAt.getTime() > remoteLastStudyDate.getTime()
          ? occurredAt
          : remoteLastStudyDate,
    };
  }
  if (dayDifference === 1) {
    return { streak: currentStreak + 1, lastStudyDate: occurredAt };
  }
  return { streak: 1, lastStudyDate: occurredAt };
}

export async function applyStudyReview({
  db,
  userId,
  cardId,
  subjectId,
  occurredAt,
  timeZoneOffsetMinutes,
  serverTimestamp = FieldValue.serverTimestamp,
}) {
  const userRef = db.collection('users').doc(userId);
  const cardRef = userRef.collection('review_queue').doc(cardId);
  const subjectRef = userRef.collection('subjects').doc(subjectId);
  const studyInfoRef = userRef.collection('study_info').doc('main');
  const progressStateRef = userRef.collection('study_progress_state').doc('main');
  const progressEventRef = userRef
    .collection('study_progress_events')
    .doc(`review_${cardId}_${occurredAt.getTime()}`);

  return db.runTransaction(async (transaction) => {
    const [
      userSnapshot,
      cardSnapshot,
      subjectSnapshot,
      studyInfoSnapshot,
      progressStateSnapshot,
    ] = await Promise.all([
      transaction.get(userRef),
      transaction.get(cardRef),
      transaction.get(subjectRef),
      transaction.get(studyInfoRef),
      transaction.get(progressStateRef),
    ]);

    if (!userSnapshot.exists) {
      const error = new Error('Usuário não encontrado.');
      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';
      throw error;
    }
    if (!cardSnapshot.exists) {
      throw domainError(
        'STUDY_REVIEW_CARD_NOT_FOUND',
        'O flashcard da revisão não foi encontrado.',
      );
    }
    if (!subjectSnapshot.exists) {
      throw domainError(
        'STUDY_REVIEW_SUBJECT_NOT_FOUND',
        'A matéria da revisão não foi encontrada.',
      );
    }

    const cardData = cardSnapshot.data();
    const subjectData = subjectSnapshot.data();
    const studyInfoData = studyInfoSnapshot.exists ? studyInfoSnapshot.data() : {};
    if (
      !isPlainObject(cardData) ||
      !isPlainObject(subjectData) ||
      !isPlainObject(studyInfoData) ||
      !isValidId(cardData.subjectId) ||
      cardData.subjectId !== subjectId
    ) {
      throw stateInvalid();
    }

    const currentLastReviewed = readOptionalDate(cardData, 'lastReviewed');
    const currentCardsToReview = readNonNegativeInteger(
      subjectData,
      'cardsToReview',
      { required: true },
    );
    const currentReviewQueue = readNonNegativeInteger(
      studyInfoData,
      'reviewQueue',
    );
    const currentProgress = readProgress(studyInfoData);
    const currentLastStudyDate = readOptionalStrictDate(
      studyInfoData,
      'lastStudyDate',
    );
    const currentStreak = readNonNegativeInteger(studyInfoData, 'streak', {
      required: currentLastStudyDate !== null,
    });
    const lastResetAt = readLastResetAt(progressStateSnapshot);

    if (currentLastReviewed !== null) {
      const comparison = occurredAt.getTime() - currentLastReviewed.getTime();
      if (comparison <= 0) {
        return {
          alreadyApplied: comparison === 0,
          skippedAsStale: comparison < 0,
        };
      }
      if (
        localDayOrdinal(occurredAt, timeZoneOffsetMinutes) ===
        localDayOrdinal(currentLastReviewed, timeZoneOffsetMinutes)
      ) {
        return { alreadyApplied: true, skippedAsStale: false };
      }
    }

    const newReviewQueue = Math.max(0, currentReviewQueue - 1);
    const newCardsToReview = Math.max(0, currentCardsToReview - 1);
    const shouldCreditGlobalProgress =
      lastResetAt === null || occurredAt.getTime() > lastResetAt.getTime();
    const studyState = nextStudyState({
      currentStreak,
      remoteLastStudyDate: currentLastStudyDate,
      occurredAt,
      timeZoneOffsetMinutes,
    });

    transaction.update(cardRef, { lastReviewed: occurredAt });
    const studyInfoUpdate = {
      reviewQueue: newReviewQueue,
      streak: studyState.streak,
      lastStudyDate: studyState.lastStudyDate,
    };
    if (shouldCreditGlobalProgress) {
      studyInfoUpdate.progress = Math.min(1, currentProgress + .05);
    }
    transaction.set(studyInfoRef, studyInfoUpdate, { merge: true });
    transaction.update(subjectRef, { cardsToReview: newCardsToReview });
    if (shouldCreditGlobalProgress) {
      transaction.set(progressEventRef, {
        kind: 'review',
        progressDelta: .05,
        occurredAt,
        createdAt: serverTimestamp(),
      });
    }

    return {
      alreadyApplied: false,
      skippedAsStale: false,
      progress: shouldCreditGlobalProgress
        ? studyInfoUpdate.progress
        : currentProgress,
    };
  });
}
