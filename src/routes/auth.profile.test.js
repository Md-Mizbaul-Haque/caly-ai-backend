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
