import { GooglePlayPayloadError } from './_entitlement.js';
import { reconcileGooglePlayPurchase } from './_reconciliation.js';
import { BillingHttpError, createBillingHandler } from './_shared.js';

function invalidGooglePayload(error) {
  if (error instanceof BillingHttpError &&
      ['GOOGLE_PLAY_UNAVAILABLE', 'BILLING_ACKNOWLEDGEMENT_FAILED'].includes(error.code)) {
    return new BillingHttpError(502, error.code, error.code === 'GOOGLE_PLAY_UNAVAILABLE'
      ? 'Não foi possível consultar a Google Play.'
      : 'A assinatura foi validada, mas o reconhecimento deve ser repetido.');
  }
  if (!(error instanceof GooglePlayPayloadError)) return error;
  if (error.code === 'BILLING_PRODUCT_INVALID') {
    return new BillingHttpError(400, error.code, 'Produto Google Play inválido para esta assinatura.');
  }
  if (error.code === 'BILLING_BASE_PLAN_INVALID') {
    return new BillingHttpError(400, error.code, 'Plano Google Play inválido para esta assinatura.');
  }
  return new BillingHttpError(502, 'BILLING_GOOGLE_RESPONSE_INVALID',
    'A Google Play retornou um estado de assinatura inválido.');
}

function responseBody(entitlement) {
  return {
    isPremium: entitlement.isPremium,
    tier: entitlement.isPremium ? entitlement.tier : 'free',
    subscriptionState: entitlement.subscriptionState,
    expiresAt: entitlement.isPremium ? new Date(entitlement.expiryMillis).toISOString() : null,
  };
}

export async function verifyGooglePlayPurchase({ db, uid, purchaseToken, nowMillis, runtime = {} }) {
  try {
    const entitlement = await reconcileGooglePlayPurchase({
      db, uid, purchaseToken, nowMillis, runtime, initial: true,
    });
    return { body: responseBody(entitlement) };
  } catch (error) {
    throw invalidGooglePayload(error);
  }
}

export const verifyGooglePlayBilling = createBillingHandler(verifyGooglePlayPurchase);
export default verifyGooglePlayBilling;
