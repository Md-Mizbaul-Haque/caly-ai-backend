const { verifyToken } = require('../services/auth');
const User = require('../models/User');

function getToken(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

async function requireAuth(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'authentication required' });
    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      return res.status(401).json({ error: 'invalid or expired token' });
    }
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'account no longer exists' });
    if (!user.emailVerified) return res.status(403).json({ error: 'email not verified', needsVerification: true });
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { requireAuth };
