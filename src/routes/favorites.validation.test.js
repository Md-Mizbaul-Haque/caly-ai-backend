const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { favoriteBodySchema, nameKey } = require('./favorites.routes');
const Favorite = require('../models/Favorite');

describe('favoriteBodySchema', () => {
  it('accepts a logged-meal shaped favorite and fills macro defaults', () => {
    const r = favoriteBodySchema.safeParse({ name: 'Tea, hot, leaf, black', kcal: 3 });
    assert.equal(r.success, true);
    assert.equal(r.data.protein, 0);
    assert.equal(r.data.carbs, 0);
    assert.equal(r.data.fat, 0);
  });
  it('rejects blank name and non-positive kcal (must stay loggable as a meal)', () => {
    assert.equal(favoriteBodySchema.safeParse({ name: '  ', kcal: 3 }).success, false);
    assert.equal(favoriteBodySchema.safeParse({ kcal: 3 }).success, false);
    assert.equal(favoriteBodySchema.safeParse({ name: 'X', kcal: 0 }).success, false);
    assert.equal(favoriteBodySchema.safeParse({ name: 'X', kcal: -5 }).success, false);
  });
  it('allows http(s) and file image URLs, rejects the rest', () => {
    const ok = (imageUrl) => favoriteBodySchema.safeParse({ name: 'X', kcal: 3, imageUrl }).success;
    assert.equal(ok('https://cdn/x.jpg'), true);
    assert.equal(ok('file:///a.jpg'), true);
    assert.equal(ok('data:image/png;base64,AAA'), false);
    assert.equal(ok('javascript:alert(1)'), false);
  });
});

describe('nameKey', () => {
  it('collapses case and whitespace for dedupe', () => {
    assert.equal(nameKey('  Tea, Hot, Leaf, Black '), 'tea, hot, leaf, black');
    assert.equal(nameKey('TEA'), nameKey('tea'));
  });
  it('handles missing names without throwing', () => {
    assert.equal(nameKey(null), '');
    assert.equal(nameKey(undefined), '');
  });
});

describe('Favorite model', () => {
  it('requires userId, name and kcal', () => {
    const err = new Favorite({}).validateSync();
    assert.ok(err.errors.userId);
    assert.ok(err.errors.name);
    assert.ok(err.errors.kcal);
  });
  it('maps _id to id and strips __v in JSON', () => {
    const json = new Favorite({ name: 'X', kcal: 10 }).toJSON();
    assert.equal(typeof json.id, 'string');
    assert.equal(json._id, undefined);
    assert.equal(json.__v, undefined);
  });
});
