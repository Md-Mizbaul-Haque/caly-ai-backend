const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSmtpOptions,
  buildHttpPayload,
  resolveSender,
  sendViaHttp,
  sendMail,
  isMailConfigured,
  isHttpMailConfigured,
  classifyMailError,
  validateSmtpConfig,
  getMailStatus,
} = require('./mailer');

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
  it('reports RATE and PROVIDER for HTTP-API failures', withHost(() => {
    assert.equal(classifyMailError({ code: 'ERATE' }), 'RATE');
    assert.equal(classifyMailError({ code: 'EPROVIDER' }), 'PROVIDER');
    assert.equal(classifyMailError({ code: 'EHTTP' }), 'PROVIDER');
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
  it('reports nothing when the HTTPS transport carries the mail', () => {
    // Blocked SMTP ports are the normal case on a PaaS free tier, so a
    // half-configured relay must not be reported as a problem once the API
    // key is present.
    assert.deepEqual(validateSmtpConfig({ BREVO_API_KEY: 'xkeysib-test-key-that-is-long-enough' }), []);
    assert.deepEqual(
      validateSmtpConfig({ BREVO_API_KEY: 'xkeysib-test-key-that-is-long-enough', SMTP_HOST: 'h', SMTP_PORT: '587', SMTP_SECURE: '1' }),
      []
    );
  });
});

describe('resolveSender (relay-verified sender)', () => {
  it('prefers an explicit sender, then SMTP_FROM, then the SMTP user', () => {
    assert.equal(resolveSender({ MAIL_FROM: 'X <x@e.co>', SMTP_FROM: 'Y <y@e.co>' }).email, 'x@e.co');
    assert.equal(resolveSender({ SMTP_FROM: 'Y <y@e.co>', SMTP_USER: 'me@gmail.com' }).email, 'y@e.co');
    assert.equal(resolveSender({ SMTP_USER: 'me@gmail.com' }).email, 'me@gmail.com');
  });
  it('falls back to the product default and parses a bare address', () => {
    assert.equal(resolveSender({}).email, 'no-reply@caly-ai.app');
    assert.deepEqual(resolveSender({ MAIL_FROM: 'bare@e.co' }), { email: 'bare@e.co' });
  });
});

describe('buildHttpPayload (HTTPS transport)', () => {
  it('addresses the sender and recipient the provider expects', () => {
    const payload = buildHttpPayload(
      { to: 'user@example.com', subject: 'Hi', text: 'Body', html: '<p>Body</p>' },
      { MAIL_FROM: 'Caly AI <no-reply@caly-ai.app>' }
    );
    assert.deepEqual(payload.sender, { name: 'Caly AI', email: 'no-reply@caly-ai.app' });
    assert.deepEqual(payload.to, [{ email: 'user@example.com' }]);
    assert.equal(payload.subject, 'Hi');
    assert.equal(payload.textContent, 'Body');
    assert.equal(payload.htmlContent, '<p>Body</p>');
  });
  it('omits htmlContent for a text-only message', () => {
    const payload = buildHttpPayload({ to: 'u@e.co', subject: 's', text: 't' }, {});
    assert.equal('htmlContent' in payload, false);
  });
  it('always carries a body, even with no text and no html', () => {
    const payload = buildHttpPayload({ to: 'u@e.co', subject: 'Subject only' }, {});
    assert.equal(payload.textContent, 'Subject only', 'the API rejects a message with no body');
  });
  it('drops the name key when the sender has none', () => {
    const payload = buildHttpPayload({ to: 'u@e.co', subject: 's', text: 't' }, { SMTP_FROM: 'bare@e.co' });
    assert.deepEqual(payload.sender, { email: 'bare@e.co' });
  });
});

describe('sendViaHttp (the transport that survives a blocked SMTP port)', () => {
  const key = { BREVO_API_KEY: 'xkeysib-test-key-that-is-long-enough' };
  const message = { to: 'u@e.co', subject: 's', text: 't' };

  it('POSTs the payload with the api-key header', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 201, text: async () => '' };
    };
    const res = await sendViaHttp(message, key, fetchImpl);
    assert.deepEqual(res, { delivered: true, transport: 'http' });
    assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['api-key'], key.BREVO_API_KEY);
    assert.equal(JSON.parse(calls[0].init.body).to[0].email, 'u@e.co');
  });

  it('maps provider statuses to triage classes', async () => {
    const withStatus = (status) => async () => ({ ok: false, status, text: async () => 'nope' });
    const cases = [[401, 'EAUTH'], [403, 'EAUTH'], [400, 'EENVELOPE'], [422, 'EENVELOPE'], [429, 'ERATE'], [500, 'EPROVIDER']];
    for (const [status, code] of cases) {
      await assert.rejects(
        () => sendViaHttp(message, key, withStatus(status)),
        (e) => e.code === code && e.status === status,
        `status ${status} should map to ${code}`
      );
    }
  });

  it('reports a transport failure as NETWORK', async () => {
    const boom = async () => { const e = new Error('getaddrinfo ENOTFOUND'); e.code = 'ECONNREFUSED'; throw e; };
    // classifyMailError reads the live env (it must stay correct for callers
    // that pass no env), so expose the key for the duration of this assertion.
    const savedKey = process.env.BREVO_API_KEY;
    process.env.BREVO_API_KEY = key.BREVO_API_KEY;
    try {
      await assert.rejects(() => sendViaHttp(message, key, boom), (e) => classifyMailError(e) === 'NETWORK');
    } finally {
      if (savedKey === undefined) delete process.env.BREVO_API_KEY;
      else process.env.BREVO_API_KEY = savedKey;
    }
  });
});

