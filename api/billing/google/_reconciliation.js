import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import {
  GOOGLE_PLAY_PRODUCT_ID,
  entitlementTimestampToMillis,
  hasValidGooglePlayPremium,
  parseGooglePlaySubscription,
} from './_entitlement.js';
import {
  acknowledgeGooglePlaySubscription,
  getGooglePlaySubscription,
  GooglePlayRequestError,
} from './_google_play.js';
import { BillingHttpError, MAX_PURCHASE_TOKEN_LENGTH } from './_shared.js';

export const MAX_LINEAGE_LINKS = 4;
export const BILLING_INDEX_DELETE_PAGE_SIZE = 100;
const MAX_INDEX_DELETE_PAGES = 100;
const HASH = /^[a-f0-9]{64}$/;

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function reconciliationError(code = 'BILLING_OWNERSHIP_CONFLICT') {
  return new BillingHttpError(409, code, 'O estado de billing da conta esta inconsistente.');
}

export function reconciliationRetry(code = 'BILLING_RECONCILIATION_RETRY') {
  return new BillingHttpError(503, code, 'Nao foi possivel reconciliar a assinatura. Tente novamente.');
}

function dependencyPending() {
  return reconciliationRetry('BILLING_DEPENDENCY_PENDING');
}

function validHash(value) {
  if (typeof value !== 'string' || !HASH.test(value)) throw reconciliationError();
  return value;
}

export function validPurchaseToken(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.trim() === value && Buffer.byteLength(value, 'utf8') <= MAX_PURCHASE_TOKEN_LENGTH;
}

function refs(db, uid) {
  const user = db.collection('users').doc(uid);
  const billing = user.collection('billing').doc('google_play');
  return {
    user, billing,
    marker: user.collection('runtime').doc('account_deletion'),
    account: db.collection('billing_google_accounts').doc(sha256(uid)),
    token: (hash) => billing.collection('tokens').doc(hash),
    index: (hash) => db.collection('billing_google_tokens').doc(hash),
  };
}

function validateAccount(data, accountHash) {
  if (!data || typeof data.uid !== 'string' || !data.uid || data.uid.length > 128 ||
      data.uid.includes('/') || sha256(data.uid) !== accountHash ||
      !['ACTIVE', 'DELETING'].includes(data.state)) throw reconciliationError();
  return data;
}

function currentHash(data) {
  const hash = data?.currentTokenHash;
  return hash === undefined || hash === null ? null : validHash(hash);
}

function revisionOf(data) {
  const revision = Object.hasOwn(data ?? {}, 'reconciliationRevision') ? data.reconciliationRevision : 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw reconciliationError('BILLING_ACCOUNT_STATE_CONFLICT');
  }
  return revision;
}

async function readLiveState(transaction, r, uid, allowMissingAccount = false) {
  const [user, billing, account, marker] = await Promise.all([
    transaction.get(r.user), transaction.get(r.billing),
    transaction.get(r.account), transaction.get(r.marker),
  ]);
  if (!user.exists || marker.exists || user.data()?._serverAccountDeletion !== undefined) {
    throw reconciliationError('BILLING_ACCOUNT_STATE_CONFLICT');
  }
  const billingData = billing.data() ?? {};
  const expectedCurrent = currentHash(billingData);
  if (account.exists) {
    const data = validateAccount(account.data(), sha256(uid));
    if (data.uid !== uid || data.state !== 'ACTIVE') throw reconciliationError();
  } else if (!allowMissingAccount || expectedCurrent !== null) {
    throw reconciliationError();
  }
  return { user: user.data(), billing: billingData, accountExists: account.exists };
}

export async function reserveReconciliation({ db, uid, allowMissingAccount = false }) {
  const r = refs(db, uid);
  return db.runTransaction(async (transaction) => {
    const state = await readLiveState(transaction, r, uid, allowMissingAccount);
    const expectedCurrent = currentHash(state.billing);
    const revision = revisionOf(state.billing) + 1;
    transaction.set(r.billing, { ...state.billing, reconciliationRevision: revision });
    return { uid, accountHash: sha256(uid), revision, expectedCurrent, allowMissingAccount };
  });
}

