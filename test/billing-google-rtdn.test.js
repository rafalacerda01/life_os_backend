import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import test from 'node:test';
import { OAuth2Client, gaxios } from 'google-auth-library';
import { Timestamp } from 'firebase-admin/firestore';

import rtdnHandler from '../api/billing/google/rtdn.js';
import { GooglePlayRequestError } from '../api/billing/google/_google_play.js';
import { sha256 } from '../api/billing/google/_reconciliation.js';
import {
  MAX_RTDN_BODY_BYTES, MAX_RTDN_DATA_BYTES, OIDC_VERIFY_DEADLINE_MS,
} from '../api/billing/google/_rtdn_shared.js';

const UID = 'private-user-rtdn';
const TOKEN = 'private-purchase-token-rtdn';
const EMAIL = 'push-private@example.test';
const AUDIENCE = 'https://rtdn.example.test/api/billing/google/rtdn';
const SUBSCRIPTION = 'projects/demo-life-os/subscriptions/rtdn-test';
const NOW = Date.parse('2026-09-15T12:00:00Z');
const USER = `users/${UID}`;
const ACCOUNT = `billing_google_accounts/${sha256(UID)}`;
const BILLING = `${USER}/billing/google_play`;
const INDEX = `billing_google_tokens/${sha256(TOKEN)}`;

class Ref {
  constructor(db, path) { this.db = db; this.path = path; }
  collection(name) { return new Ref(this.db, `${this.path}/${name}`); }
  doc(id) { return new Ref(this.db, `${this.path}/${id}`); }
  get() { return Promise.resolve(this.db.snapshot(this)); }
}

class Db {
  constructor() { this.store = new Map(); this.writes = []; this.fail = false; }
  collection(name) { if (this.fail) throw new Error('private-firestore-error'); return new Ref(this, name); }
  seed(path, data) { this.store.set(path, data); }
  data(path) { return this.store.get(path); }
  snapshot(ref) {
    const data = this.data(ref.path);
    return { ref, exists: data !== undefined, data: () => data };
  }
  async runTransaction(callback) {
    if (this.fail) throw new Error('private-firestore-error');
    const writes = [];
    const result = await callback({
      get: async (ref) => { assert.equal(writes.length, 0); return this.snapshot(ref); },
      set: (ref, data) => writes.push({ type: 'set', path: ref.path, data }),
      update: (ref, data) => writes.push({ type: 'update', path: ref.path, data }),
    });
    const next = new Map(this.store);
    for (const write of writes) {
      if (write.type === 'update') assert.ok(next.has(write.path));
      next.set(write.path, write.type === 'set' ? write.data : { ...next.get(write.path), ...write.data });
    }
    this.store = next;
    this.writes.push(...writes);
    return result;
  }
}

function claims(overrides = {}) {
  return { aud: AUDIENCE, email: EMAIL, email_verified: true, iss: 'https://accounts.google.com', ...overrides };
}

function google(state = 'SUBSCRIPTION_STATE_ACTIVE', expired = false) {
  return { subscriptionState: state, acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    externalAccountIdentifiers: { obfuscatedExternalAccountId: sha256(UID) },
    lineItems: [{ productId: 'life_os_premium', offerDetails: { basePlanId: 'annual' },
      expiryTime: expired ? '2026-09-14T12:00:00Z' : '2026-10-15T12:00:00Z' }] };
}

function notification(overrides = {}) {
  return { version: '1.0', packageName: 'com.rafalacerda.lifeos', eventTimeMillis: String(NOW),
    subscriptionNotification: { version: '1.0', notificationType: 1, purchaseToken: TOKEN }, ...overrides };
}

function envelope(value = notification()) {
  return { subscription: SUBSCRIPTION, message: { messageId: '12345',
    data: Buffer.from(JSON.stringify(value)).toString('base64') } };
}

