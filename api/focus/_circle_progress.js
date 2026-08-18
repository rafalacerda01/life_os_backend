const CIRCLE_SCHEMA_VERSION = 2;
const PROCESSED_EVENT_SCHEMA_VERSION = 1;
const SUPPORTED_CHALLENGE_TYPES = new Set([
  'FOCUS_MINUTES',
  'STUDY_MINUTES',
]);

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
    value.length > 0 &&
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

function isValidCircleV2(circle) {
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

function isValidMembershipV2(member, circle, uid, sessionStartedAt) {
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
    member.joinedAt.toMillis() > sessionStartedAt.toMillis()
  ) {
    return false;
  }

  const expectedRole = uid === circle.adminId ? 'admin' : 'member';
  return member.role === expectedRole;
}

function contributionFor(session) {
  const duration = session?.verifiedDurationSeconds;
  if (!Number.isInteger(duration) || duration <= 0 || duration % 60 !== 0) {
    return null;
  }

  return duration / 60;
}

function isEligibleChallenge(challenge, session) {
  if (
    !isPlainObject(challenge) ||
    challenge.schemaVersion !== CIRCLE_SCHEMA_VERSION ||
    !SUPPORTED_CHALLENGE_TYPES.has(challenge.type) ||
    !isTimestamp(challenge.startAt) ||
    !isTimestamp(challenge.endAt)
  ) {
    return false;
  }

  const startAtMillis = challenge.startAt.toMillis();
  const endAtMillis = challenge.endAt.toMillis();
  if (startAtMillis > endAtMillis) return false;
  if (challenge.type === 'STUDY_MINUTES' && session.targetType !== 'SUBJECT') {
    return false;
  }

  return (
    session.startedAt.toMillis() >= startAtMillis &&
    session.completedAt.toMillis() <= endAtMillis
  );
}

function validProgressUpdate(progress, contribution, completedAt) {
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

  const nextValue = progress.value + contribution;
  if (!Number.isSafeInteger(nextValue)) return null;

  const nextLastEventAt =
    isTimestamp(progress.lastEventAt) &&
    progress.lastEventAt.toMillis() > completedAt.toMillis()
      ? progress.lastEventAt
      : completedAt;
  return Object.freeze({ nextValue, nextLastEventAt });
}

function emptyPlan() {
  return Object.freeze({ entries: Object.freeze([]) });
}

export async function readCircleProgressPlan({
  transaction,
  db,
  userRef,
  uid,
  session,
}) {
  const contribution = contributionFor(session);
  if (
    contribution === null ||
    !isTimestamp(session?.startedAt) ||
    !isTimestamp(session?.completedAt)
  ) {
    return emptyPlan();
  }

  const userSnapshot = await transaction.get(userRef);
  if (!userSnapshot.exists) return emptyPlan();

  const activeCircleId = userSnapshot.data()?.activeCircleId;
  if (!isSafeDocumentId(activeCircleId)) return emptyPlan();

  const circleRef = db.collection('circles').doc(activeCircleId);
  const memberRef = circleRef.collection('members').doc(uid);
  const circleSnapshot = await transaction.get(circleRef);
  const memberSnapshot = await transaction.get(memberRef);
  const circle = circleSnapshot.data();
  const member = memberSnapshot.data();
  if (
    !circleSnapshot.exists ||
    !isValidCircleV2(circle) ||
    !memberSnapshot.exists ||
    !isValidMembershipV2(member, circle, uid, session.startedAt)
  ) {
    return emptyPlan();
  }

  const challengesSnapshot = await transaction.get(
    circleRef.collection('challenges'),
  );
  const eligibleChallenges = challengesSnapshot.docs.filter((snapshot) =>
    isEligibleChallenge(snapshot.data(), session),
  );

  if (eligibleChallenges.length > MAX_CIRCLE_PROGRESS_CHALLENGES) {
    console.warn('[focus] Circle progress skipped: write budget exceeded.');
    return emptyPlan();
  }

  const entries = [];
  for (const challengeSnapshot of eligibleChallenges) {
    const challenge = challengeSnapshot.data();
    const eventRef = challengeSnapshot.ref
      .collection('processed_events')
      .doc(session.sessionId);
    const progressRef = challengeSnapshot.ref
      .collection('progress')
      .doc(uid);
    const eventSnapshot = await transaction.get(eventRef);
    const progressSnapshot = await transaction.get(progressRef);

    if (eventSnapshot.exists) continue;

    let progressUpdate = Object.freeze({
      nextValue: contribution,
      nextLastEventAt: session.completedAt,
    });
    if (progressSnapshot.exists) {
      progressUpdate = validProgressUpdate(
        progressSnapshot.data(),
        contribution,
        session.completedAt,
      );
      if (progressUpdate === null) continue;
    }

    entries.push(
      Object.freeze({
        challengeType: challenge.type,
        eventRef,
        progressRef,
        progressExists: progressSnapshot.exists,
        nextValue: progressUpdate.nextValue,
        nextLastEventAt: progressUpdate.nextLastEventAt,
        contribution,
      }),
    );
  }

  return Object.freeze({ entries: Object.freeze(entries) });
}

export function applyCircleProgressPlan({
  transaction,
  plan,
  uid,
  session,
  processedAt,
}) {
  for (const entry of plan.entries) {
    transaction.create(entry.eventRef, {
      source: 'VERIFIED_FOCUS',
      sessionId: session.sessionId,
      uid,
      challengeType: entry.challengeType,
      contributionValue: entry.contribution,
      sessionStartedAt: session.startedAt,
      sessionCompletedAt: session.completedAt,
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
