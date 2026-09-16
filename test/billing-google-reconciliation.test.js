import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';

import {
  commitReconciliation, reconcileGooglePlayPurchase, reserveReconciliation,
  resolveOwnership, sha256,
} from '../api/billing/google/_reconciliation.js';
import { GooglePlayRequestError } from '../api/billing/google/_google_play.js';
import { verifyGooglePlayPurchase } from '../api/billing/google/verify.js';
import rtdnHandler from '../api/billing/google/rtdn.js';

const UID = 'user-reconciliation';
const NOW = Date.parse('2026-09-15T12:00:00Z');
const A = 'private-purchase-a';
const B = 'private-purchase-b';
const C = 'private-purchase-c';
const ACCOUNT = `billing_google_accounts/${sha256(UID)}`;
const USER = `users/${UID}`;
const BILLING = `${USER}/billing/google_play`;
const tokenPath = (token) => `${BILLING}/tokens/${sha256(token)}`;
const indexPath = (token) => `billing_google_tokens/${sha256(token)}`;

class Ref {
  constructor(db, path) { this.db = db; this.path = path; }
  collection(name) { return new Ref(this.db, `${this.path}/${name}`); }
  doc(id) { return new Ref(this.db, `${this.path}/${id}`); }
  get() { return Promise.resolve(this.db.snapshot(this)); }
}

class Db {
  constructor() { this.store = new Map(); this.writes = []; this.fail = false; }
  collection(name) { return new Ref(this, name); }
  seed(path, data) { this.store.set(path, data); }
  data(path) { return this.store.get(path); }
  snapshot(ref) {
    const data = this.store.get(ref.path);
    return { ref, exists: data !== undefined, data: () => data };
  }
  async runTransaction(callback) {
    if (this.fail) throw new Error('private-firestore-failure');
    const writes = [];
    const transaction = {
      get: async (ref) => {
        assert.equal(writes.length, 0, 'Firestore reads must precede writes');
        return this.snapshot(ref);
      },
      set: (ref, data) => writes.push({ path: ref.path, data, type: 'set' }),
      update: (ref, data) => writes.push({ path: ref.path, data, type: 'update' }),
    };
    const result = await callback(transaction);
    const next = new Map(this.store);
    for (const write of writes) {
      if (write.type === 'update') assert.ok(next.has(write.path));
      next.set(write.path, write.type === 'update' ? { ...next.get(write.path), ...write.data } : write.data);
    }
    this.store = next;
    this.writes.push(...writes);
    return result;
  }
}

function payload(options = {}) {
  return {
    subscriptionState: options.state ?? 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState: options.ack ?? 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    externalAccountIdentifiers: { obfuscatedExternalAccountId: options.accountHash ?? sha256(UID) },
    lineItems: [{ productId: 'life_os_premium', offerDetails: { basePlanId: 'monthly' },
      expiryTime: options.expired ? '2026-09-14T12:00:00Z' : '2026-10-15T12:00:00Z' }],
    ...(options.linked ? { linkedPurchaseToken: options.linked } : {}),
    ...(options.expiredToken ? { outOfAppPurchaseContext: {
      expiredPurchaseToken: options.expiredToken,
      expiredExternalAccountIdentifiers: { obfuscatedExternalAccountId: sha256(UID) },
    } } : {}),
  };
}

function fixture() {
  const db = new Db();
  db.seed(USER, { displayName: 'Test' });
  const responses = new Map([[A, payload()], [B, payload()]]);
  const calls = [];
  const runtime = {
    serverTimestamp: () => Timestamp.fromMillis(NOW),
    timestampFromDate: Timestamp.fromDate,
    getGooglePlaySubscription: async (token) => {
      calls.push(token);
      const value = responses.get(token);
      if (value instanceof Error) throw value;
      if (!value) throw new Error('private-google-failure');
      return value;
    },
  };
  const verify = (token = A) => verifyGooglePlayPurchase({ db, uid: UID, purchaseToken: token, nowMillis: NOW, runtime });
  const reconcile = (token = A) => reconcileGooglePlayPurchase({ db, uid: UID, purchaseToken: token, nowMillis: NOW, runtime });
  return { db, runtime, responses, calls, verify, reconcile };
}

