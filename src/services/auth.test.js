const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Dummy secret BEFORE requiring the service: sign/verify read it lazily.
process.env.JWT_SECRET = 'test-only-secret-1234567890-abcdefg';
const { signToken, verifyToken } = require('./auth');

describe('signToken / verifyToken token version', () => {
  it('embeds tokenVersion and round-trips it for a fresh account', () => {
    const token = signToken({ id: '64f000000000000000000001' });
    const payload = verifyToken(token);
    assert.equal(payload.sub, '64f000000000000000000001');
    assert.equal(payload.tv, 0);
  });
  it('carries a bumped tokenVersion so old tokens are distinguishable', () => {
    const token = signToken({ id: '64f000000000000000000002', tokenVersion: 3 });
    assert.equal(verifyToken(token).tv, 3);
  });
  it('refuses a token signed with another secret', () => {
    const good = signToken({ id: '64f000000000000000000003' });
    process.env.JWT_SECRET = 'a-different-secret-0987654321-zyxwvu';
    assert.throws(() => verifyToken(good));
    process.env.JWT_SECRET = 'test-only-secret-1234567890-abcdefg';
  });
});

describe('requireJwtSecret length gate (matches index.js startup check)', () => {
  it('refuses secrets shorter than 32 characters', () => {
    process.env.JWT_SECRET = 'twenty-seven-chars-secret-1';
    assert.throws(() => signToken({ id: '64f000000000000000000004' }), /32/);
    process.env.JWT_SECRET = 'test-only-secret-1234567890-abcdefg';
  });
});
