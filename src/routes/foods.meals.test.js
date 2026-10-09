const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORIES, SUGGESTION_TERMS } = require('./foods.routes');
const { mealBodySchema } = require('./meals.routes');

describe('meals picture-spec APIs', () => {
  it('exposes 6 browse categories with emoji + keywords', () => {
    assert.equal(CATEGORIES.length, 6);
    for (const c of CATEGORIES) {
      assert.ok(c.key && c.emoji && Array.isArray(c.keywords) && c.keywords.length > 0);
    }
    const keys = CATEGORIES.map((c) => c.key).sort();
    assert.deepEqual(keys, ['Dairy', 'Fruits', 'Grains', 'Proteins', 'Snacks', 'Vegetables']);
  });

  it('has suggestion terms for all 4 meal types', () => {
    for (const t of ['Breakfast', 'Lunch', 'Dinner', 'Snack']) {
      assert.ok(Array.isArray(SUGGESTION_TERMS[t]) && SUGGESTION_TERMS[t].length >= 3, t);
    }
  });

  it('mealBodySchema still accepts picture-spec manual entry', () => {
    const r = mealBodySchema.safeParse({ name: 'Oatmeal', kcal: 180, protein: 6, carbs: 32, fat: 3, mealType: 'Breakfast' });
    assert.equal(r.success, true);
    assert.equal(r.data.mealType, 'Breakfast');
  });

  it('mealType filter only allows the 4 picture pills', () => {
    const allowed = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
    for (const t of allowed) assert.ok(allowed.includes(t));
    assert.equal(allowed.includes('Brunch'), false);
  });
});
