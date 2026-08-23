import { createHash } from 'node:crypto';

import { ActivityHttpError, hasExactKeys, isPlainObject } from './_shared.js';
import {
  applyActivityCircleProgressPlan,
  readActivityCircleProgressPlan,
} from './_circle_progress.js';

export const ACTIVITY_EVENT_SCHEMA_VERSION = 1;
export const ACTIVITY_EVENT_SOURCE = 'SERVER_CONFIRMED_ACTIVITY';
export const ACTIVITY_OPERATION_SCHEMA_VERSION = 1;
export const ACTIVITY_OPERATION_COLLECTION = 'verified_activity_operations';
export const ACTIVITY_EVENT_TYPES = Object.freeze({
  TASK: 'TASK_COMPLETION',
  HABIT: 'HABIT_COMPLETION',
});

const TASK_PRIORITIES = new Set(['low', 'medium', 'high']);
const UTC_DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isTimestamp(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.toMillis !== 'function' ||
    typeof value.toDate !== 'function'
  ) {
    return false;
  }

  try {
    return Number.isFinite(value.toMillis()) && !Number.isNaN(value.toDate().getTime());
  } catch (_) {
    return false;
  }
}

function isValidDate(value) {
  return (
    (value instanceof Date && !Number.isNaN(value.getTime())) ||
    isTimestamp(value)
  );
}

function isValidTitle(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 200
  );
}

function isWellFormedTaskResource(task) {
  return (
    isPlainObject(task) &&
    isValidTitle(task.title) &&
    TASK_PRIORITIES.has(task.priority) &&
    typeof task.isCompleted === 'boolean' &&
    (task.date === undefined || isValidDate(task.date))
  );
}

function isWellFormedHabitResource(habit) {
  if (!isPlainObject(habit) || !isValidTitle(habit.title)) return false;
  return (
    Array.isArray(habit.completedDates) &&
    habit.completedDates.length <= 5000 &&
    habit.completedDates.every(
      (date) => typeof date === 'string' && date.length <= 20,
    )
  );
}

function hasUniqueValues(values) {
  return new Set(values).size === values.length;
}

