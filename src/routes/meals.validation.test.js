const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mealBodySchema } = require('./meals.routes');
const Meal = require('../models/Meal');

describe('mealBodySchema', () => {
  it('accepts a valid manual entry and fills defaults', () => {
    const r = mealBodySchema.safeParse({ name: 'Oatmeal', kcal: 320, mealType: 'Breakfast' });
    assert.equal(r.success, true);
    assert.equal(r.data.protein, 0);
    assert.equal(r.data.emoji, '🍽️');
  });
  it('rejects empty name, non-positive kcal, bad mealType', () => {
    assert.equal(mealBodySchema.safeParse({ name: '  ', kcal: 100 }).success, false);
    assert.equal(mealBodySchema.safeParse({ name: 'X', kcal: 0 }).success, false);
    assert.equal(mealBodySchema.safeParse({ name: 'X', kcal: 100, mealType: 'Brunch' }).success, false);
  });
  it('rejects string kcal', () => {
    assert.equal(mealBodySchema.safeParse({ name: 'X', kcal: '320' }).success, false);
  });
  it('allows http(s) and file image URLs, rejects the rest', () => {
    const ok = (imageUrl) => mealBodySchema.safeParse({ name: 'X', kcal: 100, imageUrl }).success;
    assert.equal(ok('https://cdn/x.jpg'), true);
    assert.equal(ok('file:///a.jpg'), true);
    assert.equal(ok('data:image/png;base64,AAA'), false);
    assert.equal(ok('javascript:alert(1)'), false);
  });
  it('caps macros so one row cannot skew averages', () => {
    assert.equal(mealBodySchema.safeParse({ name: 'X', kcal: 100, protein: 99999 }).success, false);
    assert.equal(mealBodySchema.safeParse({ name: 'X', kcal: 100, protein: 25 }).success, true);
  });
});

describe('Meal model', () => {
  it('requires name and kcal', () => {
    const err = new Meal({}).validateSync();
    assert.ok(err.errors.name);
    assert.ok(err.errors.kcal);
  });
  it('maps _id to id and strips __v in JSON', () => {
    const json = new Meal({ name: 'X', kcal: 10 }).toJSON();
    assert.equal(typeof json.id, 'string');
    assert.equal(json._id, undefined);
    assert.equal(json.__v, undefined);
  });
});
