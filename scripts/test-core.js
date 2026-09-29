require('dotenv').config();
process.env.NODE_ENV = 'production';

const { req, json, assert, runSuite } = require('./helpers');

runSuite(async base => {
  const health = await req(base, '/health');
  assert(health.status === 200 && health.body.status === 'ok', 'health returns 200 ok');
  assert(health.body.db === 'up', 'health reports db up');
  assert(typeof health.body.uptime === 'number', 'health includes uptime');

  const missing = await req(base, '/definitely-missing');
  assert(missing.status === 404 && missing.body && missing.body.error, 'unknown route -> 404 {error}');

  const badJson = await req(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{{not json',
  });
  assert(badJson.status === 400 && badJson.body && badJson.body.error === 'Invalid JSON body', 'malformed JSON -> 400 {error}');

  assert(health.headers.get('x-content-type-options') === 'nosniff', 'helmet sets x-content-type-options');

  const { errorHandler } = require('../src/middleware/error');
  const { AppError } = require('../src/utils/AppError');
  let captured = null;
  const fakeRes = {
    status(c) { this.code = c; return this; },
    json(b) { captured = { code: this.code, body: b }; },
  };
  const realConsoleError = console.error;
  console.error = () => {};
  errorHandler(new Error('boom'), {}, fakeRes, () => {});
  console.error = realConsoleError;
  assert(captured && captured.code === 500 && captured.body.error === 'Internal server error', 'errorHandler -> 500 {error}');
  assert(!('stack' in captured.body), 'production: no stack in response');
  process.env.NODE_ENV = 'development';
  console.error = () => {};
  errorHandler(new Error('boom'), {}, fakeRes, () => {});
  console.error = realConsoleError;
  assert('stack' in captured.body, 'development: stack included');
  process.env.NODE_ENV = 'production';
  console.error = () => {};
  errorHandler(new AppError(503, 'Database unavailable'), {}, fakeRes, () => {});
  console.error = realConsoleError;
  assert(captured && captured.code === 503 && captured.body.error === 'Database unavailable' && !('stack' in captured.body), 'AppError 503: message preserved in production, no stack');

  let limited = false;
  for (let i = 0; i < 101 && !limited; i++) {
    const r = await req(base, '/api');
    if (r.status === 429) {
      limited = true;
      assert(r.body && r.body.error, 'rate limited response is {error}');
    }
  }
  assert(limited, 'api rate limit engages within 101 requests');
}).catch(e => { console.error(e); process.exit(1); });
