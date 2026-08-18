import { ActivityHttpError, hasExactKeys, isPlainObject } from './_shared.js';

export const ACTIVITY_EVENT_SCHEMA_VERSION = 1;
export const ACTIVITY_EVENT_SOURCE = 'SERVER_CONFIRMED_ACTIVITY';
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

export function isValidTaskResource(task) {
  return (
    isPlainObject(task) &&
    isValidTitle(task.title) &&
    TASK_PRIORITIES.has(task.priority) &&
    (task.isCompleted === undefined || typeof task.isCompleted === 'boolean') &&
    (task.date === undefined || isValidDate(task.date))
  );
}

export function isValidHabitResource(habit) {
  if (!isPlainObject(habit) || !isValidTitle(habit.title)) return false;
  if (habit.completedDates === undefined) return true;
  return (
    Array.isArray(habit.completedDates) &&
    habit.completedDates.length <= 5000 &&
    habit.completedDates.every(
      (date) => typeof date === 'string' && date.length <= 20,
    )
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
        : isValidHabitResource(resourceSnapshot.data());
    if (!validResource) throw resourceConflict();

    const expected = { type, uid, resourceId, dayKey };
    if (eventSnapshot.exists) {
      const storedEvent = eventSnapshot.data();
      if (!isValidStoredEvent(storedEvent, expected, now)) {
        throw stateConflict();
      }
      return { event: storedEvent, replayed: true, eventId };
    }

    const event = {
      schemaVersion: ACTIVITY_EVENT_SCHEMA_VERSION,
      type,
      source: ACTIVITY_EVENT_SOURCE,
      uid,
      resourceId,
      ...(dayKey === undefined ? {} : { dayKey }),
      occurredAt: now,
    };
    transaction.create(eventRef, event);
    return { event, replayed: false, eventId };
  });
}
