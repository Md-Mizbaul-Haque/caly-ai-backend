const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const PendingRegistration = require('../models/PendingRegistration');
const { skipSchema } = require('./auth.routes');

describe('skipSchema', () => {
  it('accepts a valid email', () => {
    assert.equal(skipSchema.safeParse({ email: 'a@b.co' }).success, true);
  });
  it('rejects missing or invalid email', () => {
    assert.equal(skipSchema.safeParse({}).success, false);
    assert.equal(skipSchema.safeParse({ email: 'not-an-email' }).success, false);
  });
});

describe('PendingRegistration model', () => {
  it('requires name, email, and passwordHash', () => {
    const err = new PendingRegistration({}).validateSync();
    assert.ok(err.errors.name);
    assert.ok(err.errors.email);
    assert.ok(err.errors.passwordHash);
  });
  it('rejects an invalid email', () => {
    const err = new PendingRegistration({ name: 'A', email: 'bad', passwordHash: 'x'.repeat(60) }).validateSync();
    assert.ok(err.errors.email);
  });
  it('defaults attempts to 0 and expiry ~24h in the future', () => {
    const p = new PendingRegistration({ name: 'A', email: 'a@b.co', passwordHash: 'x'.repeat(60) });
    assert.equal(p.codeAttempts, 0);
    assert.equal(p.codeHash, null);
    const hoursLeft = (p.expiresAt - Date.now()) / 3600000;
    assert.ok(hoursLeft > 23 && hoursLeft <= 24);
  });
});
