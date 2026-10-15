const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const CODE_TTL_MINUTES = 10;
const MAX_RESET_ATTEMPTS = 5;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

function requireJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 20) {
    throw new Error('JWT_SECRET must be set to a long random string — see .env.example');
  }
  return secret;
}

// tv (token version) lets a password reset or an explicit logout invalidate
// every token already handed out: the middleware rejects a token whose tv
// no longer matches the user's stored tokenVersion.
function signToken(user) {
  return jwt.sign({ sub: user.id, tv: user.tokenVersion || 0 }, requireJwtSecret(), { expiresIn: '30d' });
}

function verifyToken(token) {
  const payload = jwt.verify(token, requireJwtSecret());
  if (!payload || typeof payload.sub !== 'string') throw new Error('invalid token');
  return payload;
}

// 6-digit numeric code, e.g. "042913" — leading zeros are meaningful.
function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Codes are short and rate-limited; a keyed digest keeps them out of the DB in plaintext.
function hashCode(code) {
  return crypto.createHmac('sha256', requireJwtSecret()).update(code).digest('hex');
}

function codesMatch(code, hash) {
  if (!code || !hash) return false;
  const digest = Buffer.from(hashCode(code), 'hex');
  const stored = Buffer.from(hash, 'hex');
  return digest.length === stored.length && crypto.timingSafeEqual(digest, stored);
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function passwordMatches(password, hash) {
  return bcrypt.compare(password, hash);
}

function codeExpiry() {
  return new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
}

module.exports = {
  CODE_TTL_MINUTES,
  MAX_RESET_ATTEMPTS,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCK_MS,
  signToken,
  verifyToken,
  generateCode,
  hashCode,
  codesMatch,
  hashPassword,
  passwordMatches,
  codeExpiry,
};