function fixture({ known = true } = {}) {
  const db = new Db();
  db.seed(USER, { displayName: 'Test' });
  db.seed(ACCOUNT, { uid: UID, state: 'ACTIVE' });
  if (known) db.seed(INDEX, { accountHash: sha256(UID) });
  const calls = { oidc: [], google: [] };
  const runtime = { getServices: () => ({ db }), audience: AUDIENCE, serviceAccountEmail: EMAIL,
    subscriptionName: SUBSCRIPTION, nowProvider: () => NOW,
    serverTimestamp: () => Timestamp.fromMillis(NOW), timestampFromDate: Timestamp.fromDate,
    oidcClient: { verifyIdToken: async (options) => {
      calls.oidc.push(options); return { getPayload: () => claims() };
    } },
    getGooglePlaySubscription: async (token) => { calls.google.push(token); return google(); },
  };
  return { db, calls, runtime };
}

async function invoke(f = fixture(), { body = envelope(), headers = { authorization: 'Bearer private-jwt' }, method = 'POST' } = {}) {
  const res = { headers: {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }, end() { this.ended = true; return this; },
    setHeader(key, value) { this.headers[key] = value; } };
  await rtdnHandler({ method, body, headers }, res, f.runtime);
  return res;
}

for (const authorization of [undefined, 'Bearer ', 'Bearer', 'Basic token', ['Bearer token']]) {
  test(`missing/malformed OIDC ${JSON.stringify(authorization)} returns 401`, async () => {
    const f = fixture();
    const res = await invoke(f, { headers: { authorization } });
    assert.equal(res.statusCode, 401);
    assert.equal(f.calls.oidc.length, 0);
    assert.equal(f.calls.google.length, 0);
    assert.deepEqual(f.db.writes, []);
  });
}

for (const [name, override] of [
  ['audience', { aud: 'other-audience' }], ['email', { email: 'other@example.test' }],
  ['unverified email', { email_verified: false }], ['string verified', { email_verified: 'true' }],
  ['issuer', { iss: 'https://attacker.test' }],
]) {
  test(`wrong ${name} returns 403 without Google or writes`, async () => {
    const f = fixture();
    f.runtime.oidcClient.verifyIdToken = async () => ({ getPayload: () => claims(override) });
    assert.equal((await invoke(f)).statusCode, 403);
    assert.equal(f.calls.google.length, 0);
    assert.deepEqual(f.db.writes, []);
  });
}

for (const iss of ['accounts.google.com', 'https://accounts.google.com']) {
  test(`valid OIDC issuer ${iss} validates exact audience and reconciles`, async () => {
    const f = fixture();
    f.runtime.oidcClient.verifyIdToken = async (options) => {
      assert.deepEqual(options, { idToken: 'private-jwt', audience: AUDIENCE });
      return { getPayload: () => claims({ iss }) };
    };
    const res = await invoke(f);
    assert.equal(res.statusCode, 204);
    assert.equal(f.db.data(USER).isPremium, true);
    assert.deepEqual(res.headers, {});
  });
}

// Verify signature/expiration with the actual installed library, using local
// test keys and certificates only. No Google/network request is performed.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function signedJwt(payload, key = privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'local-test' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const value = `${header}.${body}`;
  const signature = createSign('RSA-SHA256').update(value).end().sign(key).toString('base64url');
  return `${value}.${signature}`;
}
function localOidcClient() {
  const client = new OAuth2Client();
  client.getFederatedSignonCertsAsync = async () => ({ certs: {
    'local-test': publicKey.export({ type: 'spki', format: 'pem' }),
  } });
  return client;
}

for (const [name, jwt] of [
  ['malformed', 'invalid-jwt'],
  ['expired', signedJwt(claims({ iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 }))],
  ['signature', signedJwt(claims({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }),
    generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)],
]) {
  test(`actual OIDC library rejects ${name}`, async () => {
    const f = fixture();
    f.runtime.oidcClient = localOidcClient();
    assert.equal((await invoke(f, { headers: { authorization: `Bearer ${jwt}` } })).statusCode, 401);
    assert.equal(f.calls.google.length, 0);
    assert.deepEqual(f.db.writes, []);
  });
}