function isValidUtcDateKey(value) {
  if (typeof value !== 'string' || !UTC_DAY_KEY_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isValidHabitCompletionTransition(previous, next) {
  if (
    !isWellFormedHabitResource(previous) ||
    !isWellFormedHabitResource(next) ||
    !hasUniqueValues(previous.completedDates) ||
    !hasUniqueValues(next.completedDates) ||
    next.completedDates.length !== previous.completedDates.length + 1 ||
    !previous.completedDates.every((date) => next.completedDates.includes(date))
  ) {
    return false;
  }

  const addedDates = next.completedDates.filter(
    (date) => !previous.completedDates.includes(date),
  );
  return addedDates.length === 1 && isValidUtcDateKey(addedDates[0]);
}

function habitCompletionPayloadHash(completedDates) {
  return createHash('sha256')
    .update(JSON.stringify(completedDates), 'utf8')
    .digest('hex');
}

export function isValidTaskResource(task) {
  return isWellFormedTaskResource(task) && task.isCompleted === true;
}

export function isValidHabitResource(habit, dayKey) {
  return (
    isWellFormedHabitResource(habit) &&
    typeof dayKey === 'string' &&
    UTC_DAY_KEY_PATTERN.test(dayKey) &&
    habit.completedDates.includes(dayKey)
  );
}

export function taskEventId(taskId) {
  return `TASK_COMPLETION__${taskId}`;
}

export function utcDayKey(timestamp) {
  if (!isTimestamp(timestamp)) {
    throw new Error('A valid server Timestamp is required.');
  }
  return timestamp.toDate().toISOString().slice(0, 10);
}

export function habitEventId(habitId, dayKey) {
  return `HABIT_COMPLETION__${habitId}__${dayKey}`;
}

function stateConflict() {
  return new ActivityHttpError(
    409,
    'ACTIVITY_EVENT_STATE_CONFLICT',
    'O estado do evento de atividade esta inconsistente.',
  );
}

function operationStateConflict() {
  return new ActivityHttpError(
    409,
    'ACTIVITY_OPERATION_STATE_CONFLICT',
    'O estado da operacao de atividade esta inconsistente.',
  );
}

function resourceConflict() {
  return new ActivityHttpError(
    409,
    'ACTIVITY_RESOURCE_STATE_CONFLICT',
    'O estado do recurso de atividade esta inconsistente.',
  );
}

function notFound(resourceKind) {
  const isTask = resourceKind === 'task';
  return new ActivityHttpError(
    404,
    isTask ? 'TASK_NOT_FOUND' : 'HABIT_NOT_FOUND',
    isTask ? 'Task nao encontrada.' : 'Habit nao encontrado.',
  );
}

function isValidStoredEvent(event, expected, now) {
  const expectedKeys = [
    'schemaVersion',
    'type',
    'source',
    'uid',
    'resourceId',
    ...(expected.dayKey === undefined ? [] : ['dayKey']),
    'occurredAt',
  ];
  const commonFieldsAreValid =
    hasExactKeys(event, expectedKeys) &&
    event.schemaVersion === ACTIVITY_EVENT_SCHEMA_VERSION &&
    event.type === expected.type &&
    event.source === ACTIVITY_EVENT_SOURCE &&
    event.uid === expected.uid &&
    event.resourceId === expected.resourceId &&
    isTimestamp(event.occurredAt) &&
    event.occurredAt.toMillis() <= now.toMillis();
  if (!commonFieldsAreValid) return false;

  return (
    expected.dayKey === undefined ||
    (UTC_DAY_KEY_PATTERN.test(event.dayKey) &&
      event.dayKey === expected.dayKey &&
      utcDayKey(event.occurredAt) === event.dayKey)
  );
}

function isValidHabitOperationReceipt(
  receipt,
  { uid, resourceId, operationId, payloadHash, now },
) {
  return (
    hasExactKeys(receipt, [
      'schemaVersion',
      'type',
      'source',
      'uid',
      'resourceId',
      'operationId',
      'dayKey',
      'activityEventId',
      'payloadHash',
      'occurredAt',
    ]) &&
    receipt.schemaVersion === ACTIVITY_OPERATION_SCHEMA_VERSION &&
    receipt.type === ACTIVITY_EVENT_TYPES.HABIT &&
    receipt.source === ACTIVITY_EVENT_SOURCE &&
    receipt.uid === uid &&
    receipt.resourceId === resourceId &&
    receipt.operationId === operationId &&
    receipt.payloadHash === payloadHash &&
    isValidUtcDateKey(receipt.dayKey) &&
    receipt.activityEventId === habitEventId(resourceId, receipt.dayKey) &&
    isTimestamp(receipt.occurredAt) &&
    receipt.occurredAt.toMillis() <= now.toMillis() &&
    utcDayKey(receipt.occurredAt) === receipt.dayKey
  );
}

export async function recordVerifiedActivity({
  db,
  uid,
  resourceId,
  resourceKind,
  type,
  eventId,
  dayKey,
  now,
}) {
  if (!isTimestamp(now)) {
    throw new Error('A valid server Timestamp is required.');
  }

  const userRef = db.collection('users').doc(uid);
  const resourceRef = userRef.collection(`${resourceKind}s`).doc(resourceId);
  const eventRef = userRef.collection('verified_activity_events').doc(eventId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    const resourceSnapshot = await transaction.get(resourceRef);
    const eventSnapshot = await transaction.get(eventRef);

    if (!userSnapshot.exists) {
      throw new ActivityHttpError(404, 'USER_NOT_FOUND', 'Usuario nao encontrado.');
    }
    if (!resourceSnapshot.exists) throw notFound(resourceKind);

    const validResource =
      resourceKind === 'task'
        ? isValidTaskResource(resourceSnapshot.data())
        : isValidHabitResource(resourceSnapshot.data(), dayKey);
    if (!validResource) throw resourceConflict();

    const expected = { type, uid, resourceId, dayKey };
    let event;
    let replayed;
    if (eventSnapshot.exists) {
      event = eventSnapshot.data();
      if (!isValidStoredEvent(event, expected, now)) {
        throw stateConflict();
      }
      replayed = true;
    } else {
      event = {
        schemaVersion: ACTIVITY_EVENT_SCHEMA_VERSION,
        type,
        source: ACTIVITY_EVENT_SOURCE,
        uid,
        resourceId,
        ...(dayKey === undefined ? {} : { dayKey }),
        occurredAt: now,
      };
      replayed = false;
    }

    const circlePlan = await readActivityCircleProgressPlan({
      transaction,
      db,
      uid,
      userSnapshot,
      event,
      activityEventId: eventId,
    });

    if (!replayed) transaction.create(eventRef, event);
    applyActivityCircleProgressPlan({
      transaction,
      plan: circlePlan,
      uid,
      event,
      activityEventId: eventId,
      processedAt: now,
    });
    return { event, replayed, eventId };
  });
}

export async function syncVerifiedActivityUpdate({
  db,
  uid,
  resourceId,
  resourceKind,
  type,
  eventId,
  dayKey,
  updateData,
  now,
}) {
  if (!isTimestamp(now)) {
    throw new Error('A valid server Timestamp is required.');
  }
  if (!isPlainObject(updateData)) {
    throw resourceConflict();
  }
  if (resourceKind !== 'task') {
    throw new Error('syncVerifiedActivityUpdate only supports Task updates.');
  }

  const userRef = db.collection('users').doc(uid);
  const resourceRef = userRef.collection(`${resourceKind}s`).doc(resourceId);
  const eventRef = userRef.collection('verified_activity_events').doc(eventId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    const resourceSnapshot = await transaction.get(resourceRef);

    if (!userSnapshot.exists) {
      throw new ActivityHttpError(404, 'USER_NOT_FOUND', 'Usuario nao encontrado.');
    }
    if (!resourceSnapshot.exists) throw notFound(resourceKind);

    const resource = {
      ...resourceSnapshot.data(),
      ...updateData,
    };
    const resourceIsWellFormed = isWellFormedTaskResource(resource);
    if (!resourceIsWellFormed) throw resourceConflict();

    const shouldRecordActivity = resource.isCompleted === true;

    let event = null;
    let replayed = false;
    let circlePlan = null;
    if (shouldRecordActivity) {
      const eventSnapshot = await transaction.get(eventRef);
      const expected = { type, uid, resourceId, dayKey };

      if (eventSnapshot.exists) {
        event = eventSnapshot.data();
        if (!isValidStoredEvent(event, expected, now)) {
          throw stateConflict();
        }
        replayed = true;
      } else {
        event = {
          schemaVersion: ACTIVITY_EVENT_SCHEMA_VERSION,
          type,
          source: ACTIVITY_EVENT_SOURCE,
          uid,
          resourceId,
          ...(dayKey === undefined ? {} : { dayKey }),
          occurredAt: now,
        };
      }

      circlePlan = await readActivityCircleProgressPlan({
        transaction,
        db,
        uid,
        userSnapshot,
        event,
        activityEventId: eventId,
      });
    }

    transaction.update(resourceRef, updateData);
    if (shouldRecordActivity) {
      if (!replayed) transaction.create(eventRef, event);
      applyActivityCircleProgressPlan({
        transaction,
        plan: circlePlan,
        uid,
        event,
        activityEventId: eventId,
        processedAt: now,
      });
    }

    return {
      activityRecorded: shouldRecordActivity,
      replayed,
      event,
      eventId,
    };
  });
}

