const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Test inbox BEFORE requiring auth.routes: mailer reads CALY_TEST_INBOX at
// module load, so sends are captured locally instead of touching the network.
process.env.CALY_TEST_INBOX = '1';
process.env.JWT_SECRET = 'test-only-secret-1234567890-abcdefg';
const auth = require('./auth.routes');
const { issueVerifyCode, issuePendingCode, issueResetCode, withinThrottle, CODE_RESEND_WAIT_MS } = auth;
const { hashCode } = require('../services/auth');
const { getTestInbox, clearTestInbox } = require('../services/mailer');

const WAIT = CODE_RESEND_WAIT_MS;

function fakeUser() {
  return {
    email: 'u@example.com',
    lastCodeIssuedAt: null,
    verifyCodeHash: null,
    verifyCodeExpiresAt: null,
    verifyCodeAttempts: 9,
    resetCodeHash: null,
    resetCodeExpiresAt: null,
    resetCodeAttempts: 0,
    saves: 0,
    async save() { this.saves += 1; },
  };
}

function fakePending() {
  return {
    email: 'p@example.com',
    lastCodeIssuedAt: null,
    codeHash: null,
    codeExpiresAt: null,
    codeAttempts: 0,
    saves: 0,
    async save() { this.saves += 1; },
  };
}

function ageTimestamp(doc) {
  doc.lastCodeIssuedAt = new Date(Date.now() - WAIT - 1000); // fresh enough to allow
  return doc;
}

describe('withinThrottle', () => {
  it('allows when no code was ever issued', () => {
    assert.equal(withinThrottle({ lastCodeIssuedAt: null }), false);
    assert.equal(withinThrottle({}), false);
  });
  it('blocks within the wait window (even a future stamp)', () => {
    assert.equal(withinThrottle({ lastCodeIssuedAt: new Date(Date.now() - WAIT / 2) }), true);
    assert.equal(withinThrottle({ lastCodeIssuedAt: new Date(Date.now() + 5000) }), true);
  });
  it('allows once the window has passed', () => {
    assert.equal(withinThrottle({ lastCodeIssuedAt: new Date(Date.now() - WAIT - 1) }), false);
  });
});

describe('issue*Code per-account send throttle (test inbox)', () => {
  beforeEach(() => clearTestInbox());

  it('issueVerifyCode: first call mails + stamps; rapid second call reuses the code, no second mail', async () => {
    const user = fakeUser();
    assert.ok(await issueVerifyCode(user));
    assert.equal(user.lastCodeIssuedAt !== null, true);
    assert.equal(user.verifyCodeAttempts, 0);
    assert.equal(user.saves, 1);
    assert.equal(getTestInbox().length, 1);

    const hash = user.verifyCodeHash;
    assert.ok(await issueVerifyCode(user), 'throttled repeat still reports sent (previous code is valid)');
    assert.equal(user.verifyCodeHash, hash, 'rapid repeat must not mint a new code');
    assert.equal(user.saves, 1, 'no extra save on the throttled path');
    assert.equal(getTestInbox().length, 1, 'no second email within 60 s');
  });

  it('issueVerifyCode: after the window, a fresh code is minted and mailed', async () => {
    const user = ageTimestamp(fakeUser());
    const oldHash = hashCode('999999');
    user.verifyCodeHash = oldHash;
    assert.ok(await issueVerifyCode(user));
    assert.notEqual(user.verifyCodeHash, oldHash);
    assert.equal(getTestInbox().length, 1);
  });

  it('issuePendingCode throttles on the pending row exactly the same way', async () => {
    const pending = fakePending();
    assert.ok(await issuePendingCode(pending));
    assert.equal(getTestInbox().length, 1);
    const hash = pending.codeHash;
    assert.ok(await issuePendingCode(pending));
    assert.equal(pending.codeHash, hash, 'rapid repeat keeps the original hash');
    assert.equal(getTestInbox().length, 1);
    assert.ok(await issuePendingCode(ageTimestamp(pending)));
    assert.notEqual(pending.codeHash, hash);
    assert.equal(getTestInbox().length, 2);
  });

  it('issueResetCode throttles reset mails independently of the same stamp logic', async () => {
    const user = fakeUser();
    assert.ok(await issueResetCode(user));
    assert.ok(user.resetCodeHash);
    assert.equal(getTestInbox().length, 1);
    const hash = user.resetCodeHash;
    assert.ok(await issueResetCode(user));
    assert.equal(user.resetCodeHash, hash);
    assert.equal(getTestInbox().length, 1);
  });

  it('each issuer stamps lastCodeIssuedAt so the throttle carries across resend-code/forgot', async () => {
    const user = fakeUser();
    await issueVerifyCode(user);
    const stamped = user.lastCodeIssuedAt;
    const fresh = fakeUser();
    fresh.lastCodeIssuedAt = stamped;
    assert.equal(withinThrottle(fresh), true, 'a stamped doc is throttled regardless of which endpoint stamped it');
  });
});
