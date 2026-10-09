// Per-user calendar timezone with UTC fallback.
//
// Every calendar-day interpretation on the server (meal/weight ?from/?to
// windows, same-day replace checks) runs through these helpers so a user in
// Asia/Dhaka gets Dhaka days even when the server runs on UTC. ANY unusable
// zone — missing, blank, non-string, unknown — resolves to 'UTC', never throws.

const FALLBACK = 'UTC';
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// A zone is valid when ICU accepts it. Canonicalize (e.g. 'utc' -> 'UTC')
// so stored values stay comparable.
function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

function resolveTimezone(tz) {
  if (!isValidTimezone(tz)) return FALLBACK;
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).resolvedOptions().timeZone;
    return canonical || FALLBACK;
  } catch {
    return FALLBACK;
  }
}

// Precedence for a request: explicit ?tz= wins, then the stored per-user
// zone, then UTC. Invalid values at any level fall through to the next.
function requestTimezone(req) {
  const q = req && req.query ? req.query.tz : undefined;
  if (isValidTimezone(q)) return resolveTimezone(q);
  const stored = req && req.user ? req.user.timezone : undefined;
  if (isValidTimezone(stored)) return resolveTimezone(stored);
  return FALLBACK;
}

// Offset of `timeZone` at UTC instant `utcMs`, in minutes (east positive).
// hourCycle h23 avoids the midnight-as-24 rendering edge.
function offsetMinutesAt(utcMs, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value])
  );
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUTC - utcMs) / 60000;
}

// UTC instant of zoned-local midnight starting calendar day (y, m, d).
// Two offset passes absorb DST transitions inside the day.
function zonedMidnightUtc(y, m, d, tz) {
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  for (let i = 0; i < 2; i += 1) {
    guess = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - offsetMinutesAt(guess, tz) * 60000;
  }
  return guess;
}

function validYmd(s) {
  const m = DATE_RE.exec(s || '');
  if (!m) return null;
  const y = +m[1];
  const mon = +m[2];
  const day = +m[3];
  // Reject impossible dates (month 13, Feb 30…) via a UTC round-trip.
  const check = new Date(Date.UTC(y, mon - 1, day));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mon - 1 || check.getUTCDate() !== day) return null;
  return { y, mon, day };
}

// [00:00:00.000, 23:59:59.999] of calendar day `dateStr` in `timeZone`,
// returned as UTC Dates for Mongo range queries. Null on malformed input.
function dayBounds(dateStr, timeZone) {
  const ymd = validYmd(dateStr);
  if (!ymd) return null;
  const tz = resolveTimezone(timeZone);
  const startMs = zonedMidnightUtc(ymd.y, ymd.mon, ymd.day, tz);
  // Next midnight minus 1ms (correct across DST length changes).
  const next = new Date(Date.UTC(ymd.y, ymd.mon - 1, ymd.day + 1));
  const nextStartMs = zonedMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz);
  return { start: new Date(startMs), end: new Date(nextStartMs - 1) };
}

// Window of the zoned calendar day containing `instant`.
function localDayWindow(instant, timeZone) {
  const tz = resolveTimezone(timeZone);
  return dayBounds(zonedDateKey(instant, tz), tz);
}

// 'YYYY-MM-DD' of `instant` in `timeZone` (en-CA yields ISO order).
function zonedDateKey(instant, timeZone) {
  const tz = resolveTimezone(timeZone);
  const d = instant instanceof Date ? instant : new Date(instant);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

module.exports = {
  FALLBACK,
  resolveTimezone,
  requestTimezone,
  dayBounds,
  localDayWindow,
  zonedDateKey,
};
