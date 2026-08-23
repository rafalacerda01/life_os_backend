import {
  ActivityHttpError,
  createActivityHandler,
  validateHabitPayload,
} from './_shared.js';

export async function completeHabitActivity({ body }) {
  validateHabitPayload(body);
  throw new ActivityHttpError(
    410,
    'HABIT_ACTIVITY_ENDPOINT_RETIRED',
    'Use a sincronizacao de conclusao de habito.',
  );
}

export default createActivityHandler(
  'habitComplete',
  'HABIT_ACTIVITY_FAILED',
  completeHabitActivity,
);