function lineageEvidence(payload) {
  const linked = payload.linkedPurchaseToken;
  const expired = payload.outOfAppPurchaseContext?.expiredPurchaseToken;
  for (const value of [linked, expired]) {
    if (value !== undefined && !validPurchaseToken(value)) throw reconciliationError();
  }
  if (linked !== undefined && expired !== undefined && linked !== expired) {
    throw reconciliationError('BILLING_LINEAGE_CONFLICT');
  }
  return linked !== undefined ? { hash: sha256(linked), kind: 'linked' }
    : expired !== undefined ? { hash: sha256(expired), kind: 'expired' } : null;
}

async function ownershipHashes(read, db, tokenHash, payload) {
  const hashes = [];
  const index = await read(db.collection('billing_google_tokens').doc(tokenHash));
  if (index.exists) hashes.push(validHash(index.data()?.accountHash));
  for (const identifiers of [payload?.externalAccountIdentifiers,
    payload?.outOfAppPurchaseContext?.expiredExternalAccountIdentifiers]) {
    if (identifiers !== undefined) {
      const value = identifiers?.obfuscatedExternalAccountId;
      if (value !== undefined) hashes.push(validHash(value));
    }
  }
  const predecessor = payload ? lineageEvidence(payload) : null;
  let predecessorIndexed = false;
  if (predecessor) {
    const previousIndex = await read(db.collection('billing_google_tokens').doc(predecessor.hash));
    predecessorIndexed = previousIndex.exists;
    if (predecessorIndexed) hashes.push(validHash(previousIndex.data()?.accountHash));
  }
  if (new Set(hashes).size > 1) throw reconciliationError();
  return { accountHash: hashes[0] ?? null, predecessor, predecessorIndexed };
}

export async function resolveOwnership({ db, purchaseToken, payload }) {
  const { accountHash, predecessor, predecessorIndexed } =
    await ownershipHashes((ref) => ref.get(), db, sha256(purchaseToken), payload);
  if (predecessor && !predecessorIndexed && !accountHash) throw dependencyPending();
  if (!accountHash) return null;
  const account = await db.collection('billing_google_accounts').doc(accountHash).get();
  if (!account.exists) return null;
  const data = validateAccount(account.data(), accountHash);
  if (data.state === 'DELETING') return null;
  const user = await db.collection('users').doc(data.uid).get();
  if (!user.exists) return null;
  return data.uid;
}

function storedLineage(data) {
  if (!data) return { predecessor: null, successor: null };
  const predecessor = data.predecessorTokenHash === undefined ? null : validHash(data.predecessorTokenHash);
  const successor = data.supersededByTokenHash === undefined ? null : validHash(data.supersededByTokenHash);
  if ((predecessor === null && data.predecessorKind !== undefined) ||
      (predecessor !== null && !['linked', 'expired', 'terminal'].includes(data.predecessorKind))) {
    throw reconciliationError('BILLING_LINEAGE_CONFLICT');
  }
  return { predecessor, successor };
}

async function readLineage(transaction, r, tokenHash, evidence, accountHash) {
  const nodes = new Map();
  async function read(hash) {
    if (!nodes.has(hash)) {
      const [token, index] = await Promise.all([
        transaction.get(r.token(hash)), transaction.get(r.index(hash)),
      ]);
      if (index.exists && index.data()?.accountHash !== accountHash) {
        throw reconciliationError();
      }
      const data = token.data();
      const lineage = storedLineage(data);
      if (data && (!validPurchaseToken(data.purchaseToken) || sha256(data.purchaseToken) !== hash)) {
        throw reconciliationError();
      }
      nodes.set(hash, { data, indexExists: index.exists, ...lineage });
    }
    return nodes.get(hash);
  }
  const received = await read(tokenHash);
  if (evidence && received.predecessor &&
      (received.predecessor !== evidence.hash || received.data.predecessorKind !== evidence.kind)) {
    throw reconciliationError('BILLING_LINEAGE_CONFLICT');
  }
  const predecessor = evidence?.hash ?? received.predecessor;
  const kind = evidence?.kind ?? received.data?.predecessorKind;
  const ancestors = [];
  const seen = new Set([tokenHash]);
  let previous = predecessor;
  let child = tokenHash;
  while (previous !== null) {
    if (seen.has(previous) || ancestors.length >= MAX_LINEAGE_LINKS) {
      throw reconciliationError('BILLING_LINEAGE_CONFLICT');
    }
    seen.add(previous);
    ancestors.push(previous);
    const node = await read(previous);
    if (!node.data || !node.indexExists) throw dependencyPending();
    if (node.successor !== null && node.successor !== child) {
      throw reconciliationError('BILLING_LINEAGE_CONFLICT');
    }
    child = previous;
    previous = node.predecessor;
  }
  // Verify the successor side as well: stale tokens can never recover current.
  let next = received.successor;
  const successors = new Set([tokenHash]);
  let parent = tokenHash;
  let links = 0;
  while (next !== null) {
    if (successors.has(next) || links++ >= MAX_LINEAGE_LINKS) {
      throw reconciliationError('BILLING_LINEAGE_CONFLICT');
    }
    successors.add(next);
    const node = await read(next);
    if (!node.data || node.predecessor !== parent) throw reconciliationError('BILLING_LINEAGE_CONFLICT');
    parent = next;
    next = node.successor;
  }
  return { nodes, received, predecessor, kind, ancestors };
}

