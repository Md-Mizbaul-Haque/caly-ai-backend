const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requestIdMiddleware } = require('./requestId');

function fakeReq(headers = {}) {
  return { headers };
}

function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader(k, v) { headers[k] = v; },
  };
}

// One ID per request, shared frontend <-> backend: the app sends
// X-Request-Id (its Ref #) and the server echoes + logs it.
describe('requestIdMiddleware', () => {
  it('echoes an incoming X-Request-Id onto req and res', () => {
    const req = fakeReq({ 'x-request-id': '5rs8na' });
    const res = fakeRes();
    let nexted = false;
    requestIdMiddleware(req, res, () => { nexted = true; });
    assert.equal(req.reqId, '5rs8na');
    assert.equal(res.headers['X-Request-Id'], '5rs8na');
    assert.equal(nexted, true);
  });

  it('generates an 8-char id when the client sends none', () => {
    const req = fakeReq();
    const res = fakeRes();
    requestIdMiddleware(req, res, () => {});
    assert.match(req.reqId, /^[a-z0-9]{8}$/);
    assert.equal(res.headers['X-Request-Id'], req.reqId);
  });
});
