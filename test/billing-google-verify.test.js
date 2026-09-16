import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { getApps, initializeApp } from 'firebase-admin/app';
import { Timestamp } from 'firebase-admin/firestore';

import {
  ANDROID_PACKAGE_NAME,
  GOOGLE_PLAY_PRODUCT_ID,
  hasValidGooglePlayPremium,
  parseGooglePlaySubscription,
} from '../api/billing/google/_entitlement.js';
import {
  GOOGLE_PLAY_REQUEST_TIMEOUT_MS,
  GooglePlayRequestError,
  acknowledgeGooglePlaySubscription,
  getGooglePlaySubscription,
} from '../api/billing/google/_google_play.js';
import {
  MAX_BILLING_BODY_BYTES,
  MAX_PURCHASE_TOKEN_LENGTH,
  createBillingHandler,
  validateBillingPayload,
} from '../api/billing/google/_shared.js';
import {
  verifyGooglePlayPurchase,
  default as verifyHandler,
} from '../api/billing/google/verify.js';

if (!getApps().length) initializeApp({ projectId: 'billing-google-test' });
const { hasPremiumAccess } = await import('../api/chat.js');

const UID = 'user-a';
const TOKEN = 'purchase-token-secret';
const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const FUTURE = '2026-10-13T12:00:00.000Z';
const PAST = '2026-09-12T12:00:00.000Z';
const APP_CHECK_TOKEN = 'app-check-token-secret';

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

class FakeSnapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.exists = value !== undefined;
    this.value = value;
  }

  data() {
    return this.value;
  }
}

class FakeDocumentReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  collection(name) {
    return new FakeCollectionReference(this.db, `${this.path}/${name}`);
  }

  get() {
    return Promise.resolve(new FakeSnapshot(this, this.db.store.get(this.path)));
  }

  async update(data) {
    this.db.documentUpdateCalls.push({ path: this.path, data });
    if (this.db.failDocumentUpdate) {
      throw new Error('private-firestore-update-error');
    }
    if (!this.db.store.has(this.path)) throw new Error('missing update target');
    this.db.store.set(this.path, {
      ...this.db.store.get(this.path),
      ...data,
    });
  }
}

class FakeCollectionReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  doc(id) {
    return new FakeDocumentReference(this.db, `${this.path}/${id}`);
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
    this.writes = [];
  }

  get(ref) {
    return Promise.resolve(new FakeSnapshot(ref, this.db.store.get(ref.path)));
  }

  set(ref, data) {
    this.writes.push({ type: 'set', path: ref.path, data });
  }

  update(ref, data) {
    if (this.db.failDocumentUpdate && Object.hasOwn(data, 'acknowledgementState')) {
      throw new Error('private-firestore-update-error');
    }
    this.writes.push({ type: 'update', path: ref.path, data });
  }

  commit() {
    const next = new Map(this.db.store);
    for (const write of this.writes) {
      if (write.type === 'update') {
        if (!next.has(write.path)) throw new Error('missing update target');
        next.set(write.path, { ...next.get(write.path), ...write.data });
      } else {
        next.set(write.path, { ...write.data });
      }
    }
    this.db.store = next;
    this.db.committedWrites.push(...this.writes);
  }
}

class FakeFirestore {
  constructor() {
    this.store = new Map();
    this.transactions = 0;
    this.committedWrites = [];
    this.documentUpdateCalls = [];
    this.failDocumentUpdate = false;
  }

  collection(name) {
    return new FakeCollectionReference(this, name);
  }

  seed(path, value) {
    this.store.set(path, value);
  }

  data(path) {
    return this.store.get(path);
  }

  async runTransaction(callback) {
    this.transactions += 1;
    const transaction = new FakeTransaction(this);
    const result = await callback(transaction);
    transaction.commit();
    return result;
  }
}

function googlePayload({
  state = 'SUBSCRIPTION_STATE_ACTIVE',
  expiryTime = FUTURE,
  productId = GOOGLE_PLAY_PRODUCT_ID,
  basePlanId = 'monthly',
  accountId = hash(UID),
  acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  lineItems,
} = {}) {
  return {
    subscriptionState: state,
    acknowledgementState,
    externalAccountIdentifiers: accountId === undefined
      ? undefined
      : { obfuscatedExternalAccountId: accountId },
    lineItems: lineItems ?? [
      {
        productId,
        expiryTime,
        offerDetails: { basePlanId },
      },
    ],
  };
}

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function request(body = { purchaseToken: TOKEN }, headers = {}) {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer firebase-id-token',
      'x-firebase-appcheck': APP_CHECK_TOKEN,
      ...headers,
    },
    body,
  };
}

