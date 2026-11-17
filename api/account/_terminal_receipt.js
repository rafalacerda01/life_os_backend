import {createHash, timingSafeEqual} from 'node:crypto';
import control from './_deletion_control.cjs';
import manifest from './_cleanup_manifest.cjs';
import trustedAccount from './_trusted_account.cjs';
import {AccountHttpError, hasExactKeys} from './_shared.js';

const LIFETIME_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function isReceiptKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}

function forbidden() {
  return new AccountHttpError(401, 'DELETION_RECEIPT_UNAUTHORIZED', 'Consulta de exclusao nao autorizada.');
}

function unavailable() {
  return new AccountHttpError(503, 'DELETION_RECEIPT_UNAVAILABLE', 'Resultado da exclusao indisponivel.');
}

const digest = key => createHash('sha256').update(Buffer.from(key, 'base64url')).digest('hex');
const ref = (db, uid) => db.doc(`account_deletion_guards/${uid}/control/receipt`);

function authorized(record, {uid, generation, key, now}) {
  return record?.version === 1 && record.uid === uid && record.generation === generation &&
    record.revoked === false && Number.isSafeInteger(record.expiresAt) && now < record.expiresAt &&
    typeof record.keyHash === 'string' && SHA256.test(record.keyHash) &&
    timingSafeEqual(Buffer.from(record.keyHash, 'hex'), Buffer.from(digest(key), 'hex'));
}

// Read-only preparation. The controller creates this record with the operation.
export async function buildAdmissionReceipt(tx, db, operation, {generation, key, now}) {
  if (!isReceiptKey(key) || typeof generation !== 'string' || !UUID.test(generation) ||
      !Number.isSafeInteger(now)) throw forbidden();
  const {uid, projectId, databaseId, deletionId} = operation;
  const recordRef = ref(db, uid);
  const current = await tx.get(recordRef);
  if (current.exists) throw unavailable();
  const origin = (await tx.get(db.doc(`${trustedAccount.REGISTRY}/${uid}`))).data();
  if (origin?.state !== 'ACTIVE' || origin.generation !== generation || origin.deletionId !== null ||
      origin.uid !== uid || origin.projectId !== projectId || origin.databaseId !== databaseId) {
    throw forbidden();
  }
  const {header} = manifest.refs(db, operation, operation.scope.privateRoot);
  const sealed = await tx.get(header);
  if (sealed.exists) throw unavailable();
  return {version: 1, uid, generation, projectId, databaseId, deletionId,
    keyHash: digest(key), expiresAt: now + LIFETIME_MS, revoked: false};
}

async function readReceipt(db, {uid, generation, receiptKey: key}, now) {
  trustedAccount.assertEnvironment(db);
  const binding = control.validateBinding({projectId: db.projectId, databaseId: db.databaseId, uid});
  return db.runTransaction(async tx => {
    const keyRecord = (await tx.get(ref(db, uid))).data();
    if (!authorized(keyRecord, {uid, generation, key, now}) || keyRecord.projectId !== binding.projectId ||
        keyRecord.databaseId !== binding.databaseId) throw forbidden();

    const refs = control.references(db, binding);
    const original = (await tx.get(refs.operation)).data();
    const operation = control.validateControl(original, binding);
    if (operation.origin !== 'PRE_AUTH' || !operation.scope || operation.deletionId !== keyRecord.deletionId) {
      throw unavailable();
    }
    const origin = (await tx.get(db.doc(`${trustedAccount.REGISTRY}/${uid}`))).data();
    if (origin?.version !== 1 || origin.uid !== uid || origin.generation !== generation ||
        origin.projectId !== binding.projectId || origin.databaseId !== binding.databaseId) {
      throw unavailable();
    }
    const root = operation.scope.privateRoot;
    const {header} = manifest.refs(db, operation, root);
    const sealed = (await tx.get(header)).data();
    const awaitingOrigin = origin.state === 'ACTIVE' && origin.deletionId === null &&
      operation.state === 'IN_PROGRESS' && !sealed;
    if (!awaitingOrigin && (origin.deletionId !== operation.deletionId ||
        !['DELETING', 'RETIRED'].includes(origin.state))) throw unavailable();
    let state = 'PENDING';
    let evidence = null;
    if (sealed?.authOutcome === 'UNKNOWN') {
      // The normal validator refuses UNKNOWN. Validate its structure without promoting it.
      manifest.validateHeader({...sealed, authOutcome: 'DISPATCHED'}, operation, root);
      if (sealed.state !== 'SEALED' || operation.state !== 'IN_PROGRESS' || origin.state !== 'DELETING') throw unavailable();
      state = 'UNKNOWN';
    } else if (sealed || operation.state === 'COMPLETE') {
      const h = manifest.validateHeader(sealed, operation, root);
      if (operation.state === 'COMPLETE') {
        if (h.state !== 'COMPLETE' || h.authOutcome !== 'CONFIRMED') throw unavailable();
        if (origin.state === 'RETIRED') {
          state = 'CONFIRMED';
          evidence = {operationState: 'COMPLETE', manifestState: 'COMPLETE', authOutcome: 'CONFIRMED'};
        }
      }
    }
    return {version: 1, ...binding, generation, operationId: operation.deletionId, state,
      manifestRef: header.path, evidence};
  }, {readOnly: true});
}

// Explicit local route. There is no Firebase Auth fallback and no mutation port.
export async function terminalReceiptHandler(req, res, runtime) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({code: 'METHOD_NOT_ALLOWED'});
  try {
    const appCheck = req.headers?.['x-firebase-appcheck'];
    if (typeof appCheck !== 'string' || !appCheck.trim()) throw forbidden();
    try { await runtime.verifyAppCheckToken(appCheck.trim()); } catch (_) { throw forbidden(); }
    const body = req.body;
    if (req.headers?.authorization !== undefined || !hasExactKeys(body, ['uid', 'generation', 'receiptKey']) ||
        typeof body.generation !== 'string' || !UUID.test(body.generation) || !isReceiptKey(body.receiptKey)) {
      throw forbidden();
    }
    const {db} = runtime.getServices();
    try { control.validateBinding({projectId: db.projectId, databaseId: db.databaseId, uid: body.uid}); }
    catch (_) { throw forbidden(); }
    return res.status(200).json(await readReceipt(db, body, runtime.nowProvider?.() ?? Date.now()));
  } catch (error) {
    const safe = error instanceof AccountHttpError ? error : unavailable();
    return res.status(safe.statusCode).json({code: safe.code});
  }
}