async function pushRtdn(f, token) {
  const response = {
    status(code) { this.statusCode = code; return this; },
    end() { this.ended = true; return this; },
    json(body) { this.body = body; return this; },
  };
  const notification = {
    version: '1.0', packageName: 'com.rafalacerda.lifeos',
    subscriptionNotification: { version: '1.0', notificationType: 1, purchaseToken: token },
  };
  await rtdnHandler({
    method: 'POST', headers: { authorization: 'Bearer private-test-jwt' },
    body: { subscription: 'test-subscription', message: {
      data: Buffer.from(JSON.stringify(notification)).toString('base64'),
    } },
  }, response, {
    ...f.runtime, getServices: () => ({ db: f.db }), nowProvider: () => NOW,
    audience: 'test-audience', serviceAccountEmail: 'push@example.test',
    subscriptionName: 'test-subscription',
    oidcClient: { verifyIdToken: async () => ({ getPayload: () => ({
      aud: 'test-audience', email: 'push@example.test', email_verified: true,
      iss: 'accounts.google.com',
    }) }) },
  });
  return response;
}

async function assertNoCommercialChange(f, execute, expected) {
  const user = f.db.data(USER);
  const tokens = [...f.db.store].filter(([path]) => path.includes('/tokens/') || path.startsWith('billing_google_'));
  await assert.rejects(execute, expected);
  assert.deepEqual(f.db.data(USER), user);
  assert.deepEqual([...f.db.store].filter(([path]) => path.includes('/tokens/') || path.startsWith('billing_google_')), tokens);
}

test('initial verify creates hashed ownership indices without global raw tokens', async () => {
  const f = fixture();
  await f.verify();
  assert.deepEqual(f.db.data(ACCOUNT), { uid: UID, state: 'ACTIVE' });
  assert.deepEqual(f.db.data(indexPath(A)), { accountHash: sha256(UID) });
  assert.equal(f.db.data(tokenPath(A)).purchaseToken, A);
  assert.equal(f.db.data(BILLING).reconciliationRevision, 1);
});

test('known token resolves owner from server-only indices', async () => {
  const f = fixture();
  await f.verify();
  assert.equal(await resolveOwnership({ db: f.db, purchaseToken: A }), UID);
});

test('unknown token resolves owner from external account index', async () => {
  const f = fixture();
  await f.verify();
  assert.equal(await resolveOwnership({ db: f.db, purchaseToken: B, payload: payload() }), UID);
});

for (const kind of ['linked', 'expired']) {
  test(`${kind} predecessor index proves ownership without current external identifiers`, async () => {
    const f = fixture();
    await f.verify();
    const google = payload(kind === 'linked' ? { linked: A } : { expiredToken: A });
    delete google.externalAccountIdentifiers;
    if (kind === 'expired') delete google.outOfAppPurchaseContext.expiredExternalAccountIdentifiers;
    assert.equal(await resolveOwnership({ db: f.db, purchaseToken: B, payload: google }), UID);
    f.responses.set(B, google);
    await f.reconcile(B);
    assert.equal(f.db.data(BILLING).currentTokenHash, sha256(B));
    assert.equal(f.db.data(tokenPath(B)).predecessorKind, kind);
    assert.equal(f.db.data(tokenPath(A)).supersededByTokenHash, sha256(B));
  });
}

test('expired external identifiers alone resolve ownership', async () => {
  const f = fixture();
  await f.verify();
  const google = payload();
  delete google.externalAccountIdentifiers;
  google.outOfAppPurchaseContext = { expiredExternalAccountIdentifiers: { obfuscatedExternalAccountId: sha256(UID) } };
  assert.equal(await resolveOwnership({ db: f.db, purchaseToken: B, payload: google }), UID);
});

test('ownership entirely absent returns null', async () => {
  const f = fixture();
  const google = payload();
  delete google.externalAccountIdentifiers;
  assert.equal(await resolveOwnership({ db: f.db, purchaseToken: B, payload: google }), null);
});

test('missing explicit predecessor NACKs until lineage dependency arrives', async () => {
  const f = fixture();
  await f.verify();
  const before = f.db.data(USER);
  f.responses.set(C, payload({ linked: B }));

  const early = await pushRtdn(f, C);

  assert.equal(early.statusCode, 503);
  assert.equal(f.db.data(tokenPath(C)), undefined);
  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(A));
  assert.deepEqual(f.db.data(USER), before);

  f.responses.set(B, payload({ linked: A }));
  assert.equal((await pushRtdn(f, B)).statusCode, 204);
  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(B));

  assert.equal((await pushRtdn(f, C)).statusCode, 204);
  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(C));
  assert.equal(f.db.data(tokenPath(B)).supersededByTokenHash, sha256(C));
});

