const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Dummy secret BEFORE requiring services: sign/verify read it lazily, and
// these tests must never depend on a real .env value.
process.env.JWT_SECRET = 'test-only-secret-1234567890';
const User = require('../models/User');
const { signToken } = require('../services/auth');
const { requireAuth } = require('../middleware/auth');

const realFindById = User.findById;
afterEach(() => { User.findById = realFindById; });

function stubUser(user) {
  User.findById = async () => user;
}

function reqWith(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

function captureRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function run(mw, req) {
  const res = captureRes();
  let nextCalled = false;
  let nextErr = null;
  await mw(req, res, (e) => { nextCalled = true; nextErr = e || null; });
  return { res, nextCalled, nextErr, user: req.user };
}

const verifiedToken = signToken({ id: '64f000000000000000000001' });
const unverifiedToken = signToken({ id: '64f000000000000000000002' });

describe('requireAuth (strict)', () => {
  it('lets a verified user through', async () => {
    stubUser({ _id: 'u1', emailVerified: true });
    const r = await run(requireAuth, reqWith(verifiedToken));
    assert.equal(r.nextCalled, true);
    assert.equal(r.user, await User.findById());
  });
  it('403s an unverified user with needsVerification', async () => {
    stubUser({ _id: 'u2', emailVerified: false });
    const r = await run(requireAuth, reqWith(unverifiedToken));
    assert.equal(r.nextCalled, false);
    assert.equal(r.res.statusCode, 403);
    assert.equal(r.res.body.needsVerification, true);
  });
  it('401s with no token', async () => {
    const r = await run(requireAuth, reqWith(null));
    assert.equal(r.res.statusCode, 401);
  });
  it('401s on a bad token', async () => {
    const r = await run(requireAuth, reqWith('garbage'));
    assert.equal(r.res.statusCode, 401);
  });
  it('401s when the account no longer exists', async () => {
    stubUser(null);
    const r = await run(requireAuth, reqWith(verifiedToken));
    assert.equal(r.res.statusCode, 401);
  });
});

describe('requireAuth.allowUnverified', () => {
  it('lets an unverified user through with req.user set', async () => {
    const user = { _id: 'u2', emailVerified: false };
    stubUser(user);
    const req = reqWith(unverifiedToken);
    const r = await run(requireAuth.allowUnverified, req);
    assert.equal(r.nextCalled, true);
    assert.equal(req.user, user);
  });
  it('still lets verified users through', async () => {
    stubUser({ _id: 'u1', emailVerified: true });
    const r = await run(requireAuth.allowUnverified, reqWith(verifiedToken));
    assert.equal(r.nextCalled, true);
  });
  it('still 401s with no token or a bad token', async () => {
    assert.equal((await run(requireAuth.allowUnverified, reqWith(null))).res.statusCode, 401);
    assert.equal((await run(requireAuth.allowUnverified, reqWith('garbage'))).res.statusCode, 401);
  });
  it('still 401s when the account no longer exists', async () => {
    stubUser(null);
    const r = await run(requireAuth.allowUnverified, reqWith(verifiedToken));
    assert.equal(r.res.statusCode, 401);
  });
});
