const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { toLbs, seedTrackingFromOnboarding } = require('./auth.routes');

describe('toLbs (tracking surface unit)', () => {
  it('converts onboarding kg to tracking lbs to 1 decimal', () => {
    assert.equal(toLbs(50), 110.2);
    assert.equal(toLbs(60), 132.3);
    assert.equal(toLbs(70), 154.3);
  });
  it('stays inside the Weight model range for all valid profile weights', () => {
    assert.ok(toLbs(25) >= 20, 'min profile weight converts above model min');
    assert.ok(toLbs(350) <= 1000, 'max profile weight converts below model max');
  });
});

function stubModels({ weightCount = 0, goalExists = false } = {}) {
  const calls = { createdWeights: [], createdGoals: [] };
  const Weight = {
    async countDocuments() { return weightCount; },
    async create(doc) { calls.createdWeights.push(doc); return doc; },
  };
  const WeightGoal = {
    async findOne() { return goalExists ? { value: 1 } : null; },
    async create(doc) { calls.createdGoals.push(doc); return doc; },
  };
  return { calls, Weight, WeightGoal };
}

describe('seedTrackingFromOnboarding', () => {
  it('seeds first weigh-in + goal from the completed profile', async () => {
    const { calls, ...deps } = stubModels();
    await seedTrackingFromOnboarding({ _id: 'u1', weightKg: 50, targetWeightKg: 60 }, deps);
    assert.equal(calls.createdWeights.length, 1);
    assert.equal(calls.createdWeights[0].value, 110.2);
    assert.equal(calls.createdGoals.length, 1);
    assert.equal(calls.createdGoals[0].value, 132.3);
  });
  it('never overwrites existing tracking rows', async () => {
    const { calls, ...deps } = stubModels({ weightCount: 2, goalExists: true });
    await seedTrackingFromOnboarding({ _id: 'u1', weightKg: 50, targetWeightKg: 60 }, deps);
    assert.equal(calls.createdWeights.length, 0);
    assert.equal(calls.createdGoals.length, 0);
  });
  it('skips silently when the profile has no weights yet', async () => {
    const { calls, ...deps } = stubModels();
    await seedTrackingFromOnboarding({ _id: 'u1' }, deps);
    assert.equal(calls.createdWeights.length, 0);
    assert.equal(calls.createdGoals.length, 0);
  });
});
