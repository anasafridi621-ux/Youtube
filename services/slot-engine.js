'use strict';
/**
 * services/slot-engine.js
 * ---------------------------------------------------------------------------
 * Pure, dependency-free scheduling math for the five-slot-per-day
 * US-Eastern publishing calendar.
 *
 * Everything is expressed as an IANA zone name (default America/New_York).
 * No fixed UTC offset is ever stored or computed, so EST/EDT transitions,
 * month boundaries and year boundaries are handled by the platform's own
 * ICU/Intl timezone database.
 *
 * The engine is deliberately side-effect free so it can be unit-tested
 * without a database, a clock, or a network.
 */

const MINUTE = 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Intl helpers                                                               */
/* -------------------------------------------------------------------------- */

const partsFormatterCache = new Map();

function partsFormatter(timeZone) {
  let f = partsFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    partsFormatterCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of an instant inside `timeZone`. */
function zoneParts(instant, timeZone) {
  const parts = {};
  for (const p of partsFormatter(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return parts;
}

/**
 * Offset of `timeZone` from UTC at a given instant, in milliseconds.
 * Correct across DST because it is derived from the live IANA database.
 */
function zoneOffsetMs(instant, timeZone) {
  const p = zoneParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** 'YYYY-MM-DD' calendar date of an instant inside `timeZone`. */
function dateKeyIn(instant, timeZone) {
  const p = zoneParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' -> Date at UTC midnight (safe for date arithmetic). */
function dateKeyToUtcMidnight(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0));
}

function addDaysToKey(dateKey, days) {
  const t = dateKeyToUtcMidnight(dateKey).getTime() + days * 24 * 60 * 60 * 1000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/* -------------------------------------------------------------------------- */
/* Wall-clock -> instant conversion                                           */
/* -------------------------------------------------------------------------- */

/**
 * Convert a wall-clock time in `timeZone` into a real UTC instant.
 *
 * Handles both DST edge cases deterministically:
 *   - Spring forward (wall time does not exist): the gap is normalised so the
 *     result is a real instant one hour "late" in wall-clock terms.
 *   - Fall back (wall time occurs twice): the first occurrence is used.
 */
function wallTimeToInstant(dateKey, hour, minute, timeZone) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const want = Date.UTC(y, (m || 1) - 1, d || 1, hour, minute, 0, 0);

  // First pass: guess the offset at the instant assuming the wall time is UTC.
  let ts = want - zoneOffsetMs(new Date(want), timeZone);

  // Verify by round-tripping; correct any residual drift.
  for (let i = 0; i < 3; i += 1) {
    const p = zoneParts(new Date(ts), timeZone);
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (actual === want) break;
    ts -= actual - want;
  }
  return new Date(ts);
}

/** Instant -> wall-clock string inside `timeZone` (e.g. "08:00"). */
function wallClockIn(instant, timeZone) {
  const p = zoneParts(instant, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/* -------------------------------------------------------------------------- */
/* Slot model                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the slot objects for one calendar date in `timeZone`.
 * @returns {Array<{dateKey,index,hour,minute,wall,utcIso,utcMs}>}
 */
function slotsForDate(dateKey, slotTimes, timeZone) {
  return slotTimes.map((t, i) => {
    const instant = wallTimeToInstant(dateKey, t.h, t.m, timeZone);
    return {
      dateKey,
      index: i,
      hour: t.h,
      minute: t.m,
      wall: `${pad2(t.h)}:${pad2(t.m)}`,
      utc: instant,
      utcIso: instant.toISOString(),
      utcMs: instant.getTime()
    };
  });
}

/**
 * Today's slots that have not yet passed.
 * `now` is injectable so tests are deterministic.
 */
function remainingSlotsToday(now, slotTimes, timeZone, leadMs = 0) {
  const todayKey = dateKeyIn(now, timeZone);
  return slotsForDate(todayKey, slotTimes, timeZone).filter((s) => s.utcMs > now.getTime() + leadMs);
}

/** The full five-slot calendar for the next calendar day. */
function nextDaySlots(now, slotTimes, timeZone) {
  const tomorrowKey = addDaysToKey(dateKeyIn(now, timeZone), 1);
  return slotsForDate(tomorrowKey, slotTimes, timeZone);
}

/**
 * The set of slots a freshly-ingested batch is allowed to target:
 *   today's remaining slots + tomorrow's five slots.
 * This is exactly the "rolling advance buffer" window.
 */
function activeWindowSlots(now, slotTimes, timeZone, leadMs = 0) {
  const today = remainingSlotsToday(now, slotTimes, timeZone, leadMs);
  const tomorrow = nextDaySlots(now, slotTimes, timeZone);
  return [...today, ...tomorrow];
}

/** Human readable ET + IST (or any display zones) rendering of a slot. */
function formatSlotForDisplay(utc, displayZones) {
  const zones = Array.isArray(displayZones) && displayZones.length ? displayZones : [timezoneFallback()];
  const out = {};
  for (const z of zones) {
    try {
      const p = zoneParts(utc, z);
      out[z] = {
        date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
        time: `${pad2(p.hour)}:${pad2(p.minute)}`
      };
    } catch (_) {
      out[z] = { date: null, time: null };
    }
  }
  return out;
}

let _tzFallback = 'America/New_York';
function timezoneFallback() {
  return _tzFallback;
}
function setFallbackTimezone(tz) {
  _tzFallback = tz;
}

/** Validate that a zone name is usable by the runtime. */
function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* DST-aware arithmetic used by the scheduler                                 */
/* -------------------------------------------------------------------------- */

/**
 * Number of hours between two instants expressed as wall-clock times in
 * `timeZone`. Used to prove that DST transitions do not shift the schedule.
 */
function wallClockDifferenceHours(a, b, timeZone) {
  const pa = zoneParts(a, timeZone);
  const pb = zoneParts(b, timeZone);
  const wa = Date.UTC(pa.year, pa.month - 1, pa.day, pa.hour, pa.minute);
  const wb = Date.UTC(pb.year, pb.month - 1, pb.day, pb.hour, pb.minute);
  return (wb - wa) / (60 * 60 * 1000);
}

module.exports = {
  MINUTE,
  zoneParts,
  zoneOffsetMs,
  dateKeyIn,
  addDaysToKey,
  dateKeyToUtcMidnight,
  wallTimeToInstant,
  wallClockIn,
  slotsForDate,
  remainingSlotsToday,
  nextDaySlots,
  activeWindowSlots,
  formatSlotForDisplay,
  isValidTimezone,
  wallClockDifferenceHours,
  setFallbackTimezone
};
