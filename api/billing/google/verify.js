import { createHash } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import {
  GOOGLE_PLAY_PRODUCT_ID,
  GooglePlayPayloadError,
  entitlementTimestampToMillis,
  hasValidGooglePlayPremium,
  parseGooglePlaySubscription,
} from './_entitlement.js';
import {
  acknowledgeGooglePlaySubscription,
  getGooglePlaySubscription,
} from './_google_play.js';
import { BillingHttpError, createBillingHandler } from './_shared.js';

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalidGooglePayload(error) {
  if (!(error instanceof GooglePlayPayloadError)) return error;
  if (error.code === 'BILLING_PRODUCT_INVALID') {
    return new BillingHttpError(
      400,
      error.code,
      'Produto Google Play inválido para esta assinatura.',
    );
  }
  if (error.code === 'BILLING_BASE_PLAN_INVALID') {
    return new BillingHttpError(
      400,
      error.code,
      'Plano Google Play inválido para esta assinatura.',
    );
  }
  return new BillingHttpError(
    502,
    'BILLING_GOOGLE_RESPONSE_INVALID',
    'A Google Play retornou um estado de assinatura inválido.',
  );
}

function responseBody(entitlement) {
  if (!entitlement.isPremium) {
    return {
      isPremium: false,
      tier: 'free',
      subscriptionState: entitlement.subscriptionState,
      expiresAt: null,
    };
  }
  return {
    isPremium: true,
    tier: entitlement.tier,
    subscriptionState: entitlement.subscriptionState,
    expiresAt: new Date(entitlement.expiryMillis).toISOString(),
  };
}

function currentRootEntitlement(userData, nowMillis) {
  if (!hasValidGooglePlayPremium(userData, nowMillis)) return null;
  return {
    isPremium: true,
    tier: userData.premiumTier,
    subscriptionState: userData.premiumSubscriptionState,
    expiryMillis: entitlementTimestampToMillis(userData.premiumExpiresAt),
  };
}

async function markPurchaseAcknowledged({ db, uid, tokenHash }) {
  const tokenRef = db
    .collection('users')
    .doc(uid)
    .collection('billing')
    .doc('google_play')
    .collection('tokens')
    .doc(tokenHash);
  await tokenRef.update({
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  });
}

async function persistVerifiedPurchase({
  db,
  uid,
  purchaseToken,
  tokenHash,
  entitlement,
  nowMillis,
  serverTimestamp,
  timestampFromDate,
}) {
  const userRef = db.collection('users').doc(uid);
  const billingRef = userRef.collection('billing').doc('google_play');
  const tokenRef = billingRef.collection('tokens').doc(tokenHash);
  const expiresAt = timestampFromDate(entitlement.expiryDate);

  return db.runTransaction(async (transaction) => {
    const [userSnapshot, billingSnapshot, tokenSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(billingRef),
      transaction.get(tokenRef),
    ]);
    if (!userSnapshot.exists) {
      throw new BillingHttpError(
        409,
        'BILLING_ACCOUNT_STATE_CONFLICT',
        'O perfil da conta não está disponível para billing.',
      );
    }

    const userData = userSnapshot.data() ?? {};
    const billingData = billingSnapshot.exists ? billingSnapshot.data() : {};
    const currentTokenHash = billingData?.currentTokenHash;
    if (
      currentTokenHash !== undefined &&
      currentTokenHash !== null &&
      (typeof currentTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(currentTokenHash))
    ) {
      throw new BillingHttpError(
        409,
        'BILLING_ACCOUNT_STATE_CONFLICT',
        'O estado atual de billing está inconsistente.',
      );
    }

    const verifiedAt = serverTimestamp();
    const previousTokenData = tokenSnapshot.exists ? tokenSnapshot.data() : null;
    transaction.set(tokenRef, {
      purchaseToken,
      purchaseTokenHash: tokenHash,
      productId: entitlement.productId,
      basePlanId: entitlement.basePlanId,
      subscriptionState: entitlement.subscriptionState,
      expiresAt,
      acknowledgementState: entitlement.acknowledgementState,
      obfuscatedAccountId: entitlement.obfuscatedAccountId,
      firstSeenAt:
        previousTokenData?.firstSeenAt !== undefined
          ? previousTokenData.firstSeenAt
          : verifiedAt,
      lastVerifiedAt: verifiedAt,
    });

    const mayReplaceCurrent =
      entitlement.isPremium ||
      currentTokenHash === undefined ||
      currentTokenHash === null ||
      currentTokenHash === tokenHash;

    if (!mayReplaceCurrent) {
      const existing = currentRootEntitlement(userData, nowMillis);
      if (existing === null) {
        throw new BillingHttpError(
          409,
          'BILLING_ACCOUNT_STATE_CONFLICT',
          'O estado atual de billing está inconsistente.',
        );
      }
      return existing;
    }

    transaction.set(billingRef, {
      provider: 'google_play',
      currentTokenHash: tokenHash,
      productId: entitlement.productId,
      basePlanId: entitlement.basePlanId,
      subscriptionState: entitlement.subscriptionState,
      expiresAt,
      verifiedAt,
      obfuscatedAccountId: entitlement.obfuscatedAccountId,
    });

    transaction.update(userRef, entitlement.isPremium
      ? {
          isPremium: true,
          premiumTier: entitlement.tier,
          premiumProvider: 'google_play',
          premiumProductId: GOOGLE_PLAY_PRODUCT_ID,
          premiumBasePlanId: entitlement.basePlanId,
          premiumExpiresAt: expiresAt,
          premiumSubscriptionState: entitlement.subscriptionState,
          premiumVerifiedAt: verifiedAt,
        }
      : {
          isPremium: false,
          premiumTier: null,
          premiumProvider: null,
          premiumProductId: null,
          premiumBasePlanId: null,
          premiumExpiresAt: null,
          premiumSubscriptionState: entitlement.subscriptionState,
          premiumVerifiedAt: verifiedAt,
        });

    return entitlement;
  });
}