test('actual OIDC library accepts locally signed valid JWT without network', async () => {
  const f = fixture();
  f.runtime.oidcClient = localOidcClient();
  const jwt = signedJwt(claims({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }));
  assert.equal((await invoke(f, { headers: { authorization: `Bearer ${jwt}` } })).statusCode, 204);
});

test('certificate transport unavailable is retryable and sanitized', async () => {
  const f = fixture();
  f.runtime.oidcClient.verifyIdToken = async () => {
    throw new gaxios.GaxiosError('private-cert-message',
      { url: 'https://www.googleapis.com/oauth2/v1/certs' },
      { status: 503, config: {}, data: {} });
  };
  const res = await invoke(f);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /private-cert-message/);
});

test('OIDC verification has an explicit whole-operation deadline', async () => {
  assert.equal(OIDC_VERIFY_DEADLINE_MS, 5_000);
  const f = fixture();
  f.runtime.oidcVerifyDeadlineMs = 5;
  f.runtime.oidcClient.verifyIdToken = async () => new Promise(() => {});

  const res = await invoke(f);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'RTDN_OIDC_UNAVAILABLE');
  assert.equal(f.calls.google.length, 0);
  assert.deepEqual(f.db.writes, []);
});

test('missing OIDC configuration fails closed', async () => {
  const f = fixture();
  f.runtime.audience = '';
  assert.equal((await invoke(f)).statusCode, 503);
  assert.equal(f.calls.google.length, 0);
});

for (const body of [null, [], {}, { message: {}, subscription: SUBSCRIPTION },
  { message: { data: 42 }, subscription: SUBSCRIPTION }, { message: { data: 'AA==' } },
  { ...envelope(), subscription: 'wrong-subscription' },
  { ...envelope(), message: { ...envelope().message, messageId: 42 } }]) {
  test(`authenticated invalid envelope ${JSON.stringify(body).slice(0, 60)} ACKs with no writes`, async () => {
    const f = fixture();
    assert.equal((await invoke(f, { body })).statusCode, 204);
    assert.equal(f.calls.google.length, 0);
    assert.deepEqual(f.db.writes, []);
  });
}

test('external body limit returns 413 before OIDC', async () => {
  const f = fixture();
  assert.equal((await invoke(f, { body: { padding: 'a'.repeat(MAX_RTDN_BODY_BYTES) } })).statusCode, 413);
  assert.equal(f.calls.oidc.length, 0);
});

test('Content-Length exceeding limit returns 413', async () => {
  const f = fixture();
  assert.equal((await invoke(f, { headers: { authorization: 'Bearer jwt', 'content-length': String(MAX_RTDN_BODY_BYTES + 1) } })).statusCode, 413);
});

for (const data of ['***=', 'Zg', 'Zg===', ' Zh==', 'Zh==', Buffer.from([0xc3, 0x28]).toString('base64'),
  Buffer.from('{invalid-json').toString('base64'), Buffer.alloc(MAX_RTDN_DATA_BYTES + 1, 'a').toString('base64')]) {
  test(`invalid base64/UTF8/JSON/data size ${data.slice(0, 12)} fails closed`, async () => {
    const f = fixture();
    const body = envelope();
    body.message.data = data;
    assert.equal((await invoke(f, { body })).statusCode, 204);
    assert.deepEqual(f.db.writes, []);
    assert.equal(f.calls.google.length, 0);
  });
}

for (const value of [
  notification({ packageName: 'other.package' }),
  notification({ version: '2.0' }),
  notification({ subscriptionNotification: { version: '1.0', notificationType: 1 } }),
  notification({ subscriptionNotification: { version: '1.0', notificationType: 1, purchaseToken: ' ' } }),
  notification({ subscriptionNotification: { version: '1.0', notificationType: 1, purchaseToken: 'a'.repeat(4097) } }),
  notification({ testNotification: { version: '1.0' } }),
]) {
  test(`invalid RTDN fields ${JSON.stringify(value).slice(0, 75)} reject without Google`, async () => {
    const f = fixture();
    assert.equal((await invoke(f, { body: envelope(value) })).statusCode, 204);
    assert.equal(f.calls.google.length, 0);
    assert.deepEqual(f.db.writes, []);
  });
}

