import {getApps, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getFirestore} from "firebase-admin/firestore";
import {getAppCheck} from "firebase-admin/app-check";
import trusted from './_trusted_account.cjs';
import {AccountHttpError, createAccountHandler} from './_shared.js';

export async function bootstrapTrustedAccount({db, auth, decodedToken}) {
  try { return {body: await trusted.provision(db, auth, decodedToken)}; }
  catch (error) {
    const code = error?.code === 'TRUSTED_ACCOUNT_CLOSED' ? error.code : 'TRUSTED_ACCOUNT_REVIEW_REQUIRED';
    throw new AccountHttpError(code === 'TRUSTED_ACCOUNT_CLOSED' ? 503 : 409, code,
      'A origem da conta precisa de preparo ou revisão.');
  }
}
// Existing App Check, revoked-token verification, own UID, recency and limiter.
// No generation/ownership argument is accepted from the HTTP request body.
function demoServices() {
  trusted.assertEnvironment({projectId: process.env.GCLOUD_PROJECT, databaseId: '(default)'});
  let app = getApps().find(a => a.name === 'lifeos-trusted-demo');
  app ??= initializeApp({projectId: 'demo-life-os', credential: {
    getAccessToken: async () => ({access_token: 'owner', expires_in: 3600}),
  }}, 'lifeos-trusted-demo');
  return {auth: getAuth(app), db: getFirestore(app), appCheck: getAppCheck(app)};
}
const handler = createAccountHandler('bootstrap', 'TRUSTED_ACCOUNT_BOOTSTRAP_FAILED', bootstrapTrustedAccount, {getServices: demoServices});
export default async function bootstrapHandler(req, res) {
  try { trusted.assertEnvironment({projectId: process.env.GCLOUD_PROJECT, databaseId: '(default)'}); }
  catch (_) { return res.status(503).json({code: 'TRUSTED_ACCOUNT_CLOSED'}); }
  // App Check remains mandatory. There is no App Check emulator/bypass here.
  return handler(req, res);
}
