import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_DURATIONS_SECONDS,
  calculateExpiresAtMillis,
  decideCancelAction,
  decideFinishAction,
  decideStartAction,
  FocusHttpError,
  FOCUS_EXPIRY_GRACE_SECONDS,
  hasExactKeys,
  startActionRequiresTarget,
  validateDuration,
  validateSessionId,
  validateSessionPayload,
  validateStartPayload,
  validateTargetId,
  validateTargetType,
} from '../api/focus/_shared.js';

function fakeTimestamp(milliseconds) {
  return { toMillis: () => milliseconds };
}

function assertInvalidPayload(callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof FocusHttpError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, 'INVALID_FOCUS_PAYLOAD');
    return true;
  });
}

test('start payload accepts only its exact schema', () => {
  const payload = {
    targetId: 'task-1',
    targetType: 'TASK',
    plannedDurationSeconds: 1500,
  };

  assert.deepEqual(validateStartPayload(payload), payload);
  assert.equal(hasExactKeys(payload, Object.keys(payload)), true);
  assertInvalidPayload(() => validateStartPayload({ ...payload, uid: 'x' }));
  assertInvalidPayload(() => validateStartPayload([payload]));
  assertInvalidPayload(() => validateStartPayload(null));
  assertInvalidPayload(() => validateStartPayload({}));
});

test('targetId is trimmed, bounded and cannot contain a path', () => {
  assert.equal(validateTargetId('  target-1  '), 'target-1');
  assertInvalidPayload(() => validateTargetId(''));
  assertInvalidPayload(() => validateTargetId('   '));
  assertInvalidPayload(() => validateTargetId('tasks/target-1'));
  assertInvalidPayload(() => validateTargetId('x'.repeat(129)));
  assertInvalidPayload(() => validateTargetId(123));
});

test('targetType supports exactly TASK and SUBJECT', () => {
  assert.equal(validateTargetType('TASK'), 'TASK');
  assert.equal(validateTargetType('SUBJECT'), 'SUBJECT');
  for (const invalid of ['EXAM', 'task', '', null]) {
    assertInvalidPayload(() => validateTargetType(invalid));
  }
});

test('duration supports only the server allowlist of integers', () => {
  for (const duration of ALLOWED_DURATIONS_SECONDS) {
    assert.equal(validateDuration(duration), duration);
  }
  for (const invalid of [0, -1, 60.5, '60', 61, 300, 3600]) {
    assertInvalidPayload(() => validateDuration(invalid));
  }
});

test('session payload accepts one safe sessionId only', () => {
  assert.deepEqual(validateSessionPayload({ sessionId: ' session-1 ' }), {
    sessionId: 'session-1',
  });
  assert.equal(validateSessionId('session-1'), 'session-1');
  assertInvalidPayload(() => validateSessionId('users/u/session'));
  assertInvalidPayload(() =>
    validateSessionPayload({
      sessionId: 'session-1',
      verifiedDurationSeconds: 1500,
    }),
  );
});

test('expiration adds planned duration and the fixed grace period', () => {
  const startedAt = 1_000_000;
  assert.equal(
    calculateExpiresAtMillis(startedAt, 1500),
    startedAt + (1500 + FOCUS_EXPIRY_GRACE_SECONDS) * 1000,
  );
});

test('finish requires the full duration and expires only after expiresAt', () => {
  const startedAtMillis = 1_000_000;
  const plannedDurationSeconds = 60;
  const readyAtMillis = startedAtMillis + 60_000;
  const expiresAtMillis = calculateExpiresAtMillis(
    startedAtMillis,
    plannedDurationSeconds,
  );
  const input = {
    status: 'RUNNING',
    startedAtMillis,
    expiresAtMillis,
    plannedDurationSeconds,
  };

  assert.equal(
    decideFinishAction({ ...input, nowMillis: readyAtMillis - 1 }),
    'NOT_READY',
  );
  assert.equal(
    decideFinishAction({ ...input, nowMillis: readyAtMillis }),
    'COMPLETE',
  );
  assert.equal(
    decideFinishAction({ ...input, nowMillis: expiresAtMillis }),
    'COMPLETE',
  );
  assert.equal(
    decideFinishAction({ ...input, nowMillis: expiresAtMillis + 1 }),
    'MARK_EXPIRED',
  );
});

