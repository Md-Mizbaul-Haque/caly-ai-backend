const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Food catalog model', () => {
  it('requires fdcId, name and kcal', () => {
    const Food = require('../models/Food');
    const err = new Food({}).validateSync();
    assert.ok(err.errors.fdcId);
    assert.ok(err.errors.name);
    assert.ok(err.errors.kcal);
  });
  it('defaults macros to 0 and maps _id to id', () => {
    const Food = require('../models/Food');
    const json = new Food({ fdcId: 173944, name: 'Cheddar cheese', kcal: 402 }).toJSON();
    assert.equal(json.protein, 0);
    assert.equal(typeof json.id, 'string');
    assert.equal(json._id, undefined);
  });
});

describe('fdcNormalize', () => {
  it('converts FDC nutrients per 100g into catalog doc', () => {
    const { normalizeFdcFood } = require('../services/fdcNormalize');
    const doc = normalizeFdcFood({
      fdcId: 173944,
      description: 'Cheddar cheese',
      dataType: 'SR Legacy',
      foodNutrients: [
        { nutrientId: 1008, value: 402 },
        { nutrientId: 1003, value: 24.9 },
        { nutrientId: 1005, value: 3.2 },
        { nutrientId: 1004, value: 33.1 },
        { nutrientId: 1079, value: 0 },
        { nutrientId: 269, value: 0.5 },
      ],
    });
    assert.equal(doc.fdcId, 173944);
    assert.equal(doc.name, 'Cheddar cheese');
    assert.equal(doc.kcal, 402);
    assert.equal(doc.protein, 24.9);
    assert.equal(doc.carbs, 3.2);
    assert.equal(doc.fat, 33.1);
  });
  it('handles Foundation detail payloads (string numbers, amount)', () => {
    const { normalizeFdcFood } = require('../services/fdcNormalize');
    const doc = normalizeFdcFood({
      fdcId: 790508,
      description: 'Butter, stick, salted',
      dataType: 'Foundation',
      foodNutrients: [
        { nutrient: { id: 1008, number: '208', name: 'Energy' }, amount: 714 },
        { nutrient: { id: 1003, number: '203', name: 'Protein' }, amount: 0.85 },
        { nutrient: { id: 1004, number: '204', name: 'Total lipid (fat)' }, amount: 81.1 },
      ],
    });
    assert.equal(doc.kcal, 714);
    assert.equal(doc.fat, 81.1);
  });
  it('returns null for food without calories', () => {
    const { normalizeFdcFood } = require('../services/fdcNormalize');
    assert.equal(normalizeFdcFood({ fdcId: 1, description: 'Water?', foodNutrients: [] }), null);
  });
});
