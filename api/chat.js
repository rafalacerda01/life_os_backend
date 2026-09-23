import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { checkDistributedRateLimit } from './_distributed_rate_limit.js';
import { hasValidGooglePlayPremium } from './billing/google/_entitlement.js';
import {
  AI_CONSENT_VERSION_V2,
  CHAT_V2_GENERATION_CONFIG,
  ChatV2ValidationError,
  buildChatV2SystemInstruction,
  parseChatV2Insight,
  validateChatV2Request,
} from '../src/ai/chat_v2.js';

// ============================================================================
// LIFE OS - AI CHAT ENDPOINT
// ============================================================================

let db;

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

db = getFirestore();

// ============================================================================
// LIMITES
// ============================================================================

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 15;

const MAX_CONTENT_LENGTH_BYTES = 64 * 1024;
const MAX_CONTEXT_JSON_LENGTH = 15_000;

const MAX_CONTEXT_DEPTH = 6;
const MAX_CONTEXT_KEYS = 80;
const MAX_CONTEXT_ARRAY_ITEMS = 100;
const MAX_CONTEXT_STRING_LENGTH = 2_000;
const GEMINI_REQUEST_TIMEOUT_MS = 12_000;

// ============================================================================
// CORS
// ============================================================================

const ALLOWED_ORIGINS = new Set([
  'https://painel.life-os.com',
  'https://app.life-os.com',
  'http://localhost:3000',
]);

function applyCors(req, res) {
  const origin = req.headers.origin;

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
async function hasAiConsent(
  userId,
  { firestore = db } = {},
) {
  const consentSnapshot = await firestore
    .collection('users')
    .doc(userId)
    .collection('privacy')
    .doc('ai_consent')
    .get();

  if (!consentSnapshot.exists) {
    return false;
  }

  const data = consentSnapshot.data();

  if (data?.accepted !== true) return false;
  return data.consentVersion === AI_CONSENT_VERSION_V2;
}

export async function hasPremiumAccess(
  userId,
  { firestore = db, nowMillis = Date.now() } = {},
) {
  const userSnapshot = await firestore
    .collection('users')
    .doc(userId)
    .get();

  if (!userSnapshot.exists) {
    return false;
  }

  const data = userSnapshot.data();

  return hasValidGooglePlayPremium(data, nowMillis);
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

// ============================================================================
// SANITIZAÇÃO DO CONTEXTO
//
// IMPORTANTE:
// Isto NÃO transforma o contexto em dado confiável.
// Apenas impede estruturas abusivas/deep objects/valores inesperados.
// ============================================================================

function sanitizeUntrustedContext(value, depth = 0) {
  if (depth > MAX_CONTEXT_DEPTH) {
    throw new Error('Context depth exceeded.');
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'string') {
    if (value.length > MAX_CONTEXT_STRING_LENGTH) {
      throw new Error('Context string exceeded.');
    }

    return value;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Invalid numeric value in context.');
    }

    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_CONTEXT_ARRAY_ITEMS) {
      throw new Error('Context array exceeded.');
    }

    return value.map((item) =>
      sanitizeUntrustedContext(item, depth + 1),
    );
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);

    if (keys.length > MAX_CONTEXT_KEYS) {
      throw new Error('Context object exceeded.');
    }

    const result = {};

    for (const key of keys) {
      if (
        typeof key !== 'string' ||
        key.length === 0 ||
        key.length > 100
      ) {
        throw new Error('Invalid context key.');
      }

      result[key] = sanitizeUntrustedContext(
        value[key],
        depth + 1,
      );
    }

    return result;
  }

  throw new Error('Unsupported value in context.');
}

// ============================================================================
// HANDLER
// ============================================================================

