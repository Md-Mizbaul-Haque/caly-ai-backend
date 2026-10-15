const { verifyToken } = require('../services/auth');
const User = require('../models/User');

function getToken(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

async function authorize(req, res, next, allowUnverified) {
  try {
    const token = getToken(req);
    if (!token) {
      // No PII/tokens here — reason + route only, so a 401 line tells us
      // instantly whether the client sent no header vs a bad token.
      console.warn(`[auth] 401 no-authorization-header ${req.method} ${req.path}`);
      return res.status(401).json({ error: 'authentication required' });
    }
    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      console.warn(`[auth] 401 bad-token ${req.method} ${req.path}`);
      return res.status(401).json({ error: 'invalid or expired token' });
    }
    const user = await User.findById(payload.sub);
    if (!user) {
      console.warn(`[auth] 401 unknown-user ${req.method} ${req.path}`);
      return res.status(401).json({ error: 'account no longer exists' });
    }
    // A token minted before a password reset / logout carries an older tv and
    // must be refused even though its signature still verifies.
    if ((payload.tv || 0) !== (user.tokenVersion || 0)) {
      console.warn(`[auth] 401 stale-token ${req.method} ${req.path}`);
      return res.status(401).json({ error: 'invalid or expired token' });
    }
    if (!user.emailVerified && !allowUnverified) {
      console.warn(`[auth] 403 unverified ${req.method} ${req.path}`);
      return res.status(403).json({ error: 'email not verified', needsVerification: true });
    }
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

function requireAuth(req, res, next) {
  return authorize(req, res, next, false);
}

// Onboarding surface for accounts created via skip-verification:
// identity is proven (token) but the mailbox is not. Everything else
// stays verified-only.
requireAuth.allowUnverified = function requireAuthLenient(req, res, next) {
  return authorize(req, res, next, true);
};

module.exports = { requireAuth };
