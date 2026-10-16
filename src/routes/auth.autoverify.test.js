const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Dummy secret BEFORE requiring the route module (mirrors auth.pending.test.js).
process.env.JWT_SECRET = 'test-only-secret-1234567890-abcdefg';
const { isSmtpConfigured } = require('./auth.routes');

describe('isSmtpConfigured (no-SMTP auto-verify gate)', () => {
  const saved = process.env.SMTP_HOST;
  const restore = () => {
    if (saved === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = saved;
  };
  it('is a function', () => {
    assert.equal(typeof isSmtpConfigured, 'function');
  });
  it('is false when SMTP_HOST is unset (relay removed)', () => {
    delete process.env.SMTP_HOST;
    try {
      assert.equal(isSmtpConfigured(), false);
    } finally {
      restore();
    }
  });
  it('is true when SMTP_HOST is set', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    try {
      assert.equal(isSmtpConfigured(), true);
    } finally {
      restore();
    }
  });
});
