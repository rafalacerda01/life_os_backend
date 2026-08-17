import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
  getFirestore,
  FieldValue,
} from 'firebase-admin/firestore';
// ============================================================================
// LIFE OS - SYNC ENDPOINT
// ============================================================================

if (!getApps().length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin environment is not completely configured.',
    );
  }

  initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

const db = getFirestore();

// ============================================================================
// RATE LIMIT
// ============================================================================

const syncRequestTracker = new Map();

const SYNC_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const SYNC_MAX_REQUESTS_PER_WINDOW = 30;
const MAX_TRACKED_USERS = 10_000;

// ============================================================================
// LIMITES
// ============================================================================

const MAX_CONTENT_LENGTH_BYTES = 512 * 1024;

const MAX_BATCH_ITEMS = {
  tasks: 300,
  habits: 200,
  finances: 500,
};

const MAX_ITEM_JSON_LENGTH = 20_000;

const MAX_TOP_LEVEL_KEYS = 4;

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'timestamp',
  'tasks',
  'habits',
  'finances',
]);
const HABITS_FREE_LIMIT = 3;
const HABITS_PREMIUM_LIMIT = 30;
const TASKS_FREE_LIMIT = 3;
const GOALS_FREE_LIMIT = 3;
const GOALS_PREMIUM_LIMIT = 30;
const SUBJECTS_FREE_LIMIT = 3;
const SUBJECTS_PREMIUM_LIMIT = 30;

const MAX_SUBJECT_TITLE_LENGTH = 200;
const MAX_SUBJECT_ID_LENGTH = 128;
const MEDICATIONS_FREE_LIMIT = 3;
const MEDICATIONS_PREMIUM_LIMIT = 30;

const MAX_MEDICATION_NAME_LENGTH = 200;
const MAX_MEDICATION_ID_LENGTH = 128;
const MAX_MEDICATION_DURATION_DAYS = 3650;
const MAX_GOAL_TITLE_LENGTH = 200;
const MAX_GOAL_ID_LENGTH = 128;

const ALLOWED_GOAL_PERIODS = new Set([
  'DIÁRIA',
  'SEMANAL',
  'MENSAL',
]);

const MAX_TASK_TITLE_LENGTH = 200;
const MAX_TASK_ID_LENGTH = 128;
const ALLOWED_TASK_PRIORITIES = new Set([
  'low',
  'medium',
  'high',
]);
const MAX_HABIT_TITLE_LENGTH = 200;
const MAX_HABIT_DATES = 5000;
const MAX_HABIT_DATE_LENGTH = 20;
// ============================================================================
// SCHEMA ALLOWLIST
// ============================================================================

// Campos observados na estrutura atual do Life OS.
//
// Campos administrativos como:
// admin
// role
// isPremium
// permissions
// isAdmin
// ownerId
//
// NÃO fazem parte da allowlist.

const ALLOWED_TASK_FIELDS = new Set([
  'id',
  'title',
  'priority',
  'isCompleted',
  'date',
  'description',
  'subTasks',
  'createdAt',
  'updatedAt',
  'firestoreId',
]);

const ALLOWED_HABIT_FIELDS = new Set([
  'id',
  'title',
  'completedDates',
  'createdAt',
  'updatedAt',
  'firestoreId',
]);

const ALLOWED_FINANCE_FIELDS = new Set([
  'id',
  'firestoreId',
  'title',
  'amount',
  'type',
  'category',
  'date',
  'isDeleted',
  'createdAt',
  'updatedAt',
]);

// ============================================================================
// CORS
// ============================================================================

function applyCors(req, res) {
  const origin = req.headers.origin;

  const allowedOrigins = new Set([
    'https://painel.life-os.com',
    'https://app.life-os.com',
    'http://localhost:3000',
  ]);

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization',
  );
}

// ============================================================================
// HELPERS
// ============================================================================

