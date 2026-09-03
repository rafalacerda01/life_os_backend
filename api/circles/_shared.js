import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { checkDistributedRateLimit } from '../_distributed_rate_limit.js';

export const MAX_CIRCLE_DELETE_BODY_BYTES = 256;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;
const ALLOWED_ORIGINS = new Set([
  'https://painel.life-os.com',
  'https://app.life-os.com',
  'http://localhost:3000',
]);

let db;

export class CircleHttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'CircleHttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
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

export function normalizeCircleId(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    value.includes('/')
  ) {
    return null;
  }
  return value;
}

export function validateCircleDeletePayload(body) {
  if (!hasExactKeys(body, ['circleId'])) {
    throw new CircleHttpError(
      400,
      'INVALID_CIRCLE_DELETE_PAYLOAD',
      'Payload de exclusao do Circle invalido.',
    );
  }
  const circleId = normalizeCircleId(body.circleId);
  if (circleId === null) {
    throw new CircleHttpError(
      400,
      'INVALID_CIRCLE_DELETE_PAYLOAD',
      'circleId invalido.',
    );
  }
  return { circleId };
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

function assertJsonRequest(req) {
  const contentType = req.headers?.['content-type'];
  if (
    typeof contentType !== 'string' ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  ) {
    throw new CircleHttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type application/json obrigatorio.',
    );
  }

  const rawLength = req.headers?.['content-length'];
  if (rawLength !== undefined) {
    if (
      Array.isArray(rawLength) ||
      typeof rawLength !== 'string' ||
      !/^\d+$/.test(rawLength)
    ) {
      throw new CircleHttpError(
        400,
        'INVALID_CIRCLE_DELETE_PAYLOAD',
        'Content-Length invalido.',
      );
    }
    if (Number(rawLength) > MAX_CIRCLE_DELETE_BODY_BYTES) {
      throw new CircleHttpError(
        413,
        'INVALID_CIRCLE_DELETE_PAYLOAD',
        'Payload de exclusao excede o limite permitido.',
      );
    }
  }

  let serialized;
  try {
    serialized = JSON.stringify(req.body);
  } catch (_) {
    serialized = undefined;
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') > MAX_CIRCLE_DELETE_BODY_BYTES
  ) {
    throw new CircleHttpError(
      413,
      'INVALID_CIRCLE_DELETE_PAYLOAD',
      'Payload de exclusao excede o limite permitido.',
    );
  }
}

function extractBearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new CircleHttpError(
      401,
      'UNAUTHENTICATED',
      'Token Firebase ausente ou invalido.',
    );
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new CircleHttpError(
      401,
      'UNAUTHENTICATED',
      'Token Firebase ausente ou invalido.',
    );
  }
  return token;
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
  return { auth: getAuth(), appCheck: getAppCheck(), db };
}

function sendError(res, error) {
  if (error instanceof CircleHttpError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
  }
  console.error('[circles] Falha sanitizada na exclusao server-side.');
  return res.status(500).json({
    error: 'Nao foi possivel excluir o Circle.',
    code: 'CIRCLE_DELETE_FAILED',
  });
}

export function createCircleDeleteHandler(
  execute,
  { getServices = getFirebaseServices, nowProvider = () => Date.now() } = {},
) {
  return async function circleDeleteHandler(req, res, runtime = {}) {
    applyCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      return res.status(405).json({
        error: 'Metodo nao permitido.',
        code: 'METHOD_NOT_ALLOWED',
      });
    }

    try {
      assertJsonRequest(req);
      const body = validateCircleDeletePayload(req.body);
      const rawAppCheckToken = req.headers?.['x-firebase-appcheck'];
      if (
        typeof rawAppCheckToken !== 'string' ||
        rawAppCheckToken.trim().length === 0
      ) {
        throw new CircleHttpError(
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
        console.error('[circles] Falha na verificação do App Check.');
        throw new CircleHttpError(
          401,
          'APP_CHECK_INVALID',
          'Verificação de segurança do aplicativo inválida.',
        );
      }

      const token = extractBearerToken(req);
      let decodedToken;
      try {
        decodedToken = await services.auth.verifyIdToken(token, true);
      } catch (_) {
        throw new CircleHttpError(
          401,
          'UNAUTHENTICATED',
          'Token Firebase ausente, invalido ou expirado.',
        );
      }
      const uid = normalizeCircleId(decodedToken.uid);
      if (uid === null) {
        throw new CircleHttpError(
          401,
          'UNAUTHENTICATED',
          'Token Firebase ausente, invalido ou expirado.',
        );
      }
      const nowMillis = (runtime.nowProvider ?? nowProvider)();
      const checkRateLimit = runtime.checkRateLimit ?? checkDistributedRateLimit;
      let rateLimitAllowed;
      try {
        rateLimitAllowed = await checkRateLimit({
          db: services.db,
          scope: 'circle_delete',
          uid,
          limit: MAX_REQUESTS_PER_WINDOW,
          windowMs: RATE_LIMIT_WINDOW_MS,
          nowMs: nowMillis,
        });
      } catch (_) {
        console.error('[circles] Falha ao verificar rate limit.');
        throw new CircleHttpError(
          503,
          'RATE_LIMIT_UNAVAILABLE',
          'Não foi possível verificar o limite de solicitações.',
        );
      }
      if (!rateLimitAllowed) {
        throw new CircleHttpError(
          429,
          'RATE_LIMITED',
          'Muitas solicitacoes. Tente novamente em instantes.',
        );
      }

      const result = await execute({
        body,
        db: services.db,
        uid,
        nowMillis,
      });
      return res.status(result.statusCode ?? 200).json(result.body);
    } catch (error) {
      return sendError(res, error);
    }
  };
}
