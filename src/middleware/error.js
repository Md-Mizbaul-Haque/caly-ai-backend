function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Multer (multipart photo uploads) reports failures as MulterError with
  // no status — map them before the generic branch so the app gets a
  // retryable/fixable code instead of a misleading 500.
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'image too large — use a smaller photo' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'unexpected upload field — expected "image"' });
  }
  const hasStatus = Boolean(err.status || err.statusCode);
  const status = err.status || err.statusCode || 500;
  let message = err.message || 'Internal server error';
  if (err.type === 'entity.parse.failed') message = 'Invalid JSON body';
  if (process.env.NODE_ENV === 'production' && !hasStatus) message = 'Internal server error';
  if (status >= 500) console.error(err);
  const body = { error: message };
  // Lets a user's "Ref #abc123" map to one backend log line.
  if (req.reqId) body.reqId = req.reqId;
  if (status >= 500 && process.env.NODE_ENV !== 'production') body.stack = err.stack;
  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
