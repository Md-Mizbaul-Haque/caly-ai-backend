const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { weightBodySchema, goalBodySchema } = require('./weights.routes');

describe('weightBodySchema', () => {
  it('accepts a valid weight and defaults loggedAt', () => {
    const r = weightBodySchema.safeParse({ value: 132.5 });
    assert.equal(r.success, true);
    assert.equal(r.data.loggedAt, undefined);
  });
  it('accepts an explicit ISO loggedAt with offset', () => {
    assert.equal(weightBodySchema.safeParse({ value: 132.5, loggedAt: '2026-10-05T08:30:00.000Z' }).success, true);
  });
  it('rejects out-of-range values and non-numbers', () => {
    assert.equal(weightBodySchema.safeParse({ value: 10 }).success, false);
    assert.equal(weightBodySchema.safeParse({ value: 2000 }).success, false);
    assert.equal(weightBodySchema.safeParse({ value: '132' }).success, false);
  });
  it('rejects non-ISO loggedAt', () => {
    assert.equal(weightBodySchema.safeParse({ value: 132, loggedAt: 'yesterday' }).success, false);
  });
});

describe('goalBodySchema', () => {
  it('accepts a valid goal', () => {
    assert.equal(goalBodySchema.safeParse({ value: 140 }).success, true);
  });
  it('rejects out-of-range goals', () => {
    assert.equal(goalBodySchema.safeParse({ value: 0 }).success, false);
    assert.equal(goalBodySchema.safeParse({ value: 1001 }).success, false);
  });
  it('accepts pace + activityLevel for plan recompute', () => {
    const r = goalBodySchema.safeParse({ value: 140, pace: 'steady', activityLevel: 'moderate' });
    assert.equal(r.success, true);
  });
  it('rejects bad pace enum', () => {
    assert.equal(goalBodySchema.safeParse({ value: 140, pace: 'warp' }).success, false);
  });
  it('rejects bad activityLevel enum', () => {
    assert.equal(goalBodySchema.safeParse({ value: 140, activityLevel: 'marathon' }).success, false);
  });
});

describe('recomputePlanForGoal', () => {
  const { recomputePlanForGoal } = require('./weights.routes');
  const user = { gender: 'male', birthDate: '1990-01-01', heightCm: 180, weightKg: 90, activityLevel: 'light' };
  it('recomputes dailyGoalKcal from new target + pace', () => {
    const out = recomputePlanForGoal(user, { goalLbs: 176.4, activityLevel: 'moderate', pace: 'slow' });
    assert.ok(out.plan.dailyGoalKcal >= 500 && out.plan.dailyGoalKcal <= 10000);
    assert.equal(out.candidate.targetWeightKg, 80);
    assert.equal(out.plan.pace, 'slow');
  });
  it('returns missing when profile incomplete', () => {
    const out = recomputePlanForGoal({}, { goalLbs: 140 });
    assert.ok(Array.isArray(out.missing) && out.missing.length > 0);
    assert.equal(out.plan, null);
  });
  it('prefers the latest weigh-in over a stale profile weight', () => {
    const user = { gender: 'male', birthDate: '1990-01-01', heightCm: 180, weightKg: 120, activityLevel: 'moderate' };
    const stale = recomputePlanForGoal(user, { goalLbs: 176.4, pace: 'steady' });
    const fresh = recomputePlanForGoal(user, { goalLbs: 176.4, pace: 'steady', currentWeightKg: 80 });
    assert.ok(fresh.plan.dailyGoalKcal < stale.plan.dailyGoalKcal, 'lighter current weight = smaller maintenance = smaller target');
  });
});
