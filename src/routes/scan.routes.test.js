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

describe('isQuotaError (Groq rate-limit detection)', () => {
  const { isQuotaError } = scanHelpers;

  it('flags provider 429 shapes, ignores real failures', () => {
    assert.equal(typeof isQuotaError, 'function');
    assert.equal(isQuotaError({ status: 429, message: 'Rate limit exceeded' }), true);
    assert.equal(isQuotaError({ code: 'rate_limit_exceeded', message: 'slow down' }), true);
    assert.equal(isQuotaError(new Error('Request was rejected due to a rate limit (RPD 1000)')), true);
    assert.equal(isQuotaError(new Error('boom')), false);
    assert.equal(isQuotaError(null), false);
  });
});

const { scanHelpers: scanHelpers2 } = require('./scan.routes');

describe('lookupOffProduct (upstream accounting)', () => {
  const { lookupOffProduct } = scanHelpers2;

  it('treats an upstream 404 as reachable (product missing, not lookup failed)', async () => {
    const notFound = { ok: false, status: 404, json: async () => ({ status: 0 }) };
    const out = await lookupOffProduct(['0000000000000'], async () => notFound);
    assert.equal(out.upstreamOk, true);
    assert.equal(out.data, null);
  });

  it('returns product data on 200 with status 1', async () => {
    const product = { product_name: 'X', nutriments: {} };
    const ok = { ok: true, status: 200, json: async () => ({ status: 1, product }) };
    const out = await lookupOffProduct(['3017620422003'], async () => ok);
    assert.equal(out.upstreamOk, true);
    assert.equal(out.data.product, product);
  });

  it('reports unreachable only when every attempt throws', async () => {
    const out = await lookupOffProduct(['3017620422003', '03017620422003'], async () => { throw new Error('boom'); });
    assert.equal(out.upstreamOk, false);
    assert.equal(out.data, null);
  });
});

describe('chargeScanQuota (per-user daily scan cap)', () => {
  const { chargeScanQuota, SCAN_DAILY_LIMIT } = require('./scan.routes');
  const todayKey = () => new Date().toISOString().slice(0, 10);
  const fakeModel = (user) => ({ findById: () => ({ select: async () => user }) });
  const fakeUser = (patch) => ({ saves: 0, async save() { this.saves += 1; }, ...patch });

  it('increments within the same day', async () => {
    const user = fakeUser({ scanDayKey: todayKey(), scanCountToday: 4 });
    assert.equal(await chargeScanQuota('u1', fakeModel(user)), 5);
    assert.equal(user.saves, 1);
  });

  it('resets the counter on a new day', async () => {
    const user = fakeUser({ scanDayKey: '2000-01-01', scanCountToday: 49 });
    assert.equal(await chargeScanQuota('u1', fakeModel(user)), 1);
  });

  it('treats a missing user as over quota (defensive)', async () => {
    assert.ok((await chargeScanQuota('ghost', fakeModel(null))) > SCAN_DAILY_LIMIT);
  });

  it('has a sane default limit', () => {
    assert.ok(Number.isInteger(SCAN_DAILY_LIMIT) && SCAN_DAILY_LIMIT >= 1 && SCAN_DAILY_LIMIT <= 500);
  });
});

describe('refundScanQuota (failed paid calls give the quota back)', () => {
  const { refundScanQuota } = require('./scan.routes');
  const todayKey = () => new Date().toISOString().slice(0, 10);

  it('decrements only today\'s non-zero counter (atomic guard in the filter)', async () => {
    let seen = null;
    const model = { updateOne: async (filter, update) => { seen = { filter, update }; } };
    await refundScanQuota('u1', model);
    assert.equal(seen.filter._id, 'u1');
    assert.equal(seen.filter.scanDayKey, todayKey());
    assert.deepEqual(seen.filter.scanCountToday, { $gt: 0 });
    assert.deepEqual(seen.update, { $inc: { scanCountToday: -1 } });
  });
});
