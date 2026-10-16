const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const { profileSchema, onboardingCandidate } = require('./auth.routes');
const { buildNutritionPlan } = require('../services/nutritionPlan');

// The exact body NutritionPlanScreen PUTs to /api/auth/profile. It never sends
// goalPace — pace is only ever set later from the weight-goal wizard.
const COMPLETION_BODY = {
  gender: 'male',
  birthDate: '1990-05-05T00:00:00.000Z',
  heightCm: 170,
  weightKg: 70,
  targetWeightKg: 65,
  activityLevel: 'light',
  onboardingCompleted: true,
};

function newUser() {
  return new User({ name: 'New', email: 'new@user.co', passwordHash: 'x'.repeat(60) });
}

describe('onboardingCandidate (route merge)', () => {
  it('plans a first-time onboarding save even though goalPace is still null', () => {
    // Regression: the stored goalPace (mongoose default null) was merged into
    // pace and the planner rejected the explicit null, so EVERY new user got
    // "cannot complete onboarding — all profile fields are required".
    const user = newUser();
    assert.equal(user.goalPace, null);
    const parsed = profileSchema.safeParse(COMPLETION_BODY);
    assert.equal(parsed.success, true);
    const candidate = onboardingCandidate(user, parsed.data);
    assert.equal(candidate.pace, null);
    const plan = buildNutritionPlan(candidate);
    assert.equal(plan.pace, 'steady');
    assert.ok(plan.dailyGoalKcal >= 500 && plan.dailyGoalKcal <= 10000);
  });

  it('honors the stored pace when the body omits goalPace', () => {
    const user = newUser();
    user.goalPace = 'fast';
    const parsed = profileSchema.safeParse(COMPLETION_BODY);
    const candidate = onboardingCandidate(user, parsed.data);
    assert.equal(candidate.pace, 'fast');
    assert.equal(buildNutritionPlan(candidate).pace, 'fast');
  });

  it('lets an explicit body value win over the stored profile', () => {
    const user = newUser();
    user.goalPace = 'slow';
    user.weightKg = 120;
    const parsed = profileSchema.safeParse({ ...COMPLETION_BODY, goalPace: 'fast', weightKg: 72 });
    assert.equal(parsed.success, true);
    const candidate = onboardingCandidate(user, parsed.data);
    assert.equal(candidate.pace, 'fast');
    assert.equal(candidate.weightKg, 72);
  });

  it('falls back to the stored profile for fields the body omits', () => {
    const user = newUser();
    Object.assign(user, { gender: 'female', heightCm: 160, activityLevel: 'moderate' });
    const parsed = profileSchema.safeParse({ weightKg: 60, targetWeightKg: 58, onboardingCompleted: true });
    assert.equal(parsed.success, true);
    const candidate = onboardingCandidate(user, parsed.data);
    assert.equal(candidate.gender, 'female');
    assert.equal(candidate.heightCm, 160);
    assert.equal(candidate.activityLevel, 'moderate');
  });

  it('still reports a genuinely empty profile as incomplete', () => {
    const user = newUser();
    const parsed = profileSchema.safeParse({ onboardingCompleted: true });
    const candidate = onboardingCandidate(user, parsed.data);
    try {
      buildNutritionPlan(candidate);
      assert.fail('should throw');
    } catch (e) {
      assert.equal(e.status, 400);
      assert.deepEqual(e.missing.sort(), ['activityLevel', 'birthDate', 'gender', 'heightCm', 'targetWeightKg', 'weightKg'].sort());
    }
  });
});
