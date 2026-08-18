import {
  createActivityHandler,
  getNowTimestamp,
  timestampToIso,
  validateHabitPayload,
} from './_shared.js';
import {
  ACTIVITY_EVENT_TYPES,
  habitEventId,
  recordVerifiedActivity,
  utcDayKey,
} from './_verified_events.js';

export async function completeHabitActivity({
  body,
  db,
  uid,
  now = getNowTimestamp(),
}) {
  const { habitId } = validateHabitPayload(body);
  const dayKey = utcDayKey(now);
  const result = await recordVerifiedActivity({
    db,
    uid,
    resourceId: habitId,
    resourceKind: 'habit',
    type: ACTIVITY_EVENT_TYPES.HABIT,
    eventId: habitEventId(habitId, dayKey),
    dayKey,
    now,
  });

  return {
    body: {
      type: ACTIVITY_EVENT_TYPES.HABIT,
      resourceId: habitId,
      dayKey,
      occurredAt: timestampToIso(result.event.occurredAt),
      replayed: result.replayed,
    },
  };
}

export default createActivityHandler(
  'habitComplete',
  'HABIT_ACTIVITY_FAILED',
  completeHabitActivity,
);
