import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

export const MAX_ACTIVITY_BODY_BYTES = 4 * 1024;

const MAX_DOCUMENT_ID_LENGTH = 128;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_RATE_KEYS = 10_000;
const RATE_LIMITS = Object.freeze({
  taskComplete: 30,
  habitComplete: 30,
});
const ALLOWED_ORIGINS = new Set([
  'https://painel.life-os.com',
  'https://app.life-os.com',
  'http://localhost:3000',
]);
const requestTracker = new Map();

let db;

export class ActivityHttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ActivityHttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function getNowTimestamp() {
  return Timestamp.now();
}

export function timestampToIso(timestamp) {
  return timestamp.toDate().toISOString();
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;

  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function invalidPayload(message = 'Payload de atividade invalido.') {
  return new ActivityHttpError(400, 'INVALID_ACTIVITY_PAYLOAD', message);
}

function validateDocumentId(value, fieldName) {
  if (typeof value !== 'string') {
    throw invalidPayload(`${fieldName} invalido.`);
  }

  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_DOCUMENT_ID_LENGTH ||
    normalized.includes('/')
  ) {
    throw invalidPayload(`${fieldName} invalido.`);
  }

  return normalized;
}

export function validateTaskPayload(body) {
  if (!hasExactKeys(body, ['taskId'])) throw invalidPayload();
  return { taskId: validateDocumentId(body.taskId, 'taskId') };
}

export function validateHabitPayload(body) {
  if (!hasExactKeys(body, ['habitId'])) throw invalidPayload();
  return { habitId: validateDocumentId(body.habitId, 'habitId') };
}

function applyCors(req, res) {
  const origin = req.headers?.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
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

function assertBodyWithinLimit(req) {
  const rawLength = req.headers?.['content-length'];
  if (rawLength !== undefined) {
    if (
      Array.isArray(rawLength) ||
      typeof rawLength !== 'string' ||
      !/^\d+$/.test(rawLength)
    ) {
      throw invalidPayload('Content-Length invalido.');
    }
    if (Number(rawLength) > MAX_ACTIVITY_BODY_BYTES) {
      throw new ActivityHttpError(
        413,
        'INVALID_ACTIVITY_PAYLOAD',
        'Payload de atividade excede o limite permitido.',
      );
    }
  }

  let serialized;
  try {
    serialized = JSON.stringify(req.body);
  } catch (_) {
    throw invalidPayload();
  }
  if (
    serialized !== undefined &&
    Buffer.byteLength(serialized, 'utf8') > MAX_ACTIVITY_BODY_BYTES
  ) {
    throw new ActivityHttpError(
      413,
      'INVALID_ACTIVITY_PAYLOAD',
      'Payload de atividade excede o limite permitido.',
    );
  }
}

function getFirebaseServices() {
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error('Firebase Admin environment is not configured.');
    }
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }

  db ??= getFirestore();
  return { auth: getAuth(), db };
}

function extractBearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new ActivityHttpError(
      401,
      'UNAUTHENTICATED',
      'Token Firebase ausente ou invalido.',
    );
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new ActivityHttpError(
      401,
      'UNAUTHENTICATED',
      'Token Firebase ausente ou invalido.',
    );
  }
  return token;
}

function checkRateLimit(uid, operation, nowMillis = Date.now()) {
  const limit = RATE_LIMITS[operation];
  const key = `${uid}:${operation}`;
  if (requestTracker.size >= MAX_TRACKED_RATE_KEYS) {
    for (const [trackedKey, entry] of requestTracker) {
      if (nowMillis - entry.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
        requestTracker.delete(trackedKey);
      }
    }
  }

  const current = requestTracker.get(key);
  if (!current || nowMillis - current.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    if (!current && requestTracker.size >= MAX_TRACKED_RATE_KEYS) return false;
    requestTracker.set(key, { count: 1, windowStartedAt: nowMillis });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function sendError(res, error, fallbackCode) {
  if (error instanceof ActivityHttpError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
  }

  console.error(`[activity] ${fallbackCode}`);
  return res.status(500).json({
    error: 'Nao foi possivel registrar a atividade.',
    code: fallbackCode,
  });
}

export function createActivityHandler(operation, fallbackCode, execute) {
  return async function activityHandler(req, res, runtime = {}) {
    applyCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      return res.status(405).json({
        error: 'Metodo nao permitido.',
        code: 'METHOD_NOT_ALLOWED',
      });
    }

    try {
      assertBodyWithinLimit(req);
      const token = extractBearerToken(req);
      const { auth, db: firestore } = (
        runtime.getServices ?? getFirebaseServices
      )();
      let decodedToken;
      try {
        decodedToken = await auth.verifyIdToken(token, true);
      } catch (_) {
        throw new ActivityHttpError(
          401,
          'UNAUTHENTICATED',
          'Token Firebase ausente, invalido ou expirado.',
        );
      }

      if (!checkRateLimit(decodedToken.uid, operation)) {
        throw new ActivityHttpError(
          429,
          'RATE_LIMITED',
          'Muitas solicitacoes de atividade. Tente novamente em instantes.',
        );
      }

      const result = await execute({
        body: req.body,
        db: firestore,
        uid: decodedToken.uid,
      });
      return res.status(result.statusCode ?? 200).json(result.body);
    } catch (error) {
      return sendError(res, error, fallbackCode);
    }
  };
}
