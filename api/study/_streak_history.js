const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MIN_TIME_ZONE_OFFSET_MINUTES = -840;
const MAX_TIME_ZONE_OFFSET_MINUTES = 840;
const RANGE_KEYS = new Set(['startDayOrdinal', 'endDayOrdinal']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.size && actualKeys.every((key) => keys.has(key));
}

export function canonicalLocalDayOrdinal(date, timeZoneOffsetMinutes) {
  if (
    !(date instanceof Date) ||
    !Number.isFinite(date.getTime()) ||
    !Number.isInteger(timeZoneOffsetMinutes) ||
    timeZoneOffsetMinutes < MIN_TIME_ZONE_OFFSET_MINUTES ||
    timeZoneOffsetMinutes > MAX_TIME_ZONE_OFFSET_MINUTES
  ) {
    throw new TypeError('INVALID_STUDY_DAY');
  }

  const localTimestamp = date.getTime() + timeZoneOffsetMinutes * 60 * 1000;
  const localInstant = new Date(localTimestamp);
  return Math.floor(
    Date.UTC(
      localInstant.getUTCFullYear(),
      localInstant.getUTCMonth(),
      localInstant.getUTCDate(),
    ) / MILLISECONDS_PER_DAY,
  );
}

function rangeKey(range) {
  return range.ref.path ?? range.ref.id;
}

function readRange(document, stateInvalid) {
  const data = document.data();
  if (
    !isPlainObject(data) ||
    !hasExactKeys(data, RANGE_KEYS) ||
    !Number.isInteger(data.startDayOrdinal) ||
    !Number.isInteger(data.endDayOrdinal) ||
    data.startDayOrdinal > data.endDayOrdinal
  ) {
    throw stateInvalid();
  }

  return {
    ref: document.ref,
    startDayOrdinal: data.startDayOrdinal,
    endDayOrdinal: data.endDayOrdinal,
  };
}

function validateLocalInvariants(ranges, stateInvalid) {
  const ordered = [...ranges].sort(
    (left, right) => left.startDayOrdinal - right.startDayOrdinal,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].endDayOrdinal + 1 >= ordered[index].startDayOrdinal) {
      throw stateInvalid();
    }
  }
}

function closestRanges(ranges, dayOrdinal) {
  let left = null;
  let right = null;
  for (const range of ranges) {
    if (
      range.startDayOrdinal <= dayOrdinal &&
      (left === null || range.startDayOrdinal > left.startDayOrdinal)
    ) {
      left = range;
    }
    if (
      range.startDayOrdinal > dayOrdinal &&
      (right === null || range.startDayOrdinal < right.startDayOrdinal)
    ) {
      right = range;
    }
  }
  return { left, right };
}

function latestRange(ranges) {
  let latest = null;
  for (const range of ranges) {
    if (latest === null || range.startDayOrdinal > latest.startDayOrdinal) {
      latest = range;
    }
  }
  return latest;
}

function rangeData(range) {
  return {
    startDayOrdinal: range.startDayOrdinal,
    endDayOrdinal: range.endDayOrdinal,
  };
}

export async function updateStudyStreakHistory({
  transaction,
  userRef,
  occurredAt,
  timeZoneOffsetMinutes,
  currentStreak,
  legacyLastStudyDate,
  stateInvalid,
}) {
  if (!Number.isInteger(currentStreak) || currentStreak < 0) {
    throw stateInvalid();
  }

  const dayOrdinal = canonicalLocalDayOrdinal(
    occurredAt,
    timeZoneOffsetMinutes,
  );
  const rangesRef = userRef.collection('study_streak_ranges');
  const leftQuery = rangesRef
    .where('startDayOrdinal', '<=', dayOrdinal)
    .orderBy('startDayOrdinal', 'desc')
    .limit(1);
  const rightQuery = rangesRef
    .where('startDayOrdinal', '>', dayOrdinal)
    .orderBy('startDayOrdinal', 'asc')
    .limit(1);
  const latestQuery = rangesRef
    .orderBy('startDayOrdinal', 'desc')
    .limit(1);

  const [leftSnapshot, rightSnapshot, latestSnapshot] = await Promise.all([
    transaction.get(leftQuery),
    transaction.get(rightQuery),
    transaction.get(latestQuery),
  ]);

  const loaded = new Map();
  for (const snapshot of [leftSnapshot, rightSnapshot, latestSnapshot]) {
    for (const document of snapshot.docs) {
      const range = readRange(document, stateInvalid);
      loaded.set(rangeKey(range), range);
    }
  }
  validateLocalInvariants(loaded.values(), stateInvalid);

  const previousLatest = latestRange(loaded.values());
  const actual = new Map(loaded);
  const working = new Map(loaded);

  if (previousLatest === null && legacyLastStudyDate !== null) {
    const legacyEndDayOrdinal = canonicalLocalDayOrdinal(
      legacyLastStudyDate,
      timeZoneOffsetMinutes,
    );
    // Legacy data did not retain its original offset. The first post-migration
    // event supplies the only available offset for this one-time bootstrap.
    const legacyStreak = Math.max(1, currentStreak);
    const legacyRange = {
      ref: rangesRef.doc(`legacy_${legacyEndDayOrdinal}`),
      startDayOrdinal: legacyEndDayOrdinal - legacyStreak + 1,
      endDayOrdinal: legacyEndDayOrdinal,
    };
    working.set(rangeKey(legacyRange), legacyRange);
  }

  validateLocalInvariants(working.values(), stateInvalid);
  const latestBeforeInsert = latestRange(working.values());
  const { left, right } = closestRanges(working.values(), dayOrdinal);
  const dayWasKnown = left !== null && dayOrdinal <= left.endDayOrdinal;

  if (!dayWasKnown) {
    const joinsLeft = left !== null && left.endDayOrdinal === dayOrdinal - 1;
    const joinsRight = right !== null && right.startDayOrdinal === dayOrdinal + 1;

    if (joinsLeft && joinsRight) {
      working.set(rangeKey(left), {
        ...left,
        endDayOrdinal: right.endDayOrdinal,
      });
      working.delete(rangeKey(right));
    } else if (joinsLeft) {
      working.set(rangeKey(left), { ...left, endDayOrdinal: dayOrdinal });
    } else if (joinsRight) {
      working.set(rangeKey(right), { ...right, startDayOrdinal: dayOrdinal });
    } else {
      const newRange = {
        ref: rangesRef.doc(`day_${dayOrdinal}`),
        startDayOrdinal: dayOrdinal,
        endDayOrdinal: dayOrdinal,
      };
      working.set(rangeKey(newRange), newRange);
    }
  }

  validateLocalInvariants(working.values(), stateInvalid);
  let historyChanged = false;
  for (const [key, range] of actual) {
    if (!working.has(key)) {
      transaction.delete(range.ref);
      historyChanged = true;
    }
  }
  for (const [key, range] of working) {
    const previous = actual.get(key);
    if (
      previous === undefined ||
      previous.startDayOrdinal !== range.startDayOrdinal ||
      previous.endDayOrdinal !== range.endDayOrdinal
    ) {
      transaction.set(range.ref, rangeData(range));
      historyChanged = true;
    }
  }

  const latest = latestRange(working.values());
  if (latest === null) throw stateInvalid();

  return {
    dayOrdinal,
    historyChanged,
    isHistorical:
      latestBeforeInsert !== null && dayOrdinal < latestBeforeInsert.endDayOrdinal,
    streak: latest.endDayOrdinal - latest.startDayOrdinal + 1,
  };
}
