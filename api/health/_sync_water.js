import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

// Deliberately closed in the deployed handler. Only trusted server runtime
// injection can open this in tests; no request field or environment enables it.
export const WATER_V2_ENABLED = false;
const MAX_WATER_ML = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INCREMENT_KEYS = ['operation', 'version', 'mutationId', 'healthDay',
  'deltaMl', 'occurredAt', 'timeZoneOffsetMinutes'];
const RECONCILE_KEYS = ['operation', 'version', 'healthDay', 'pendingMutationIds'];
const ERRORS = Object.freeze({
  WATER_INVALID_PAYLOAD: [400, false, 'Payload de hidratação inválido.'],
  WATER_MUTATION_CONFLICT: [409, false, 'Identidade de hidratação reutilizada com conteúdo divergente.'],
  WATER_USER_NOT_FOUND: [404, false, 'Usuário não encontrado.'],
  WATER_ACCOUNT_DELETING: [403, false, 'Conta indisponível para hidratação.'],
  WATER_V2_DISABLED: [503, true, 'Protocolo de hidratação temporariamente indisponível.'],
  WATER_MIGRATION_NOT_READY: [503, true, 'Hidratação V2 ainda não preparada.'],
  WATER_INVALID_REMOTE_STATE: [409, true, 'Estado de hidratação inconsistente.'],
  WATER_SNAPSHOT_MISMATCH: [409, true, 'Snapshot de hidratação incompatível.'],
  WATER_FIRESTORE_UNAVAILABLE: [503, true, 'Não foi possível sincronizar hidratação.'],
});
class WaterError extends Error {
  constructor(code) { super(ERRORS[code][2]); this.code = code; }
}
function fail(code) { throw new WaterError(code); }
export function waterErrorResponse(error) {
  // Never trust a Firestore error's code, message, status or retryable flag.
  const code = error instanceof WaterError ? error.code : 'WATER_FIRESTORE_UNAVAILABLE';
  const [status, retryable, message] = ERRORS[code];
  return { status, body: { error: message, code, retryable } };
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value, keys) {
  return object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}
function uuid(value) { return typeof value === 'string' && UUID.test(value); }
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return false;
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value;
}
function validIntent(value) {
  if (!uuid(value.mutationId) || !day(value.healthDay) || value.deltaMl !== 250 ||
      typeof value.occurredAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.occurredAt) ||
      !Number.isInteger(value.timeZoneOffsetMinutes) ||
      value.timeZoneOffsetMinutes < -840 || value.timeZoneOffsetMinutes > 840) return false;
  const instant = Date.parse(value.occurredAt);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value.occurredAt) return false;
  // Offset is local minus UTC (e.g. São Paulo = -180), captured at occurrence.
  const local = new Date(instant + value.timeZoneOffsetMinutes * 60_000).toISOString();
  return local.slice(0, 10) === value.healthDay;
}
function validate(body) {
  if (!object(body) || body.version !== 2 || !day(body.healthDay)) fail('WATER_INVALID_PAYLOAD');
  if (body.operation === 'increment_water') {
    if (!exact(body, INCREMENT_KEYS) || !validIntent(body)) fail('WATER_INVALID_PAYLOAD');
  } else if (body.operation === 'reconcile_water') {
    const optional = ['expectedEpoch', 'expectedRevision'].filter(key => Object.hasOwn(body, key));
    if (!exact(body, [...RECONCILE_KEYS, ...optional]) ||
        !Array.isArray(body.pendingMutationIds) || body.pendingMutationIds.length > 100 ||
        !body.pendingMutationIds.every(uuid) || new Set(body.pendingMutationIds).size !== body.pendingMutationIds.length ||
        (optional.includes('expectedEpoch') && !uuid(body.expectedEpoch)) ||
        (optional.includes('expectedRevision') && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0))) {
      fail('WATER_INVALID_PAYLOAD');
    }
  } else fail('WATER_INVALID_PAYLOAD');
}
function fingerprint(intent) {
  return createHash('sha256').update(JSON.stringify([2, intent.mutationId,
    intent.healthDay, intent.deltaMl, intent.occurredAt, intent.timeZoneOffsetMinutes])).digest('hex');
}
function validState(state) {
  return exact(state, ['protocolVersion', 'epoch', 'waterIntakeMl', 'revision']) &&
    state.protocolVersion === 2 && uuid(state.epoch) &&
    Number.isSafeInteger(state.waterIntakeMl) && state.waterIntakeMl >= 0 && state.waterIntakeMl <= MAX_WATER_ML &&
    Number.isSafeInteger(state.revision) && state.revision >= 0;
}
function validateReceiptIdentity(receipt, mutationId) {
  if (!exact(receipt, ['protocolVersion', 'mutationId', 'healthDay', 'deltaMl',
    'occurredAt', 'timeZoneOffsetMinutes', 'fingerprint', 'effectiveCreditMl',
    'revision', 'epoch', 'appliedAt']) || receipt.protocolVersion !== 2 ||
    receipt.mutationId !== mutationId || !validIntent(receipt) ||
    receipt.fingerprint !== fingerprint(receipt) ||
    !Number.isSafeInteger(receipt.effectiveCreditMl) || receipt.effectiveCreditMl < 0 || receipt.effectiveCreditMl > 250 ||
    !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || !uuid(receipt.epoch) ||
    !(receipt.appliedAt instanceof Timestamp)) fail('WATER_INVALID_REMOTE_STATE');
}
function validateReceipt(receipt, mutationId, state, healthDay) {
  validateReceiptIdentity(receipt, mutationId);
  if (receipt.epoch !== state.epoch || receipt.healthDay !== healthDay || receipt.revision > state.revision) {
    fail('WATER_SNAPSHOT_MISMATCH');
  }
}
function snapshot(state, healthDay) {
  return { version: 2, healthDay, epoch: state.epoch,
    revision: state.revision, waterIntakeMl: state.waterIntakeMl };
}

