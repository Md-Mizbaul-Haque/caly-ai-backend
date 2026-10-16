const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSmtpOptions, classifyMailError, validateSmtpConfig, getMailStatus } = require('./mailer');

describe('classifyMailError (Render log triage)', () => {
  const savedHost = process.env.SMTP_HOST;
  const withHost = (fn) => () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    try { fn(); } finally {
      if (savedHost === undefined) delete process.env.SMTP_HOST;
      else process.env.SMTP_HOST = savedHost;
    }
  };
  it('reports NOT_CONFIGURED when SMTP_HOST is missing', () => {
    delete process.env.SMTP_HOST;
    try {
      assert.equal(classifyMailError({ code: 'ETIMEDOUT' }), 'NOT_CONFIGURED');
    } finally {
      if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
    }
  });
  it('reports AUTH for bad credentials', withHost(() => {
    assert.equal(classifyMailError({ code: 'EAUTH', message: 'Invalid login' }), 'AUTH');
  }));
  it('reports NETWORK for timeouts/refusals (the Render black-hole)', withHost(() => {
    for (const code of ['ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'EDNS', 'ECONNRESET']) {
      assert.equal(classifyMailError({ code }), 'NETWORK');
    }
  }));
  it('reports REJECTED when the provider refuses the message', withHost(() => {
    assert.equal(classifyMailError({ code: 'EENVELOPE' }), 'REJECTED');
  }));
  it('reports UNKNOWN otherwise', withHost(() => {
    assert.equal(classifyMailError({ code: 'ESOMETHING' }), 'UNKNOWN');
    assert.equal(classifyMailError(new Error('boom')), 'UNKNOWN');
  }));
});

describe('buildSmtpOptions (fail-fast SMTP)', () => {
  it('caps connection, greeting, and socket timeouts at 10 s', () => {
    const opts = buildSmtpOptions();
    assert.ok(opts.connectionTimeout <= 10000, 'connection can hang register past the 15 s client timeout');
    assert.ok(opts.greetingTimeout <= 10000, 'greeting can hang register past the 15 s client timeout');
    assert.ok(opts.socketTimeout <= 10000, 'idle socket can hang register past the 15 s client timeout');
  });
});

describe('validateSmtpConfig (hang-before-fail audit)', () => {
  it('flags a missing host', () => {
    assert.deepEqual(validateSmtpConfig({}), ['SMTP_HOST not set — emails are console-logged, NOT sent']);
  });
  it('flags implicit-TLS on the STARTTLS port (the 10 s black-hole)', () => {
    const problems = validateSmtpConfig({ SMTP_HOST: 'h', SMTP_PORT: '587', SMTP_SECURE: '1', SMTP_USER: 'u' });
    assert.ok(problems.some((p) => /port 465/.test(p)), 'expected the 587+secure mismatch warning');
  });
  it('flags plaintext on the implicit-TLS port', () => {
    const problems = validateSmtpConfig({ SMTP_HOST: 'h', SMTP_PORT: '465', SMTP_USER: 'u' });
    assert.ok(problems.some((p) => /465/.test(p)));
  });
  it('flags missing auth', () => {
    const problems = validateSmtpConfig({ SMTP_HOST: 'h' });
    assert.ok(problems.some((p) => /SMTP_USER/.test(p)));
  });
  it('passes a sane Gmail-style config', () => {
    assert.deepEqual(validateSmtpConfig({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587', SMTP_USER: 'u' }), []);
  });
});

describe('getMailStatus (health without log access)', () => {
  it('reports configured flag and null lastError before any send', () => {
    const saved = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      assert.deepEqual(getMailStatus(), { configured: false, lastError: null });
    } finally {
      if (saved !== undefined) process.env.SMTP_HOST = saved;
    }
  });
});
