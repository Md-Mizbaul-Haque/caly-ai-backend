const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Dummy secret BEFORE requiring the route module (mirrors auth.pending.test.js).
process.env.JWT_SECRET = 'test-only-secret-1234567890-abcdefg';
const { isEmailDeliveryConfigured } = require('./auth.routes');

describe('isEmailDeliveryConfigured (no-transport auto-verify gate)', () => {
  const savedHost = process.env.SMTP_HOST;
  const savedKey = process.env.BREVO_API_KEY;
  const restore = () => {
    if (savedHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = savedHost;
    if (savedKey === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = savedKey;
  };
  it('is a function', () => {
    assert.equal(typeof isEmailDeliveryConfigured, 'function');
  });
  it('is false when no transport is configured', () => {
    delete process.env.SMTP_HOST;
    delete process.env.BREVO_API_KEY;
    try {
      assert.equal(isEmailDeliveryConfigured(), false);
    } finally {
      restore();
    }
  });
  it('is true when SMTP_HOST is set', () => {
    delete process.env.BREVO_API_KEY;
    process.env.SMTP_HOST = 'smtp.example.com';
    try {
      assert.equal(isEmailDeliveryConfigured(), true);
    } finally {
      restore();
    }
  });
  it('is true when only the HTTPS mail API is configured', () => {
    // The case that matters on a host which blocks outbound SMTP: the relay is
    // absent but email still works, so accounts must NOT auto-verify.
    delete process.env.SMTP_HOST;
    process.env.BREVO_API_KEY = 'xkeysib-test-key-that-is-long-enough';
    try {
      assert.equal(isEmailDeliveryConfigured(), true);
    } finally {
      restore();
    }
  });
});
