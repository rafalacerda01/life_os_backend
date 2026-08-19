import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export const MAX_ACCOUNT_BODY_BYTES = 64;
export const ACCOUNT_AUTH_RECENCY_WINDOW_MS = 5 * 60 * 1000;
export const ACCOUNT_RATE_LIMIT_PER_MINUTE = 5;
export const MAX_TRACKED_RATE_KEYS = 10_000;
export const MAX_CIRCLE_CHALLENGES_TO_SCAN = 240;
export const MAX_PROCESSED_EVENTS_PER_CHALLENGE = 20_000;
export const PROCESSED_EVENT_DELETE_PAGE_SIZE = 200;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const ALLOWED_ORIGINS = new Set([
  'https://painel.life-os.com',
  'https://app.life-os.com',
  'http://localhost:3000',
]);
const requestTracker = new Map();

let db;

export class AccountHttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'AccountHttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function invalidPayload(message = 'Payload de conta invalido.') {
  return new AccountHttpError(400, 'INVALID_ACCOUNT_PAYLOAD', message);
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

export function validateDeletePayload(body) {
  if (!hasExactKeys(body, [])) {
    throw invalidPayload();
  }

  return {};
}

export function normalizeSafeDocumentId(value) {
  if (typeof value !== 'string') return null;

  if (
    value.length === 0 ||
    value.length > 128 ||
    value.includes('/') ||
    value.trim() !== value
  ) {
    return null;
  }

  return value;
}

export function validateSafeDocumentId(value, fieldName) {
  const normalized = normalizeSafeDocumentId(value);
  if (normalized === null) {
    throw new AccountHttpError(
      409,
      'ACCOUNT_STATE_CONFLICT',
      `${fieldName} invalido.`,
    );
  }

  return normalized;
}

export function isValidAuthTime(authTimeMillis, nowMillis) {
  return (
    Number.isFinite(authTimeMillis) &&
    Number.isFinite(nowMillis) &&
    nowMillis >= authTimeMillis &&
    nowMillis - authTimeMillis <= ACCOUNT_AUTH_RECENCY_WINDOW_MS
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
      throw invalidPayload('Content-Length invalido.');
    }
    if (Number(rawLength) > MAX_ACCOUNT_BODY_BYTES) {
      throw new AccountHttpError(
        413,
        'INVALID_ACCOUNT_PAYLOAD',
        'Payload de conta excede o limite permitido.',
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
    Buffer.byteLength(serialized, 'utf8') > MAX_ACCOUNT_BODY_BYTES
  ) {
    throw new AccountHttpError(
      413,
      'INVALID_ACCOUNT_PAYLOAD',
      'Payload de conta excede o limite permitido.',
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
    throw new AccountHttpError(
      401,
      'UNAUTHENTICATED',
      'Token Firebase ausente ou invalido.',
    );
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new AccountHttpError(
      401,
      'UNAUTHENTICATED',
      'Token Firebase ausente ou invalido.',
    );
  }

  return token;
}

function checkRateLimit(uid, operation, nowMillis = Date.now()) {
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
  if (current.count >= ACCOUNT_RATE_LIMIT_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

function sendError(res, error, fallbackCode) {
  if (error instanceof AccountHttpError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
  }

  console.error(`[account] ${fallbackCode}`, error?.code ?? 'unknown_error');
  return res.status(500).json({
    error: 'Nao foi possivel excluir a conta.',
    code: fallbackCode,
  });
}

export function createAccountHandler(
  operation,
  fallbackCode,
  execute,
  { nowProvider = () => Date.now(), getServices = getFirebaseServices } = {},
) {
  return async function accountHandler(req, res, runtime = {}) {
    const resolvedNowProvider = runtime.nowProvider ?? nowProvider;
    const resolvedGetServices = runtime.getServices ?? getServices;

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
      validateDeletePayload(req.body);
      const token = extractBearerToken(req);
      const { auth, db: firestore } = resolvedGetServices();
      const nowMillis = resolvedNowProvider();

      let decodedToken;
      try {
        decodedToken = await auth.verifyIdToken(token, true);
      } catch (_) {
        throw new AccountHttpError(
          401,
          'UNAUTHENTICATED',
          'Token Firebase ausente, invalido ou expirado.',
        );
      }

      let uid;
      try {
        uid = validateSafeDocumentId(decodedToken.uid, 'uid');
      } catch (_) {
        throw new AccountHttpError(
          401,
          'UNAUTHENTICATED',
          'Token Firebase ausente, invalido ou expirado.',
        );
      }
      if (!checkRateLimit(uid, operation, nowMillis)) {
        throw new AccountHttpError(
          429,
          'RATE_LIMITED',
          'Muitas solicitacoes de conta. Tente novamente em instantes.',
        );
      }

      const authTimeMillis =
        typeof decodedToken.auth_time === 'number'
          ? decodedToken.auth_time * 1000
          : Number.NaN;
      if (!isValidAuthTime(authTimeMillis, nowMillis)) {
        throw new AccountHttpError(
          401,
          'REAUTHENTICATION_REQUIRED',
          'Autenticacao recente obrigatoria.',
        );
      }

      const result = await execute({
        body: req.body,
        db: firestore,
        auth,
        decodedToken,
        uid,
        nowMillis,
      });
      return res.status(result.statusCode ?? 200).json(result.body);
    } catch (error) {
      return sendError(res, error, fallbackCode);
    }
  };
}
