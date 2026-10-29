import { GooglePlayPayloadError } from './_entitlement.js';
import { getGooglePlaySubscription, GooglePlayRequestError } from './_google_play.js';
import { classifyRtdnPurchase, reconcileGooglePlayPurchase } from './_reconciliation.js';
import { BillingHttpError, getFirebaseServices } from './_shared.js';
import {
  RtdnHttpError, assertRtdnBodyLimit, authenticateRtdn, decodeRtdnEnvelope,
} from './_rtdn_shared.js';

export default async function rtdnHandler(req, res, runtime = {}) {
  // Pub/Sub ingress has no app CORS, Firebase Auth or App Check contract.
  if (req.method !== 'POST') return res.status(405).json({ code: 'METHOD_NOT_ALLOWED' });
  let authenticated = false;
  let originalUid = null, originalToken = null, originalDb = null;
  try {
    assertRtdnBodyLimit(req);
    await authenticateRtdn(req, runtime);
    authenticated = true;
    const notification = decodeRtdnEnvelope(req.body,
      runtime.subscriptionName ?? process.env.GOOGLE_PLAY_RTDN_SUBSCRIPTION_NAME);
    if (notification.kind === 'test') return res.status(204).end();
    if (notification.kind === 'drop') {
      console.error('[billing-rtdn] MESSAGE_REJECTED');
      return res.status(204).end();
    }
    const { db } = (runtime.getServices ?? getFirebaseServices)();
    originalDb = db;
    const purchaseToken = notification.purchaseToken;
    originalToken = purchaseToken;
    let disposition = await classifyRtdnPurchase({ db, purchaseToken });
    if (['RETIRED', 'DELETING'].includes(disposition.status)) return res.status(204).end();
    if (disposition.status === 'UNOWNED') {
      let discovery;
      try {
        discovery = await (runtime.getGooglePlaySubscription ?? getGooglePlaySubscription)(purchaseToken);
      } catch (error) {
        if (error instanceof GooglePlayRequestError && !error.retryable) {
          throw new BillingHttpError(409, 'BILLING_GOOGLE_REQUEST_REJECTED', 'A Google Play rejeitou o purchase token.');
        }
        throw new BillingHttpError(503, 'GOOGLE_PLAY_UNAVAILABLE', 'Nao foi possivel consultar a Google Play.');
      }
      disposition = await classifyRtdnPurchase({ db, purchaseToken, payload: discovery });
      if (['UNOWNED', 'RETIRED', 'DELETING'].includes(disposition.status)) return res.status(204).end();
    }
    if (disposition.status !== 'ACTIVE' || typeof disposition.uid !== 'string') {
      throw new BillingHttpError(503, 'BILLING_RTDN_STATE_INDETERMINATE', 'Nao foi possivel reconciliar a assinatura.');
    }
    const uid = disposition.uid;
    originalUid = uid;
    const nowMillis = (runtime.nowProvider ?? Date.now)();
    if (!Number.isSafeInteger(nowMillis) || nowMillis < 0) throw new Error('INVALID_CLOCK');
    await reconcileGooglePlayPurchase({ db, uid, purchaseToken, nowMillis, runtime });
    return res.status(204).end();
  } catch (error) {
    if (error instanceof RtdnHttpError) {
      console.error('[billing-rtdn] MESSAGE_REJECTED');
      if (authenticated && error.statusCode === 400) return res.status(204).end();
      return res.status(error.statusCode).json({ code: error.code });
    }
    if (originalUid !== null && error instanceof BillingHttpError &&
        ['ACCOUNT_DELETION_BLOCKED', 'BILLING_ACCOUNT_STATE_CONFLICT', 'BILLING_OWNERSHIP_CONFLICT'].includes(error.code)) {
      try {
        const disposition = await classifyRtdnPurchase({ db: originalDb, uid: originalUid, purchaseToken: originalToken });
        if (['RETIRED', 'DELETING'].includes(disposition.status)) return res.status(204).end();
      } catch (_) { /* Indeterminate state remains retryable; no guessed owner. */ }
    }
    if ((error instanceof GooglePlayPayloadError &&
        ['BILLING_PRODUCT_INVALID', 'BILLING_BASE_PLAN_INVALID'].includes(error.code)) ||
        (error instanceof BillingHttpError && error.code === 'BILLING_GOOGLE_REQUEST_REJECTED')) {
      console.error('[billing-rtdn] OWNERSHIP_CONFLICT');
      return res.status(204).end();
    }
    console.error(error?.code === 'GOOGLE_PLAY_UNAVAILABLE'
      ? '[billing-rtdn] GOOGLE_PLAY_UNAVAILABLE' : '[billing-rtdn] RECONCILIATION_RETRY');
    return res.status(503).json({ code: 'RTDN_RECONCILIATION_RETRY' });
  }
}