function getContentLength(req) {
  const raw = req.headers['content-length'];

  if (Array.isArray(raw)) {
    return null;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : null;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function isSafePrimitive(value) {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (
      typeof value === 'number' &&
      Number.isFinite(value)
    )
  );
}

// ============================================================================
// RATE LIMIT
// ============================================================================

function checkSyncRateLimit(userId) {
  const now = Date.now();

  if (syncRequestTracker.size > MAX_TRACKED_USERS) {
    for (const [key, value] of syncRequestTracker) {
      if (
        now - value.startTime >
        SYNC_RATE_LIMIT_WINDOW_MS
      ) {
        syncRequestTracker.delete(key);
      }
    }
  }

  const current = syncRequestTracker.get(userId);

  if (
    !current ||
    now - current.startTime >=
      SYNC_RATE_LIMIT_WINDOW_MS
  ) {
    syncRequestTracker.set(userId, {
      count: 1,
      startTime: now,
    });

    return true;
  }

  if (
    current.count >=
    SYNC_MAX_REQUESTS_PER_WINDOW
  ) {
    return false;
  }

  current.count += 1;

  syncRequestTracker.set(userId, current);

  return true;
}

// ============================================================================
// TIMESTAMP
// ============================================================================

function validateTimestamp(value) {
  if (value === undefined) {
    return true;
  }

  if (typeof value !== 'string') {
    return false;
  }

  if (value.length > 100) {
    return false;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed);
}

// ============================================================================
// FIELD ALLOWLIST
// ============================================================================

function validateKnownKeys(item, allowedFields) {
  const keys = Object.keys(item);

  return keys.every((key) =>
    allowedFields.has(key),
  );
}

// ============================================================================
// RECURSIVE JSON VALIDATION
// ============================================================================

function validateNestedJsonValue(
  value,
  depth = 0,
) {
  if (depth > 5) {
    return false;
  }

  if (isSafePrimitive(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    if (value.length > 100) {
      return false;
    }

    return value.every((item) =>
      validateNestedJsonValue(
        item,
        depth + 1,
      ),
    );
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);

    if (keys.length > 50) {
      return false;
    }

    return keys.every(
      (key) =>
        key.length > 0 &&
        key.length <= 100 &&
        validateNestedJsonValue(
          value[key],
          depth + 1,
        ),
    );
  }

  return false;
}

// ============================================================================
// TASK VALIDATION
// ============================================================================

function validateTask(item) {
  if (!isPlainObject(item)) {
    return false;
  }

  if (
    !validateKnownKeys(
      item,
      ALLOWED_TASK_FIELDS,
    )
  ) {
    return false;
  }

  if (
    item.id !== undefined &&
    typeof item.id !== 'string'
  ) {
    return false;
  }

  if (
    item.title !== undefined &&
    typeof item.title !== 'string'
  ) {
    return false;
  }

  if (
    item.priority !== undefined &&
    typeof item.priority !== 'string'
  ) {
    return false;
  }

  if (
    item.isCompleted !== undefined &&
    typeof item.isCompleted !== 'boolean'
  ) {
    return false;
  }

  return validateNestedJsonValue(item);
}

// ============================================================================
// HABIT VALIDATION
// ============================================================================

function validateHabit(item) {
  if (!isPlainObject(item)) {
    return false;
  }

  if (
    !validateKnownKeys(
      item,
      ALLOWED_HABIT_FIELDS,
    )
  ) {
    return false;
  }

  if (
    item.id !== undefined &&
    typeof item.id !== 'string'
  ) {
    return false;
  }

  if (
    item.title !== undefined &&
    typeof item.title !== 'string'
  ) {
    return false;
  }

  if (item.completedDates !== undefined) {
    if (!Array.isArray(item.completedDates)) {
      return false;
    }

    if (item.completedDates.length > 5000) {
      return false;
    }

    if (
      !item.completedDates.every(
        (date) =>
          typeof date === 'string' &&
          date.length <= 20,
      )
    ) {
      return false;
    }
  }

  return validateNestedJsonValue(item);
}

// ============================================================================
// FINANCE VALIDATION
// ============================================================================

function validateFinance(item) {
  if (!isPlainObject(item)) {
    return false;
  }

  if (
    !validateKnownKeys(
      item,
      ALLOWED_FINANCE_FIELDS,
    )
  ) {
    return false;
  }

  if (
    item.id !== undefined &&
    typeof item.id !== 'string'
  ) {
    return false;
  }

  if (
    item.firestoreId !== undefined &&
    item.firestoreId !== null &&
    typeof item.firestoreId !== 'string'
  ) {
    return false;
  }

  if (
    item.title !== undefined &&
    typeof item.title !== 'string'
  ) {
    return false;
  }

  if (
    item.amount !== undefined &&
    (
      typeof item.amount !== 'number' ||
      !Number.isFinite(item.amount)
    )
  ) {
    return false;
  }

  if (
    item.type !== undefined &&
    item.type !== 'income' &&
    item.type !== 'expense'
  ) {
    return false;
  }

  if (
    item.category !== undefined &&
    typeof item.category !== 'string'
  ) {
    return false;
  }

  if (
    item.isDeleted !== undefined &&
    typeof item.isDeleted !== 'boolean'
  ) {
    return false;
  }

  return validateNestedJsonValue(item);
}

// ============================================================================
// COLLECTION VALIDATION
// ============================================================================

function validateEntityStructure(
  items,
  validator,
  maxAllowed,
) {
  if (!Array.isArray(items)) {
    return false;
  }

  if (items.length > maxAllowed) {
    return false;
  }

  for (const item of items) {
    if (!validator(item)) {
      return false;
    }

    if (
      JSON.stringify(item).length >
      MAX_ITEM_JSON_LENGTH
    ) {
      return false;
    }
  }

  return true;
}
function validateSubjectCreatePayload(body) {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      error: 'Payload inválido.',
    };
  }

  const {
    subjectId,
    title,
    hasExam,
    examDate,
  } = body;

  if (
    typeof subjectId !== 'string' ||
    subjectId.trim().length === 0 ||
    subjectId.length > MAX_SUBJECT_ID_LENGTH ||
    subjectId.includes('/')
  ) {
    return {
      valid: false,
      error: 'subjectId inválido.',
    };
  }

  if (
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.length > MAX_SUBJECT_TITLE_LENGTH
  ) {
    return {
      valid: false,
      error: 'Título da matéria inválido.',
    };
  }

  if (typeof hasExam !== 'boolean') {
    return {
      valid: false,
      error: 'Indicador de prova inválido.',
    };
  }

  if (
    examDate !== null &&
    (
      typeof examDate !== 'string' ||
      !Number.isFinite(Date.parse(examDate))
    )
  ) {
    return {
      valid: false,
      error: 'Data da prova inválida.',
    };
  }

  if (
    hasExam === true &&
    examDate === null
  ) {
    return {
      valid: false,
      error: 'Data da prova é obrigatória.',
    };
  }

  return {
    valid: true,
  };
}

function validateMedicationCreatePayload(body) {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      error: 'Payload inválido.',
    };
  }

  const {
    medicationId,
    name,
    startDate,
    durationDays,
    endDate,
  } = body;

  if (
    typeof medicationId !== 'string' ||
    medicationId.trim().length === 0 ||
    medicationId.length > MAX_MEDICATION_ID_LENGTH ||
    medicationId.includes('/')
  ) {
    return {
      valid: false,
      error: 'medicationId inválido.',
    };
  }

  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.length > MAX_MEDICATION_NAME_LENGTH
  ) {
    return {
      valid: false,
      error: 'Nome do medicamento inválido.',
    };
  }

  if (
    typeof startDate !== 'string' ||
    !Number.isFinite(Date.parse(startDate))
  ) {
    return {
      valid: false,
      error: 'Data inicial do medicamento inválida.',
    };
  }

  if (
    durationDays !== null &&
    (
      typeof durationDays !== 'number' ||
      !Number.isInteger(durationDays) ||
      durationDays <= 0 ||
      durationDays > MAX_MEDICATION_DURATION_DAYS
    )
  ) {
    return {
      valid: false,
      error: 'Duração do medicamento inválida.',
    };
  }

  if (
    endDate !== null &&
    (
      typeof endDate !== 'string' ||
      !Number.isFinite(Date.parse(endDate))
    )
  ) {
    return {
      valid: false,
      error: 'Data final do medicamento inválida.',
    };
  }

  return {
    valid: true,
  };
}

function validateMedicationDeletePayload(body) {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      error: 'Payload inválido.',
    };
  }

  const { medicationId } = body;

  if (
    typeof medicationId !== 'string' ||
    medicationId.trim().length === 0 ||
    medicationId.length > MAX_MEDICATION_ID_LENGTH ||
    medicationId.includes('/')
  ) {
    return {
      valid: false,
      error: 'medicationId inválido.',
    };
  }

  return {
    valid: true,
  };
}