test('unknown explicit predecessor with no ownership remains retryable and grants nothing', async () => {
  const f = fixture();
  f.db.store.delete(ACCOUNT);
  const unknown = payload({ linked: 'never-seen-predecessor' });
  delete unknown.externalAccountIdentifiers;
  f.responses.set(C, unknown);

  const response = await pushRtdn(f, C);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(f.db.data(USER), { displayName: 'Test' });
  assert.equal(f.db.data(tokenPath(C)), undefined);
  assert.equal(f.db.data(indexPath(C)), undefined);
});

for (const missing of ['account', 'profile']) {
  test(`known token with missing ${missing} does not invent owner`, async () => {
    const f = fixture();
    await f.verify();
    f.db.store.delete(missing === 'account' ? ACCOUNT : USER);
    assert.equal(await resolveOwnership({ db: f.db, purchaseToken: A }), null);
  });
}

for (const corruption of ['account uid', 'account state', 'token accountHash']) {
  test(`${corruption} conflict fails closed`, async () => {
    const f = fixture();
    await f.verify();
    if (corruption === 'account uid') f.db.seed(ACCOUNT, { uid: 'other-user', state: 'ACTIVE' });
    if (corruption === 'account state') f.db.seed(ACCOUNT, { uid: UID, state: 'INVALID' });
    if (corruption === 'token accountHash') f.db.seed(indexPath(B), { accountHash: sha256('other-user') });
    await assertNoCommercialChange(f, () => f.verify(B));
  });
}

test('conflicting expired and external account evidence fails closed', async () => {
  const f = fixture();
  await f.verify();
  const google = payload({ expiredToken: A });
  google.outOfAppPurchaseContext.expiredExternalAccountIdentifiers.obfuscatedExternalAccountId = sha256('other-user');
  f.responses.set(B, google);
  await assertNoCommercialChange(f, () => f.reconcile(B));
});

test('conflicting linked predecessor ownership fails closed', async () => {
  const f = fixture();
  await f.verify();
  f.db.seed(indexPath(A), { accountHash: sha256('other-user') });
  f.responses.set(B, payload({ linked: A }));
  await assertNoCommercialChange(f, () => f.verify(B));
});

for (const initial of [true, false]) {
  test(`DELETING barrier blocks ${initial ? 'verify' : 'RTDN'} before Google`, async () => {
    const f = fixture();
    await f.verify();
    f.db.seed(ACCOUNT, { uid: UID, state: 'DELETING' });
    f.calls.length = 0;
    await assertNoCommercialChange(f, () => initial ? f.verify() : f.reconcile());
    assert.deepEqual(f.calls, []);
  });
}

for (const marker of [`${USER}/runtime/account_deletion`, USER]) {
  test(`deletion marker at ${marker === USER ? 'root' : 'runtime'} blocks billing writes`, async () => {
    const f = fixture();
    await f.verify();
    f.db.seed(marker, marker === USER ? { ...f.db.data(USER), _serverAccountDeletion: {} } : { state: 'EXTERNAL_CLEANUP_COMPLETE' });
    await assertNoCommercialChange(f, () => f.verify());
  });
}

test('rotation promotes successor and delayed ancestor updates history only', async () => {
  const f = fixture();
  await f.verify();
  f.responses.set(B, payload({ linked: A }));
  await f.reconcile(B);
  const root = f.db.data(USER);
  f.responses.set(A, payload({ state: 'SUBSCRIPTION_STATE_EXPIRED', expired: true }));
  await f.reconcile(A);
  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(B));
  assert.deepEqual(f.db.data(USER), root);
  assert.equal(f.db.data(tokenPath(A)).supersededByTokenHash, sha256(B));
  assert.equal(f.db.data(tokenPath(A)).subscriptionState, 'SUBSCRIPTION_STATE_EXPIRED');
});

test('duplicate notification is commercially idempotent and preserves lineage', async () => {
  const f = fixture();
  await f.verify();
  f.responses.set(B, payload({ linked: A }));
  await f.reconcile(B);
  const root = f.db.data(USER);
  await f.reconcile(B);
  assert.deepEqual(f.db.data(USER), root);
  assert.equal(f.db.data(tokenPath(A)).supersededByTokenHash, sha256(B));
  assert.equal(f.db.data(tokenPath(B)).predecessorTokenHash, sha256(A));
});

