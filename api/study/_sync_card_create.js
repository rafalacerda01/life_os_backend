import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

export const REVIEW_CARD_CREATE_MAX_BYTES = 512 * 1024;
const OPERATION = 'create_review_card';
const VERSION = 1;
const FIELDS = ['operation', 'version', 'cardId', 'subjectId', 'question', 'answer', 'createdAt'];
const RECEIPT_FIELDS = ['version', 'uid', 'operation', 'operationId', 'subjectId',
  'payloadFingerprint', 'state', 'appliedAt', 'cardCreated', 'reviewQueueDelta', 'cardsToReviewDelta'];
const definition = (statusCode, message) => Object.freeze({statusCode, messages: Object.freeze([message])});
export const REVIEW_CARD_CREATE_ERRORS = Object.freeze({
  REVIEW_CREATE_PAYLOAD_TOO_LARGE: definition(413, 'Payload de criação de flashcard excede o limite permitido.'),
  REVIEW_CREATE_LEGACY_UNVERIFIED: definition(409, 'A criação anterior do flashcard exige recuperação.'),
  REVIEW_CREATE_RECEIPT_INVALID: definition(503, 'A confirmação de criação do flashcard exige recuperação.'),
  REVIEW_CREATE_FINGERPRINT_CONFLICT: definition(409, 'A identidade de criação do flashcard possui outro conteúdo.'),
  REVIEW_CREATE_ROOT_UNAVAILABLE: definition(503, 'A conta da criação do flashcard exige recuperação.'),
  REVIEW_CREATE_SUBJECT_UNAVAILABLE: definition(409, 'A matéria da criação do flashcard não está disponível.'),
  REVIEW_CREATE_SUBJECT_TOMBSTONED: definition(409, 'A matéria da criação do flashcard foi removida.'),
  REVIEW_CREATE_STATE_INVALID: definition(503, 'Os contadores da criação do flashcard exigem recuperação.'),
});
function failure(code) {
  const entry = REVIEW_CARD_CREATE_ERRORS[code];
  return Object.assign(new Error(entry.messages[0]), {statusCode: entry.statusCode, code});
}
function plain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields) {
  return plain(value) && Reflect.ownKeys(value).length === fields.length &&
    fields.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function text(value) { return typeof value === 'string' && value.isWellFormed(); }
function identifier(value) { return text(value) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
function serverUid(value) {
  return text(value) && value.length > 0 && value.length <= 128 && value.trim() === value &&
    value !== '.' && value !== '..' && !value.includes('/') &&
    ![...value].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}
function timestamp(value) { return value instanceof Timestamp; }
function storedTime(value) { return timestamp(value) || (value instanceof Date && Number.isFinite(value.getTime())); }
function canonicalTimestamp(value) {
  if (!text(value)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(\d{3})?Z$/.exec(value);
  if (!m || (m[8] === '000')) return null; // Dart emits milliseconds if the microsecond remainder is zero.
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return new Timestamp(date.getTime() / 1000, Number(m[7] + (m[8] ?? '000')) * 1000);
}
export function validateStudyCardCreatePayload(body) {
  const invalid = {valid: false, statusCode: 400, code: 'INVALID_PAYLOAD', error: 'Payload de criação de flashcard inválido.'};
  try {
    if (!exact(body, FIELDS) || body.operation !== OPERATION || body.version !== VERSION ||
      !identifier(body.cardId) || !identifier(body.subjectId) ||
      !text(body.question) || !body.question.trim() || !text(body.answer) || !body.answer.trim()) return invalid;
    const createdAt = canonicalTimestamp(body.createdAt);
    if (!createdAt) return invalid;
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > REVIEW_CARD_CREATE_MAX_BYTES) {
      const error = REVIEW_CARD_CREATE_ERRORS.REVIEW_CREATE_PAYLOAD_TOO_LARGE;
      return {valid: false, statusCode: error.statusCode, code: 'REVIEW_CREATE_PAYLOAD_TOO_LARGE', error: error.messages[0]};
    }
    return {valid: true, createdAt, value: Object.freeze({...body})};
  } catch (_) { return invalid; }
}
export function studyCardCreateFingerprint(userId, body) {
  const validation = validateStudyCardCreatePayload(body);
  if (!serverUid(userId) || !validation.valid) throw new TypeError('Invalid review-create fingerprint input.');
  const hash = createHash('sha256');
  for (const field of ['review-create-v1', userId, body.cardId, body.subjectId, body.question, body.answer, body.createdAt]) {
    const bytes = Buffer.from(field, 'utf8');
    hash.update(String(bytes.length) + ':', 'ascii');
    hash.update(bytes);
  }
  return hash.digest('hex');
}
async function read(transaction, ref) {
  const snapshot = await transaction.get(ref);
  if (!snapshot || typeof snapshot.exists !== 'boolean' || typeof snapshot.data !== 'function' || snapshot.ref?.path !== ref.path) {
    throw new Error('Unconfirmed review-create snapshot.');
  }
  const data = snapshot.data();
  if (!snapshot.exists && data !== undefined) {
    throw new Error('Unconfirmed review-create snapshot data.');
  }
  return {exists: snapshot.exists, data};
}
function validReceipt(data, userId, cardId) {
  return exact(data, RECEIPT_FIELDS) && data.version === VERSION && data.uid === userId &&
    data.operation === OPERATION && data.operationId === cardId && identifier(data.subjectId) &&
    typeof data.payloadFingerprint === 'string' && /^[a-f0-9]{64}$/.test(data.payloadFingerprint) &&
    data.state === 'APPLIED' && timestamp(data.appliedAt) && data.cardCreated === true &&
    data.reviewQueueDelta === 1 && data.cardsToReviewDelta === 1;
}
function counter(data, field) {
  if (!plain(data) || !Number.isSafeInteger(data[field]) || data[field] < 0 || data[field] >= Number.MAX_SAFE_INTEGER) {
    throw failure('REVIEW_CREATE_STATE_INVALID');
  }
  return data[field];
}
function knownStudyFields(data) {
  if ((Object.hasOwn(data, 'streak') && (!Number.isSafeInteger(data.streak) || data.streak < 0)) ||
    (Object.hasOwn(data, 'progress') && (typeof data.progress !== 'number' || !Number.isFinite(data.progress) || data.progress < 0 || data.progress > 1)) ||
    (Object.hasOwn(data, 'lastStudyDate') && data.lastStudyDate !== null && !storedTime(data.lastStudyDate)) ||
    (Object.hasOwn(data, 'updatedAt') && !storedTime(data.updatedAt))) {
    throw failure('REVIEW_CREATE_STATE_INVALID');
  }
}

function knownSubjectFields(data) {
  if ((Object.hasOwn(data, 'streakDays') && (!Number.isSafeInteger(data.streakDays) || data.streakDays < 0)) ||
    (Object.hasOwn(data, 'progress') && (typeof data.progress !== 'number' || !Number.isFinite(data.progress) || data.progress < 0 || data.progress > 1)) ||
    (Object.hasOwn(data, 'hasExam') && typeof data.hasExam !== 'boolean') ||
    (Object.hasOwn(data, 'examDate') && data.examDate !== null && !storedTime(data.examDate)) ||
    (data.hasExam === true && !storedTime(data.examDate)) ||
    (Object.hasOwn(data, 'createdAt') && !storedTime(data.createdAt)) ||
    (Object.hasOwn(data, 'updatedAt') && !storedTime(data.updatedAt))) throw failure('REVIEW_CREATE_STATE_INVALID');
}

// The caller must pass Sync's guardedDb; its transaction entry performs the
// three R5 reads before this callback on EVERY attempt. No cleaner capability.
export async function createStudyCard({db, userId, body}) {
  const validation = validateStudyCardCreatePayload(body);
  if (!validation.valid) throw new TypeError('Invalid review-create payload.');
  if (!serverUid(userId)) throw failure('REVIEW_CREATE_ROOT_UNAVAILABLE');
  const {cardId, subjectId, question, answer} = validation.value;
  const fingerprint = studyCardCreateFingerprint(userId, validation.value);
  const root = db.collection('users').doc(userId);
  if (root.path !== `users/${userId}`) throw failure('REVIEW_CREATE_ROOT_UNAVAILABLE');
  const receiptRef = root.collection('study_card_create_receipts').doc(cardId);
  const cardRef = root.collection('review_queue').doc(cardId);
  const subjectRef = root.collection('subjects').doc(subjectId);
  const infoRef = root.collection('study_info').doc('main');
  const tombstoneRef = root.collection('sync_tombstones').doc(`subjects__${subjectId}`);
  const outcome = await db.runTransaction(async transaction => {
    const account = await read(transaction, root);
    if (!account.exists || !plain(account.data) || (Object.hasOwn(account.data, 'uid') && account.data.uid !== userId) || Object.hasOwn(account.data, '_serverAccountDeletion')) {
      throw failure('REVIEW_CREATE_ROOT_UNAVAILABLE');
    }
    const receipt = await read(transaction, receiptRef);
    if (receipt.exists) {
      if (!validReceipt(receipt.data, userId, cardId)) throw failure('REVIEW_CREATE_RECEIPT_INVALID');
      if (receipt.data.payloadFingerprint !== fingerprint) throw failure('REVIEW_CREATE_FINGERPRINT_CONFLICT');
      if (receipt.data.subjectId !== subjectId) throw failure('REVIEW_CREATE_RECEIPT_INVALID');
      // Historical effects can have been followed by review or Subject deletion.
      // Never restore current card/counters as part of replay.
      return 'REPLAYED';
    }
    const card = await read(transaction, cardRef);
    const subject = await read(transaction, subjectRef);
    const info = await read(transaction, infoRef);
    const tombstone = await read(transaction, tombstoneRef);
    if (tombstone.exists) throw failure('REVIEW_CREATE_SUBJECT_TOMBSTONED');
    if (card.exists) throw failure('REVIEW_CREATE_LEGACY_UNVERIFIED');
    if (!subject.exists) throw failure('REVIEW_CREATE_SUBJECT_UNAVAILABLE');
    if (!plain(subject.data) || (Object.hasOwn(subject.data, 'uid') && subject.data.uid !== userId) ||
      (Object.hasOwn(subject.data, 'title') && (typeof subject.data.title !== 'string' || !subject.data.title.trim() || subject.data.title.length > 200))) throw failure('REVIEW_CREATE_STATE_INVALID');
    knownSubjectFields(subject.data);
    const cardsToReview = counter(subject.data, 'cardsToReview');
    const reviewQueue = info.exists ? counter(info.data, 'reviewQueue') : 0;
    if (info.exists) knownStudyFields(info.data);
    transaction.set(cardRef, {subjectId, question, answer, createdAt: validation.createdAt});
    transaction.set(infoRef, {reviewQueue: reviewQueue + 1}, {merge: true});
    transaction.update(subjectRef, {cardsToReview: cardsToReview + 1});
    transaction.set(receiptRef, {version: VERSION, uid: userId, operation: OPERATION,
      operationId: cardId, subjectId, payloadFingerprint: fingerprint, state: 'APPLIED',
      appliedAt: FieldValue.serverTimestamp(), cardCreated: true, reviewQueueDelta: 1, cardsToReviewDelta: 1});
    return 'APPLIED';
  });
  // No ACK is constructed until the transaction's commit/readonly completion
  // is known. Any exception propagates to the existing sanitized Sync handler.
  return {success: true, operation: OPERATION, version: VERSION, uid: userId,
    operationId: cardId, fingerprint, outcome, effectsCommitted: true};
}