export async function chatHandler(req, res, runtime = {}) {
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
    contentLength > MAX_CONTENT_LENGTH_BYTES
  ) {
    return res.status(413).json({
      error: 'Payload excede o limite permitido.',
    });
  }

  // --------------------------------------------------------------------------
  // APP CHECK
  // --------------------------------------------------------------------------

  const rawAppCheckToken = req.headers['x-firebase-appcheck'];

  if (
    typeof rawAppCheckToken !== 'string' ||
    rawAppCheckToken.trim().length === 0
  ) {
    return res.status(401).json({
      code: 'APP_CHECK_REQUIRED',
      error: 'Verificação de segurança do aplicativo necessária.',
    });
  }

  const appCheckToken = rawAppCheckToken.trim();
  const verifyAppCheckToken =
    runtime.verifyAppCheckToken ??
    ((token) => getAppCheck().verifyToken(token));

  try {
    await verifyAppCheckToken(appCheckToken);
  } catch (_) {
    console.error('[chat] Falha na verificação do App Check.');

    return res.status(401).json({
      code: 'APP_CHECK_INVALID',
      error: 'Verificação de segurança do aplicativo inválida.',
    });
  }

  // --------------------------------------------------------------------------
  // AUTHORIZATION
  // --------------------------------------------------------------------------

  const authHeader = req.headers.authorization;

  if (
    typeof authHeader !== 'string' ||
    !authHeader.startsWith('Bearer ')
  ) {
    return res.status(401).json({
      error: 'Acesso negado. Token de segurança ausente.',
    });
  }

  const idToken = authHeader
    .slice('Bearer '.length)
    .trim();

  if (!idToken) {
    return res.status(401).json({
      error: 'Acesso negado. Token de segurança ausente.',
    });
  }

  let decodedToken;
  const verifyIdToken =
    runtime.verifyIdToken ??
    ((token, checkRevoked) =>
      getAuth().verifyIdToken(token, checkRevoked));

  try {
    decodedToken = await verifyIdToken(idToken, true);
  } catch (_) {
    console.error('[chat] Falha ao verificar Firebase Auth.');

    return res.status(401).json({
      error: 'Token inválido ou expirado.',
    });
  }

  const userId = decodedToken.uid;
  const rawBody = req.body;
  if (!isPlainObject(rawBody) || rawBody.version !== 2) {
    return res.status(400).json({
      code: 'AI_REQUEST_INVALID',
      error: 'Solicitação V2 inválida.',
    });
  }

// --------------------------------------------------------------------------
// CONSENTIMENTO
// --------------------------------------------------------------------------

let consentGranted;

try {
  consentGranted = await (runtime.hasAiConsent ?? hasAiConsent)(userId, {
    requiredVersion: AI_CONSENT_VERSION_V2,
  });
} catch (_) {
  console.error('[chat] Falha ao verificar consentimento da IA.');

  return res.status(500).json({
    error: 'Não foi possível verificar a autorização para uso da IA.',
  });
}

if (!consentGranted) {
  return res.status(451).json({
    error: 'Consentimento necessário para utilizar o Companion IA.',
  });
}

// --------------------------------------------------------------------------
// PREMIUM
//
// O status Premium NÃO é confiado ao cliente.
// O UID vem exclusivamente do Firebase ID Token validado pelo backend.
// --------------------------------------------------------------------------

let premiumGranted;

try {
  premiumGranted = await (runtime.hasPremiumAccess ?? hasPremiumAccess)(
    userId,
  );
} catch (_) {
  console.error('[chat] Falha ao verificar status Premium.');

  return res.status(500).json({
    error: 'Não foi possível verificar a autorização Premium.',
  });
}

if (!premiumGranted) {
  return res.status(402).json({
    error: 'Plano PRO necessário para utilizar o Companion IA.',
  });
}

// --------------------------------------------------------------------------
// RATE LIMIT
// --------------------------------------------------------------------------

let rateLimitAllowed;
const checkRateLimit =
  runtime.checkRateLimit ??
  ((parameters) => checkDistributedRateLimit({ db, ...parameters }));