export async function verifyGooglePlayPurchase({
  db,
  uid,
  purchaseToken,
  nowMillis,
  runtime = {},
}) {
  const getSubscription =
    runtime.getGooglePlaySubscription ?? getGooglePlaySubscription;
  const acknowledgeSubscription =
    runtime.acknowledgeGooglePlaySubscription ??
    acknowledgeGooglePlaySubscription;

  let payload;
  try {
    payload = await getSubscription(purchaseToken);
  } catch (_) {
    console.error('[billing] Falha ao consultar Google Play.');
    throw new BillingHttpError(
      502,
      'GOOGLE_PLAY_UNAVAILABLE',
      'Não foi possível consultar a Google Play.',
    );
  }

  let entitlement;
  try {
    entitlement = parseGooglePlaySubscription(payload, nowMillis);
  } catch (error) {
    throw invalidGooglePayload(error);
  }

  const expectedAccountId = sha256(uid);
  if (entitlement.obfuscatedAccountId !== expectedAccountId) {
    throw new BillingHttpError(
      403,
      'BILLING_ACCOUNT_MISMATCH',
      'A assinatura não pertence à conta autenticada.',
    );
  }

  const tokenHash = sha256(purchaseToken);
  const effectiveEntitlement = await persistVerifiedPurchase({
    db,
    uid,
    purchaseToken,
    tokenHash,
    entitlement,
    nowMillis,
    serverTimestamp: runtime.serverTimestamp ?? FieldValue.serverTimestamp,
    timestampFromDate: runtime.timestampFromDate ?? Timestamp.fromDate,
  });

  if (
    entitlement.isPremium &&
    entitlement.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING'
  ) {
    try {
      await acknowledgeSubscription(purchaseToken);
      await (runtime.markPurchaseAcknowledged ?? markPurchaseAcknowledged)({
        db,
        uid,
        tokenHash,
      });
    } catch (_) {
      console.error('[billing] Falha ao reconhecer assinatura Google Play.');
      throw new BillingHttpError(
        502,
        'BILLING_ACKNOWLEDGEMENT_FAILED',
        'A assinatura foi validada, mas o reconhecimento deve ser repetido.',
      );
    }
  }

  return { body: responseBody(effectiveEntitlement) };
}

export const verifyGooglePlayBilling = createBillingHandler(
  verifyGooglePlayPurchase,
);

export default verifyGooglePlayBilling;