function rootEntitlement(data, nowMillis) {
  if (!hasValidGooglePlayPremium(data, nowMillis)) return {
    isPremium: false, tier: 'free', subscriptionState: data.premiumSubscriptionState ?? 'SUBSCRIPTION_STATE_EXPIRED',
    expiryMillis: null,
  };
  return { isPremium: true, tier: data.premiumTier,
    subscriptionState: data.premiumSubscriptionState,
    expiryMillis: entitlementTimestampToMillis(data.premiumExpiresAt) };
}

export async function commitReconciliation({
  db, reservation, purchaseToken, payload, entitlement, nowMillis, currentProof = null, runtime = {},
}) {
  const { uid, expectedCurrent, revision, accountHash } = reservation;
  const r = refs(db, uid);
  const tokenHash = sha256(purchaseToken);
  return db.runTransaction(async (transaction) => {
    const state = await readLiveState(transaction, r, uid, reservation.allowMissingAccount);
    if (revisionOf(state.billing) !== revision || currentHash(state.billing) !== expectedCurrent) {
      throw reconciliationRetry();
    }
    const ownership = await ownershipHashes((ref) => transaction.get(ref), db, tokenHash, payload);
    if (ownership.accountHash !== accountHash) throw reconciliationError();
    if (ownership.predecessor && !ownership.predecessorIndexed) throw dependencyPending();
    const lineage = await readLineage(transaction, r, tokenHash, ownership.predecessor, accountHash);
    let promote = expectedCurrent === tokenHash || expectedCurrent === null;
    let freshPrevious = null;
    if (lineage.received.successor !== null) promote = false;
    else if (expectedCurrent && expectedCurrent !== tokenHash) {
      if (lineage.ancestors.includes(expectedCurrent)) promote = true;
      else if (lineage.predecessor === null && currentProof) {
        if (currentProof.tokenHash !== expectedCurrent) {
          throw reconciliationError();
        }
        const [currentToken, currentIndex] = await Promise.all([
          transaction.get(r.token(expectedCurrent)), transaction.get(r.index(expectedCurrent)),
        ]);
        const currentData = currentToken.data();
        if (!currentToken.exists || !currentIndex.exists ||
            currentIndex.data()?.accountHash !== accountHash ||
            !validPurchaseToken(currentData?.purchaseToken) ||
            sha256(currentData.purchaseToken) !== expectedCurrent ||
            (currentData.obfuscatedAccountId !== undefined &&
              currentData.obfuscatedAccountId !== accountHash)) {
          throw reconciliationError();
        }
        const currentLineage = storedLineage(currentData);
        if (currentLineage.successor !== null && currentLineage.successor !== tokenHash) {
          throw reconciliationError('BILLING_LINEAGE_CONFLICT');
        }
        if (currentProof.terminalTokenUnavailable) {
          promote = entitlement.isPremium;
        } else {
          const externalId = currentProof.entitlement?.obfuscatedAccountId;
          if (externalId !== null && externalId !== accountHash) throw reconciliationError();
          promote = !currentProof.entitlement.isPremium && entitlement.isPremium;
        }
        if (promote) freshPrevious = { data: currentData, hash: expectedCurrent };
      }
    }
    const verifiedAt = (runtime.serverTimestamp ?? FieldValue.serverTimestamp)();
    const expiresAt = (runtime.timestampFromDate ?? Timestamp.fromDate)(entitlement.expiryDate);
    const tokenData = {
      ...(lineage.received.data ?? {}), purchaseToken, purchaseTokenHash: tokenHash,
      productId: entitlement.productId, basePlanId: entitlement.basePlanId,
      subscriptionState: entitlement.subscriptionState, expiresAt,
      acknowledgementState: entitlement.acknowledgementState,
      obfuscatedAccountId: accountHash,
      firstSeenAt: lineage.received.data?.firstSeenAt ?? verifiedAt, lastVerifiedAt: verifiedAt,
    };
    if (lineage.predecessor) {
      tokenData.predecessorTokenHash = lineage.predecessor;
      tokenData.predecessorKind = lineage.kind;
    }
    // All reads precede writes. Lineage and ownership are persisted atomically,
    // before acknowledgement can remove outOfAppPurchaseContext at Google.
    if (!state.accountExists) transaction.set(r.account, { uid, state: 'ACTIVE' });
    transaction.set(r.index(tokenHash), { accountHash });
    if (lineage.predecessor) {
      const previous = lineage.nodes.get(lineage.predecessor);
      transaction.set(r.token(lineage.predecessor), { ...previous.data, supersededByTokenHash: tokenHash });
    }
    if (freshPrevious) {
      transaction.set(r.token(freshPrevious.hash), {
        ...freshPrevious.data, supersededByTokenHash: tokenHash,
      });
    }
    transaction.set(r.token(tokenHash), tokenData);
    if (!promote) return rootEntitlement(state.user, nowMillis);
    transaction.set(r.billing, {
      ...state.billing, provider: 'google_play', reconciliationRevision: revision,
      currentTokenHash: tokenHash, productId: entitlement.productId, basePlanId: entitlement.basePlanId,
      subscriptionState: entitlement.subscriptionState, expiresAt, verifiedAt, obfuscatedAccountId: accountHash,
    });
    transaction.update(r.user, entitlement.isPremium ? {
      isPremium: true, premiumTier: entitlement.tier, premiumProvider: 'google_play',
      premiumProductId: GOOGLE_PLAY_PRODUCT_ID, premiumBasePlanId: entitlement.basePlanId,
      premiumExpiresAt: expiresAt, premiumSubscriptionState: entitlement.subscriptionState,
      premiumVerifiedAt: verifiedAt,
    } : {
      isPremium: false, premiumTier: null, premiumProvider: null, premiumProductId: null,
      premiumBasePlanId: null, premiumExpiresAt: null, premiumSubscriptionState: entitlement.subscriptionState,
      premiumVerifiedAt: verifiedAt,
    });
    return entitlement;
  });
}

