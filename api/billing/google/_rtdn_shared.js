import { TextDecoder } from 'node:util';
import { OAuth2Client, gaxios } from 'google-auth-library';

import { ANDROID_PACKAGE_NAME } from './_entitlement.js';
import { validPurchaseToken } from './_reconciliation.js';

export const MAX_RTDN_BODY_BYTES = 16 * 1024;
export const MAX_RTDN_DATA_BYTES = 8 * 1024;
export const OIDC_VERIFY_DEADLINE_MS = 5_000;
const oidcClient = new OAuth2Client({ transporterOptions: { timeout: OIDC_VERIFY_DEADLINE_MS } });

export class RtdnHttpError extends Error {
  constructor(statusCode, code = 'RTDN_MESSAGE_INVALID') {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function reject() {
  throw new RtdnHttpError(400);
}

export function assertRtdnBodyLimit(req) {
  const length = req.headers?.['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length))) reject();
  if (length !== undefined && Number(length) > MAX_RTDN_BODY_BYTES) throw new RtdnHttpError(413);
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(req.body) ?? '', 'utf8');
  } catch (_) { reject(); }
  if (bytes > MAX_RTDN_BODY_BYTES) throw new RtdnHttpError(413);
}

export async function authenticateRtdn(req, runtime = {}) {
  const audience = runtime.audience ?? process.env.GOOGLE_PLAY_RTDN_AUDIENCE;
  const email = runtime.serviceAccountEmail ?? process.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL;
  if (typeof audience !== 'string' || !audience || typeof email !== 'string' || !email) {
    throw new RtdnHttpError(503, 'RTDN_NOT_CONFIGURED');
  }
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header) || header.length > MAX_RTDN_BODY_BYTES) {
    throw new RtdnHttpError(401, 'RTDN_UNAUTHENTICATED');
  }
  let payload;
  try {
    const deadlineMs = runtime.oidcVerifyDeadlineMs ?? OIDC_VERIFY_DEADLINE_MS;
    if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
      throw new RtdnHttpError(503, 'RTDN_NOT_CONFIGURED');
    }
    let timeoutId;
    const deadline = new Promise((_, rejectDeadline) => {
      timeoutId = setTimeout(() => rejectDeadline(
        new RtdnHttpError(503, 'RTDN_OIDC_UNAVAILABLE'),
      ), deadlineMs);
    });
    const ticket = await Promise.race([
      (runtime.oidcClient ?? oidcClient).verifyIdToken({
        idToken: header.slice(7), audience,
      }),
      deadline,
    ]).finally(() => clearTimeout(timeoutId));
    payload = ticket.getPayload();
  } catch (error) {
    if (error instanceof RtdnHttpError) throw error;
    // Certificate transport failures in the installed library are Gaxios
    // errors. Signature/claim failures are never classified by private text.
    const url = String(error?.config?.url ?? '');
    const certTransport = error instanceof gaxios.GaxiosError &&
      url === 'https://www.googleapis.com/oauth2/v1/certs';
    const status = error?.response?.status;
    if (certTransport && (status === undefined || status === 429 || status >= 500)) {
      throw new RtdnHttpError(503, 'RTDN_OIDC_UNAVAILABLE');
    }
    throw new RtdnHttpError(401, 'RTDN_UNAUTHENTICATED');
  }
  if (!payload || payload.aud !== audience || payload.email !== email ||
      payload.email_verified !== true ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) {
    throw new RtdnHttpError(403, 'RTDN_UNAUTHENTICATED');
  }
}

export function decodeRtdnEnvelope(body, subscriptionName) {
  if (!object(body) || !object(body.message) || typeof body.subscription !== 'string' ||
      !body.subscription || (subscriptionName !== undefined && body.subscription !== subscriptionName)) reject();
  const { data, messageId } = body.message;
  if (messageId !== undefined && (typeof messageId !== 'string' || !messageId || messageId.length > 256)) reject();
  if (typeof data !== 'string' || !data || data.length > Math.ceil(MAX_RTDN_DATA_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) reject();
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > MAX_RTDN_DATA_BYTES || buffer.toString('base64') !== data) reject();
  let notification;
  try {
    notification = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch (_) { reject(); }
  if (!object(notification)) reject();
  const present = Object.keys(notification).filter((key) => key.endsWith('Notification'));
  if (present.length > 1) reject();
  if (present.length === 0) return { kind: 'drop' };
  const kind = present[0];
  if (!object(notification[kind])) reject();
  if (kind === 'testNotification') return { kind: 'test' };
  if (kind !== 'subscriptionNotification') return { kind: 'drop' };
  if (notification.version !== '1.0' || notification.subscriptionNotification.version !== '1.0' ||
      notification.packageName !== ANDROID_PACKAGE_NAME ||
      !Number.isSafeInteger(notification.subscriptionNotification.notificationType) ||
      !validPurchaseToken(notification.subscriptionNotification.purchaseToken)) reject();
  return { kind: 'subscription', purchaseToken: notification.subscriptionNotification.purchaseToken };
}
