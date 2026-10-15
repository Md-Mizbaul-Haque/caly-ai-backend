const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { supportMessageSchema } = require('./support.routes');

describe('supportMessageSchema', () => {
  it('accepts a normal message with optional subject', () => {
    const r = supportMessageSchema.safeParse({ message: 'Help me log meals', subject: 'Bug' });
    assert.equal(r.success, true);
    assert.equal(r.data.subject, 'Bug');
  });
  it('trims surrounding whitespace', () => {
    const r = supportMessageSchema.safeParse({ message: '  hello  ' });
    assert.equal(r.data.message, 'hello');
  });
  it('rejects missing, too-short, and too-long messages', () => {
    assert.equal(supportMessageSchema.safeParse({}).success, false);
    assert.equal(supportMessageSchema.safeParse({ message: 'hi' }).success, false);
    assert.equal(supportMessageSchema.safeParse({ message: 'x'.repeat(2001) }).success, false);
  });
});
