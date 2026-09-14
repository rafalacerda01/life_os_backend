import { GoogleAuth } from 'google-auth-library';

import {
  ANDROID_PACKAGE_NAME,
  GOOGLE_PLAY_PRODUCT_ID,
} from './_entitlement.js';

const ANDROID_PUBLISHER_SCOPE =
  'https://www.googleapis.com/auth/androidpublisher';
const ANDROID_PUBLISHER_BASE_URL =
  'https://androidpublisher.googleapis.com/androidpublisher/v3';
export const GOOGLE_PLAY_REQUEST_TIMEOUT_MS = 10_000;

export class GooglePlayRequestError extends Error {
  constructor(operation) {
    super(`GOOGLE_PLAY_${operation}_FAILED`);
    this.name = 'GooglePlayRequestError';
    this.operation = operation;
  }
}

function getGoogleCredentials() {
  const clientEmail = process.env.GOOGLE_PLAY_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PLAY_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    throw new GooglePlayRequestError('AUTH');
  }
  return { client_email: clientEmail, private_key: privateKey };
}

async function getAuthorizationHeader(url, googleAuthFactory) {
  try {
    const auth = googleAuthFactory({
      credentials: getGoogleCredentials(),
      scopes: [ANDROID_PUBLISHER_SCOPE],
    });
    const client = await auth.getClient();
    const headers = await client.getRequestHeaders(url);
    const authorization =
      typeof headers?.get === 'function'
        ? headers.get('authorization')
        : headers?.authorization ?? headers?.Authorization;
    if (typeof authorization !== 'string' || authorization.length === 0) {
      throw new Error('Missing authorization header.');
    }
    return authorization;
  } catch (_) {
    throw new GooglePlayRequestError('AUTH');
  }
}

function defaultGoogleAuthFactory(options) {
  return new GoogleAuth(options);
}

async function runWithDeadline(operation, timeoutMs, execute) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new GooglePlayRequestError(operation);
  }

  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new GooglePlayRequestError(operation));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      execute(controller.signal),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getGooglePlaySubscription(
  purchaseToken,
  {
    fetchImpl = fetch,
    googleAuthFactory = defaultGoogleAuthFactory,
    timeoutMs = GOOGLE_PLAY_REQUEST_TIMEOUT_MS,
  } = {},
) {
  const url =
    `${ANDROID_PUBLISHER_BASE_URL}/applications/` +
    `${ANDROID_PACKAGE_NAME}/purchases/subscriptionsv2/tokens/` +
    encodeURIComponent(purchaseToken);
  return runWithDeadline('GET', timeoutMs, async (signal) => {
    const authorization = await getAuthorizationHeader(url, googleAuthFactory);
    if (signal.aborted) throw new GooglePlayRequestError('GET');

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization },
        signal,
      });
      if (!response.ok) throw new GooglePlayRequestError('GET');
      const payload = await response.json();
      if (
        payload === null ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      ) {
        throw new GooglePlayRequestError('GET');
      }
      return payload;
    } catch (error) {
      if (error instanceof GooglePlayRequestError) throw error;
      throw new GooglePlayRequestError('GET');
    }
  });
}

export async function acknowledgeGooglePlaySubscription(
  purchaseToken,
  {
    fetchImpl = fetch,
    googleAuthFactory = defaultGoogleAuthFactory,
    timeoutMs = GOOGLE_PLAY_REQUEST_TIMEOUT_MS,
  } = {},
) {
  const url =
    `${ANDROID_PUBLISHER_BASE_URL}/applications/` +
    `${ANDROID_PACKAGE_NAME}/purchases/subscriptions/` +
    `${GOOGLE_PLAY_PRODUCT_ID}/tokens/${encodeURIComponent(purchaseToken)}` +
    ':acknowledge';
  return runWithDeadline('ACKNOWLEDGE', timeoutMs, async (signal) => {
    const authorization = await getAuthorizationHeader(url, googleAuthFactory);
    if (signal.aborted) throw new GooglePlayRequestError('ACKNOWLEDGE');

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body: '{}',
        signal,
      });
      if (!response.ok) throw new GooglePlayRequestError('ACKNOWLEDGE');
    } catch (error) {
      if (error instanceof GooglePlayRequestError) throw error;
      throw new GooglePlayRequestError('ACKNOWLEDGE');
    }
  });
}