for (const kind of ['testNotification', 'oneTimeProductNotification', 'voidedPurchaseNotification', 'unknownNotification']) {
  test(`${kind} is ACK/drop with zero Google and zero entitlement writes`, async () => {
    const f = fixture();
    const body = envelope({ version: '1.0', packageName: 'com.rafalacerda.lifeos', [kind]: { version: '1.0' } });
    assert.equal((await invoke(f, { body })).statusCode, 204);
    assert.deepEqual(f.db.writes, []);
    assert.equal(f.calls.google.length, 0);
  });
}

for (const [state, isPremium] of [
  ['SUBSCRIPTION_STATE_ACTIVE', true], ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', true],
  ['SUBSCRIPTION_STATE_CANCELED', true], ['SUBSCRIPTION_STATE_ON_HOLD', false],
  ['SUBSCRIPTION_STATE_PAUSED', false], ['SUBSCRIPTION_STATE_EXPIRED', false],
]) {
  test(`RTDN uses Google state ${state}, not notificationType`, async () => {
    const f = fixture();
    f.runtime.getGooglePlaySubscription = async () => google(state);
    assert.equal((await invoke(f)).statusCode, 204);
    assert.equal(f.db.data(USER).isPremium, isPremium);
  });
}

test('canceled with past expiry remains Free', async () => {
  const f = fixture();
  f.runtime.getGooglePlaySubscription = async () => google('SUBSCRIPTION_STATE_CANCELED', true);
  assert.equal((await invoke(f)).statusCode, 204);
  assert.equal(f.db.data(USER).isPremium, false);
});

test('new token uses discovery then a fenced final Google query', async () => {
  const f = fixture({ known: false });
  assert.equal((await invoke(f)).statusCode, 204);
  assert.deepEqual(f.calls.google, [TOKEN, TOKEN]);
  assert.equal(f.db.data(USER).isPremium, true);
  assert.deepEqual(f.db.data(INDEX), { accountHash: sha256(UID) });
});

test('absent ownership ACKs without creating indices or entitlement', async () => {
  const f = fixture({ known: false });
  f.db.store.delete(ACCOUNT);
  assert.equal((await invoke(f)).statusCode, 204);
  assert.equal(f.calls.google.length, 1);
  assert.deepEqual(f.db.writes, []);
});

for (const [statusCode, reason] of [
  [404, 'notFound'], [400, 'purchaseTokenMismatch'],
  [410, 'subscriptionNoLongerAvailable'], [410, 'purchaseTokenNoLongerValid'],
]) {
  test(`permanent discovery ${statusCode} ${reason} ACKs without writes`, async () => {
    const f = fixture({ known: false });
    f.runtime.getGooglePlaySubscription = async () => {
      throw new GooglePlayRequestError('GET', {
        statusCode, reason, retryable: false,
        terminalTokenUnavailable: statusCode === 410,
      });
    };

    assert.equal((await invoke(f)).statusCode, 204);
    assert.deepEqual(f.db.writes, []);
    assert.equal(f.db.data(USER).isPremium, undefined);
  });
}

test('Google 429 is retried without commercial changes', async () => {
  const f = fixture({ known: false });
  const root = { ...f.db.data(USER) };
  f.runtime.getGooglePlaySubscription = async () => {
    throw new GooglePlayRequestError('GET', {
      statusCode: 429,
      reason: 'rateLimitExceeded',
      retryable: true,
      terminalTokenUnavailable: false,
    });
  };

  const response = await invoke(f);

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'RTDN_RECONCILIATION_RETRY');
  assert.deepEqual(f.db.data(USER), root);
  assert.deepEqual(f.db.writes, []);
  assert.equal(f.db.data(BILLING), undefined);
});

