import { GooglePlayPayloadError } from './_entitlement.js';
import { getGooglePlaySubscription, GooglePlayRequestError } from './_google_play.js';
import { reconcileGooglePlayPurchase, resolveOwnership, sha256 } from './_reconciliation.js';
import { BillingHttpError, getFirebaseServices } from './_shared.js';
import {
  RtdnHttpError, assertRtdnBodyLimit, authenticateRtdn, decodeRtdnEnvelope,
} from './_rtdn_shared.js';

export default async function rtdnHandler(req, res, runtime = {}) {
  // Pub/Sub ingress has no app CORS, Firebase Auth or App Check contract.
  if (req.method !== 'POST') return res.status(405).json({ code: 'METHOD_NOT_ALLOWED' });
  let authenticated = false;
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
    const purchaseToken = notification.purchaseToken;
    let uid = await resolveOwnership({ db, purchaseToken });
    if (uid === null) {
      // Late messages for removed/DELETING accounts are ACKed, not retried.
      const index = await db.collection('billing_google_tokens').doc(sha256(purchaseToken)).get();
      if (index.exists) return res.status(204).end();
      let discovery;
      try {
        discovery = await (runtime.getGooglePlaySubscription ?? getGooglePlaySubscription)(purchaseToken);
      } catch (error) {
        if (error instanceof GooglePlayRequestError && !error.retryable) {
          throw new BillingHttpError(409, 'BILLING_GOOGLE_REQUEST_REJECTED',
            'A Google Play rejeitou o purchase token.');
        }
        throw new BillingHttpError(503, 'GOOGLE_PLAY_UNAVAILABLE', 'Nao foi possivel consultar a Google Play.');
      }
      uid = await resolveOwnership({ db, purchaseToken, payload: discovery });
      if (uid === null) return res.status(204).end();
    }
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
    if (error instanceof GooglePlayPayloadError || (error instanceof BillingHttpError && error.statusCode < 500)) {
      console.error('[billing-rtdn] OWNERSHIP_CONFLICT');
      return res.status(204).end();
    }
    console.error(error?.code === 'GOOGLE_PLAY_UNAVAILABLE'
      ? '[billing-rtdn] GOOGLE_PLAY_UNAVAILABLE' : '[billing-rtdn] RECONCILIATION_RETRY');
    return res.status(503).json({ code: 'RTDN_RECONCILIATION_RETRY' });
  }
}
