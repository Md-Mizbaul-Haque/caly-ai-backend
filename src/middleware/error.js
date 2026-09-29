function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || err.statusCode || 500;
  let message = err.message || 'Internal server error';
  if (err.type === 'entity.parse.failed') message = 'Invalid JSON body';
  if (status >= 500) console.error(err);
  const body = { error: message };
  if (status >= 500 && process.env.NODE_ENV !== 'production') body.stack = err.stack;
  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
