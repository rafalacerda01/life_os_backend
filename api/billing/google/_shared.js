import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

import { checkDistributedRateLimit } from '../../_distributed_rate_limit.js';

export const MAX_BILLING_BODY_BYTES = 8 * 1024;
export const MAX_PURCHASE_TOKEN_LENGTH = 4 * 1024;
export const BILLING_RATE_LIMIT_PER_MINUTE = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const ALLOWED_ORIGINS = new Set([
  'https://painel.life-os.com',
  'https://app.life-os.com',
  'http://localhost:3000',
]);

let db;

export class BillingHttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'BillingHttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateBillingPayload(body) {
  if (!isPlainObject(body)) {
    throw new BillingHttpError(
      400,
      'INVALID_BILLING_PAYLOAD',
      'Payload de billing inválido.',
    );
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'purchaseToken') {
    throw new BillingHttpError(
      400,
      'INVALID_BILLING_PAYLOAD',
      'Payload de billing inválido.',
    );
  }
  if (
    typeof body.purchaseToken !== 'string' ||
    body.purchaseToken.trim() !== body.purchaseToken ||
    body.purchaseToken.length === 0 ||
    body.purchaseToken.length > MAX_PURCHASE_TOKEN_LENGTH
  ) {
    throw new BillingHttpError(
      400,
      'INVALID_PURCHASE_TOKEN',
      'Purchase token inválido.',
    );
  }
  return body.purchaseToken;
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
    'Content-Type, Authorization, X-Firebase-AppCheck',
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
      throw new BillingHttpError(
        400,
        'INVALID_BILLING_PAYLOAD',
        'Payload de billing inválido.',
      );
    }
    if (Number(rawLength) > MAX_BILLING_BODY_BYTES) {
      throw new BillingHttpError(
        413,
        'BILLING_PAYLOAD_TOO_LARGE',
        'Payload de billing excede o limite permitido.',
      );
    }
  }

  let serialized;
  try {
    serialized = JSON.stringify(req.body);
  } catch (_) {
    throw new BillingHttpError(
      400,
      'INVALID_BILLING_PAYLOAD',
      'Payload de billing inválido.',
    );
  }
  if (
    serialized !== undefined &&
    Buffer.byteLength(serialized, 'utf8') > MAX_BILLING_BODY_BYTES
  ) {
    throw new BillingHttpError(
      413,
      'BILLING_PAYLOAD_TOO_LARGE',
      'Payload de billing excede o limite permitido.',
    );
  }
}

export function getFirebaseServices() {
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
  return { auth: getAuth(), appCheck: getAppCheck(), db };
}

function extractBearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new BillingHttpError(
      401,
      'UNAUTHENTICATED',
      'Token Firebase ausente ou inválido.',
    );
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new BillingHttpError(
      401,
      'UNAUTHENTICATED',
      'Token Firebase ausente ou inválido.',
    );
  }
  return token;
}

function validateUid(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value.includes('/')
  ) {
    throw new BillingHttpError(
      401,
      'UNAUTHENTICATED',
      'Token Firebase ausente ou inválido.',
    );
  }
  return value;
}

function sendError(res, error) {
  if (error instanceof BillingHttpError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
  }
  console.error('[billing] BILLING_VERIFICATION_FAILED');
  return res.status(500).json({
    error: 'Não foi possível verificar a assinatura.',
    code: 'BILLING_VERIFICATION_FAILED',
  });
}

export function createBillingHandler(execute, { getServices = getFirebaseServices } = {}) {
  return async function billingHandler(req, res, runtime = {}) {
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
      const purchaseToken = validateBillingPayload(req.body);
      const rawAppCheckToken = req.headers?.['x-firebase-appcheck'];
      if (
        typeof rawAppCheckToken !== 'string' ||
        rawAppCheckToken.trim().length === 0
      ) {
        throw new BillingHttpError(
          401,
          'APP_CHECK_REQUIRED',
          'Verificação de segurança do aplicativo necessária.',
        );
      }

      const services = (runtime.getServices ?? getServices)();
      const verifyAppCheckToken =
        runtime.verifyAppCheckToken ??
        ((token) => services.appCheck.verifyToken(token));
      try {
        await verifyAppCheckToken(rawAppCheckToken.trim());
      } catch (_) {
        console.error('[billing] Falha na verificação do App Check.');
        throw new BillingHttpError(
          401,
          'APP_CHECK_INVALID',
          'Verificação de segurança do aplicativo inválida.',
        );
      }

      const idToken = extractBearerToken(req);
      const verifyIdToken =
        runtime.verifyIdToken ??
        ((token, checkRevoked) => services.auth.verifyIdToken(token, checkRevoked));
      let decodedToken;
      try {
        decodedToken = await verifyIdToken(idToken, true);
      } catch (_) {
        throw new BillingHttpError(
          401,
          'UNAUTHENTICATED',
          'Token Firebase ausente, inválido ou expirado.',
        );
      }
      const uid = validateUid(decodedToken?.uid);
      const nowMillis = (runtime.nowProvider ?? Date.now)();
      if (!Number.isSafeInteger(nowMillis) || nowMillis < 0) {
        throw new Error('Invalid server clock.');
      }

      const checkRateLimit = runtime.checkRateLimit ?? checkDistributedRateLimit;
      let allowed;
      try {
        allowed = await checkRateLimit({
          db: services.db,
          scope: 'billing_google_verify',
          uid,
          limit: BILLING_RATE_LIMIT_PER_MINUTE,
          windowMs: RATE_LIMIT_WINDOW_MS,
          nowMs: nowMillis,
        });
      } catch (_) {
        console.error('[billing] Falha ao verificar rate limit.');
        throw new BillingHttpError(
          503,
          'RATE_LIMIT_UNAVAILABLE',
          'Não foi possível verificar o limite de solicitações.',
        );
      }
      if (!allowed) {
        throw new BillingHttpError(
          429,
          'RATE_LIMITED',
          'Muitas verificações de assinatura. Tente novamente em instantes.',
        );
      }

      const result = await execute({
        db: services.db,
        uid,
        purchaseToken,
        nowMillis,
        runtime,
      });
      return res.status(result.statusCode ?? 200).json(result.body);
    } catch (error) {
      return sendError(res, error);
    }
  };
}