function validateSubjectDeletePayload(body) {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      error: 'Payload inválido.',
    };
  }

  const { subjectId } = body;

  if (
    typeof subjectId !== 'string' ||
    subjectId.trim().length === 0 ||
    subjectId.length > MAX_SUBJECT_ID_LENGTH ||
    subjectId.includes('/')
  ) {
    return {
      valid: false,
      error: 'subjectId inválido.',
    };
  }

  return {
    valid: true,
  };
}
function validateGoalCreatePayload(body) {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      error: 'Payload inválido.',
    };
  }

  const {
    goalId,
    title,
    period,
    targetValue,
    createdAt,
  } = body;

  if (
    typeof goalId !== 'string' ||
    goalId.trim().length === 0 ||
    goalId.length > MAX_GOAL_ID_LENGTH ||
    goalId.includes('/')
  ) {
    return {
      valid: false,
      error: 'goalId inválido.',
    };
  }

  if (
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.length > MAX_GOAL_TITLE_LENGTH
  ) {
    return {
      valid: false,
      error: 'Título da meta inválido.',
    };
  }

  if (
    typeof period !== 'string' ||
    !ALLOWED_GOAL_PERIODS.has(period)
  ) {
    return {
      valid: false,
      error: 'Período da meta inválido.',
    };
  }

  if (
    typeof targetValue !== 'number' ||
    !Number.isInteger(targetValue) ||
    targetValue <= 0
  ) {
    return {
      valid: false,
      error: 'Objetivo numérico inválido.',
    };
  }

  if (
    typeof createdAt !== 'string' ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    return {
      valid: false,
      error: 'Data da meta inválida.',
    };
  }

  return {
    valid: true,
  };
}

function validateGoalDeletePayload(body) {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      error: 'Payload inválido.',
    };
  }

  const { goalId } = body;

  if (
    typeof goalId !== 'string' ||
    goalId.trim().length === 0 ||
    goalId.length > MAX_GOAL_ID_LENGTH ||
    goalId.includes('/')
  ) {
    return {
      valid: false,
      error: 'goalId inválido.',
    };
  }

  return {
    valid: true,
  };
}
function validateTaskCreatePayload(body) {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      error: 'Payload inválido.',
    };
  }

  const {
    taskId,
    title,
    priority,
    date,
  } = body;

  if (
    typeof taskId !== 'string' ||
    taskId.trim().length === 0 ||
    taskId.length > MAX_TASK_ID_LENGTH ||
    taskId.includes('/')
  ) {
    return {
      valid: false,
      error: 'taskId inválido.',
    };
  }

  if (
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.length > MAX_TASK_TITLE_LENGTH
  ) {
    return {
      valid: false,
      error: 'Título da tarefa inválido.',
    };
  }

  if (
    typeof priority !== 'string' ||
    !ALLOWED_TASK_PRIORITIES.has(priority)
  ) {
    return {
      valid: false,
      error: 'Prioridade da tarefa inválida.',
    };
  }

  if (
    typeof date !== 'string' ||
    !Number.isFinite(Date.parse(date))
  ) {
    return {
      valid: false,
      error: 'Data da tarefa inválida.',
    };
  }

  return {
    valid: true,
  };
}

function validateTaskDeletePayload(body) {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      error: 'Payload inválido.',
    };
  }

  const { taskId } = body;

  if (
    typeof taskId !== 'string' ||
    taskId.trim().length === 0 ||
    taskId.length > MAX_TASK_ID_LENGTH ||
    taskId.includes('/')
  ) {
    return {
      valid: false,
      error: 'taskId inválido.',
    };
  }

  return {
    valid: true,
  };
}
function validateHabitCreatePayload(body) {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      error: 'Payload inválido.',
    };
  }

  const { habitId, title, completedDates } = body;

  if (
    typeof habitId !== 'string' ||
    habitId.trim().length === 0 ||
    habitId.length > 128 ||
    habitId.includes('/')
  ) {
    return {
      valid: false,
      error: 'habitId inválido.',
    };
  }

  if (
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.length > MAX_HABIT_TITLE_LENGTH
  ) {
    return {
      valid: false,
      error: 'Título do hábito inválido.',
    };
  }

  if (!Array.isArray(completedDates)) {
    return {
      valid: false,
      error: 'completedDates deve ser uma lista.',
    };
  }

  if (completedDates.length > MAX_HABIT_DATES) {
    return {
      valid: false,
      error: 'Limite de completedDates excedido.',
    };
  }

  if (
    !completedDates.every(
      (date) =>
        typeof date === 'string' &&
        date.length <= MAX_HABIT_DATE_LENGTH,
    )
  ) {
    return {
      valid: false,
      error: 'completedDates contém valores inválidos.',
    };
  }

  return {
    valid: true,
  };
}

function validateHabitDeletePayload(body) {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      error: 'Payload inválido.',
    };
  }

  const { habitId } = body;

  if (
    typeof habitId !== 'string' ||
    habitId.trim().length === 0 ||
    habitId.length > 128 ||
    habitId.includes('/')
  ) {
    return {
      valid: false,
      error: 'habitId inválido.',
    };
  }

  return {
    valid: true,
  };
}
async function createMedicationWithQuota({
  userId,
  medicationId,
  name,
  startDate,
  durationDays,
  endDate,
}) {
  const userRef =
    db.collection('users').doc(userId);

  const medicationRef =
    userRef.collection('medications').doc(medicationId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot =
      await transaction.get(userRef);

    const medicationSnapshot =
      await transaction.get(medicationRef);

    if (!userSnapshot.exists) {
      const error = new Error(
        'Usuário não encontrado.',
      );

      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';

      throw error;
    }

    if (medicationSnapshot.exists) {
      return {
        alreadyExisted: true,
      };
    }

    const userData =
      userSnapshot.data() ?? {};

    const isPremium =
      userData.isPremium === true;

    const medicationsCount =
      userData.medicationsCount;

    if (
      typeof medicationsCount !== 'number' ||
      !Number.isInteger(medicationsCount) ||
      medicationsCount < 0
    ) {
      const error = new Error(
        'Contador de medicamentos ainda não foi migrado.',
      );

      error.statusCode = 412;
      error.code =
        'MEDICATION_QUOTA_MIGRATION_REQUIRED';

      throw error;
    }

    const limit = isPremium
      ? MEDICATIONS_PREMIUM_LIMIT
      : MEDICATIONS_FREE_LIMIT;

    if (medicationsCount >= limit) {
      const error = new Error(
        isPremium
          ? 'Limite Premium de 30 medicamentos atingido.'
          : 'Limite gratuito de 3 medicamentos atingido.',
      );

      error.statusCode = 403;
      error.code =
        'MEDICATION_QUOTA_EXCEEDED';

      throw error;
    }

    transaction.set(
      medicationRef,
      {
        name: name.trim(),
        startDate: new Date(startDate),
        durationDays,
        endDate:
          endDate !== null
            ? new Date(endDate)
            : null,
        createdAt:
          FieldValue.serverTimestamp(),
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      },
    );

    transaction.update(
      userRef,
      {
        medicationsCount:
          medicationsCount + 1,
        updatedAt:
          FieldValue.serverTimestamp(),
      },
    );

    return {
      alreadyExisted: false,
    };
  });
}