// Provisioning is intentionally absent. A future trusted initializer must first
// exclude all V1 water writers and resolve legacy pending intentions. It must
// atomically create activation {protocolVersion:2, epoch:UUIDv4, status:'ACTIVE',
// legacyWritesBlocked:true}, state and matching health_info projection. A truly
// new, proven-empty day starts at 0/revision 0 in the same account epoch. Missing
// documents here are never bootstrapped from an absolute legacy value.
export async function syncWater({ db, userId, body, enabled = WATER_V2_ENABLED }) {
  validate(body);
  if (enabled !== true) fail('WATER_V2_DISABLED');
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128 ||
      userId.trim() !== userId || userId.includes('/') || ['.', '..'].includes(userId) ||
      /^__.*__$/.test(userId)) fail('WATER_USER_NOT_FOUND');
  const user = db.collection('users').doc(userId);
  const guard = db.collection('account_deletion_guards').doc(userId);
  const activation = user.collection('water_protocol').doc('activation');
  const stateRef = user.collection('water_state').doc(body.healthDay);
  const projectionRef = user.collection('health_info').doc(body.healthDay);
  const ids = body.operation === 'increment_water' ? [body.mutationId] : body.pendingMutationIds;
  const receiptRefs = ids.map(id => user.collection('water_increment_receipts').doc(id));
  return db.runTransaction(async tx => {
    const userDoc = await tx.get(user);
    const guardDoc = await tx.get(guard);
    const activationDoc = await tx.get(activation);
    const stateDoc = await tx.get(stateRef);
    const receiptDocs = [];
    for (const ref of receiptRefs) receiptDocs.push(await tx.get(ref));
    const projectionDoc = await tx.get(projectionRef);
    if (!userDoc.exists) fail('WATER_USER_NOT_FOUND');
    // Any existing guard blocks, including expired COMPLETE and malformed data.
    if (guardDoc.exists) fail('WATER_ACCOUNT_DELETING');
    if (!activationDoc.exists) fail('WATER_MIGRATION_NOT_READY');
    const active = activationDoc.data();
    if (!exact(active, ['protocolVersion', 'epoch', 'status', 'legacyWritesBlocked']) ||
        active.protocolVersion !== 2 || !uuid(active.epoch) || active.status !== 'ACTIVE' ||
        active.legacyWritesBlocked !== true) fail('WATER_MIGRATION_NOT_READY');
    // A UUID is account-wide, so divergent reuse must conflict even if the new
    // requested day has not been provisioned. Account/activation checks precede
    // this; a receipt never grants permission to a deleted or inactive account.
    if (body.operation === 'increment_water' && receiptDocs[0].exists) {
      const receipt = receiptDocs[0].data();
      validateReceiptIdentity(receipt, body.mutationId);
      if (receipt.fingerprint !== fingerprint(body)) fail('WATER_MUTATION_CONFLICT');
    }
    if (!stateDoc.exists || !projectionDoc.exists) fail('WATER_MIGRATION_NOT_READY');
    const state = stateDoc.data();
    const projection = projectionDoc.data();
    if (!validState(state) || state.epoch !== active.epoch || !object(projection) ||
        projection.waterIntakeMl !== state.waterIntakeMl) fail('WATER_INVALID_REMOTE_STATE');
    if (body.operation === 'reconcile_water') {
      if ((Object.hasOwn(body, 'expectedEpoch') && body.expectedEpoch !== state.epoch) ||
          (Object.hasOwn(body, 'expectedRevision') && body.expectedRevision !== state.revision)) fail('WATER_SNAPSHOT_MISMATCH');
      const recognized = [];
      const unrecognizedMutationIds = [];
      receiptDocs.forEach((doc, index) => {
        if (!doc.exists) { unrecognizedMutationIds.push(ids[index]); return; }
        const receipt = doc.data();
        validateReceipt(receipt, ids[index], state, body.healthDay);
        recognized.push({ mutationId: ids[index], effectiveCreditMl: receipt.effectiveCreditMl,
          appliedRevision: receipt.revision });
      });
      return { ...snapshot(state, body.healthDay), complete: true, recognized, unrecognizedMutationIds };
    }
    if (receiptDocs[0].exists) {
      const receipt = receiptDocs[0].data();
      validateReceipt(receipt, body.mutationId, state, body.healthDay);
      return { ...snapshot(state, body.healthDay), alreadyApplied: true,
        effectiveCreditMl: receipt.effectiveCreditMl, appliedRevision: receipt.revision };
    }
    if (state.revision === Number.MAX_SAFE_INTEGER) fail('WATER_INVALID_REMOTE_STATE');
    const total = Math.min(MAX_WATER_ML, state.waterIntakeMl + 250);
    const next = { ...state, waterIntakeMl: total, revision: state.revision + 1 };
    const effectiveCreditMl = total - state.waterIntakeMl;
    tx.set(stateRef, next);
    // Only the existing water field changes; no administrative projection data.
    tx.update(projectionRef, { waterIntakeMl: total });
    tx.set(receiptRefs[0], { protocolVersion: 2, mutationId: body.mutationId,
      healthDay: body.healthDay, deltaMl: 250, occurredAt: body.occurredAt,
      timeZoneOffsetMinutes: body.timeZoneOffsetMinutes, fingerprint: fingerprint(body),
      effectiveCreditMl, revision: next.revision, epoch: next.epoch,
      appliedAt: FieldValue.serverTimestamp() });
    return { ...snapshot(next, body.healthDay), alreadyApplied: false,
      effectiveCreditMl, appliedRevision: next.revision };
  });
}
