const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Dummy secret BEFORE requiring services/auth: hashCode/codeExpiry read it
// lazily, and these tests must never depend on a real .env value.
process.env.JWT_SECRET = 'test-only-secret-1234567890';
const PendingRegistration = require('../models/PendingRegistration');
const { skipSchema } = require('./auth.routes');
const { generateCode, hashCode, codesMatch } = require('../services/auth');

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
  it('declares a TTL index so stale pendings self-delete', () => {
    const ttl = PendingRegistration.schema.indexes().find(([fields]) => fields.expiresAt === 1);
    assert.ok(ttl, 'expected a TTL index on expiresAt');
    assert.equal(ttl[1].expireAfterSeconds, 0);
  });
  it('declares a unique index on email', () => {
    const unique = PendingRegistration.schema.indexes().find(([fields]) => fields.email === 1);
    assert.ok(unique, 'expected a unique index on email');
    assert.equal(unique[1].unique, true);
  });
});

describe('verification code crypto', () => {
  it('generates 6-digit codes, zero-padded', () => {
    for (let i = 0; i < 50; i++) {
      assert.match(generateCode(), /^\d{6}$/);
    }
  });
  it('hash round-trips, including leading-zero codes', () => {
    assert.ok(codesMatch('042913', hashCode('042913')));
    assert.ok(!codesMatch('042914', hashCode('042913')));
  });
  it('never matches empty or missing inputs', () => {
    assert.ok(!codesMatch('', hashCode('123456')));
    assert.ok(!codesMatch('123456', null));
    assert.ok(!codesMatch(null, null));
  });
});