async function deleteMedicationWithQuota({
  userId,
  medicationId,
}) {
  const userRef =
    db.collection('users').doc(userId);

  const medicationRef =
    userRef.collection('medications').doc(medicationId);

  const notificationRef =
    userRef
      .collection('notifications')
      .doc(`health_med_${medicationId}`);

  return db.runTransaction(async (transaction) => {
    const userSnapshot =
      await transaction.get(userRef);

    const medicationSnapshot =
      await transaction.get(medicationRef);

    if (!userSnapshot.exists) {
      const error = new Error(
        'Usuário não encontrado.',
      );

      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';

      throw error;
    }

    if (!medicationSnapshot.exists) {
      return {
        alreadyDeleted: true,
      };
    }

    const userData =
      userSnapshot.data() ?? {};

    const medicationsCount =
      userData.medicationsCount;

    if (
      typeof medicationsCount !== 'number' ||
      !Number.isInteger(medicationsCount) ||
      medicationsCount < 0
    ) {
      const error = new Error(
        'Contador de medicamentos ainda não foi migrado.',
      );

      error.statusCode = 412;
      error.code =
        'MEDICATION_QUOTA_MIGRATION_REQUIRED';

      throw error;
    }

    transaction.delete(
      medicationRef,
    );

    transaction.delete(
      notificationRef,
    );

    transaction.update(
      userRef,
      {
        medicationsCount:
          Math.max(
            0,
            medicationsCount - 1,
          ),
        updatedAt:
          FieldValue.serverTimestamp(),
      },
    );

    return {
      alreadyDeleted: false,
    };
  });
}
async function createSubjectWithQuota({
  userId,
  subjectId,
  title,
  hasExam,
  examDate,
}) {
  const userRef =
    db.collection('users').doc(userId);

  const subjectRef =
    userRef.collection('subjects').doc(subjectId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot =
      await transaction.get(userRef);

    const subjectSnapshot =
      await transaction.get(subjectRef);

    if (!userSnapshot.exists) {
      const error = new Error(
        'Usuário não encontrado.',
      );

      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';

      throw error;
    }

    if (subjectSnapshot.exists) {
      return {
        alreadyExisted: true,
      };
    }

    const userData =
      userSnapshot.data() ?? {};

    const isPremium =
      userData.isPremium === true;

    const subjectsCount =
      userData.subjectsCount;

    if (
      typeof subjectsCount !== 'number' ||
      !Number.isInteger(subjectsCount) ||
      subjectsCount < 0
    ) {
      const error = new Error(
        'Contador de matérias ainda não foi migrado.',
      );

      error.statusCode = 412;
      error.code =
        'SUBJECT_QUOTA_MIGRATION_REQUIRED';

      throw error;
    }

    const limit = isPremium
      ? SUBJECTS_PREMIUM_LIMIT
      : SUBJECTS_FREE_LIMIT;

    if (subjectsCount >= limit) {
      const error = new Error(
        isPremium
          ? 'Limite Premium de 30 matérias atingido.'
          : 'Limite gratuito de 3 matérias atingido.',
      );

      error.statusCode = 403;
      error.code = 'SUBJECT_QUOTA_EXCEEDED';

      throw error;
    }

    transaction.set(
      subjectRef,
      {
        title: title.trim(),
        hasExam,
        examDate:
          examDate !== null
            ? new Date(examDate)
            : null,
        cardsToReview: 0,
        streakDays: 0,
        progress: 0,
        createdAt:
          FieldValue.serverTimestamp(),
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      },
    );

    transaction.update(
      userRef,
      {
        subjectsCount: subjectsCount + 1,
        updatedAt:
          FieldValue.serverTimestamp(),
      },
    );

    return {
      alreadyExisted: false,
    };
  });
}

