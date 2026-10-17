const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// A short budget so the "still in flight" path is testable without waiting.
process.env.MAIL_BUDGET_MS = '60';
process.env.JWT_SECRET = 'test-only-secret-1234567890-abcdefg';
const { sendWithinBudget } = require('./auth.routes');

const KEY = 'xkeysib-test-key-that-is-long-enough';
const MESSAGE = { to: 'user@example.com', subject: 'Your code', text: 'Code: 123456' };

describe('sendWithinBudget (honest delivery reporting)', () => {
  const savedKey = process.env.BREVO_API_KEY;
  const savedFetch = globalThis.fetch;
  const restore = () => {
    if (savedKey === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = savedKey;
    globalThis.fetch = savedFetch;
  };

  it('reports true when the provider accepts the message', async () => {
    try {
      process.env.BREVO_API_KEY = KEY;
      globalThis.fetch = async () => ({ ok: true, status: 201, text: async () => '' });
      assert.equal(await sendWithinBudget(MESSAGE), true);
    } finally {
      restore();
    }
  });

  it('reports false when the send fails, instead of claiming the code was sent', async () => {
    try {
      process.env.BREVO_API_KEY = KEY;
      globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => '{"message":"sender not verified"}' });
      assert.equal(await sendWithinBudget(MESSAGE), false, 'a failed send must surface as emailSent:false');
    } finally {
      restore();
    }
  });

  it('reports false when the transport itself is unreachable', async () => {
    try {
      process.env.BREVO_API_KEY = KEY;
      globalThis.fetch = async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; };
      assert.equal(await sendWithinBudget(MESSAGE), false);
    } finally {
      restore();
    }
  });

  it('counts a still-in-flight send as sent rather than failing the request', async () => {
    try {
      process.env.BREVO_API_KEY = KEY;
      globalThis.fetch = () => new Promise(() => {}); // never settles
      const started = Date.now();
      assert.equal(await sendWithinBudget(MESSAGE), true);
      assert.ok(Date.now() - started < 2000, 'the budget must not hold the request open');
    } finally {
      restore();
    }
  });

  it('is optimistic in dev console mode, where the code is logged not emailed', async () => {
    try {
      delete process.env.BREVO_API_KEY;
      delete process.env.SMTP_HOST;
      assert.equal(await sendWithinBudget(MESSAGE), true);
    } finally {
      restore();
    }
  });
});
