const crypto = require('crypto');

// One ID per request, shared frontend <-> backend: the app sends its Ref #
// as X-Request-Id and the server echoes + logs it, so a user's "Ref #abc123"
// maps to exactly one backend log line.
function newRequestId() {
  return crypto.randomBytes(4).toString('hex').slice(0, 8);
}

function requestIdMiddleware(req, res, next) {
  const incoming = req.headers && req.headers['x-request-id'];
  const id = (typeof incoming === 'string' && incoming.trim()) || newRequestId();
  req.reqId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = { requestIdMiddleware, newRequestId };