async function deleteSubjectWithQuota({
  userId,
  subjectId,
}) {
  const userRef =
    db.collection('users').doc(userId);

  const subjectRef =
    userRef.collection('subjects').doc(subjectId);

  const studyInfoRef =
    userRef.collection('study_info').doc('main');

  const flashcardsQuery =
    userRef
      .collection('review_queue')
      .where('subjectId', '==', subjectId);

  return db.runTransaction(async (transaction) => {
    // Todas as leituras antes das escritas.
    const userSnapshot =
      await transaction.get(userRef);

    const subjectSnapshot =
      await transaction.get(subjectRef);

    const studyInfoSnapshot =
      await transaction.get(studyInfoRef);

    const flashcardsSnapshot =
      await transaction.get(flashcardsQuery);

    if (!userSnapshot.exists) {
      const error = new Error(
        'Usuário não encontrado.',
      );

      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';

      throw error;
    }

    if (!subjectSnapshot.exists) {
      return {
        alreadyDeleted: true,
      };
    }

    const userData =
      userSnapshot.data() ?? {};

    const subjectsCount =
      userData.subjectsCount;

    if (
      typeof subjectsCount !== 'number' ||
      !Number.isInteger(subjectsCount) ||
      subjectsCount < 0
    ) {
      const error = new Error(
        'Contador de matérias ainda não foi migrado.',
      );

      error.statusCode = 412;
      error.code =
        'SUBJECT_QUOTA_MIGRATION_REQUIRED';

      throw error;
    }

    if (flashcardsSnapshot.size > 450) {
      const error = new Error(
        'A matéria possui flashcards demais para exclusão transacional.',
      );

      error.statusCode = 409;
      error.code =
        'SUBJECT_DELETE_TOO_MANY_FLASHCARDS';

      throw error;
    }

    const studyInfoData =
      studyInfoSnapshot.data() ?? {};

    const rawReviewQueue =
      studyInfoData.reviewQueue;

    const currentReviewQueue =
      typeof rawReviewQueue === 'number' &&
      Number.isInteger(rawReviewQueue) &&
      rawReviewQueue >= 0
        ? rawReviewQueue
        : 0;

    const newReviewQueue =
      Math.max(
        0,
        currentReviewQueue - flashcardsSnapshot.size,
      );

    for (const flashcardDoc of flashcardsSnapshot.docs) {
      transaction.delete(
        flashcardDoc.ref,
      );
    }

    transaction.delete(
      subjectRef,
    );

    transaction.set(
      studyInfoRef,
      {
        reviewQueue: newReviewQueue,
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      },
    );

    transaction.update(
      userRef,
      {
        subjectsCount: Math.max(
          0,
          subjectsCount - 1,
        ),
        updatedAt:
          FieldValue.serverTimestamp(),
      },
    );

    return {
      alreadyDeleted: false,
      deletedFlashcards:
        flashcardsSnapshot.size,
      reviewQueue:
        newReviewQueue,
    };
  });
}
async function createGoalWithQuota({
  userId,
  goalId,
  title,
  period,
  targetValue,
  createdAt,
}) {
  const userRef =
    db.collection('users').doc(userId);

  const goalRef =
    userRef.collection('goals').doc(goalId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot =
      await transaction.get(userRef);

    const goalSnapshot =
      await transaction.get(goalRef);

    if (!userSnapshot.exists) {
      const error = new Error(
        'Usuário não encontrado.',
      );

      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';

      throw error;
    }

    // Retry da mesma criação não incrementa novamente.
    if (goalSnapshot.exists) {
      return {
        alreadyExisted: true,
      };
    }

    const userData =
      userSnapshot.data() ?? {};

    const isPremium =
      userData.isPremium === true;

    const goalsCount =
      userData.goalsCount;

    if (
      typeof goalsCount !== 'number' ||
      !Number.isInteger(goalsCount) ||
      goalsCount < 0
    ) {
      const error = new Error(
        'Contador de metas ainda não foi migrado.',
      );

      error.statusCode = 412;
      error.code =
        'GOAL_QUOTA_MIGRATION_REQUIRED';

      throw error;
    }

    const limit = isPremium
      ? GOALS_PREMIUM_LIMIT
      : GOALS_FREE_LIMIT;

    if (goalsCount >= limit) {
      const error = new Error(
        isPremium
          ? 'Limite Premium de 30 metas atingido.'
          : 'Limite gratuito de 3 metas atingido.',
      );

      error.statusCode = 403;
      error.code = 'GOAL_QUOTA_EXCEEDED';

      throw error;
    }

    const createdDate =
      new Date(createdAt);

    transaction.set(
      goalRef,
      {
        title: title.trim(),
        period,
        currentValue: 0,
        targetValue,
        createdAt: createdDate,
        lastReset: createdDate,
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      },
    );

    transaction.update(
      userRef,
      {
        goalsCount: goalsCount + 1,
        updatedAt:
          FieldValue.serverTimestamp(),
      },
    );

    return {
      alreadyExisted: false,
    };
  });
}

async function deleteGoalWithQuota({
  userId,
  goalId,
}) {
  const userRef =
    db.collection('users').doc(userId);

  const goalRef =
    userRef.collection('goals').doc(goalId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot =
      await transaction.get(userRef);

    const goalSnapshot =
      await transaction.get(goalRef);

    if (!userSnapshot.exists) {
      const error = new Error(
        'Usuário não encontrado.',
      );

      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';

      throw error;
    }

    // Retry da exclusão não decrementa novamente.
    if (!goalSnapshot.exists) {
      return {
        alreadyDeleted: true,
      };
    }

    const userData =
      userSnapshot.data() ?? {};

    const goalsCount =
      userData.goalsCount;

    if (
      typeof goalsCount !== 'number' ||
      !Number.isInteger(goalsCount) ||
      goalsCount < 0
    ) {
      const error = new Error(
        'Contador de metas ainda não foi migrado.',
      );

      error.statusCode = 412;
      error.code =
        'GOAL_QUOTA_MIGRATION_REQUIRED';

      throw error;
    }

    transaction.delete(goalRef);

    transaction.update(
      userRef,
      {
        goalsCount: Math.max(
          0,
          goalsCount - 1,
        ),
        updatedAt:
          FieldValue.serverTimestamp(),
      },
    );

    return {
      alreadyDeleted: false,
    };
  });
}
async function createTaskWithQuota({
  userId,
  taskId,
  title,
  priority,
  date,
}) {
  const userRef = db.collection('users').doc(userId);
  const taskRef = userRef.collection('tasks').doc(taskId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    const taskSnapshot = await transaction.get(taskRef);

    if (!userSnapshot.exists) {
      const error = new Error(
        'Usuário não encontrado.',
      );

      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';

      throw error;
    }

    // Idempotência: retry da mesma criação não aumenta o contador.
    if (taskSnapshot.exists) {
      return {
        alreadyExisted: true,
      };
    }

    const userData = userSnapshot.data() ?? {};

    const isPremium =
      userData.isPremium === true;

    const tasksCount =
      userData.tasksCount;

    if (
      typeof tasksCount !== 'number' ||
      !Number.isInteger(tasksCount) ||
      tasksCount < 0
    ) {
      const error = new Error(
        'Contador de tarefas ainda não foi migrado.',
      );

      error.statusCode = 412;
      error.code =
        'TASK_QUOTA_MIGRATION_REQUIRED';

      throw error;
    }

    if (
      !isPremium &&
      tasksCount >= TASKS_FREE_LIMIT
    ) {
      const error = new Error(
        'Limite gratuito de 3 tarefas atingido.',
      );

      error.statusCode = 403;
      error.code = 'TASK_QUOTA_EXCEEDED';

      throw error;
    }

    transaction.set(
      taskRef,
      {
        title: title.trim(),
        priority,
        isCompleted: false,
        date: new Date(date),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      },
    );

    transaction.update(
      userRef,
      {
        tasksCount: tasksCount + 1,
        updatedAt: FieldValue.serverTimestamp(),
      },
    );

    return {
      alreadyExisted: false,
    };
  });
}