test('acknowledgement losing out-of-app context does not erase stored predecessor', async () => {
  const f = fixture();
  await f.verify();
  f.responses.set(B, payload({ expiredToken: A, ack: 'ACKNOWLEDGEMENT_STATE_PENDING' }));
  f.runtime.acknowledgeGooglePlaySubscription = async () => {
    assert.equal(f.db.data(tokenPath(B)).predecessorKind, 'expired');
    assert.equal(f.db.data(tokenPath(A)).supersededByTokenHash, sha256(B));
    f.responses.set(B, payload());
  };
  await f.reconcile(B);
  await f.reconcile(B);
  assert.equal(f.db.data(tokenPath(B)).predecessorTokenHash, sha256(A));
  assert.equal(f.db.data(tokenPath(B)).predecessorKind, 'expired');
});

for (const previousState of ['SUBSCRIPTION_STATE_EXPIRED', 'SUBSCRIPTION_STATE_ON_HOLD']) {
  test(`fresh chain allowed only after current Google proof ${previousState}`, async () => {
    const f = fixture();
    await f.verify();
    f.calls.length = 0;
    f.responses.set(A, payload({ state: previousState, expired: previousState.endsWith('EXPIRED') }));
    await f.reconcile(B);
    assert.deepEqual(f.calls, [B, A]);
    assert.equal(f.db.data(BILLING).currentTokenHash, sha256(B));
    assert.equal(Object.hasOwn(f.db.data(tokenPath(B)), 'predecessorTokenHash'), false);
    assert.equal(f.db.data(tokenPath(A)).supersededByTokenHash, sha256(B));
  });
}

test('fresh chain accepts indexed current when Google omits external identifiers', async () => {
  const f = fixture();
  await f.verify();
  const current = payload({ state: 'SUBSCRIPTION_STATE_EXPIRED', expired: true });
  delete current.externalAccountIdentifiers;
  f.responses.set(A, current);

  await f.reconcile(B);

  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(B));
  assert.equal(f.db.data(USER).isPremium, true);
});

test('fresh chain rejects a present divergent current external identifier', async () => {
  const f = fixture();
  await f.verify();
  f.responses.set(A, payload({
    state: 'SUBSCRIPTION_STATE_EXPIRED', expired: true,
    accountHash: sha256('different-user'),
  }));

  await assertNoCommercialChange(f, () => f.reconcile(B), {
    code: 'BILLING_OWNERSHIP_CONFLICT',
  });
  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(A));
});

for (const reason of ['subscriptionNoLongerAvailable', 'purchaseTokenNoLongerValid']) {
  test(`recognized terminal current ${reason} permits a fenced fresh chain`, async () => {
    const f = fixture();
    await f.verify();
    const previous = { ...f.db.data(tokenPath(A)) };
    f.responses.set(A, new GooglePlayRequestError('GET', {
      statusCode: 410, reason, retryable: false, terminalTokenUnavailable: true,
    }));

    await f.reconcile(B);

    assert.equal(f.db.data(BILLING).currentTokenHash, sha256(B));
    assert.equal(f.db.data(tokenPath(A)).subscriptionState, previous.subscriptionState);
    assert.equal(f.db.data(tokenPath(A)).expiresAt, previous.expiresAt);
    assert.equal(f.db.data(tokenPath(A)).supersededByTokenHash, sha256(B));
    assert.equal(Object.hasOwn(f.db.data(tokenPath(B)), 'predecessorTokenHash'), false);
    assert.equal(Object.hasOwn(f.db.data(tokenPath(B)), 'predecessorKind'), false);
  });
}

test('terminal fresh chain after four links starts new lineage and remains reconcilable', async () => {
  const f = fixture();
  await f.verify();
  let previous = A;
  for (let index = 1; index <= 4; index += 1) {
    const token = `old-lineage-token-${index}`;
    f.responses.set(token, payload({ linked: previous }));
    await f.reconcile(token);
    previous = token;
  }
  f.responses.set(previous, new GooglePlayRequestError('GET', {
    statusCode: 410,
    reason: 'subscriptionNoLongerAvailable',
    retryable: false,
    terminalTokenUnavailable: true,
  }));

  await f.reconcile(B);

  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(B));
  assert.equal(Object.hasOwn(f.db.data(tokenPath(B)), 'predecessorTokenHash'), false);
  assert.equal(Object.hasOwn(f.db.data(tokenPath(B)), 'predecessorKind'), false);
  assert.equal(f.db.data(tokenPath(previous)).supersededByTokenHash, sha256(B));

  f.responses.set(B, payload({ state: 'SUBSCRIPTION_STATE_ON_HOLD' }));
  await f.reconcile(B);
  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(B));
  assert.equal(f.db.data(USER).isPremium, false);
});

