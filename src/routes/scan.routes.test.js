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

  it('accepts an optional serving portion per item', () => {
    const r = LABEL_SCHEMA.safeParse({
      items: [{ name: 'Pizza', kcal: 300, serving: '1 slice' }],
    });
    assert.equal(r.success, true);
    assert.equal(r.data.items[0].serving, '1 slice');
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

  it('isImageBuffer checks magic bytes, not the mime string', () => {
    assert.equal(scanHelpers.isImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0x00, 1, 2, 3, 4, 5, 6, 7, 8])), true);
    assert.equal(scanHelpers.isImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8])), true);
    assert.equal(scanHelpers.isImageBuffer(Buffer.from('not an image at all......')), false);
    assert.equal(scanHelpers.isImageBuffer(Buffer.alloc(4)), false);
    assert.equal(scanHelpers.isImageBuffer(null), false);
  });
});