test('finish terminal states are replayed or rejected without transitions', () => {
  assert.equal(decideFinishAction({ status: 'COMPLETED' }), 'REPLAY');
  assert.equal(decideFinishAction({ status: 'CANCELLED' }), 'CANCELLED');
  assert.equal(decideFinishAction({ status: 'EXPIRED' }), 'EXPIRED');
  assert.equal(decideFinishAction({ status: 'UNKNOWN' }), 'STATE_CONFLICT');
});

test('cancel uses expiresAt as an inclusive temporal boundary', () => {
  const expiresAtMillis = 2_000_000;
  const running = (nowMillis) =>
    decideCancelAction({
      status: 'RUNNING',
      nowMillis,
      expiresAtMillis,
    });

  assert.equal(running(expiresAtMillis - 1), 'CANCEL');
  assert.equal(running(expiresAtMillis), 'CANCEL');
  assert.equal(running(expiresAtMillis + 1), 'MARK_EXPIRED');
});

test('cancel preserves terminal-state behavior', () => {
  assert.equal(
    decideCancelAction({ status: 'CANCELLED' }),
    'REPLAY',
  );
  assert.equal(decideCancelAction({ status: 'EXPIRED' }), 'EXPIRED');
  assert.equal(
    decideCancelAction({ status: 'COMPLETED' }),
    'COMPLETED',
  );
  assert.equal(
    decideCancelAction({ status: 'UNKNOWN' }),
    'STATE_CONFLICT',
  );
});

test('start decision reuses only the same non-expired request', () => {
  const startedAtMillis = 1_000_000;
  const request = {
    targetId: 'task-1',
    targetType: 'TASK',
    plannedDurationSeconds: 60,
  };
  const pointer = {
    sessionId: 'session-1',
    ...request,
    startedAt: fakeTimestamp(startedAtMillis),
    expiresAt: fakeTimestamp(
      calculateExpiresAtMillis(startedAtMillis, 60),
    ),
    schemaVersion: 1,
  };

  assert.equal(
    decideStartAction({ pointer: null, request, nowMillis: startedAtMillis }),
    'CREATE',
  );
  assert.equal(
    decideStartAction({ pointer, request, nowMillis: startedAtMillis }),
    'REUSE',
  );
  assert.equal(
    decideStartAction({
      pointer,
      request: { ...request, plannedDurationSeconds: 180 },
      nowMillis: startedAtMillis,
    }),
    'ACTIVE_CONFLICT',
  );
  assert.equal(
    decideStartAction({
      pointer,
      request,
      nowMillis: pointer.expiresAt.toMillis() + 1,
    }),
    'REPLACE_EXPIRED',
  );
});

test('start fails closed for a malformed or orphan-prone pointer', () => {
  const request = {
    targetId: 'task-1',
    targetType: 'TASK',
    plannedDurationSeconds: 60,
  };
  assert.equal(
    decideStartAction({
      pointer: {
        sessionId: 'session-1',
        ...request,
        startedAt: fakeTimestamp(1_000_000),
        expiresAt: fakeTimestamp(2_000_000),
        schemaVersion: 1,
      },
      request,
      nowMillis: 1_000_000,
    }),
    'STATE_CONFLICT',
  );
});

test('only CREATE and REPLACE_EXPIRED require a current target', () => {
  assert.equal(startActionRequiresTarget('REUSE'), false);
  assert.equal(startActionRequiresTarget('CREATE'), true);
  assert.equal(startActionRequiresTarget('REPLACE_EXPIRED'), true);
  assert.equal(startActionRequiresTarget('ACTIVE_CONFLICT'), false);
});
