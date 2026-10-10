const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { LABEL_SCHEMA, scanHelpers } = require('./scan.routes');

describe('LABEL_SCHEMA (AI vision output)', () => {
  it('accepts a realistic AI payload', () => {
    const r = LABEL_SCHEMA.safeParse({
      items: [{ name: 'Grilled chicken rice bowl', kcal: 520, protein: 35, carbs: 55, fat: 14 }],
    });
    assert.equal(r.success, true);
  });
  it('defaults missing macros to 0 and rejects empty/oversize lists', () => {
    const r = LABEL_SCHEMA.safeParse({ items: [{ name: 'Apple', kcal: 95 }] });
    assert.equal(r.success, true);
    assert.equal(r.data.items[0].protein, 0);
    assert.equal(LABEL_SCHEMA.safeParse({ items: [] }).success, false);
    const many = Array.from({ length: 7 }, (_, i) => ({ name: `food ${i}`, kcal: 10 }));
    assert.equal(LABEL_SCHEMA.safeParse({ items: many }).success, false);
  });
  it('rejects out-of-range kcal', () => {
    assert.equal(LABEL_SCHEMA.safeParse({ items: [{ name: 'x', kcal: -5 }] }).success, false);
    assert.equal(LABEL_SCHEMA.safeParse({ items: [{ name: 'x', kcal: 6000 }] }).success, false);
  });
});

describe('scanHelpers (barcode math)', () => {
  it('toNum coerces strings and kills NaN', () => {
    assert.equal(scanHelpers.toNum('12.5'), 13);
    assert.equal(scanHelpers.toNum('12.5', 1), 12.5);
    assert.equal(scanHelpers.toNum(undefined), 0);
    assert.equal(scanHelpers.toNum('n/a'), 0);
  });
  it('servingGrams parses grams, ignores unit-less counts', () => {
    assert.equal(scanHelpers.servingGrams('40g'), 40);
    assert.equal(scanHelpers.servingGrams('40 g', 'g'), 40);
    assert.equal(scanHelpers.servingGrams('1 bar (40g)'), 40);
    assert.equal(scanHelpers.servingGrams('40'), null);
    assert.equal(scanHelpers.servingGrams(undefined), null);
  });
});
