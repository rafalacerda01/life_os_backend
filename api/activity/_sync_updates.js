import { Timestamp } from 'firebase-admin/firestore';

import {
  ActivityHttpError,
  hasExactKeys,
  isPlainObject,
} from './_shared.js';
import {
  ACTIVITY_EVENT_TYPES,
  syncHabitStateUpdate,
  syncVerifiedActivityUpdate,
  syncVerifiedHabitCompletion,
  taskEventId,
} from './_verified_events.js';

const MAX_RESOURCE_ID_LENGTH = 128;
const MAX_HABIT_DATES = 5000;
const MAX_HABIT_DATE_LENGTH = 20;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidPayload() {
  return new ActivityHttpError(
    400,
    'INVALID_SYNC_PAYLOAD',
    'Payload de sincronizacao invalido.',
  );
}

function normalizeResourceId(value) {
  if (typeof value !== 'string') throw invalidPayload();
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_RESOURCE_ID_LENGTH ||
    normalized.includes('/')
  ) {
    throw invalidPayload();
  }
  return normalized;
}

export async function syncTaskUpdate({
  body,
  db,
  uid,
  now = Timestamp.now(),
}) {
  if (
    !hasExactKeys(body, ['operation', 'taskId', 'isCompleted']) ||
    body.operation !== 'update_task' ||
    typeof body.isCompleted !== 'boolean'
  ) {
    throw invalidPayload();
  }

  const taskId = normalizeResourceId(body.taskId);
  const result = await syncVerifiedActivityUpdate({
    db,
    uid,
    resourceId: taskId,
    resourceKind: 'task',
    type: ACTIVITY_EVENT_TYPES.TASK,
    eventId: taskEventId(taskId),
    updateData: { isCompleted: body.isCompleted },
    now,
  });

  return {
    body: {
      success: true,
      operation: 'update_task',
      activityRecorded: result.activityRecorded,
      replayed: result.replayed,
    },
  };
}

export async function syncHabitUpdate({
  body,
  db,
  uid,
  now = Timestamp.now(),
}) {
  if (
    !hasExactKeys(body, ['operation', 'habitId', 'completedDates']) ||
    body.operation !== 'update_habit' ||
    !Array.isArray(body.completedDates) ||
    body.completedDates.length > MAX_HABIT_DATES ||
    !body.completedDates.every(
      (date) =>
        typeof date === 'string' && date.length <= MAX_HABIT_DATE_LENGTH,
    )
  ) {
    throw invalidPayload();
  }

  const habitId = normalizeResourceId(body.habitId);
  const result = await syncHabitStateUpdate({
    db,
    uid,
    resourceId: habitId,
    completedDates: [...body.completedDates],
  });

  return {
    body: {
      success: true,
      operation: 'update_habit',
      activityRecorded: result.activityRecorded,
      replayed: result.replayed,
    },
  };
}

export async function syncHabitCompletionUpdate({
  body,
  db,
  uid,
  now = Timestamp.now(),
}) {
  if (
    !hasExactKeys(body, [
      'operation',
      'habitId',
      'completedDates',
      'competitiveCompletionId',
    ]) ||
    body.operation !== 'update_habit_completion' ||
    !Array.isArray(body.completedDates) ||
    body.completedDates.length > MAX_HABIT_DATES ||
    !body.completedDates.every(
      (date) =>
        typeof date === 'string' && date.length <= MAX_HABIT_DATE_LENGTH,
    ) ||
    typeof body.competitiveCompletionId !== 'string' ||
    !UUID_V4_PATTERN.test(body.competitiveCompletionId)
  ) {
    throw invalidPayload();
  }

  const habitId = normalizeResourceId(body.habitId);
  const result = await syncVerifiedHabitCompletion({
    db,
    uid,
    resourceId: habitId,
    operationId: body.competitiveCompletionId,
    completedDates: [...body.completedDates],
    now,
  });

  return {
    body: {
      success: true,
      operation: 'update_habit_completion',
      activityRecorded: result.activityRecorded,
      replayed: result.replayed,
    },
  };
}

export function isCompetitiveSyncOperation(body) {
  return (
    isPlainObject(body) &&
    (body.operation === 'update_task' ||
      body.operation === 'update_habit' ||
      body.operation === 'update_habit_completion')
  );
}
