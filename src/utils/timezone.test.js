const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveTimezone,
  requestTimezone,
  dayBounds,
  localDayWindow,
  zonedDateKey,
} = require('./timezone');

describe('resolveTimezone (any situation falls back to UTC)', () => {
  it('keeps a valid IANA zone', () => {
    assert.equal(resolveTimezone('Asia/Dhaka'), 'Asia/Dhaka');
    assert.equal(resolveTimezone('UTC'), 'UTC');
  });
  it('falls back to UTC for missing/blank/invalid zones', () => {
    assert.equal(resolveTimezone(undefined), 'UTC');
    assert.equal(resolveTimezone(null), 'UTC');
    assert.equal(resolveTimezone(''), 'UTC');
    assert.equal(resolveTimezone('  '), 'UTC');
    assert.equal(resolveTimezone('Bogus/Zone'), 'UTC');
    assert.equal(resolveTimezone(42), 'UTC');
  });
});

describe('requestTimezone (query param wins, then user, then UTC)', () => {
  it('prefers an explicit valid ?tz over the stored user zone', () => {
    assert.equal(requestTimezone({ query: { tz: 'Asia/Dhaka' }, user: { timezone: 'UTC' } }), 'Asia/Dhaka');
  });
  it('falls back to the stored user zone', () => {
    assert.equal(requestTimezone({ query: {}, user: { timezone: 'Asia/Dhaka' } }), 'Asia/Dhaka');
  });
  it('falls back to UTC with nothing usable anywhere', () => {
    assert.equal(requestTimezone({ query: {}, user: {} }), 'UTC');
    assert.equal(requestTimezone({ query: { tz: 'Nope' }, user: { timezone: 'Also/Nope' } }), 'UTC');
    assert.equal(requestTimezone({}), 'UTC');
  });
});

describe('dayBounds (calendar day in the user zone, as UTC instants)', () => {
  it('Asia/Dhaka Oct 9 spans Oct 8 18:00Z .. Oct 9 17:59:59.999Z', () => {
    const b = dayBounds('2026-10-09', 'Asia/Dhaka');
    assert.equal(b.start.toISOString(), '2026-10-08T18:00:00.000Z');
    assert.equal(b.end.toISOString(), '2026-10-09T17:59:59.999Z');
  });
  it('UTC Oct 9 spans midnight to midnight UTC', () => {
    const b = dayBounds('2026-10-09', 'UTC');
    assert.equal(b.start.toISOString(), '2026-10-09T00:00:00.000Z');
    assert.equal(b.end.toISOString(), '2026-10-09T23:59:59.999Z');
  });
  it('a Dhaka late-night meal falls inside the Dhaka day, not the UTC day', () => {
    // 00:30 in Dhaka on Oct 10 == 18:30Z Oct 9: UTC-day Oct 9 contains it,
    // but the user's Oct 9 must NOT contain it.
    const meal = new Date('2026-10-09T18:30:00.000Z');
    const dhakaOct9 = dayBounds('2026-10-09', 'Asia/Dhaka');
    const utcOct9 = dayBounds('2026-10-09', 'UTC');
    assert.ok(meal >= utcOct9.start && meal <= utcOct9.end);
    assert.ok(!(meal >= dhakaOct9.start && meal <= dhakaOct9.end));
    const dhakaOct10 = dayBounds('2026-10-10', 'Asia/Dhaka');
    assert.ok(meal >= dhakaOct10.start && meal <= dhakaOct10.end);
  });
  it('returns null for malformed dates and resolves bad zones to UTC', () => {
    assert.equal(dayBounds('bad-date', 'Asia/Dhaka'), null);
    assert.equal(dayBounds('2026-13-45', 'Asia/Dhaka'), null);
    assert.deepEqual(dayBounds('2026-10-09', 'Nope'), dayBounds('2026-10-09', 'UTC'));
  });
  it('Santiago spring-forward: day starts at the real local midnight, not 23:00 the day before', () => {
    // 2026-09-06 00:00 CLT (-04:00) == 04:00Z. A naive offset guess landed on
    // 03:00Z == Sep 5 23:00 local, shifting the whole day back an hour.
    const b = dayBounds('2026-09-06', 'America/Santiago');
    assert.equal(b.start.toISOString(), '2026-09-06T04:00:00.000Z');
    assert.equal(zonedDateKey(b.start, 'America/Santiago'), '2026-09-06');
    assert.equal(zonedDateKey(new Date(b.start.getTime() - 1), 'America/Santiago'), '2026-09-05');
  });
  it('Beirut fall-back at midnight: day still starts at local 00:00', () => {
    // 2026-10-25 00:00 EET (+02:00) == 2026-10-24T22:00Z.
    const b = dayBounds('2026-10-25', 'Asia/Beirut');
    assert.equal(b.start.toISOString(), '2026-10-24T22:00:00.000Z');
    assert.equal(zonedDateKey(b.start, 'Asia/Beirut'), '2026-10-25');
    assert.equal(zonedDateKey(new Date(b.start.getTime() - 1), 'Asia/Beirut'), '2026-10-24');
  });
});

describe('zonedDateKey + localDayWindow', () => {
  it('keys the same instant differently per zone', () => {
    const instant = new Date('2026-10-09T18:30:00.000Z');
    assert.equal(zonedDateKey(instant, 'UTC'), '2026-10-09');
    assert.equal(zonedDateKey(instant, 'Asia/Dhaka'), '2026-10-10');
  });
  it('localDayWindow contains the instant and matches its zoned day bounds', () => {
    const instant = new Date('2026-10-09T18:30:00.000Z');
    const w = localDayWindow(instant, 'Asia/Dhaka');
    assert.ok(instant >= w.start && instant <= w.end);
    assert.deepEqual(w, dayBounds('2026-10-10', 'Asia/Dhaka'));
  });
});
