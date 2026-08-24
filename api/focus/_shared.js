import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

export const ALLOWED_DURATIONS_SECONDS = Object.freeze([
  60,
  180,
  600,
  1500,
  2700,
]);

export const FOCUS_STATUS = Object.freeze({
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
});

export const FOCUS_SCHEMA_VERSION = 1;
export const FOCUS_EXPIRY_GRACE_SECONDS = 600;
export const MAX_FOCUS_BODY_BYTES = 4 * 1024;

const MAX_DOCUMENT_ID_LENGTH = 128;
const ALLOWED_TARGET_TYPES = new Set(['TASK', 'SUBJECT']);
const ALLOWED_DURATIONS = new Set(ALLOWED_DURATIONS_SECONDS);
const TARGET_COLLECTIONS = Object.freeze({
  TASK: 'tasks',
  SUBJECT: 'subjects',
});

// Advisory only: state integrity is enforced by Firestore transactions, not
// by this per-instance serverless rate limiter.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMITS = Object.freeze({
  start: 20,
  finish: 30,
  cancel: 30,
});
const MAX_TRACKED_RATE_KEYS = 10_000;
const requestTracker = new Map();

const ALLOWED_ORIGINS = new Set([
  'https://painel.life-os.com',
  'https://app.life-os.com',
  'http://localhost:3000',
]);

let db;

export class FocusHttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'FocusHttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function getNowTimestamp() {
  return Timestamp.now();
}

export function calculateExpiresAtMillis(startedAtMillis, durationSeconds) {
  return (
    startedAtMillis +
    (durationSeconds + FOCUS_EXPIRY_GRACE_SECONDS) * 1000
  );
}

export function calculateExpiresAt(startedAt, durationSeconds) {
  return Timestamp.fromMillis(
    calculateExpiresAtMillis(startedAt.toMillis(), durationSeconds),
  );
}

export function timestampToIso(timestamp) {
  return timestamp.toDate().toISOString();
}

function invalidPayload(message = 'Payload Focus inválido.') {
  return new FocusHttpError(400, 'INVALID_FOCUS_PAYLOAD', message);
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function validateDocumentId(value, fieldName) {
  if (typeof value !== 'string') {
    throw invalidPayload(`${fieldName} inválido.`);
  }

  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_DOCUMENT_ID_LENGTH ||
    normalized.includes('/')
  ) {
    throw invalidPayload(`${fieldName} inválido.`);
  }

  return normalized;
}

export function validateTargetId(value) {
  return validateDocumentId(value, 'targetId');
}

export function validateSessionId(value) {
  return validateDocumentId(value, 'sessionId');
}

export function validateTargetType(value) {
  if (typeof value !== 'string' || !ALLOWED_TARGET_TYPES.has(value)) {
    throw invalidPayload('targetType inválido.');
  }

  return value;
}

export function validateDuration(value) {
  if (!Number.isInteger(value) || !ALLOWED_DURATIONS.has(value)) {
    throw invalidPayload('plannedDurationSeconds inválido.');
  }

  return value;
}

export function validateStartPayload(body) {
  if (
    !hasExactKeys(body, [
      'targetId',
      'targetType',
      'plannedDurationSeconds',
    ])
  ) {
    throw invalidPayload();
  }

  return {
    targetId: validateTargetId(body.targetId),
    targetType: validateTargetType(body.targetType),
    plannedDurationSeconds: validateDuration(body.plannedDurationSeconds),
  };
}

export function validateSessionPayload(body) {
  if (!hasExactKeys(body, ['sessionId'])) {
    throw invalidPayload();
  }

  return { sessionId: validateSessionId(body.sessionId) };
}

function isTimestamp(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.toMillis === 'function' &&
    Number.isFinite(value.toMillis())
  );
}

function isValidPointer(pointer) {
  try {
    return (
      pointer?.schemaVersion === FOCUS_SCHEMA_VERSION &&
      validateSessionId(pointer.sessionId) === pointer.sessionId &&
      validateTargetId(pointer.targetId) === pointer.targetId &&
      validateTargetType(pointer.targetType) === pointer.targetType &&
      validateDuration(pointer.plannedDurationSeconds) ===
        pointer.plannedDurationSeconds &&
      isTimestamp(pointer.startedAt) &&
      isTimestamp(pointer.expiresAt) &&
      pointer.expiresAt.toMillis() ===
        calculateExpiresAtMillis(
          pointer.startedAt.toMillis(),
          pointer.plannedDurationSeconds,
        )
    );
  } catch (_) {
    return false;
  }
}

export function decideStartAction({ pointer, request, nowMillis }) {
  if (pointer === null || pointer === undefined) {
    return 'CREATE';
  }
  if (!isValidPointer(pointer) || !Number.isFinite(nowMillis)) {
    return 'STATE_CONFLICT';
  }
  if (nowMillis > pointer.expiresAt.toMillis()) {
    return 'REPLACE_EXPIRED';
  }

  const sameRequest =
    pointer.targetId === request.targetId &&
    pointer.targetType === request.targetType &&
    pointer.plannedDurationSeconds === request.plannedDurationSeconds;
  return sameRequest ? 'REUSE' : 'ACTIVE_CONFLICT';
}

export function startActionRequiresTarget(action) {
  return action === 'CREATE' || action === 'REPLACE_EXPIRED';
}