function fixture({ seedUser = true, payload = googlePayload() } = {}) {
  const db = new FakeFirestore();
  if (seedUser) db.seed(`users/${UID}`, { displayName: 'Test' });
  const calls = {
    appCheck: [],
    auth: [],
    rateLimit: [],
    google: [],
    acknowledge: [],
  };
  const runtime = {
    getServices: () => ({ db, auth: {}, appCheck: {} }),
    verifyAppCheckToken: async (token) => {
      calls.appCheck.push(token);
      return { appId: 'test-app' };
    },
    verifyIdToken: async (token, checkRevoked) => {
      calls.auth.push({ token, checkRevoked });
      return { uid: UID };
    },
    checkRateLimit: async (parameters) => {
      calls.rateLimit.push(parameters);
      return true;
    },
    getGooglePlaySubscription: async (purchaseToken) => {
      calls.google.push(purchaseToken);
      return payload;
    },
    acknowledgeSubscription: undefined,
    acknowledgeGooglePlaySubscription: async (purchaseToken) => {
      calls.acknowledge.push({
        purchaseToken,
        persisted: db.data(`users/${UID}`)?.isPremium === true,
      });
    },
    nowProvider: () => NOW,
    serverTimestamp: () => Timestamp.fromMillis(NOW),
    timestampFromDate: (date) => Timestamp.fromDate(date),
  };
  return { db, calls, runtime };
}

async function invoke(req = request(), options = {}) {
  const { db, calls, runtime } = fixture(options);
  Object.assign(runtime, options.runtime);
  const res = responseStub();
  await verifyHandler(req, res, runtime);
  return { db, calls, runtime, res };
}

function assertNoEntitlementWrites(db) {
  assert.ok(db.committedWrites.every((write) =>
    write.path === `users/${UID}/billing/google_play` &&
    Object.keys(write.data).length === 1 &&
    Number.isSafeInteger(write.data.reconciliationRevision)));
  assert.deepEqual(db.data(`users/${UID}`), { displayName: 'Test' });
}

test('OPTIONS succeeds and advertises the App Check header', async () => {
  const { res } = await invoke({ method: 'OPTIONS', headers: {}, body: undefined });
  assert.equal(res.statusCode, 204);
  assert.match(res.headers['Access-Control-Allow-Headers'], /X-Firebase-AppCheck/);
});

test('method other than POST is rejected', async () => {
  const { res } = await invoke({ method: 'GET', headers: {}, body: undefined });
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.code, 'METHOD_NOT_ALLOWED');
});

test('missing App Check fails before Auth and Google', async () => {
  const req = request();
  delete req.headers['x-firebase-appcheck'];
  const { res, calls } = await invoke(req);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'APP_CHECK_REQUIRED');
  assert.equal(calls.auth.length, 0);
  assert.equal(calls.google.length, 0);
});

test('invalid App Check is sanitized and fails before Auth', async () => {
  const { res, calls } = await invoke(request(), {
    runtime: {
      verifyAppCheckToken: async () => {
        throw new Error('private-app-check-error');
      },
    },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'APP_CHECK_INVALID');
  assert.doesNotMatch(JSON.stringify(res.body), /private-app-check-error/);
  assert.equal(calls.auth.length, 0);
});

test('missing Firebase token fails before Google', async () => {
  const req = request();
  delete req.headers.authorization;
  const { res, calls } = await invoke(req);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
  assert.equal(calls.google.length, 0);
});

test('invalid or revoked Firebase token is sanitized and checks revocation', async () => {
  let checkRevoked;
  const { res } = await invoke(request(), {
    runtime: {
      verifyIdToken: async (_, value) => {
        checkRevoked = value;
        throw new Error('private-auth-error');
      },
    },
  });
  assert.equal(checkRevoked, true);
  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(JSON.stringify(res.body), /private-auth-error/);
});

test('distributed rate limit receives verified UID and billing scope', async () => {
  const { res, calls } = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(calls.rateLimit.length, 1);
  assert.equal(calls.rateLimit[0].scope, 'billing_google_verify');
  assert.equal(calls.rateLimit[0].uid, UID);
});

test('denied rate limit returns 429 without Google call', async () => {
  const { res, calls } = await invoke(request(), {
    runtime: { checkRateLimit: async () => false },
  });
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'RATE_LIMITED');
  assert.equal(calls.google.length, 0);
});

