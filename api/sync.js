import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

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