test('verify with existing current fails closed when account index is missing', async () => {
  const f = fixture();
  await f.verify();
  const root = { ...f.db.data(USER) };
  const billing = { ...f.db.data(BILLING) };
  f.db.store.delete(ACCOUNT);
  f.calls.length = 0;
  f.responses.set(A, new GooglePlayRequestError('GET', {
    statusCode: 410,
    reason: 'subscriptionNoLongerAvailable',
    retryable: false,
    terminalTokenUnavailable: true,
  }));

  await assert.rejects(() => f.verify(B), { code: 'BILLING_OWNERSHIP_CONFLICT' });

  assert.deepEqual(f.calls, []);
  assert.equal(f.db.data(ACCOUNT), undefined);
  assert.deepEqual(f.db.data(BILLING), billing);
  assert.deepEqual(f.db.data(USER), root);
});

test('terminal current cannot promote without its server-only token index', async () => {
  const f = fixture();
  await f.verify();
  f.db.store.delete(indexPath(A));
  f.responses.set(A, new GooglePlayRequestError('GET', {
    statusCode: 410, reason: 'subscriptionNoLongerAvailable',
    retryable: false, terminalTokenUnavailable: true,
  }));

  await assertNoCommercialChange(f, () => f.reconcile(B));
  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(A));
});

test('unclassified permanent current response stays fail-closed', async () => {
  const f = fixture();
  await f.verify();
  f.responses.set(A, new GooglePlayRequestError('GET', {
    statusCode: 404, reason: 'notFound', retryable: false,
  }));

  await assertNoCommercialChange(f, () => f.reconcile(B), {
    code: 'BILLING_GOOGLE_REQUEST_REJECTED',
  });
  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(A));
});

test('fresh token does not replace still entitled current even with greater expiry', async () => {
  const f = fixture();
  await f.verify();
  const root = f.db.data(USER);
  const google = payload();
  google.lineItems[0].expiryTime = '2027-10-15T12:00:00Z';
  f.responses.set(B, google);
  await f.reconcile(B);
  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(A));
  assert.deepEqual(f.db.data(USER), root);
});

test('required current query unavailable is retryable with no promotion', async () => {
  const f = fixture();
  await f.verify();
  f.responses.set(A, new Error('private-current-error'));
  await assertNoCommercialChange(f, () => f.reconcile(B), { statusCode: 503 });
});

test('predecessor cannot be swapped by replay', async () => {
  const f = fixture();
  await f.verify();
  f.responses.set(B, payload({ linked: A }));
  await f.reconcile(B);
  f.responses.set(B, payload({ linked: 'different-predecessor' }));
  await assertNoCommercialChange(f, () => f.reconcile(B));
});

test('fork incompatible with existing successor fails closed', async () => {
  const f = fixture();
  await f.verify();
  f.responses.set(B, payload({ linked: A }));
  await f.reconcile(B);
  f.responses.set('fork-token', payload({ linked: A }));
  await assertNoCommercialChange(f, () => f.reconcile('fork-token'));
});

test('self cycle fails closed', async () => {
  const f = fixture();
  await f.verify();
  f.responses.set(B, payload({ linked: B }));
  await assertNoCommercialChange(f, () => f.reconcile(B));
});

test('lineage allows four links and refuses a fifth', async () => {
  const f = fixture();
  await f.verify();
  let previous = A;
  for (let index = 1; index <= 4; index += 1) {
    const token = `lineage-token-${index}`;
    f.responses.set(token, payload({ linked: previous }));
    await f.reconcile(token);
    previous = token;
  }
  f.responses.set('fifth-link', payload({ linked: previous }));
  await assertNoCommercialChange(f, () => f.reconcile('fifth-link'));
});

test('RTDN revision N cannot commit after revision N+1', async () => {
  const f = fixture();
  await f.verify();
  const old = await reserveReconciliation({ db: f.db, uid: UID });
  f.responses.set(A, payload({ state: 'SUBSCRIPTION_STATE_PAUSED' }));
  await f.reconcile();
  const root = f.db.data(USER);
  const { parseGooglePlaySubscription } = await import('../api/billing/google/_entitlement.js');
  await assert.rejects(commitReconciliation({ db: f.db, reservation: old, purchaseToken: A,
    payload: payload(), entitlement: parseGooglePlaySubscription(payload(), NOW), nowMillis: NOW,
    runtime: f.runtime }), { statusCode: 503 });
  assert.deepEqual(f.db.data(USER), root);
});

