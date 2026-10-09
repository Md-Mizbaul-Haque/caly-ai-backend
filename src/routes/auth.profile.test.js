const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const { profileSchema } = require('./auth.routes');

describe('profileSchema', () => {
  it('accepts a partial onboarding payload', () => {
    const r = profileSchema.safeParse({ gender: 'female', activityLevel: 'light', weightKg: 70 });
    assert.equal(r.success, true);
  });
  it('rejects bad enum, out-of-range weight, under-500 goal', () => {
    assert.equal(profileSchema.safeParse({ gender: 'x' }).success, false);
    assert.equal(profileSchema.safeParse({ weightKg: 5 }).success, false);
    assert.equal(profileSchema.safeParse({ dailyGoalKcal: 100 }).success, false);
  });
  it('accepts empty object (no-op update)', () => {
    assert.equal(profileSchema.safeParse({}).success, true);
  });
});

describe('User onboarding defaults', () => {
  it('defaults new fields to null/false', () => {
    const u = new User({ name: 'A', email: 'a@b.co', passwordHash: 'x'.repeat(60) });
    // Deviates from brief verbatim (which asserted `undefined`): installed
    // mongoose@9.10.2 applies `default: null` at construction, so pre-save
    // `u.gender` is `null` (verified by failing run). Matches test name "null/false".
    assert.equal(u.gender, null);
    assert.equal(u.onboardingCompleted, false);
    const json = u.toJSON();
    assert.equal(json.onboardingCompleted, false);
  });
});

describe('profileSchema timezone', () => {
  it('accepts an IANA zone string', () => {
    const r = profileSchema.safeParse({ timezone: 'Asia/Dhaka' });
    assert.equal(r.success, true);
  });
  it('new users default to UTC', () => {
    const u = new User({ name: 'C', email: 'c@d.co', passwordHash: 'x'.repeat(60) });
    assert.equal(u.timezone, 'UTC');
  });
});

describe('profileSchema birthDate', () => {
  it('rejects under-13 birthdays', () => {
    assert.equal(profileSchema.safeParse({ birthDate: '2015-06-01' }).success, false);
  });
  it('accepts an adult ISO birthday string', () => {
    assert.equal(profileSchema.safeParse({ birthDate: '2000-01-15' }).success, true);
  });
});

describe('User accepts coerced onboarding payload', () => {
  it('ISO date string validates through the model', () => {
    const parsed = profileSchema.safeParse({ birthDate: '2000-01-15', weightKg: 70 });
    assert.equal(parsed.success, true);
    const u = new User({ name: 'B', email: 'b@c.co', passwordHash: 'x'.repeat(60), ...parsed.data });
    assert.equal(u.validateSync(), undefined);
  });
});