test('rate limiter failure fails closed with sanitized 503', async () => {
  const { res, calls } = await invoke(request(), {
    runtime: {
      checkRateLimit: async () => {
        throw new Error('private-rate-limit-error');
      },
    },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'RATE_LIMIT_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(res.body), /private-rate-limit-error/);
  assert.equal(calls.google.length, 0);
});

for (const [name, body] of [
  ['null', null],
  ['array', []],
  ['empty object', {}],
  ['extra field', { purchaseToken: TOKEN, tier: 'annual' }],
]) {
  test(`invalid payload ${name} is rejected`, async () => {
    const { res, calls } = await invoke(request(body));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_BILLING_PAYLOAD');
    assert.equal(calls.google.length, 0);
  });
}

for (const [name, purchaseToken] of [
  ['missing', undefined],
  ['null', null],
  ['number', 12],
  ['empty', ''],
  ['whitespace', '   '],
  ['surrounding whitespace', ' token '],
  ['too large', 'a'.repeat(MAX_PURCHASE_TOKEN_LENGTH + 1)],
]) {
  test(`purchaseToken ${name} is rejected`, async () => {
    const body = purchaseToken === undefined ? {} : { purchaseToken };
    const { res, calls } = await invoke(request(body));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.google.length, 0);
  });
}

test('oversized Content-Length is rejected before services', async () => {
  const { res, calls } = await invoke(request(
    { purchaseToken: TOKEN },
    { 'content-length': String(MAX_BILLING_BODY_BYTES + 1) },
  ));
  assert.equal(res.statusCode, 413);
  assert.equal(calls.appCheck.length, 0);
});

test('Google API failure is sanitized without purchase token', async () => {
  const { res } = await invoke(request(), {
    runtime: {
      getGooglePlaySubscription: async () => {
        throw new Error(`private-google-error-${TOKEN}`);
      },
    },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'GOOGLE_PLAY_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(TOKEN));
});

test('wrong product is rejected without entitlement writes', async () => {
  const { res, db } = await invoke(request(), {
    payload: googlePayload({ productId: 'other_product' }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'BILLING_PRODUCT_INVALID');
  assertNoEntitlementWrites(db);
});

test('unknown base plan is rejected without entitlement writes', async () => {
  const { res, db } = await invoke(request(), {
    payload: googlePayload({ basePlanId: 'weekly' }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'BILLING_BASE_PLAN_INVALID');
  assertNoEntitlementWrites(db);
});

test('missing obfuscated account ID returns account mismatch', async () => {
  const payload = googlePayload();
  delete payload.externalAccountIdentifiers;
  const { res, db } = await invoke(request(), {
    payload,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'BILLING_ACCOUNT_MISMATCH');
  assertNoEntitlementWrites(db);
});

test('Google parser preserves absent and valid external account identifiers', () => {
  const absent = googlePayload();
  delete absent.externalAccountIdentifiers;
  assert.equal(parseGooglePlaySubscription(absent, NOW).obfuscatedAccountId, null);

  const missingProperty = googlePayload();
  missingProperty.externalAccountIdentifiers = {};
  assert.equal(parseGooglePlaySubscription(missingProperty, NOW).obfuscatedAccountId, null);
  assert.equal(
    parseGooglePlaySubscription(googlePayload(), NOW).obfuscatedAccountId,
    hash(UID),
  );
});

for (const [name, accountId] of [
  ['number', 123],
  ['boolean', true],
  ['object', { private: 'value' }],
  ['array', ['value']],
  ['null', null],
  ['empty string', ''],
]) {
  test(`malformed ${name} external account ID fails closed`, async () => {
    const invalid = googlePayload();
    invalid.externalAccountIdentifiers.obfuscatedExternalAccountId = accountId;
    const { res, db } = await invoke(request(), { payload: invalid });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'BILLING_GOOGLE_RESPONSE_INVALID');
    assertNoEntitlementWrites(db);
  });
}

test('another user obfuscated account ID returns account mismatch', async () => {
  const { res, db } = await invoke(request(), {
    payload: googlePayload({ accountId: hash('user-b') }),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'BILLING_ACCOUNT_MISMATCH');
  assertNoEntitlementWrites(db);
});

for (const state of [
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  'SUBSCRIPTION_STATE_CANCELED',
]) {
  test(`${state} with future expiry grants Premium`, async () => {
    const { res } = await invoke(request(), {
      payload: googlePayload({ state }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isPremium, true);
    assert.equal(res.body.subscriptionState, state);
    assert.equal(res.body.expiresAt, FUTURE);
  });
}

for (const state of [
  'SUBSCRIPTION_STATE_PENDING',
  'SUBSCRIPTION_STATE_ON_HOLD',
  'SUBSCRIPTION_STATE_PAUSED',
  'SUBSCRIPTION_STATE_EXPIRED',
  'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED',
  'SUBSCRIPTION_STATE_UNSPECIFIED',
  'SUBSCRIPTION_STATE_FUTURE_UNKNOWN',
]) {
  test(`${state} remains Free`, async () => {
    const { res } = await invoke(request(), {
      payload: googlePayload({ state }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      isPremium: false,
      tier: 'free',
      subscriptionState: state,
      expiresAt: null,
    });
  });
}

test('canceled subscription with past expiry is Free', async () => {
  const { res } = await invoke(request(), {
    payload: googlePayload({
      state: 'SUBSCRIPTION_STATE_CANCELED',
      expiryTime: PAST,
    }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.isPremium, false);
});

for (const expiryTime of [undefined, null, 'invalid-date', '2026-10-13']) {
  test(`invalid expiry ${String(expiryTime)} fails closed`, async () => {
    const payload = googlePayload();
    payload.lineItems[0].expiryTime = expiryTime;
    const { res, db } = await invoke(request(), { payload });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'BILLING_GOOGLE_RESPONSE_INVALID');
    assertNoEntitlementWrites(db);
  });
}

for (const [basePlanId, tier] of [
  ['monthly', 'monthly'],
  ['annual', 'annual'],
]) {
  test(`${basePlanId} maps only to ${tier}`, async () => {
    const { res } = await invoke(request(), {
      payload: googlePayload({ basePlanId }),
    });
    assert.equal(res.body.tier, tier);
  });
}

test('successful verification writes root and private billing atomically', async () => {
  const { res, db } = await invoke();
  const root = db.data(`users/${UID}`);
  const current = db.data(`users/${UID}/billing/google_play`);
  const token = db.data(`users/${UID}/billing/google_play/tokens/${hash(TOKEN)}`);

  assert.equal(res.statusCode, 200);
  assert.equal(db.transactions, 2);
  assert.equal(root.isPremium, true);
  assert.equal(root.premiumTier, 'monthly');
  assert.equal(root.premiumProvider, 'google_play');
  assert.equal(root.premiumProductId, GOOGLE_PLAY_PRODUCT_ID);
  assert.equal(root.premiumBasePlanId, 'monthly');
  assert.equal(root.premiumSubscriptionState, 'SUBSCRIPTION_STATE_ACTIVE');
  assert.equal(current.currentTokenHash, hash(TOKEN));
  assert.equal(token.purchaseToken, TOKEN);
  assert.equal(Object.hasOwn(root, 'purchaseToken'), false);
  assert.equal(Object.hasOwn(current, 'purchaseToken'), false);
});

test('missing root user fails without creating profile or billing data', async () => {
  const { res, db } = await invoke(request(), { seedUser: false });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'BILLING_ACCOUNT_STATE_CONFLICT');
  assert.equal(db.store.size, 0);
});

test('retry of same token preserves firstSeenAt and writes once per transaction', async () => {
  const { db, runtime } = fixture();
  await verifyGooglePlayPurchase({ db, uid: UID, purchaseToken: TOKEN, nowMillis: NOW, runtime });
  const tokenPath = `users/${UID}/billing/google_play/tokens/${hash(TOKEN)}`;
  const firstSeenAt = db.data(tokenPath).firstSeenAt;
  runtime.serverTimestamp = () => Timestamp.fromMillis(NOW + 60_000);
  await verifyGooglePlayPurchase({
    db,
    uid: UID,
    purchaseToken: TOKEN,
    nowMillis: NOW + 60_000,
    runtime,
  });
  assert.deepEqual(db.data(tokenPath).firstSeenAt, firstSeenAt);
  assert.equal(db.transactions, 4);
});

test('expired old token does not revoke a different current token', async () => {
  const { db, runtime } = fixture();
  const newToken = 'new-token';
  await verifyGooglePlayPurchase({
    db,
    uid: UID,
    purchaseToken: newToken,
    nowMillis: NOW,
    runtime,
  });
  runtime.getGooglePlaySubscription = async () => googlePayload({
    state: 'SUBSCRIPTION_STATE_EXPIRED',
    expiryTime: PAST,
  });
  const result = await verifyGooglePlayPurchase({
    db,
    uid: UID,
    purchaseToken: 'old-token',
    nowMillis: NOW,
    runtime,
  });
  assert.equal(db.data(`users/${UID}`).isPremium, true);
  assert.equal(
    db.data(`users/${UID}/billing/google_play`).currentTokenHash,
    hash(newToken),
  );
  assert.equal(result.body.isPremium, true);
});

test('expired current token revokes root entitlement', async () => {
  const { db, runtime } = fixture();
  await verifyGooglePlayPurchase({ db, uid: UID, purchaseToken: TOKEN, nowMillis: NOW, runtime });
  runtime.getGooglePlaySubscription = async () => googlePayload({
    state: 'SUBSCRIPTION_STATE_EXPIRED',
    expiryTime: PAST,
  });
  const result = await verifyGooglePlayPurchase({
    db,
    uid: UID,
    purchaseToken: TOKEN,
    nowMillis: NOW,
    runtime,
  });
  assert.equal(result.body.isPremium, false);
  assert.equal(db.data(`users/${UID}`).isPremium, false);
  assert.equal(db.data(`users/${UID}`).premiumProvider, null);
});

test('pending acknowledgement runs only after entitlement persistence', async () => {
  const { res, calls, db } = await invoke(request(), {
    payload: googlePayload({
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.acknowledge, [
    { purchaseToken: TOKEN, persisted: true },
  ]);
  assert.deepEqual(db.committedWrites.filter((write) =>
    write.type === 'update' && Object.hasOwn(write.data, 'acknowledgementState'))
    .map(({ path, data }) => ({ path, data })), [
    {
      path: `users/${UID}/billing/google_play/tokens/${hash(TOKEN)}`,
      data: {
        acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      },
    },
  ]);
  assert.equal(
    db.data(`users/${UID}/billing/google_play/tokens/${hash(TOKEN)}`)
      .acknowledgementState,
    'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  );
});

test('already acknowledged subscription does not call acknowledge', async () => {
  const { calls } = await invoke();
  assert.equal(calls.acknowledge.length, 0);
});

test('non-entitled pending purchase is never acknowledged', async () => {
  const { calls } = await invoke(request(), {
    payload: googlePayload({
      state: 'SUBSCRIPTION_STATE_PENDING',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    }),
  });
  assert.equal(calls.acknowledge.length, 0);
});

test('acknowledge failure returns retryable 502 but preserves entitlement', async () => {
  const { res, db } = await invoke(request(), {
    payload: googlePayload({
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    }),
    runtime: {
      acknowledgeGooglePlaySubscription: async () => {
        throw new Error(`private-ack-error-${TOKEN}`);
      },
    },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'BILLING_ACKNOWLEDGEMENT_FAILED');
  assert.equal(db.data(`users/${UID}`).isPremium, true);
  assert.equal(
    db.data(`users/${UID}/billing/google_play/tokens/${hash(TOKEN)}`)
      .acknowledgementState,
    'ACKNOWLEDGEMENT_STATE_PENDING',
  );
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(TOKEN));
});

test('post-ack Firestore failure is retryable and keeps entitlement', async () => {
  const { db, runtime } = fixture({
    payload: googlePayload({
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    }),
  });
  db.failDocumentUpdate = true;
  const handler = createBillingHandler(verifyGooglePlayPurchase);
  const res = responseStub();
  await handler(request(), res, runtime);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'BILLING_ACKNOWLEDGEMENT_FAILED');
  assert.equal(db.data(`users/${UID}`).isPremium, true);
  assert.equal(
    db.data(`users/${UID}/billing/google_play/tokens/${hash(TOKEN)}`)
      .acknowledgementState,
    'ACKNOWLEDGEMENT_STATE_PENDING',
  );
});

test('retry reconciles token when Google reports acknowledged', async () => {
  const { db, runtime } = fixture({
    payload: googlePayload({
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    }),
  });
  runtime.acknowledgeGooglePlaySubscription = async () => {
    throw new Error('first-ack-failure');
  };
  await assert.rejects(
    verifyGooglePlayPurchase({
      db,
      uid: UID,
      purchaseToken: TOKEN,
      nowMillis: NOW,
      runtime,
    }),
  );

  runtime.getGooglePlaySubscription = async () => googlePayload({
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  });
  let acknowledgeCalls = 0;
  runtime.acknowledgeGooglePlaySubscription = async () => {
    acknowledgeCalls += 1;
  };
  await verifyGooglePlayPurchase({
    db,
    uid: UID,
    purchaseToken: TOKEN,
    nowMillis: NOW,
    runtime,
  });

  assert.equal(acknowledgeCalls, 0);
  assert.equal(
    db.data(`users/${UID}/billing/google_play/tokens/${hash(TOKEN)}`)
      .acknowledgementState,
    'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  );
});

test('unexpected errors and logs do not expose token, credentials, or raw error', async () => {
  const messages = [];
  const original = console.error;
  console.error = (...values) => messages.push(values.join(' '));
  process.env.GOOGLE_PLAY_PRIVATE_KEY = 'private-key-secret';
  try {
    const { res } = await invoke(request(), {
      runtime: {
        getGooglePlaySubscription: async () => {
          throw new Error(`raw-${TOKEN}-private-key-secret`);
        },
      },
    });
    const exposed = `${JSON.stringify(res.body)} ${messages.join(' ')}`;
    assert.doesNotMatch(exposed, new RegExp(TOKEN));
    assert.doesNotMatch(exposed, /private-key-secret|raw-/);
  } finally {
    console.error = original;
    delete process.env.GOOGLE_PLAY_PRIVATE_KEY;
  }
});

test('Google GET uses frozen package URL and dedicated credentials', async () => {
  const oldEmail = process.env.GOOGLE_PLAY_CLIENT_EMAIL;
  const oldKey = process.env.GOOGLE_PLAY_PRIVATE_KEY;
  process.env.GOOGLE_PLAY_CLIENT_EMAIL = 'billing@example.test';
  process.env.GOOGLE_PLAY_PRIVATE_KEY = 'billing-private-key';
  let authOptions;
  let receivedUrl;
  try {
    const payload = await getGooglePlaySubscription(TOKEN, {
      googleAuthFactory: (options) => {
        authOptions = options;
        return {
          getClient: async () => ({
            getRequestHeaders: async () => ({ authorization: 'Bearer google' }),
          }),
        };
      },
      fetchImpl: async (url) => {
        receivedUrl = url;
        return { ok: true, json: async () => googlePayload() };
      },
    });
    assert.equal(
      receivedUrl,
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${ANDROID_PACKAGE_NAME}/purchases/subscriptionsv2/tokens/${TOKEN}`,
    );
    assert.equal(authOptions.credentials.client_email, 'billing@example.test');
    assert.equal(authOptions.credentials.private_key, 'billing-private-key');
    assert.deepEqual(authOptions.scopes, [
      'https://www.googleapis.com/auth/androidpublisher',
    ]);
    assert.equal(payload.subscriptionState, 'SUBSCRIPTION_STATE_ACTIVE');
  } finally {
    if (oldEmail === undefined) delete process.env.GOOGLE_PLAY_CLIENT_EMAIL;
    else process.env.GOOGLE_PLAY_CLIENT_EMAIL = oldEmail;
    if (oldKey === undefined) delete process.env.GOOGLE_PLAY_PRIVATE_KEY;
    else process.env.GOOGLE_PLAY_PRIVATE_KEY = oldKey;
  }
});

test('Google acknowledge uses official subscription endpoint and empty body', async () => {
  const oldEmail = process.env.GOOGLE_PLAY_CLIENT_EMAIL;
  const oldKey = process.env.GOOGLE_PLAY_PRIVATE_KEY;
  process.env.GOOGLE_PLAY_CLIENT_EMAIL = 'billing@example.test';
  process.env.GOOGLE_PLAY_PRIVATE_KEY = 'billing-private-key';
  let requestOptions;
  let receivedUrl;
  try {
    await acknowledgeGooglePlaySubscription(TOKEN, {
      googleAuthFactory: () => ({
        getClient: async () => ({
          getRequestHeaders: async () => ({ authorization: 'Bearer google' }),
        }),
      }),
      fetchImpl: async (url, options) => {
        receivedUrl = url;
        requestOptions = options;
        return { ok: true };
      },
    });
    assert.equal(
      receivedUrl,
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${ANDROID_PACKAGE_NAME}/purchases/subscriptions/${GOOGLE_PLAY_PRODUCT_ID}/tokens/${TOKEN}:acknowledge`,
    );
    assert.equal(requestOptions.method, 'POST');
    assert.equal(requestOptions.body, '{}');
  } finally {
    if (oldEmail === undefined) delete process.env.GOOGLE_PLAY_CLIENT_EMAIL;
    else process.env.GOOGLE_PLAY_CLIENT_EMAIL = oldEmail;
    if (oldKey === undefined) delete process.env.GOOGLE_PLAY_PRIVATE_KEY;
    else process.env.GOOGLE_PLAY_PRIVATE_KEY = oldKey;
  }
});

test('Google Play operations default to a ten-second deadline', () => {
  assert.equal(GOOGLE_PLAY_REQUEST_TIMEOUT_MS, 10_000);
});

test('Google GET classifies retryable and terminal responses without private data', async () => {
  const oldEmail = process.env.GOOGLE_PLAY_CLIENT_EMAIL;
  const oldKey = process.env.GOOGLE_PLAY_PRIVATE_KEY;
  process.env.GOOGLE_PLAY_CLIENT_EMAIL = 'billing@example.test';
  process.env.GOOGLE_PLAY_PRIVATE_KEY = 'billing-private-key';
  const cases = [
    [410, 'subscriptionNoLongerAvailable', false, true],
    [410, 'purchaseTokenNoLongerValid', false, true],
    [410, 'unknownGoneReason', false, false],
    [404, 'notFound', false, false],
    [400, 'invalidValue', false, false],
    [400, 'purchaseTokenMismatch', false, false],
    [409, 'concurrentUpdate', true, false],
    [409, 'conflict', false, false],
    [429, 'rateLimitExceeded', true, false],
    [401, 'authError', true, false],
    [403, 'permissionDenied', true, false],
    [503, 'backendError', true, false],
  ];
  try {
    for (const [statusCode, reason, retryable, terminalTokenUnavailable] of cases) {
      await assert.rejects(getGooglePlaySubscription(TOKEN, {
        googleAuthFactory: () => ({ getClient: async () => ({
          getRequestHeaders: async () => ({ authorization: 'Bearer private-oauth' }),
        }) }),
        fetchImpl: async () => ({
          ok: false, status: statusCode,
          json: async () => ({ error: { errors: [{ reason }], private: TOKEN } }),
        }),
      }), (error) => {
        assert.ok(error instanceof GooglePlayRequestError);
        assert.equal(error.statusCode, statusCode);
        assert.equal(error.reason, reason);
        assert.equal(error.retryable, retryable);
        assert.equal(error.terminalTokenUnavailable, terminalTokenUnavailable);
        assert.doesNotMatch(JSON.stringify(error), new RegExp(TOKEN));
        assert.doesNotMatch(JSON.stringify(error), /private-oauth/);
        return true;
      });
    }
  } finally {
    if (oldEmail === undefined) delete process.env.GOOGLE_PLAY_CLIENT_EMAIL;
    else process.env.GOOGLE_PLAY_CLIENT_EMAIL = oldEmail;
    if (oldKey === undefined) delete process.env.GOOGLE_PLAY_PRIVATE_KEY;
    else process.env.GOOGLE_PLAY_PRIVATE_KEY = oldKey;
  }
});

test('Google GET that never resolves is aborted by the deadline', async () => {
  const oldEmail = process.env.GOOGLE_PLAY_CLIENT_EMAIL;
  const oldKey = process.env.GOOGLE_PLAY_PRIVATE_KEY;
  process.env.GOOGLE_PLAY_CLIENT_EMAIL = 'billing@example.test';
  process.env.GOOGLE_PLAY_PRIVATE_KEY = 'billing-private-key';
  let receivedSignal;
  try {
    await assert.rejects(
      getGooglePlaySubscription(TOKEN, {
        timeoutMs: 5,
        googleAuthFactory: () => ({
          getClient: async () => ({
            getRequestHeaders: async () => ({ authorization: 'Bearer google' }),
          }),
        }),
        fetchImpl: async (_, options) => {
          receivedSignal = options.signal;
          return new Promise((_, reject) => {
            receivedSignal.addEventListener('abort', () => {
              reject(new Error(`private-timeout-${TOKEN}`));
            }, { once: true });
          });
        },
      }),
      /GOOGLE_PLAY_GET_FAILED/,
    );
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal.aborted, true);
  } finally {
    if (oldEmail === undefined) delete process.env.GOOGLE_PLAY_CLIENT_EMAIL;
    else process.env.GOOGLE_PLAY_CLIENT_EMAIL = oldEmail;
    if (oldKey === undefined) delete process.env.GOOGLE_PLAY_PRIVATE_KEY;
    else process.env.GOOGLE_PLAY_PRIVATE_KEY = oldKey;
  }
});

test('Google acknowledge that never resolves is aborted by the deadline', async () => {
  const oldEmail = process.env.GOOGLE_PLAY_CLIENT_EMAIL;
  const oldKey = process.env.GOOGLE_PLAY_PRIVATE_KEY;
  process.env.GOOGLE_PLAY_CLIENT_EMAIL = 'billing@example.test';
  process.env.GOOGLE_PLAY_PRIVATE_KEY = 'billing-private-key';
  let receivedSignal;
  try {
    await assert.rejects(
      acknowledgeGooglePlaySubscription(TOKEN, {
        timeoutMs: 5,
        googleAuthFactory: () => ({
          getClient: async () => ({
            getRequestHeaders: async () => ({ authorization: 'Bearer google' }),
          }),
        }),
        fetchImpl: async (_, options) => {
          receivedSignal = options.signal;
          return new Promise((_, reject) => {
            receivedSignal.addEventListener('abort', () => {
              reject(new Error(`private-timeout-${TOKEN}`));
            }, { once: true });
          });
        },
      }),
      /GOOGLE_PLAY_ACKNOWLEDGE_FAILED/,
    );
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal.aborted, true);
  } finally {
    if (oldEmail === undefined) delete process.env.GOOGLE_PLAY_CLIENT_EMAIL;
    else process.env.GOOGLE_PLAY_CLIENT_EMAIL = oldEmail;
    if (oldKey === undefined) delete process.env.GOOGLE_PLAY_PRIVATE_KEY;
    else process.env.GOOGLE_PLAY_PRIVATE_KEY = oldKey;
  }
});

test('Google Auth header that never resolves is bounded before fetch', async () => {
  const oldEmail = process.env.GOOGLE_PLAY_CLIENT_EMAIL;
  const oldKey = process.env.GOOGLE_PLAY_PRIVATE_KEY;
  process.env.GOOGLE_PLAY_CLIENT_EMAIL = 'billing@example.test';
  process.env.GOOGLE_PLAY_PRIVATE_KEY = 'billing-private-key';
  let fetchCalls = 0;
  try {
    await assert.rejects(
      getGooglePlaySubscription(TOKEN, {
        timeoutMs: 5,
        googleAuthFactory: () => ({
          getClient: async () => new Promise(() => {}),
        }),
        fetchImpl: async () => {
          fetchCalls += 1;
          return { ok: true, json: async () => googlePayload() };
        },
      }),
      /GOOGLE_PLAY_GET_FAILED/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    if (oldEmail === undefined) delete process.env.GOOGLE_PLAY_CLIENT_EMAIL;
    else process.env.GOOGLE_PLAY_CLIENT_EMAIL = oldEmail;
    if (oldKey === undefined) delete process.env.GOOGLE_PLAY_PRIVATE_KEY;
    else process.env.GOOGLE_PLAY_PRIVATE_KEY = oldKey;
  }
});

test('Google GET timeout reaches endpoint as sanitized retryable 502', async () => {
  const oldEmail = process.env.GOOGLE_PLAY_CLIENT_EMAIL;
  const oldKey = process.env.GOOGLE_PLAY_PRIVATE_KEY;
  process.env.GOOGLE_PLAY_CLIENT_EMAIL = 'billing@example.test';
  process.env.GOOGLE_PLAY_PRIVATE_KEY = 'billing-private-key';
  try {
    const { res } = await invoke(request(), {
      runtime: {
        getGooglePlaySubscription: (purchaseToken) =>
          getGooglePlaySubscription(purchaseToken, {
            timeoutMs: 5,
            googleAuthFactory: () => ({
              getClient: async () => ({
                getRequestHeaders: async () => ({
                  authorization: 'Bearer private-oauth-token',
                }),
              }),
            }),
            fetchImpl: async () => new Promise(() => {}),
          }),
      },
    });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'GOOGLE_PLAY_UNAVAILABLE');
    const body = JSON.stringify(res.body);
    assert.doesNotMatch(body, new RegExp(TOKEN));
    assert.doesNotMatch(body, /private-oauth-token|GOOGLE_PLAY_GET_FAILED/);
  } finally {
    if (oldEmail === undefined) delete process.env.GOOGLE_PLAY_CLIENT_EMAIL;
    else process.env.GOOGLE_PLAY_CLIENT_EMAIL = oldEmail;
    if (oldKey === undefined) delete process.env.GOOGLE_PLAY_PRIVATE_KEY;
    else process.env.GOOGLE_PLAY_PRIVATE_KEY = oldKey;
  }
});

function premiumRoot(overrides = {}) {
  return {
    isPremium: true,
    premiumTier: 'monthly',
    premiumProvider: 'google_play',
    premiumProductId: GOOGLE_PLAY_PRODUCT_ID,
    premiumBasePlanId: 'monthly',
    premiumSubscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    premiumExpiresAt: Timestamp.fromDate(new Date(FUTURE)),
    ...overrides,
  };
}

test('pure chat entitlement gate rejects isPremium without metadata', () => {
  assert.equal(hasValidGooglePlayPremium({ isPremium: true }, NOW), false);
});

for (const state of [
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  'SUBSCRIPTION_STATE_CANCELED',
]) {
  test(`chat entitlement gate accepts valid ${state}`, () => {
    assert.equal(hasValidGooglePlayPremium(premiumRoot({
      premiumSubscriptionState: state,
    }), NOW), true);
  });
}

for (const [name, overrides] of [
  ['past expiry', { premiumExpiresAt: Timestamp.fromDate(new Date(PAST)) }],
  ['on hold', { premiumSubscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' }],
  ['expired', { premiumSubscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }],
  ['tier mismatch', { premiumTier: 'annual' }],
  ['non-Timestamp expiry', { premiumExpiresAt: new Date(FUTURE) }],
]) {
  test(`chat entitlement gate rejects ${name}`, () => {
    assert.equal(hasValidGooglePlayPremium(premiumRoot(overrides), NOW), false);
  });
}

test('default chat premium lookup uses complete root entitlement', async () => {
  const db = new FakeFirestore();
  db.seed(`users/${UID}`, premiumRoot());
  assert.equal(await hasPremiumAccess(UID, { firestore: db, nowMillis: NOW }), true);
  db.seed(`users/${UID}`, { isPremium: true });
  assert.equal(await hasPremiumAccess(UID, { firestore: db, nowMillis: NOW }), false);
});

test('strict payload helper accepts exactly one nonempty token', () => {
  assert.equal(validateBillingPayload({ purchaseToken: TOKEN }), TOKEN);
});

test('Google parser rejects ambiguous multiple line items', () => {
  assert.throws(
    () => parseGooglePlaySubscription(googlePayload({
      lineItems: [
        googlePayload().lineItems[0],
        googlePayload({ basePlanId: 'annual' }).lineItems[0],
      ],
    }), NOW),
    /BILLING_GOOGLE_RESPONSE_INVALID/,
  );
});

test('billing handler never requires recent auth_time', async () => {
  const { db, runtime } = fixture();
  runtime.verifyIdToken = async () => ({ uid: UID, auth_time: 1 });
  const handler = createBillingHandler(verifyGooglePlayPurchase);
  const res = responseStub();
  await handler(request(), res, runtime);
  assert.equal(res.statusCode, 200);
  assert.equal(db.data(`users/${UID}`).isPremium, true);
});