test('verify in flight loses fence to actual RTDN handler', async () => {
  const f = fixture();
  await f.verify();
  let start;
  let release;
  const started = new Promise((resolve) => { start = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const oldRuntime = { ...f.runtime, getGooglePlaySubscription: async () => { start(); return blocked; } };
  const oldVerify = verifyGooglePlayPurchase({ db: f.db, uid: UID, purchaseToken: A, nowMillis: NOW, runtime: oldRuntime });
  const rejected = assert.rejects(oldVerify, { statusCode: 503 });
  await started;
  f.responses.set(A, payload({ state: 'SUBSCRIPTION_STATE_ON_HOLD' }));
  const response = { status(code) { this.statusCode = code; return this; }, end() {}, json(body) { this.body = body; } };
  await rtdnHandler({ method: 'POST', headers: { authorization: 'Bearer oidc-test' }, body: {
    subscription: 'test-subscription', message: { data: Buffer.from(JSON.stringify({ version: '1.0',
      packageName: 'com.rafalacerda.lifeos', subscriptionNotification: { version: '1.0', notificationType: 1, purchaseToken: A } })).toString('base64') },
  } }, response, { ...f.runtime, getServices: () => ({ db: f.db }), nowProvider: () => NOW,
    audience: 'test-audience', serviceAccountEmail: 'push@example.test', oidcClient: {
      verifyIdToken: async () => ({ getPayload: () => ({ aud: 'test-audience', email: 'push@example.test',
        email_verified: true, iss: 'accounts.google.com' }) }),
    } });
  assert.equal(response.statusCode, 204);
  release(payload());
  await rejected;
  assert.equal(f.db.data(USER).isPremium, false);
});

test('two concurrent verifies cannot apply an old response', async () => {
  const f = fixture();
  let release;
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const old = verifyGooglePlayPurchase({ db: f.db, uid: UID, purchaseToken: A, nowMillis: NOW,
    runtime: { ...f.runtime, getGooglePlaySubscription: async () => { start(); return blocked; } } });
  const rejected = assert.rejects(old, { statusCode: 503 });
  await started;
  await f.verify(B);
  release(payload());
  await rejected;
  assert.equal(f.db.data(BILLING).currentTokenHash, sha256(B));
});

test('deletion barrier appearing while Google is in flight blocks commit', async () => {
  const f = fixture();
  await f.verify();
  f.runtime.getGooglePlaySubscription = async () => {
    f.db.seed(ACCOUNT, { uid: UID, state: 'DELETING' });
    return payload();
  };
  const root = f.db.data(USER);
  await assert.rejects(f.reconcile());
  assert.deepEqual(f.db.data(USER), root);
});

test('ambiguous acknowledgement is reconciled with one Google reread', async () => {
  const f = fixture();
  f.responses.set(A, payload({ ack: 'ACKNOWLEDGEMENT_STATE_PENDING' }));
  let acknowledgeCalls = 0;
  f.runtime.acknowledgeGooglePlaySubscription = async () => {
    acknowledgeCalls += 1;
    f.responses.set(A, payload());
    throw new Error('private-after-ack-marker');
  };
  await f.verify();
  assert.equal(acknowledgeCalls, 1);
  assert.deepEqual(f.calls, [A, A]);
  assert.equal(f.db.data(tokenPath(A)).acknowledgementState, 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED');
});

test('unconfirmed acknowledgement remains retryable and preserves persisted entitlement', async () => {
  const f = fixture();
  f.responses.set(A, payload({ ack: 'ACKNOWLEDGEMENT_STATE_PENDING' }));
  f.runtime.acknowledgeGooglePlaySubscription = async () => { throw new Error('private-ack-error'); };
  await assert.rejects(f.verify(), { code: 'BILLING_ACKNOWLEDGEMENT_FAILED' });
  assert.equal(f.db.data(USER).isPremium, true);
  assert.equal(f.db.data(tokenPath(A)).acknowledgementState, 'ACKNOWLEDGEMENT_STATE_PENDING');
});

for (const revision of [null, -1, '1', Number.MAX_SAFE_INTEGER]) {
  test(`invalid revision ${String(revision)} fails closed`, async () => {
    const f = fixture();
    f.db.seed(BILLING, { reconciliationRevision: revision });
    await assertNoCommercialChange(f, () => f.verify());
  });
}
