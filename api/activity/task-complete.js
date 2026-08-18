import {
  createActivityHandler,
  getNowTimestamp,
  timestampToIso,
  validateTaskPayload,
} from './_shared.js';
import {
  ACTIVITY_EVENT_TYPES,
  recordVerifiedActivity,
  taskEventId,
} from './_verified_events.js';

export async function completeTaskActivity({
  body,
  db,
  uid,
  now = getNowTimestamp(),
}) {
  const { taskId } = validateTaskPayload(body);
  const result = await recordVerifiedActivity({
    db,
    uid,
    resourceId: taskId,
    resourceKind: 'task',
    type: ACTIVITY_EVENT_TYPES.TASK,
    eventId: taskEventId(taskId),
    now,
  });

  return {
    body: {
      type: ACTIVITY_EVENT_TYPES.TASK,
      resourceId: taskId,
      occurredAt: timestampToIso(result.event.occurredAt),
      replayed: result.replayed,
    },
  };
}

export default createActivityHandler(
  'taskComplete',
  'TASK_ACTIVITY_FAILED',
  completeTaskActivity,
);
