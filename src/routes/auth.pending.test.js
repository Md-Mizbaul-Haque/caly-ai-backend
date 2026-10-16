const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Dummy secret BEFORE requiring services/auth: hashCode/codeExpiry read it
// lazily, and these tests must never depend on a real .env value.
process.env.JWT_SECRET = 'test-only-secret-1234567890-abcdefg';
const PendingRegistration = require('../models/PendingRegistration');
const { skipSchema, checkCode, registerFailedLogin, markVerified, keepPendingOnEmailFailure } = require('./auth.routes');
const { generateCode, hashCode, codesMatch, MAX_RESET_ATTEMPTS, MAX_LOGIN_ATTEMPTS, LOGIN_LOCK_MS, signToken, verifyToken } = require('../services/auth');

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

// Fake doc matching either PendingRegistration (prefix 'code') or an
// unverified User (prefix 'verifyCode') so the shared check stays testable
// without a database.
function fakeDoc(prefix, { code = '123456', ttlMs = 60000, attempts = 0, expired = false } = {}) {
  return {
    [`${prefix}Hash`]: code ? hashCode(code) : null,
    [`${prefix}ExpiresAt`]: expired ? new Date(Date.now() - 1000) : new Date(Date.now() + ttlMs),
    [`${prefix}Attempts`]: attempts,
    saves: 0,
    async save() { this.saves += 1; },
  };
}

describe('checkCode (shared by pending + unverified-user rows)', () => {
  it('accepts the matching code without touching attempts', async () => {
    const doc = fakeDoc('code');
    assert.equal(await checkCode(doc, 'code', '123456'), 'ok');
    assert.equal(doc.codeAttempts, 0);
    assert.equal(doc.saves, 0);
  });
  it('works with the User verifyCode field names', async () => {
    const doc = fakeDoc('verifyCode');
    assert.equal(await checkCode(doc, 'verifyCode', '123456'), 'ok');
  });
  it('rejects and counts a wrong code', async () => {
    const doc = fakeDoc('code', { attempts: 2 });
    assert.equal(await checkCode(doc, 'code', '000000'), 'bad');
    assert.equal(doc.codeAttempts, 3);
    assert.equal(doc.saves, 1);
  });
  it('reports expired when missing or past expiry', async () => {
    assert.equal(await checkCode(fakeDoc('code', { code: null }), 'code', '123456'), 'expired');
    assert.equal(await checkCode(fakeDoc('code', { expired: true }), 'code', '123456'), 'expired');
  });
  it('locks out once attempts reach the cap', async () => {
    const doc = fakeDoc('code', { attempts: MAX_RESET_ATTEMPTS });
    assert.equal(await checkCode(doc, 'code', '123456'), 'locked');
    assert.equal(doc.saves, 0);
  });
});

describe('keepPendingOnEmailFailure (register when SMTP is down)', () => {
  function fakePendingStore(existing = { email: 'a@b.co' }) {
    const calls = [];
    return {
      calls,
      async findOne(query) { calls.push(['findOne', query]); return existing; },
      async deleteOne(query) { calls.push(['deleteOne', query]); return { deletedCount: 1 }; },
    };
  }
  function throwingUser() {
    return { async create() { throw new Error('User.create must not run on email failure'); } };
  }
  it('keeps the pending row and reports emailSent:false', async () => {
    const Pending = fakePendingStore();
    const payload = await keepPendingOnEmailFailure({ PendingRegistration: Pending, User: throwingUser() }, 'a@b.co');
    assert.equal(payload.requiresVerification, true);
    assert.equal(payload.emailSent, false);
    assert.ok(Pending.calls.some(([op]) => op === 'findOne'));
    assert.ok(!Pending.calls.some(([op]) => op === 'deleteOne'), 'pending must survive so resend/skip/verify keep working');
  });
  it('reports pendingKept:false when the row is gone', async () => {
    const payload = await keepPendingOnEmailFailure({ PendingRegistration: fakePendingStore(null), User: throwingUser() }, 'a@b.co');
    assert.equal(payload.emailSent, false);
    assert.equal(payload.pendingKept, false);
  });
});

describe('registerFailedLogin (per-account throttle)', () => {
  it('counts attempts below the cap without locking', async () => {
    const user = { failedLoginAttempts: 0, loginLockedUntil: null, saves: 0, async save() { this.saves += 1; } };
    await registerFailedLogin(user);
    assert.equal(user.failedLoginAttempts, 1);
    assert.equal(user.loginLockedUntil, null);
  });
  it('locks for LOGIN_LOCK_MS on the last allowed attempt', async () => {
    const user = { failedLoginAttempts: MAX_LOGIN_ATTEMPTS - 1, loginLockedUntil: null, async save() {} };
    await registerFailedLogin(user);
    assert.equal(user.failedLoginAttempts, 0);
    const msLeft = user.loginLockedUntil.getTime() - Date.now();
    assert.ok(msLeft > LOGIN_LOCK_MS - 5000 && msLeft <= LOGIN_LOCK_MS);
  });
});

function fakeUnverifiedUser() {
  return {
    emailVerified: false,
    tokenVersion: 0,
    verifyCodeHash: 'abc',
    verifyCodeExpiresAt: new Date(),
    verifyCodeAttempts: 2,
    saves: 0,
    clearVerifyCode() { this.verifyCodeHash = null; this.verifyCodeExpiresAt = null; this.verifyCodeAttempts = 0; },
    async save() { this.saves += 1; },
  };
}

describe('markVerified (verification kills pre-verification tokens)', () => {
  it('marks verified, bumps tokenVersion, clears the code, and saves', async () => {
    const user = fakeUnverifiedUser();
    markVerified(user);
    assert.equal(user.emailVerified, true);
    assert.equal(user.tokenVersion, 1);
    assert.equal(user.verifyCodeHash, null);
    await user.save();
    assert.equal(user.saves, 1);
  });
  it('invalidates a token minted while the row was unverified (skip-verification takeover)', () => {
    const user = fakeUnverifiedUser();
    // What the attacker holds: a real token from skip-verification, tv=0.
    const attackerToken = signToken({ id: '64f00000000000000000000a', tokenVersion: user.tokenVersion });
    markVerified(user);
    // The middleware rejects when payload.tv !== user.tokenVersion — this is
    // the exact comparison that used to let the attacker in after the victim
    // verified the same row.
    assert.notEqual(verifyToken(attackerToken).tv, user.tokenVersion);
  });
});
