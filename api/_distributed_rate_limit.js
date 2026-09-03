import { createHash } from 'node:crypto';

const RATE_LIMIT_COLLECTION = 'server_rate_limits';
const ALLOWED_SCOPES = new Set([
  'chat',
  'sync',
  'account_delete',
  'activity_task_complete',
  'activity_habit_complete',
  'focus_start',
  'focus_finish',
  'focus_cancel',
  'circle_delete',
]);

function rateLimitDocumentId(scope, uid) {
  const uidHash = createHash('sha256').update(uid, 'utf8').digest('hex');
  return `${scope}_${uidHash}`;
}

function validateConfiguration({ db, scope, uid, limit, windowMs, nowMs }) {
  if (
    !db ||
    typeof db.collection !== 'function' ||
    typeof db.runTransaction !== 'function' ||
    !ALLOWED_SCOPES.has(scope) ||
    typeof uid !== 'string' ||
    uid.length === 0 ||
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs <= 0 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    throw new Error('INVALID_DISTRIBUTED_RATE_LIMIT_CONFIGURATION');
  }
}

function readStoredState(snapshot) {
  if (!snapshot.exists) return null;

  const data = snapshot.data();
  const windowStartMs = data?.windowStartMs;
  const count = data?.count;

  if (
    !Number.isSafeInteger(windowStartMs) ||
    windowStartMs < 0 ||
    !Number.isSafeInteger(count) ||
    count < 1
  ) {
    throw new Error('INVALID_DISTRIBUTED_RATE_LIMIT_STATE');
  }

  return { windowStartMs, count };
}

export async function checkDistributedRateLimit({
  db,
  scope,
  uid,
  limit,
  windowMs,
  nowMs = Date.now(),
}) {
  try {
    validateConfiguration({ db, scope, uid, limit, windowMs, nowMs });

    const documentId = rateLimitDocumentId(scope, uid);
    const documentRef = db.collection(RATE_LIMIT_COLLECTION).doc(documentId);

    return await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(documentRef);
      const stored = readStoredState(snapshot);

      if (
        stored === null ||
        nowMs - stored.windowStartMs >= windowMs
      ) {
        transaction.set(documentRef, {
          windowStartMs: nowMs,
          count: 1,
        });
        return true;
      }

      if (nowMs < stored.windowStartMs) {
        throw new Error('INVALID_DISTRIBUTED_RATE_LIMIT_STATE');
      }

      if (stored.count >= limit) return false;

      transaction.set(documentRef, {
        windowStartMs: stored.windowStartMs,
        count: stored.count + 1,
      });
      return true;
    });
  } catch (_) {
    throw new Error('DISTRIBUTED_RATE_LIMIT_FAILED');
  }
}
