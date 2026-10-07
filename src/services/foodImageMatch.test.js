const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { baseName, scoreMatch, pickBestImage, wikiTitles, trustWikiPick, deniedTitle } = require('./foodImageMatch');

describe('foodImageMatch.baseName', () => {
  it('strips cooking qualifiers, keeps food nouns', () => {
    assert.equal(baseName('Egg, whole, raw'), 'egg');
    assert.equal(baseName('Rice, white, cooked, glutinous'), 'rice white glutinous');
    assert.equal(baseName('Milk, nonfat, fluid, with added vitamin A'), 'milk nonfat');
    assert.equal(baseName('Cheese, cheddar'), 'cheese cheddar');
    assert.equal(baseName('Snacks, popcorn, air-popped'), 'snacks popcorn');
    assert.equal(baseName('Pork, cured, bacon, unprepared'), 'pork bacon');
  });
});

describe('foodImageMatch.pickBestImage', () => {
  it('picks the high-overlap candidate with an image', () => {
    const got = pickBestImage('Banana, raw', [
      { product_name: 'Banana chips', image_url: 'http://x/b.jpg' },
      { product_name: 'Banana', image_url: 'http://x/a.jpg' },
    ]);
    assert.equal(got, 'http://x/a.jpg');
  });
  it('rejects low-confidence matches instead of storing a wrong image', () => {
    const got = pickBestImage('Grapes, raw', [
      { product_name: 'Grape tomatoes', image_url: 'http://x/t.jpg' },
      { product_name: 'Soda', image_url: null },
    ]);
    assert.equal(got, null);
  });
  it('ignores candidates without images', () => {
    const got = pickBestImage('Honey', [{ product_name: 'Honey', image_url: null }]);
    assert.equal(got, null);
  });
  it('rejects head-word matches buried deep in the title', () => {
    const got = pickBestImage('Mushrooms, white', [
      { product_name: 'Frog with white mushrooms on log', image_url: 'http://x/f.jpg' },
    ]);
    assert.equal(got, null);
  });
});

describe('foodImageMatch.wikiTitles', () => {
  it('tries full dish, adjective-first combo, specific token, head', () => {
    assert.deepEqual(wikiTitles('Chicken curry'), ['Chicken curry', 'Curry chicken', 'Curry', 'Chicken']);
    assert.deepEqual(wikiTitles('Banana, raw'), ['Banana']);
    assert.deepEqual(wikiTitles('Cheese, cheddar')[0], 'Cheese cheddar');
    assert.deepEqual(wikiTitles('Cheese, cheddar')[1], 'Cheddar cheese');
    assert.deepEqual(wikiTitles('Rice, white, cooked')[1], 'White rice');
  });
  it('skips bare colors and anatomy words', () => {
    assert.deepEqual(wikiTitles('Chicken, breast, grilled'), ['Chicken breast', 'Breast chicken', 'Chicken']);
  });
  it('tries middle tokens before the last token (taco beats tomato)', () => {
    const titles = wikiTitles('Beef taco filling: beef, cheese, tomato, taco sauce');
    assert.ok(titles.indexOf('Taco') !== -1);
    assert.ok(titles.indexOf('Taco') < titles.indexOf('Tomato'));
  });
  it('uses hard aliases for displaced articles', () => {
    assert.deepEqual(wikiTitles('Beverages, cola')[0], 'Soft drink');
    assert.deepEqual(wikiTitles('Frankfurter, beef')[0], 'Hot dog');
  });
});

describe('foodImageMatch.trustWikiPick', () => {
  it('trusts meaning-preserving redirects', () => {
    assert.equal(trustWikiPick('Corn', 'Maize', 'Corn, sweet, yellow', true), true);
    assert.equal(trustWikiPick('Potato Pancakes', 'Potato pancake', 'Potato pancakes', true), true);
  });
  it('rejects unrelated pages', () => {
    assert.equal(trustWikiPick('Greek', 'Diet food', 'Yogurt, Greek', false), false);
    assert.equal(trustWikiPick('Greek', 'Greeks', 'Yogurt, Greek', true), false);
  });
  it('accepts overlapping direct hits', () => {
    assert.equal(trustWikiPick('Curry', 'Curry', 'Chicken curry', false), true);
  });
  it('denies disambiguation traps even on overlap', () => {
    assert.equal(deniedTitle('Peanuts (comic strip)'), true);
    assert.equal(deniedTitle('Orange County, California'), true);
    assert.equal(trustWikiPick('Peanuts', 'Peanuts (comic strip)', 'PEANUTS', true), false);
  });
});
