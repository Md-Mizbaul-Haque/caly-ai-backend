const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildNutritionPlan, missingPlanFields } = require('../services/nutritionPlan');

describe('nutritionPlan service — completeness gate', () => {
  it('refuses partial inputs with 400 + missing[] (plan only after ALL info)', () => {
    try {
      buildNutritionPlan({ gender: 'male', heightCm: 173 });
      assert.fail('should throw');
    } catch (e) {
      assert.equal(e.status, 400);
      assert.ok(Array.isArray(e.missing) && e.missing.includes('weightKg'));
    }
  });
  it('rejects under-13 birthdays', () => {
    try {
      buildNutritionPlan({ gender: 'female', birthDate: '2020-01-01', heightCm: 150, weightKg: 50, targetWeightKg: 45, activityLevel: 'light' });
      assert.fail('should throw');
    } catch (e) {
      assert.equal(e.status, 400);
    }
  });
  it('missingPlanFields names every absent field', () => {
    assert.deepEqual(missingPlanFields({ gender: 'male' }).sort(), ['activityLevel', 'birthDate', 'heightCm', 'targetWeightKg', 'weightKg'].sort());
  });
});

describe('nutritionPlan service — medical safety', () => {
  it('floors loss at max(sex floor, BMR), never below basal', () => {
    // Small, sedentary woman: maintenance ~1400s, -500 would breach floor.
    const p = buildNutritionPlan({ gender: 'female', birthDate: '1990-01-01', heightCm: 155, weightKg: 55, targetWeightKg: 45, activityLevel: 'sedentary' });
    assert.equal(p.goal, 'Lose Weight');
    assert.ok(p.dailyGoalKcal >= 1200, `floor 1200, got ${p.dailyGoalKcal}`);
    assert.ok(p.dailyGoalKcal >= p.bmr, `never below BMR ${p.bmr}, got ${p.dailyGoalKcal}`);
    assert.ok(p.dailyGoalKcal <= p.maintenance);
  });
  it('downgrades underweight loss to maintenance with warning', () => {
    const p = buildNutritionPlan({ gender: 'female', birthDate: '2000-01-01', heightCm: 170, weightKg: 50, targetWeightKg: 45, activityLevel: 'light' });
    assert.ok(p.bmi < 18.5);
    assert.equal(p.dailyGoalKcal, p.maintenance);
    assert.ok(p.warnings.some((w) => w.includes('BMI')));
  });
  it('keeps teen deficit small with higher floor + warning', () => {
    const p = buildNutritionPlan({ gender: 'male', birthDate: '2010-06-01', heightCm: 170, weightKg: 70, targetWeightKg: 60, activityLevel: 'moderate' });
    assert.ok(p.age < 18);
    assert.ok(p.dailyGoalKcal >= 1800);
    assert.ok(p.warnings.some((w) => w.toLowerCase().includes('teen')));
  });
  it('gain path is bounded (+400, max +500)', () => {
    const p = buildNutritionPlan({ gender: 'male', birthDate: '1995-01-01', heightCm: 180, weightKg: 70, targetWeightKg: 80, activityLevel: 'moderate' });
    assert.equal(p.goal, 'Gain Weight');
    assert.equal(p.dailyGoalKcal, p.maintenance + 400);
  });
  it('nonbinary uses mean constant, protein 1.8/2.0 (not 2.5)', () => {
    const nb = buildNutritionPlan({ gender: 'nonbinary', birthDate: '2000-01-01', heightCm: 170, weightKg: 70, targetWeightKg: 70, activityLevel: 'moderate' });
    assert.equal(nb.proteinG, Math.round(1.8 * 70));
    const lose = buildNutritionPlan({ gender: 'female', birthDate: '1995-01-01', heightCm: 165, weightKg: 80, targetWeightKg: 65, activityLevel: 'light' });
    assert.equal(lose.proteinG, Math.round(2.0 * 80));
  });
  it('pace controls deficit: slow -250 / steady -500 / fast -750 (clamped)', () => {
    const base = { gender: 'male', birthDate: '1990-01-01', heightCm: 180, weightKg: 90, targetWeightKg: 80, activityLevel: 'moderate' };
    const slow = buildNutritionPlan({ ...base, pace: 'slow' });
    const steady = buildNutritionPlan({ ...base, pace: 'steady' });
    const fast = buildNutritionPlan({ ...base, pace: 'fast' });
    assert.equal(slow.dailyGoalKcal, slow.maintenance - 250);
    assert.equal(steady.dailyGoalKcal, steady.maintenance - 500);
    assert.equal(fast.dailyGoalKcal, fast.maintenance - 750);
    assert.ok(fast.dailyGoalKcal < steady.dailyGoalKcal && steady.dailyGoalKcal < slow.dailyGoalKcal);
  });
  it('pace never breaches safe floors (sex floor + BMR)', () => {
    const base = { gender: 'female', birthDate: '1990-01-01', heightCm: 155, weightKg: 55, targetWeightKg: 45, activityLevel: 'sedentary' };
    const fast = buildNutritionPlan({ ...base, pace: 'fast' });
    assert.ok(fast.dailyGoalKcal >= 1200);
    assert.ok(fast.dailyGoalKcal >= fast.bmr);
    assert.ok(fast.dailyGoalKcal <= fast.maintenance);
  });
  it('teen fast pace is capped at small deficit + warning', () => {
    const p = buildNutritionPlan({ gender: 'male', birthDate: '2010-06-01', heightCm: 170, weightKg: 70, targetWeightKg: 60, activityLevel: 'moderate', pace: 'fast' });
    assert.ok(p.dailyGoalKcal >= 1800);
    assert.ok(p.warnings.some((w) => w.toLowerCase().includes('teen')));
  });
  it('gain pace controls surplus: slow +250 / steady +400 / fast +500', () => {
    const base = { gender: 'male', birthDate: '1995-01-01', heightCm: 180, weightKg: 70, targetWeightKg: 80, activityLevel: 'moderate' };
    assert.equal(buildNutritionPlan({ ...base, pace: 'slow' }).dailyGoalKcal - buildNutritionPlan({ ...base, pace: 'slow' }).maintenance, 250);
    assert.equal(buildNutritionPlan({ ...base, pace: 'steady' }).dailyGoalKcal - buildNutritionPlan({ ...base, pace: 'steady' }).maintenance, 400);
    assert.equal(buildNutritionPlan({ ...base, pace: 'fast' }).dailyGoalKcal - buildNutritionPlan({ ...base, pace: 'fast' }).maintenance, 500);
  });
  it('exposes etaWeeks from pace rate', () => {
    const p = buildNutritionPlan({ gender: 'male', birthDate: '1990-01-01', heightCm: 180, weightKg: 90, targetWeightKg: 80, activityLevel: 'moderate', pace: 'steady' });
    assert.equal(p.etaWeeks, 20);
  });
});