try {
  rateLimitAllowed = await checkRateLimit({
    scope: 'chat',
    uid: userId,
    limit: MAX_REQUESTS_PER_WINDOW,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
} catch (_) {
  console.error('[chat] Falha ao verificar rate limit.');

  return res.status(503).json({
    error: 'Não foi possível verificar o limite de solicitações.',
  });
}

if (!rateLimitAllowed) {
  return res.status(429).json({
    error:
      'Muitas solicitações. Tente novamente em alguns instantes.',
  });
}

  // --------------------------------------------------------------------------
  // BODY
  // --------------------------------------------------------------------------

  let v2Request;
  let modelContext;

  try {
    const safeV2Context = sanitizeUntrustedContext(rawBody.context);
    if (JSON.stringify(safeV2Context).length > MAX_CONTEXT_JSON_LENGTH) {
      throw new ChatV2ValidationError();
    }
    v2Request = validateChatV2Request({
      ...rawBody,
      context: safeV2Context,
    });
    modelContext = v2Request.context;
  } catch (error) {
    const code = error instanceof ChatV2ValidationError
      ? error.code
      : 'AI_REQUEST_INVALID';
    return res.status(400).json({
      code,
      error: 'Solicitação V2 inválida.',
    });
  }

  // --------------------------------------------------------------------------
  // GEMINI KEY
  // --------------------------------------------------------------------------

  const apiKey = runtime.geminiApiKey ?? process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error('GEMINI_API_KEY não configurada.');

    return res.status(500).json({
      error: 'Configuração de serviço indisponível.',
    });
  }

  try {
    // ------------------------------------------------------------------------
    // SYSTEM INSTRUCTION
    //
    // Agora fica separado da entrada do usuário.
    // ------------------------------------------------------------------------

    const systemInstruction = buildChatV2SystemInstruction(v2Request.intent);

    // ------------------------------------------------------------------------
    // USER DATA
    //
    // O UID permanece exclusivamente no servidor.
    // Somente o contexto minimizado chega ao modelo.
    // ------------------------------------------------------------------------

    const untrustedUserPayload = JSON.stringify({
      intent: v2Request.intent,
      context: modelContext,
    });

    // ------------------------------------------------------------------------
    // GEMINI REQUEST
    // ------------------------------------------------------------------------

    const fetchRequest = runtime.fetch ?? fetch;
    const configuredTimeoutMs = runtime.geminiTimeoutMs;
    const timeoutMs =
      Number.isInteger(configuredTimeoutMs) && configuredTimeoutMs > 0
        ? configuredTimeoutMs
        : GEMINI_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);

    let response;
    let data;
    try {
      response = await fetchRequest(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },

          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: systemInstruction,
                },
              ],
            },

            contents: [
              {
                role: 'user',

                parts: [
                  {
                    text:
                      '[DADOS NÃO CONFIÁVEIS DO USUÁRIO]\n' +
                      untrustedUserPayload,
                  },
                ],
              },
            ],
            generationConfig: CHAT_V2_GENERATION_CONFIG,
          }),
          signal: controller.signal,
        },
      );
      data = await response.json();
    } catch (error) {
      if (didTimeout) {
        console.error('[chat] Timeout na chamada à API do Google.');
        return res.status(504).json({
          error: 'O serviço de IA demorou para responder.',
        });
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    const reply =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (
      response.ok &&
      typeof reply === 'string' &&
      reply.length > 0
    ) {
      try {
        return res.status(200).json({
          version: 2,
          intent: v2Request.intent,
          insight: parseChatV2Insight(reply),
        });
      } catch (_) {
        console.error('[chat] Resposta V2 inválida da API do Google.');
        return res.status(502).json({
          error: 'Não foi possível processar sua solicitação no momento.',
        });
      }
    }

    // Nunca devolve o erro bruto da API ao cliente.
    const googleErrorCode = Number.isInteger(data?.error?.code)
      ? data.error.code
      : undefined;
    console.error('[chat] Erro estruturado da API do Google.', {
      status: response.status,
      code: googleErrorCode,
    });

    return res.status(502).json({
      error:
        'Não foi possível processar sua solicitação no momento.',
    });
  } catch (_) {
    console.error('[chat] Falha interna no endpoint de IA.');

    return res.status(500).json({
      error: 'Não foi possível processar sua solicitação.',
    });
  }
}

export default chatHandler;