export function decideFinishAction({
  status,
  startedAtMillis,
  expiresAtMillis,
  plannedDurationSeconds,
  nowMillis,
}) {
  if (status === FOCUS_STATUS.COMPLETED) return 'REPLAY';
  if (status === FOCUS_STATUS.CANCELLED) return 'CANCELLED';
  if (status === FOCUS_STATUS.EXPIRED) return 'EXPIRED';
  if (
    status !== FOCUS_STATUS.RUNNING ||
    !Number.isFinite(startedAtMillis) ||
    !Number.isFinite(expiresAtMillis) ||
    !Number.isFinite(nowMillis) ||
    !ALLOWED_DURATIONS.has(plannedDurationSeconds)
  ) {
    return 'STATE_CONFLICT';
  }

  const readyAtMillis = startedAtMillis + plannedDurationSeconds * 1000;
  if (nowMillis < readyAtMillis) return 'NOT_READY';
  if (nowMillis > expiresAtMillis) return 'MARK_EXPIRED';
  return 'COMPLETE';
}

export function decideCancelAction({
  status,
  nowMillis,
  expiresAtMillis,
}) {
  if (status === FOCUS_STATUS.CANCELLED) return 'REPLAY';
  if (status === FOCUS_STATUS.EXPIRED) return 'EXPIRED';
  if (status === FOCUS_STATUS.COMPLETED) return 'COMPLETED';
  if (
    status !== FOCUS_STATUS.RUNNING ||
    !Number.isFinite(nowMillis) ||
    !Number.isFinite(expiresAtMillis)
  ) {
    return 'STATE_CONFLICT';
  }
  return nowMillis > expiresAtMillis ? 'MARK_EXPIRED' : 'CANCEL';
}

export function assertStoredSessionIntegrity(data, uid, sessionId) {
  let valid = false;
  try {
    valid =
      isPlainObject(data) &&
      data.schemaVersion === FOCUS_SCHEMA_VERSION &&
      data.uid === uid &&
      data.sessionId === sessionId &&
      validateSessionId(data.sessionId) === data.sessionId &&
      validateTargetId(data.targetId) === data.targetId &&
      validateTargetType(data.targetType) === data.targetType &&
      validateDuration(data.plannedDurationSeconds) ===
        data.plannedDurationSeconds &&
      Object.values(FOCUS_STATUS).includes(data.status) &&
      isTimestamp(data.startedAt) &&
      isTimestamp(data.expiresAt) &&
      data.expiresAt.toMillis() ===
        calculateExpiresAtMillis(
          data.startedAt.toMillis(),
          data.plannedDurationSeconds,
        );
  } catch (_) {
    valid = false;
  }

  if (!valid) throw stateConflict();
}

export function assertPointerMatchesSession(pointer, session) {
  if (
    !isValidPointer(pointer) ||
    pointer.sessionId !== session.sessionId ||
    pointer.targetId !== session.targetId ||
    pointer.targetType !== session.targetType ||
    pointer.plannedDurationSeconds !== session.plannedDurationSeconds ||
    pointer.startedAt.toMillis() !== session.startedAt.toMillis() ||
    pointer.expiresAt.toMillis() !== session.expiresAt.toMillis()
  ) {
    throw stateConflict();
  }
}

export function assertCompletedSessionIntegrity(session) {
  if (
    session.status !== FOCUS_STATUS.COMPLETED ||
    session.verifiedDurationSeconds !== session.plannedDurationSeconds ||
    !isTimestamp(session.completedAt)
  ) {
    throw stateConflict();
  }
}

export function assertCancelledSessionIntegrity(session) {
  if (
    session.status !== FOCUS_STATUS.CANCELLED ||
    !isTimestamp(session.cancelledAt)
  ) {
    throw stateConflict();
  }
}

export function targetCollectionFor(targetType) {
  return TARGET_COLLECTIONS[targetType];
}

export function stateConflict() {
  return new FocusHttpError(
    409,
    'FOCUS_SESSION_STATE_CONFLICT',
    'O estado da sessão Focus está inconsistente.',
  );
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
      throw invalidPayload('Content-Length inválido.');
    }
    if (Number(rawLength) > MAX_FOCUS_BODY_BYTES) {
      throw new FocusHttpError(
        413,
        'INVALID_FOCUS_PAYLOAD',
        'Payload Focus excede o limite permitido.',
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
    Buffer.byteLength(serialized, 'utf8') > MAX_FOCUS_BODY_BYTES
  ) {
    throw new FocusHttpError(
      413,
      'INVALID_FOCUS_PAYLOAD',
      'Payload Focus excede o limite permitido.',
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
    throw new FocusHttpError(
      401,
      'UNAUTHENTICATED',
      'Token Firebase ausente ou inválido.',
    );
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new FocusHttpError(
      401,
      'UNAUTHENTICATED',
      'Token Firebase ausente ou inválido.',
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
  if (error instanceof FocusHttpError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
  }

  console.error(`[focus] ${fallbackCode}`);
  return res.status(500).json({
    error: 'Não foi possível processar a sessão Focus.',
    code: fallbackCode,
  });
}

export function createFocusHandler(operation, fallbackCode, execute) {
  return async function focusHandler(req, res, runtime = {}) {
    applyCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      return res.status(405).json({
        error: 'Método não permitido.',
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
        throw new FocusHttpError(
          401,
          'UNAUTHENTICATED',
          'Token Firebase ausente, inválido ou expirado.',
        );
      }

      if (!checkRateLimit(decodedToken.uid, operation)) {
        throw new FocusHttpError(
          429,
          'RATE_LIMITED',
          'Muitas solicitações Focus. Tente novamente em instantes.',
        );
      }
      const result = await execute({ body: req.body, db: firestore, uid: decodedToken.uid });
      return res.status(result.statusCode ?? 200).json(result.body);
    } catch (error) {
      return sendError(res, error, fallbackCode);
    }
  };
}