test('known token for DELETING account drops before Google', async () => {
  const f = fixture();
  f.db.seed(ACCOUNT, { uid: UID, state: 'DELETING' });
  assert.equal((await invoke(f)).statusCode, 204);
  assert.deepEqual(f.db.writes, []);
  assert.equal(f.calls.google.length, 0);
});

test('late token after full account removal drops with no retries or writes', async () => {
  const f = fixture({ known: false });
  f.db.store.delete(ACCOUNT);
  f.db.store.delete(USER);
  assert.equal((await invoke(f)).statusCode, 204);
  assert.deepEqual(f.db.writes, []);
});

test('conflicting Google ownership ACKs fail-closed without entitlement', async () => {
  const f = fixture();
  f.runtime.getGooglePlaySubscription = async () => ({ ...google(), externalAccountIdentifiers: {
    obfuscatedExternalAccountId: sha256('other-user'),
  } });
  assert.equal((await invoke(f)).statusCode, 204);
  assert.equal(f.db.data(USER).isPremium, undefined);
  assert.ok(f.db.writes.every((write) => write.path === BILLING && Object.keys(write.data).length === 1));
});

for (const known of [true, false]) {
  test(`Google unavailable ${known ? 'final' : 'discovery'} NACKs with sanitized 503`, async () => {
    const f = fixture({ known });
    f.runtime.getGooglePlaySubscription = async () => { throw new Error('private-google-error'); };
    assert.equal((await invoke(f)).statusCode, 503);
    assert.equal(f.db.data(USER).isPremium, undefined);
  });
}

test('Firestore unavailable NACKs with 503', async () => {
  const f = fixture();
  f.db.fail = true;
  assert.equal((await invoke(f)).statusCode, 503);
  assert.deepEqual(f.db.writes, []);
});

test('revision race NACKs instead of applying stale Google result', async () => {
  const f = fixture();
  f.runtime.getGooglePlaySubscription = async () => {
    f.db.seed(BILLING, { reconciliationRevision: 2 });
    return google();
  };
  assert.equal((await invoke(f)).statusCode, 503);
  assert.equal(f.db.data(USER).isPremium, undefined);
});

test('duplicate RTDN does not duplicate commercial state', async () => {
  const f = fixture();
  assert.equal((await invoke(f)).statusCode, 204);
  const root = f.db.data(USER);
  const token = f.db.data(`${BILLING}/tokens/${sha256(TOKEN)}`);
  assert.equal((await invoke(f)).statusCode, 204);
  assert.deepEqual(f.db.data(USER), root);
  assert.deepEqual(f.db.data(`${BILLING}/tokens/${sha256(TOKEN)}`), token);
});

test('logs and caller never expose private identifiers or raw exceptions', async () => {
  const f = fixture();
  const messages = [];
  const original = console.error;
  console.error = (...values) => messages.push(values.join(' '));
  try {
    f.runtime.getGooglePlaySubscription = async () => { throw new Error(`${TOKEN} ${UID} ${EMAIL} private-jwt ${sha256(UID)}`); };
    const res = await invoke(f);
    const exposed = `${JSON.stringify(res.body)} ${messages.join(' ')}`;
    for (const secret of [TOKEN, UID, EMAIL, 'private-jwt', sha256(UID), sha256(TOKEN)]) assert.ok(!exposed.includes(secret));
    assert.ok(messages.every((message) => message === '[billing-rtdn] GOOGLE_PLAY_UNAVAILABLE'));
  } finally { console.error = original; }
});

test('only POST is accepted without app CORS', async () => {
  const f = fixture();
  for (const method of ['GET', 'OPTIONS', 'PUT']) {
    const res = await invoke(f, { method });
    assert.equal(res.statusCode, 405);
    assert.deepEqual(res.headers, {});
  }
  assert.equal(f.calls.oidc.length, 0);
});
