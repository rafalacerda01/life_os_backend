const CIRCLE_SCHEMA_VERSION = 2;
const PROCESSED_EVENT_SCHEMA_VERSION = 1;
const CHALLENGE_TYPE_BY_ACTIVITY = Object.freeze({
  TASK_COMPLETION: 'TASK_COMPLETIONS',
  HABIT_COMPLETION: 'HABIT_COMPLETIONS',
});

export const MAX_CIRCLE_PROGRESS_CHALLENGES = 240;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isTimestamp(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.toMillis !== 'function'
  ) {
    return false;
  }

  try {
    return Number.isFinite(value.toMillis());
  } catch (_) {
    return false;
  }
}

function isSafeDocumentId(value) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    value.trim() === value &&
    !value.includes('/')
  );
}

function isNonEmptyStringWithin(value, maxLength) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function isValidCircle(circle) {
  return (
    isPlainObject(circle) &&
    circle.schemaVersion === CIRCLE_SCHEMA_VERSION &&
    isNonEmptyStringWithin(circle.name, 100) &&
    isNonEmptyStringWithin(circle.description, 500) &&
    isSafeDocumentId(circle.adminId) &&
    Number.isInteger(circle.memberCount) &&
    circle.memberCount >= 1 &&
    (circle.memberLimit === 3 || circle.memberLimit === 10) &&
    circle.memberCount <= circle.memberLimit &&
    isTimestamp(circle.createdAt) &&
    isTimestamp(circle.updatedAt)
  );
}

function isValidMembership(member, circle, uid, occurredAt) {
  if (
    !isPlainObject(member) ||
    (member.role !== 'admin' && member.role !== 'member') ||
    !isNonEmptyStringWithin(member.displayNameSnapshot, 50) ||
    !(
      member.photoUrlSnapshot === null ||
      (typeof member.photoUrlSnapshot === 'string' &&
        member.photoUrlSnapshot.length <= 2048)
    ) ||
    !isTimestamp(member.joinedAt) ||
    member.joinedAt.toMillis() > occurredAt.toMillis()
  ) {
    return false;
  }

  const expectedRole = uid === circle.adminId ? 'admin' : 'member';
  return member.role === expectedRole;
}

function isEligibleChallenge(challenge, challengeType, occurredAt) {
  if (
    !isPlainObject(challenge) ||
    challenge.schemaVersion !== CIRCLE_SCHEMA_VERSION ||
    challenge.type !== challengeType ||
    !isTimestamp(challenge.startAt) ||
    !isTimestamp(challenge.endAt)
  ) {
    return false;
  }

  const startMillis = challenge.startAt.toMillis();
  const endMillis = challenge.endAt.toMillis();
  const occurredMillis = occurredAt.toMillis();
  return (
    startMillis <= endMillis &&
    startMillis <= occurredMillis &&
    occurredMillis <= endMillis
  );
}

function isExpectedActivityEventId(event, activityEventId) {
  if (event.type === 'TASK_COMPLETION') {
    return activityEventId === `TASK_COMPLETION__${event.resourceId}`;
  }
  if (event.type === 'HABIT_COMPLETION') {
    return (
      typeof event.dayKey === 'string' &&
      activityEventId ===
        `HABIT_COMPLETION__${event.resourceId}__${event.dayKey}`
    );
  }
  return false;
}

function validProgressUpdate(progress, occurredAt) {
  if (!isPlainObject(progress)) return null;
  if (!Number.isSafeInteger(progress.value) || progress.value < 0) return null;
  if (progress.updatedAt !== undefined && !isTimestamp(progress.updatedAt)) {
    return null;
  }
  if (progress.lastEventAt !== undefined && !isTimestamp(progress.lastEventAt)) {
    return null;
  }
  if (
    isTimestamp(progress.updatedAt) &&
    isTimestamp(progress.lastEventAt) &&
    progress.lastEventAt.toMillis() > progress.updatedAt.toMillis()
  ) {
    return null;
  }

  const nextValue = progress.value + 1;
  if (!Number.isSafeInteger(nextValue)) return null;

  const nextLastEventAt =
    isTimestamp(progress.lastEventAt) &&
    progress.lastEventAt.toMillis() > occurredAt.toMillis()
      ? progress.lastEventAt
      : occurredAt;
  return Object.freeze({ nextValue, nextLastEventAt });
}