describe('isMailConfigured / getMailStatus (two transports, one health line)', () => {
  const savedHost = process.env.SMTP_HOST;
  const savedKey = process.env.BREVO_API_KEY;
  const savedFetch = globalThis.fetch;
  const restore = () => {
    if (savedHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = savedHost;
    if (savedKey === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = savedKey;
    globalThis.fetch = savedFetch;
  };

  it('counts either transport as configured', () => {
    try {
      delete process.env.SMTP_HOST;
      delete process.env.BREVO_API_KEY;
      assert.equal(isMailConfigured(), false);
      assert.equal(isHttpMailConfigured(), false);
      process.env.SMTP_HOST = 'smtp.example.com';
      assert.equal(isMailConfigured(), true, 'SMTP alone is enough');
      delete process.env.SMTP_HOST;
      process.env.BREVO_API_KEY = 'xkeysib-test-key-that-is-long-enough';
      assert.equal(isMailConfigured(), true, 'the HTTP API alone is enough');
      assert.equal(isHttpMailConfigured(), true);
      // A short/placeholder value is not a usable key.
      process.env.BREVO_API_KEY = 'short';
      assert.equal(isHttpMailConfigured(), false);
      assert.equal(isMailConfigured(), false, 'a too-short key must not be mistaken for a transport');
    } finally {
      restore();
    }
  });

  it('names the active transport in health', () => {
    try {
      delete process.env.SMTP_HOST;
      delete process.env.BREVO_API_KEY;
      assert.equal(getMailStatus().transport, 'none');
      assert.equal(getMailStatus().configured, false);
      assert.equal(getMailStatus().lastError, null);
      assert.match(getMailStatus().sender, /@/, 'health must name the sender address');
      process.env.SMTP_HOST = 'smtp.example.com';
      assert.equal(getMailStatus().transport, 'smtp');
      process.env.BREVO_API_KEY = 'xkeysib-test-key-that-is-long-enough';
      assert.equal(getMailStatus().transport, 'http', 'the HTTPS API wins so a blocked SMTP port cannot decide delivery');
    } finally {
      restore();
    }
  });

  it('sends over HTTP through sendMail when the key is present', async () => {
    const calls = [];
    try {
      process.env.BREVO_API_KEY = 'xkeysib-test-key-that-is-long-enough';
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 201, text: async () => '' };
      };
      const res = await sendMail({ to: 'u@e.co', subject: 's', text: 't' });
      assert.deepEqual(res, { delivered: true, transport: 'http' });
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });

  it('throws (so the caller can report honestly) when the API rejects the send', async () => {
    try {
      process.env.BREVO_API_KEY = 'xkeysib-test-key-that-is-long-enough';
      globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => '{"message":"sender not verified"}' });
      await assert.rejects(
        () => sendMail({ to: 'u@e.co', subject: 's', text: 't' }),
        (e) => classifyMailError(e) === 'REJECTED'
      );
      assert.equal(getMailStatus().lastError.class, 'REJECTED', 'a failed send must land in /health');
      assert.match(getMailStatus().lastError.code, /EENVELOPE/);
    } finally {
      restore();
    }
  });
});