async function deleteTaskWithQuota({
  userId,
  taskId,
}) {
  const userRef = db.collection('users').doc(userId);
  const taskRef = userRef.collection('tasks').doc(taskId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    const taskSnapshot = await transaction.get(taskRef);

    if (!userSnapshot.exists) {
      const error = new Error(
        'Usuário não encontrado.',
      );

      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';

      throw error;
    }

    // Idempotência: retry da exclusão não decrementa duas vezes.
    if (!taskSnapshot.exists) {
      return {
        alreadyDeleted: true,
      };
    }

    const userData = userSnapshot.data() ?? {};
    const tasksCount = userData.tasksCount;

    if (
      typeof tasksCount !== 'number' ||
      !Number.isInteger(tasksCount) ||
      tasksCount < 0
    ) {
      const error = new Error(
        'Contador de tarefas ainda não foi migrado.',
      );

      error.statusCode = 412;
      error.code =
        'TASK_QUOTA_MIGRATION_REQUIRED';

      throw error;
    }

    transaction.delete(taskRef);

    transaction.update(
      userRef,
      {
        tasksCount: Math.max(
          0,
          tasksCount - 1,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      },
    );

    return {
      alreadyDeleted: false,
    };
  });
}
async function createHabitWithQuota({
  userId,
  habitId,
  title,
  completedDates,
}) {
  const userRef = db.collection('users').doc(userId);
  const habitRef = userRef.collection('habits').doc(habitId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    const habitSnapshot = await transaction.get(habitRef);

    if (!userSnapshot.exists) {
      const error = new Error(
        'Usuário não encontrado.',
      );

      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';

      throw error;
    }

    // Idempotência:
    // se a criação já aconteceu e a resposta foi perdida,
    // uma nova tentativa não incrementa o contador novamente.
    if (habitSnapshot.exists) {
      return {
        alreadyExisted: true,
      };
    }

    const userData = userSnapshot.data() ?? {};

    const isPremium =
      userData.isPremium === true;

    const habitsCount =
      userData.habitsCount;

    if (
      typeof habitsCount !== 'number' ||
      !Number.isInteger(habitsCount) ||
      habitsCount < 0
    ) {
      const error = new Error(
        'Contador de hábitos ainda não foi migrado.',
      );

      error.statusCode = 412;
      error.code =
        'HABIT_QUOTA_MIGRATION_REQUIRED';

      throw error;
    }

    const limit = isPremium
      ? HABITS_PREMIUM_LIMIT
      : HABITS_FREE_LIMIT;

    if (habitsCount >= limit) {
      const error = new Error(
        isPremium
          ? 'Limite Premium de hábitos atingido.'
          : 'Limite gratuito de 3 hábitos atingido.',
      );

      error.statusCode = 403;
      error.code =
        'HABIT_QUOTA_EXCEEDED';

      throw error;
    }

    transaction.set(
      habitRef,
      {
        title: title.trim(),
        completedDates,
      },
      {
        merge: true,
      },
    );

    transaction.update(
      userRef,
      {
        habitsCount: habitsCount + 1,
        updatedAt:
          FieldValue.serverTimestamp(),
      },
    );

    return {
      alreadyExisted: false,
    };
  });
}

