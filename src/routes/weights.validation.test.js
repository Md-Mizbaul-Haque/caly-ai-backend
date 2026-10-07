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
});