async function queryGoogle(purchaseToken, runtime, { preserveTerminal = false } = {}) {
  try {
    return await (runtime.getGooglePlaySubscription ?? getGooglePlaySubscription)(purchaseToken);
  } catch (error) {
    if (error instanceof GooglePlayRequestError && !error.retryable) {
      if (preserveTerminal && error.terminalTokenUnavailable) throw error;
      throw reconciliationError('BILLING_GOOGLE_REQUEST_REJECTED');
    }
    throw reconciliationRetry('GOOGLE_PLAY_UNAVAILABLE');
  }
}

export async function reconcileGooglePlayPurchase({ db, uid, purchaseToken, nowMillis, runtime = {}, initial = false }) {
  const reservation = await reserveReconciliation({ db, uid, allowMissingAccount: initial });
  const payload = await queryGoogle(purchaseToken, runtime);
  const entitlement = parseGooglePlaySubscription(payload, nowMillis);
  if (initial && entitlement.obfuscatedAccountId !== sha256(uid)) {
    throw new BillingHttpError(403, 'BILLING_ACCOUNT_MISMATCH', 'A assinatura nao pertence a conta autenticada.');
  }
  let currentProof = null;
  const tokenHash = sha256(purchaseToken);
  const previous = lineageEvidence(payload);
  if (reservation.expectedCurrent && reservation.expectedCurrent !== tokenHash && !previous) {
    const r = refs(db, uid);
    const received = await r.token(tokenHash).get();
    const stored = storedLineage(received.data());
    if (!stored.predecessor && !stored.successor && entitlement.isPremium) {
      const current = await r.token(reservation.expectedCurrent).get();
      const raw = current.data()?.purchaseToken;
      if (!validPurchaseToken(raw) || sha256(raw) !== reservation.expectedCurrent) throw reconciliationError();
      try {
        currentProof = {
          tokenHash: reservation.expectedCurrent,
          entitlement: parseGooglePlaySubscription(
            await queryGoogle(raw, runtime, { preserveTerminal: true }), nowMillis,
          ),
          terminalTokenUnavailable: false,
        };
      } catch (error) {
        if (error instanceof GooglePlayRequestError && error.terminalTokenUnavailable) {
          currentProof = {
            tokenHash: reservation.expectedCurrent,
            entitlement: null,
            terminalTokenUnavailable: true,
          };
        } else if (error instanceof GooglePlayRequestError) {
          throw reconciliationError('BILLING_CURRENT_TOKEN_UNVERIFIABLE');
        } else {
          throw error;
        }
      }
    }
  }
  const effective = await commitReconciliation({
    db, reservation, purchaseToken, payload, entitlement, nowMillis, currentProof, runtime,
  });
  if (entitlement.isPremium && entitlement.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
    try {
      // Revalidate the fence before every new external effect.
      await db.runTransaction(async (transaction) => {
        const state = await readLiveState(transaction, refs(db, uid), uid);
        if (revisionOf(state.billing) !== reservation.revision) throw reconciliationRetry();
      });
      try {
        await (runtime.acknowledgeGooglePlaySubscription ?? acknowledgeGooglePlaySubscription)(purchaseToken);
      } catch (_) {
        const confirmed = parseGooglePlaySubscription(await queryGoogle(purchaseToken, runtime), nowMillis);
        if (confirmed.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') throw reconciliationRetry();
      }
      const r = refs(db, uid);
      await db.runTransaction(async (transaction) => {
        const state = await readLiveState(transaction, r, uid);
        const token = await transaction.get(r.token(tokenHash));
        if (revisionOf(state.billing) !== reservation.revision || !token.exists) throw reconciliationRetry();
        transaction.update(r.token(tokenHash), { acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' });
      });
    } catch (_) {
      throw reconciliationRetry('BILLING_ACKNOWLEDGEMENT_FAILED');
    }
  }
  return effective;
}

export async function establishBillingDeletionBarrier({ db, uid }) {
  const r = refs(db, uid);
  await db.runTransaction(async (transaction) => {
    const account = await transaction.get(r.account);
    if (account.exists && validateAccount(account.data(), sha256(uid)).uid !== uid) throw reconciliationError();
    transaction.set(r.account, { uid, state: 'DELETING' });
  });
  for (let page = 0; page < MAX_INDEX_DELETE_PAGES; page += 1) {
    const result = await db.collection('billing_google_tokens').where('accountHash', '==', sha256(uid))
      .limit(BILLING_INDEX_DELETE_PAGE_SIZE).get();
    if (result.docs.length === 0) return;
    await db.runTransaction(async (transaction) => {
      const account = await transaction.get(r.account);
      if (!account.exists || validateAccount(account.data(), sha256(uid)).state !== 'DELETING') {
        throw reconciliationError();
      }
      const snapshots = await Promise.all(result.docs.map((doc) => transaction.get(doc.ref)));
      for (const snapshot of snapshots) {
        if (snapshot.exists && snapshot.data()?.accountHash !== sha256(uid)) throw reconciliationError();
      }
      for (const snapshot of snapshots) if (snapshot.exists) transaction.delete(snapshot.ref);
    });
  }
  throw reconciliationRetry('BILLING_INDEX_CLEANUP_REQUIRED');
}

export async function finishBillingDeletion({ db, uid }) {
  const r = refs(db, uid);
  await db.runTransaction(async (transaction) => {
    const [account, user, remaining] = await Promise.all([
      transaction.get(r.account), transaction.get(r.user),
      transaction.get(db.collection('billing_google_tokens').where('accountHash', '==', sha256(uid)).limit(1)),
    ]);
    if (user.exists || remaining.docs.length > 0) throw reconciliationError();
    if (!account.exists) return;
    if (validateAccount(account.data(), sha256(uid)).state !== 'DELETING') throw reconciliationError();
    transaction.delete(r.account);
  });
}
