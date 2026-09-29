async function req(base, path, opts = {}) {
  const res = await fetch(base + path, opts);
  let body = null;
  try { body = await res.json(); } catch (e) { /* empty body */ }
  return { status: res.status, body, headers: res.headers };
}

function json(method, body, token) {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  };
}

const results = { passed: 0, failed: 0 };

function assert(cond, name) {
  if (cond) { results.passed++; console.log(`ok - ${name}`); }
  else { results.failed++; console.error(`FAIL - ${name}`); }
}

async function runSuite(fn) {
  const { connectDb, disconnectDb } = require('../src/config/db');
  const app = require('../src/app');
  await connectDb();
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    await disconnectDb().catch(() => {});
  }
  console.log(`${results.passed} passed, ${results.failed} failed`);
  process.exit(results.failed ? 1 : 0);
}

module.exports = { req, json, assert, runSuite };