function emptyPlan() {
  return Object.freeze({ entries: Object.freeze([]) });
}

export async function readActivityCircleProgressPlan({
  transaction,
  db,
  uid,
  userSnapshot,
  event,
  activityEventId,
}) {
  const challengeType = CHALLENGE_TYPE_BY_ACTIVITY[event.type];
  if (
    challengeType === undefined ||
    !isTimestamp(event.occurredAt) ||
    !isExpectedActivityEventId(event, activityEventId)
  ) {
    return emptyPlan();
  }

  const activeCircleId = userSnapshot.data()?.activeCircleId;
  if (!isSafeDocumentId(activeCircleId)) return emptyPlan();

  const circleRef = db.collection('circles').doc(activeCircleId);
  const memberRef = circleRef.collection('members').doc(uid);
  const circleSnapshot = await transaction.get(circleRef);
  const memberSnapshot = await transaction.get(memberRef);
  const circle = circleSnapshot.data();
  if (
    !circleSnapshot.exists ||
    !isValidCircle(circle) ||
    !memberSnapshot.exists ||
    !isValidMembership(
      memberSnapshot.data(),
      circle,
      uid,
      event.occurredAt,
    )
  ) {
    return emptyPlan();
  }

  const challengesSnapshot = await transaction.get(
    circleRef.collection('challenges'),
  );
  const eligibleChallenges = challengesSnapshot.docs.filter((snapshot) =>
    isEligibleChallenge(snapshot.data(), challengeType, event.occurredAt),
  );

  if (eligibleChallenges.length > MAX_CIRCLE_PROGRESS_CHALLENGES) {
    console.warn('[activity] Circle progress skipped: write budget exceeded.');
    return emptyPlan();
  }

  const entries = [];
  for (const challengeSnapshot of eligibleChallenges) {
    const processedEventRef = challengeSnapshot.ref
      .collection('processed_events')
      .doc(activityEventId);
    const progressRef = challengeSnapshot.ref
      .collection('progress')
      .doc(uid);
    const processedEventSnapshot = await transaction.get(processedEventRef);
    const progressSnapshot = await transaction.get(progressRef);

    if (processedEventSnapshot.exists) continue;

    let progressUpdate = Object.freeze({
      nextValue: 1,
      nextLastEventAt: event.occurredAt,
    });
    if (progressSnapshot.exists) {
      progressUpdate = validProgressUpdate(
        progressSnapshot.data(),
        event.occurredAt,
      );
      if (progressUpdate === null) continue;
    }

    entries.push(
      Object.freeze({
        challengeType,
        processedEventRef,
        progressRef,
        progressExists: progressSnapshot.exists,
        nextValue: progressUpdate.nextValue,
        nextLastEventAt: progressUpdate.nextLastEventAt,
      }),
    );
  }

  return Object.freeze({ entries: Object.freeze(entries) });
}

export function applyActivityCircleProgressPlan({
  transaction,
  plan,
  uid,
  event,
  activityEventId,
  processedAt,
}) {
  for (const entry of plan.entries) {
    transaction.create(entry.processedEventRef, {
      source: 'VERIFIED_ACTIVITY',
      activityEventId,
      uid,
      activityType: event.type,
      challengeType: entry.challengeType,
      resourceId: event.resourceId,
      contributionValue: 1,
      eventOccurredAt: event.occurredAt,
      processedAt,
      schemaVersion: PROCESSED_EVENT_SCHEMA_VERSION,
    });

    const progressData = {
      value: entry.nextValue,
      updatedAt: processedAt,
      lastEventAt: entry.nextLastEventAt,
    };
    if (entry.progressExists) {
      transaction.update(entry.progressRef, progressData);
    } else {
      transaction.create(entry.progressRef, progressData);
    }
  }
}
