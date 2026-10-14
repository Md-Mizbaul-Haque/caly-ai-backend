const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSmtpOptions } = require('./mailer');

describe('buildSmtpOptions (fail-fast SMTP)', () => {
  it('caps connection, greeting, and socket timeouts at 10 s', () => {
    const opts = buildSmtpOptions();
    assert.ok(opts.connectionTimeout <= 10000, 'connection can hang register past the 15 s client timeout');
    assert.ok(opts.greetingTimeout <= 10000, 'greeting can hang register past the 15 s client timeout');
    assert.ok(opts.socketTimeout <= 10000, 'idle socket can hang register past the 15 s client timeout');
  });
});