async function deleteHabitWithQuota({
  userId,
  habitId,
}) {
  const userRef = db.collection('users').doc(userId);
  const habitRef = userRef.collection('habits').doc(habitId);

  const notificationRef1 = userRef
    .collection('notifications')
    .doc(habitId);

  const notificationRef2 = userRef
    .collection('notifications')
    .doc(`habit_${habitId}`);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    const habitSnapshot =
      await transaction.get(habitRef);

    if (!userSnapshot.exists) {
      const error = new Error(
        'Usuário não encontrado.',
      );

      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';

      throw error;
    }

    // Idempotência:
    // se o hábito já foi removido, não decrementamos novamente.
    if (!habitSnapshot.exists) {
      return {
        alreadyDeleted: true,
      };
    }

    const userData = userSnapshot.data() ?? {};
    const habitsCount =
      userData.habitsCount;

    if (
      typeof habitsCount !== 'number' ||
      !Number.isInteger(habitsCount) ||
      habitsCount < 0
    ) {
      const error = new Error(
        'Contador de hábitos ainda não foi migrado.',
      );

      error.statusCode = 412;
      error.code =
        'HABIT_QUOTA_MIGRATION_REQUIRED';

      throw error;
    }

    transaction.delete(habitRef);
    transaction.delete(notificationRef1);
    transaction.delete(notificationRef2);

    transaction.update(
      userRef,
      {
        habitsCount: Math.max(
          0,
          habitsCount - 1,
        ),
        updatedAt:
          FieldValue.serverTimestamp(),
      },
    );

    return {
      alreadyDeleted: false,
    };
  });
}
// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  applyCors(req, res);

  // --------------------------------------------------------------------------
  // OPTIONS
  // --------------------------------------------------------------------------

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // --------------------------------------------------------------------------
  // METHOD
  // --------------------------------------------------------------------------

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Método não permitido.',
    });
  }

  // --------------------------------------------------------------------------
  // BODY SIZE
  // --------------------------------------------------------------------------

  const contentLength = getContentLength(req);

  if (
    contentLength !== null &&
    contentLength >
      MAX_CONTENT_LENGTH_BYTES
  ) {
    return res.status(413).json({
      error:
        'Payload de sincronização excede o limite permitido.',
    });
  }

  // --------------------------------------------------------------------------
  // AUTH
  // --------------------------------------------------------------------------

  const authHeader =
    req.headers.authorization;

  if (
    typeof authHeader !== 'string' ||
    !authHeader.startsWith('Bearer ')
  ) {
    return res.status(401).json({
      error:
        'Acesso negado. Token não fornecido.',
    });
  }

  const token = authHeader
    .slice('Bearer '.length)
    .trim();

  if (!token) {
    return res.status(401).json({
      error:
        'Acesso negado. Token não fornecido.',
    });
  }

  let decodedToken;

  try {
    decodedToken =
      await getAuth().verifyIdToken(token);
  } catch (error) {
    console.error(
      'Erro ao verificar o token Firebase:',
      error?.message ??
        'unknown_error',
    );

    return res.status(401).json({
      error:
        'Token inválido ou expirado.',
    });
  }

  // --------------------------------------------------------------------------
  // UID É SEMPRE OBTIDO DO TOKEN
  // NUNCA DO PAYLOAD
  // --------------------------------------------------------------------------

  const userId = decodedToken.uid;

  // --------------------------------------------------------------------------
  // RATE LIMIT
  // --------------------------------------------------------------------------

  if (!checkSyncRateLimit(userId)) {
    return res.status(429).json({
      error:
        'Muitas solicitações de sincronização. Tente novamente mais tarde.',
    });
  }

  try {
    // ------------------------------------------------------------------------
    // BODY
    // ------------------------------------------------------------------------

    const rawBody = req.body;

    if (!isPlainObject(rawBody)) {
      return res.status(400).json({
        error:
          'Payload de sincronização inválido.',
      });
    }
    
        // ------------------------------------------------------------------------
    // OPERAÇÕES SERVER-SIDE DE HÁBITOS
    // ------------------------------------------------------------------------

    const operation = rawBody.operation;
    if (operation === 'create_medication') {
  const validation =
    validateMedicationCreatePayload(rawBody);

  if (!validation.valid) {
    return res.status(400).json({
      error: validation.error,
    });
  }

  try {
    await createMedicationWithQuota({
      userId,
      medicationId:
        rawBody.medicationId.trim(),
      name: rawBody.name,
      startDate: rawBody.startDate,
      durationDays: rawBody.durationDays,
      endDate: rawBody.endDate,
    });

    return res.status(200).json({
      success: true,
      operation: 'create_medication',
    });
  } catch (error) {
    console.error(
      'Erro ao criar medicamento server-side:',
      error?.message ?? 'unknown_error',
    );

    return res.status(
      error?.statusCode ?? 500,
    ).json({
      error:
        error?.message ??
        'Não foi possível criar o medicamento.',
      code:
        error?.code ??
        'MEDICATION_CREATE_FAILED',
    });
  }
}

if (operation === 'delete_medication') {
  const validation =
    validateMedicationDeletePayload(rawBody);

  if (!validation.valid) {
    return res.status(400).json({
      error: validation.error,
    });
  }

  try {
    await deleteMedicationWithQuota({
      userId,
      medicationId:
        rawBody.medicationId.trim(),
    });

    return res.status(200).json({
      success: true,
      operation: 'delete_medication',
    });
  } catch (error) {
    console.error(
      'Erro ao excluir medicamento server-side:',
      error?.message ?? 'unknown_error',
    );

    return res.status(
      error?.statusCode ?? 500,
    ).json({
      error:
        error?.message ??
        'Não foi possível excluir o medicamento.',
      code:
        error?.code ??
        'MEDICATION_DELETE_FAILED',
    });
  }
}
    if (operation === 'create_subject') {
  const validation =
    validateSubjectCreatePayload(rawBody);

  if (!validation.valid) {
    return res.status(400).json({
      error: validation.error,
    });
  }

  try {
    await createSubjectWithQuota({
      userId,
      subjectId: rawBody.subjectId.trim(),
      title: rawBody.title,
      hasExam: rawBody.hasExam,
      examDate: rawBody.examDate,
    });

    return res.status(200).json({
      success: true,
      operation: 'create_subject',
    });
  } catch (error) {
    console.error(
      'Erro ao criar matéria server-side:',
      error?.message ?? 'unknown_error',
    );

    return res.status(
      error?.statusCode ?? 500,
    ).json({
      error:
        error?.message ??
        'Não foi possível criar a matéria.',
      code:
        error?.code ??
        'SUBJECT_CREATE_FAILED',
    });
  }
}

if (operation === 'delete_subject') {
  const validation =
    validateSubjectDeletePayload(rawBody);

  if (!validation.valid) {
    return res.status(400).json({
      error: validation.error,
    });
  }

  try {
    await deleteSubjectWithQuota({
  userId,
  subjectId: rawBody.subjectId.trim(),
});

    return res.status(200).json({
      success: true,
      operation: 'delete_subject',
    });
  } catch (error) {
    console.error(
      'Erro ao excluir matéria server-side:',
      error?.message ?? 'unknown_error',
    );

    return res.status(
      error?.statusCode ?? 500,
    ).json({
      error:
        error?.message ??
        'Não foi possível excluir a matéria.',
      code:
        error?.code ??
        'SUBJECT_DELETE_FAILED',
    });
  }
}
    if (operation === 'create_goal') {
  const validation =
    validateGoalCreatePayload(rawBody);

  if (!validation.valid) {
    return res.status(400).json({
      error: validation.error,
    });
  }

  try {
    await createGoalWithQuota({
      userId,
      goalId: rawBody.goalId.trim(),
      title: rawBody.title,
      period: rawBody.period,
      targetValue: rawBody.targetValue,
      createdAt: rawBody.createdAt,
    });

    return res.status(200).json({
      success: true,
      operation: 'create_goal',
    });
  } catch (error) {
    console.error(
      'Erro ao criar meta server-side:',
      error?.message ?? 'unknown_error',
    );

    return res.status(
      error?.statusCode ?? 500,
    ).json({
      error:
        error?.message ??
        'Não foi possível criar a meta.',
      code:
        error?.code ??
        'GOAL_CREATE_FAILED',
    });
  }
}

if (operation === 'delete_goal') {
  const validation =
    validateGoalDeletePayload(rawBody);

  if (!validation.valid) {
    return res.status(400).json({
      error: validation.error,
    });
  }

  try {
    await deleteGoalWithQuota({
      userId,
      goalId: rawBody.goalId.trim(),
    });

    return res.status(200).json({
      success: true,
      operation: 'delete_goal',
    });
  } catch (error) {
    console.error(
      'Erro ao excluir meta server-side:',
      error?.message ?? 'unknown_error',
    );

    return res.status(
      error?.statusCode ?? 500,
    ).json({
      error:
        error?.message ??
        'Não foi possível excluir a meta.',
      code:
        error?.code ??
        'GOAL_DELETE_FAILED',
    });
  }
}
if (operation === 'create_task') {
  const validation =
    validateTaskCreatePayload(rawBody);

  if (!validation.valid) {
    return res.status(400).json({
      error: validation.error,
    });
  }

  try {
    await createTaskWithQuota({
      userId,
      taskId: rawBody.taskId.trim(),
      title: rawBody.title,
      priority: rawBody.priority,
      date: rawBody.date,
    });

    return res.status(200).json({
      success: true,
      operation: 'create_task',
    });
  } catch (error) {
    console.error(
      'Erro ao criar tarefa server-side:',
      error?.message ?? 'unknown_error',
    );

    return res.status(
      error?.statusCode ?? 500,
    ).json({
      error:
        error?.message ??
        'Não foi possível criar a tarefa.',
      code:
        error?.code ??
        'TASK_CREATE_FAILED',
    });
  }
}

if (operation === 'delete_task') {
  const validation =
    validateTaskDeletePayload(rawBody);

  if (!validation.valid) {
    return res.status(400).json({
      error: validation.error,
    });
  }

  try {
    await deleteTaskWithQuota({
      userId,
      taskId: rawBody.taskId.trim(),
    });

    return res.status(200).json({
      success: true,
      operation: 'delete_task',
    });
  } catch (error) {
    console.error(
      'Erro ao excluir tarefa server-side:',
      error?.message ?? 'unknown_error',
    );

    return res.status(
      error?.statusCode ?? 500,
    ).json({
      error:
        error?.message ??
        'Não foi possível excluir a tarefa.',
      code:
        error?.code ??
        'TASK_DELETE_FAILED',
    });
  }
}
    if (operation === 'create_habit') {
      const validation =
        validateHabitCreatePayload(rawBody);

      if (!validation.valid) {
        return res.status(400).json({
          error: validation.error,
        });
      }

      try {
        await createHabitWithQuota({
          userId,
          habitId: rawBody.habitId.trim(),
          title: rawBody.title,
          completedDates: rawBody.completedDates,
        });

        return res.status(200).json({
          success: true,
          operation: 'create_habit',
        });
      } catch (error) {
        console.error(
          'Erro ao criar hábito server-side:',
          error?.message ??
            'unknown_error',
        );

        return res.status(
          error?.statusCode ?? 500,
        ).json({
          error:
            error?.message ??
            'Não foi possível criar o hábito.',
          code:
            error?.code ??
            'HABIT_CREATE_FAILED',
        });
      }
    }

    if (operation === 'delete_habit') {
      const validation =
        validateHabitDeletePayload(rawBody);

      if (!validation.valid) {
        return res.status(400).json({
          error: validation.error,
        });
      }

      try {
        await deleteHabitWithQuota({
          userId,
          habitId: rawBody.habitId.trim(),
        });

        return res.status(200).json({
          success: true,
          operation: 'delete_habit',
        });
      } catch (error) {
        console.error(
          'Erro ao excluir hábito server-side:',
          error?.message ??
            'unknown_error',
        );

        return res.status(
          error?.statusCode ?? 500,
        ).json({
          error:
            error?.message ??
            'Não foi possível excluir o hábito.',
          code:
            error?.code ??
            'HABIT_DELETE_FAILED',
        });
      }
    }
    // ------------------------------------------------------------------------
    // TOP LEVEL ALLOWLIST
    // ------------------------------------------------------------------------

    const topLevelKeys =
      Object.keys(rawBody);

    if (
      topLevelKeys.length >
      MAX_TOP_LEVEL_KEYS
    ) {
      return res.status(400).json({
        error:
          'Payload de sincronização contém campos não permitidos.',
      });
    }

    if (
      !topLevelKeys.every((key) =>
        ALLOWED_TOP_LEVEL_KEYS.has(key),
      )
    ) {
      return res.status(400).json({
        error:
          'Payload de sincronização contém campos não permitidos.',
      });
    }

    // ------------------------------------------------------------------------
    // PAYLOAD
    // ------------------------------------------------------------------------

    const {
      timestamp,
      tasks,
      habits,
      finances,
    } = rawBody;

    // ------------------------------------------------------------------------
    // TIMESTAMP
    // ------------------------------------------------------------------------

    if (!validateTimestamp(timestamp)) {
      return res.status(400).json({
        error:
          'Timestamp de sincronização inválido.',
      });
    }

    // ------------------------------------------------------------------------
    // TASKS
    // ------------------------------------------------------------------------

    if (
      tasks !== undefined &&
      !validateEntityStructure(
        tasks,
        validateTask,
        MAX_BATCH_ITEMS.tasks,
      )
    ) {
      return res.status(400).json({
        error:
          'Formato de dados inválido ou limite excedido para a coleção de tarefas.',
      });
    }

    // ------------------------------------------------------------------------
    // HABITS
    // ------------------------------------------------------------------------

    if (
      habits !== undefined &&
      !validateEntityStructure(
        habits,
        validateHabit,
        MAX_BATCH_ITEMS.habits,
      )
    ) {
      return res.status(400).json({
        error:
          'Formato de dados inválido ou limite excedido para a coleção de hábitos.',
      });
    }

    // ------------------------------------------------------------------------
    // FINANCES
    // ------------------------------------------------------------------------

    if (
      finances !== undefined &&
      !validateEntityStructure(
        finances,
        validateFinance,
        MAX_BATCH_ITEMS.finances,
      )
    ) {
      return res.status(400).json({
        error:
          'Formato de dados inválido ou limite excedido para a coleção de finanças.',
      });
    }

    // ------------------------------------------------------------------------
    // FIRESTORE
    // ------------------------------------------------------------------------

    // IMPORTANTE:
    // O documento é determinado exclusivamente pelo UID autenticado.
    //
    // O cliente NÃO pode escolher:
    //
    // users/outra-pessoa
    //
    // porque não existe userId no payload usado para construir a referência.

    const userRef =
      db.collection('users').doc(userId);

    const serverIsoString =
      new Date().toISOString();

    const payloadToSave = {
      lastSync:
        timestamp ||
        serverIsoString,

      updatedAt:
        serverIsoString,
    };

    if (tasks !== undefined) {
      payloadToSave.tasks = tasks;
    }

    if (habits !== undefined) {
      payloadToSave.habits = habits;
    }

    if (finances !== undefined) {
      payloadToSave.finances = finances;
    }

    // Preserva o comportamento existente.
    await userRef.set(
      payloadToSave,
      {
        merge: true,
      },
    );

    // ------------------------------------------------------------------------
    // SUCCESS
    // ------------------------------------------------------------------------

    return res.status(200).json({
      success: true,
      message:
        'Sincronização concluída e salva no Firestore com sucesso.',
      serverTimestamp:
        serverIsoString,
    });
  } catch (error) {
    console.error(
      'Erro crítico no processo de sincronização:',
      error?.message ??
        'unknown_error',
    );

    return res.status(500).json({
      error:
        'Não foi possível concluir a sincronização no momento.',
    });
  }
}