export async function syncHabitStateUpdate({
  db,
  uid,
  resourceId,
  completedDates,
}) {
  const userRef = db.collection('users').doc(uid);
  const resourceRef = userRef.collection('habits').doc(resourceId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    const resourceSnapshot = await transaction.get(resourceRef);
    if (!userSnapshot.exists) {
      throw new ActivityHttpError(404, 'USER_NOT_FOUND', 'Usuario nao encontrado.');
    }
    if (!resourceSnapshot.exists) throw notFound('habit');

    const resource = {
      ...resourceSnapshot.data(),
      completedDates,
    };
    if (!isWellFormedHabitResource(resource)) throw resourceConflict();

    transaction.update(resourceRef, { completedDates });
    return { activityRecorded: false, replayed: false };
  });
}

export async function syncVerifiedHabitCompletion({
  db,
  uid,
  resourceId,
  operationId,
  completedDates,
  now,
}) {
  if (!isTimestamp(now)) {
    throw new Error('A valid server Timestamp is required.');
  }

  const payloadHash = habitCompletionPayloadHash(completedDates);
  const userRef = db.collection('users').doc(uid);
  const resourceRef = userRef.collection('habits').doc(resourceId);
  const operationRef = userRef
    .collection(ACTIVITY_OPERATION_COLLECTION)
    .doc(operationId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    const resourceSnapshot = await transaction.get(resourceRef);
    const operationSnapshot = await transaction.get(operationRef);

    if (!userSnapshot.exists) {
      throw new ActivityHttpError(404, 'USER_NOT_FOUND', 'Usuario nao encontrado.');
    }

    if (operationSnapshot.exists) {
      const receipt = operationSnapshot.data();
      if (
        !isValidHabitOperationReceipt(receipt, {
          uid,
          resourceId,
          operationId,
          payloadHash,
          now,
        })
      ) {
        throw operationStateConflict();
      }

      const eventRef = userRef
        .collection('verified_activity_events')
        .doc(receipt.activityEventId);
      const eventSnapshot = await transaction.get(eventRef);
      if (
        !eventSnapshot.exists ||
        !isValidStoredEvent(
          eventSnapshot.data(),
          {
            type: ACTIVITY_EVENT_TYPES.HABIT,
            uid,
            resourceId,
            dayKey: receipt.dayKey,
          },
          now,
        )
      ) {
        throw operationStateConflict();
      }

      return {
        activityRecorded: true,
        replayed: true,
        event: eventSnapshot.data(),
        eventId: receipt.activityEventId,
      };
    }

    if (!resourceSnapshot.exists) throw notFound('habit');
    const resource = {
      ...resourceSnapshot.data(),
      completedDates,
    };
    if (!isValidHabitCompletionTransition(resourceSnapshot.data(), resource)) {
      throw resourceConflict();
    }

    const dayKey = utcDayKey(now);
    const eventId = habitEventId(resourceId, dayKey);
    const eventRef = userRef.collection('verified_activity_events').doc(eventId);
    const eventSnapshot = await transaction.get(eventRef);
    const expected = {
      type: ACTIVITY_EVENT_TYPES.HABIT,
      uid,
      resourceId,
      dayKey,
    };
    let event;
    let replayed;
    if (eventSnapshot.exists) {
      event = eventSnapshot.data();
      if (!isValidStoredEvent(event, expected, now)) throw stateConflict();
      replayed = true;
    } else {
      event = {
        schemaVersion: ACTIVITY_EVENT_SCHEMA_VERSION,
        type: ACTIVITY_EVENT_TYPES.HABIT,
        source: ACTIVITY_EVENT_SOURCE,
        uid,
        resourceId,
        dayKey,
        occurredAt: now,
      };
      replayed = false;
    }

    const circlePlan = await readActivityCircleProgressPlan({
      transaction,
      db,
      uid,
      userSnapshot,
      event,
      activityEventId: eventId,
    });

    transaction.update(resourceRef, { completedDates });
    transaction.create(operationRef, {
      schemaVersion: ACTIVITY_OPERATION_SCHEMA_VERSION,
      type: ACTIVITY_EVENT_TYPES.HABIT,
      source: ACTIVITY_EVENT_SOURCE,
      uid,
      resourceId,
      operationId,
      dayKey,
      activityEventId: eventId,
      payloadHash,
      occurredAt: now,
    });
    if (!replayed) transaction.create(eventRef, event);
    applyActivityCircleProgressPlan({
      transaction,
      plan: circlePlan,
      uid,
      event,
      activityEventId: eventId,
      processedAt: now,
    });

    return {
      activityRecorded: true,
      replayed,
      event,
      eventId,
    };
  });
}
