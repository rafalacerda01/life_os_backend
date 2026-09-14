export const ANDROID_PACKAGE_NAME = 'com.rafalacerda.lifeos';
export const GOOGLE_PLAY_PRODUCT_ID = 'life_os_premium';

export const ENTITLED_SUBSCRIPTION_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  'SUBSCRIPTION_STATE_CANCELED',
]);

const BASE_PLAN_TIERS = new Map([
  ['monthly', 'monthly'],
  ['annual', 'annual'],
]);

const ACKNOWLEDGEMENT_STATES = new Set([
  'ACKNOWLEDGEMENT_STATE_PENDING',
  'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
]);

export class GooglePlayPayloadError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GooglePlayPayloadError';
    this.code = code;
  }
}

export function tierForBasePlan(basePlanId) {
  return BASE_PLAN_TIERS.get(basePlanId) ?? null;
}

export function isEntitledSubscriptionState(subscriptionState) {
  return ENTITLED_SUBSCRIPTION_STATES.has(subscriptionState);
}

function parseExpiryTime(expiryTime) {
  if (
    typeof expiryTime !== 'string' ||
    expiryTime.trim() !== expiryTime ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      expiryTime,
    )
  ) {
    throw new GooglePlayPayloadError('BILLING_EXPIRY_INVALID');
  }

  const expiryMillis = Date.parse(expiryTime);
  if (!Number.isFinite(expiryMillis)) {
    throw new GooglePlayPayloadError('BILLING_EXPIRY_INVALID');
  }

  return expiryMillis;
}

export function parseGooglePlaySubscription(payload, nowMillis) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Number.isSafeInteger(nowMillis)
  ) {
    throw new GooglePlayPayloadError('BILLING_GOOGLE_RESPONSE_INVALID');
  }

  const { lineItems, subscriptionState, acknowledgementState } = payload;
  if (!Array.isArray(lineItems) || lineItems.length !== 1) {
    throw new GooglePlayPayloadError('BILLING_GOOGLE_RESPONSE_INVALID');
  }

  const lineItem = lineItems[0];
  if (
    lineItem === null ||
    typeof lineItem !== 'object' ||
    Array.isArray(lineItem) ||
    lineItem.productId !== GOOGLE_PLAY_PRODUCT_ID
  ) {
    throw new GooglePlayPayloadError('BILLING_PRODUCT_INVALID');
  }

  const basePlanId = lineItem.offerDetails?.basePlanId;
  const tier = tierForBasePlan(basePlanId);
  if (tier === null) {
    throw new GooglePlayPayloadError('BILLING_BASE_PLAN_INVALID');
  }

  if (typeof subscriptionState !== 'string' || subscriptionState.length === 0) {
    throw new GooglePlayPayloadError('BILLING_GOOGLE_RESPONSE_INVALID');
  }
  if (!ACKNOWLEDGEMENT_STATES.has(acknowledgementState)) {
    throw new GooglePlayPayloadError('BILLING_GOOGLE_RESPONSE_INVALID');
  }

  const expiryMillis = parseExpiryTime(lineItem.expiryTime);
  const obfuscatedAccountId =
    payload.externalAccountIdentifiers?.obfuscatedExternalAccountId;

  return {
    productId: lineItem.productId,
    basePlanId,
    tier,
    subscriptionState,
    acknowledgementState,
    expiryMillis,
    expiryDate: new Date(expiryMillis),
    obfuscatedAccountId:
      typeof obfuscatedAccountId === 'string' ? obfuscatedAccountId : null,
    isPremium:
      expiryMillis > nowMillis &&
      isEntitledSubscriptionState(subscriptionState),
  };
}

export function entitlementTimestampToMillis(value) {
  if (value && typeof value.toMillis === 'function') {
    const milliseconds = value.toMillis();
    return Number.isFinite(milliseconds) ? milliseconds : Number.NaN;
  }
  return Number.NaN;
}

export function hasValidGooglePlayPremium(data, nowMillis = Date.now()) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }

  const expectedTier = tierForBasePlan(data.premiumBasePlanId);
  const expiryMillis = entitlementTimestampToMillis(data.premiumExpiresAt);

  return (
    data.isPremium === true &&
    data.premiumProvider === 'google_play' &&
    data.premiumProductId === GOOGLE_PLAY_PRODUCT_ID &&
    expectedTier !== null &&
    data.premiumTier === expectedTier &&
    isEntitledSubscriptionState(data.premiumSubscriptionState) &&
    Number.isFinite(expiryMillis) &&
    expiryMillis > nowMillis
  );
}
