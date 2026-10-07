// Match USDA food names to image sources — conservatively.
// Base name = head word + meaningful later nouns, cooking qualifiers stripped.
// Wikipedia article lead images are tried first (exact by construction);
// Commons file search is the gated fallback. Below CONFIDENCE (0.6) we
// return null: no image is better than a wrong image.

const QUALIFIERS = new Set([
  'raw', 'cooked', 'boiled', 'baked', 'fried', 'grilled', 'steamed', 'roasted',
  'frozen', 'canned', 'drained', 'fresh', 'fluid', 'pasteurized', 'unprepared',
  'ready', 'nfs', 'solids', 'mature', 'seeds', 'salt', 'sugar', 'fat', 'added',
  'vitamin', 'with', 'and', 'or', 'without', 'meat', 'lean', 'skin', 'eaten',
  'sauce', 'rotisserie', 'farmed', 'atlantic', 'air', 'popped', 'glazed',
  'cured', 'only', 'regular', 'all', 'grade', 'large', 'small', 'diet', 'whole',
  'restaurant', 'salt', 'fat',
]);

// The head word is the subject — only cooking/prep states are stripped from
// it, never subject nouns ("Sugar" stays; "Egg, whole, raw" -> "egg").
// Later parts use the full QUALIFIERS set.
const HEAD_STRIP = new Set([
  'raw', 'cooked', 'boiled', 'baked', 'fried', 'grilled', 'steamed', 'roasted',
  'frozen', 'canned', 'drained', 'fresh', 'fluid', 'pasteurized', 'unprepared',
  'ready', 'whole',
]);

function tokens(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

// ALL-CAPS tokens in FDC names are brand names (V8, SILK, QUAKER) —
// they poison matching, so they are dropped. Parentheticals like
// "(includes oyster, soda, soup)" are dropped too.
function isBrand(t) {
  return t.length > 1 && t === t.toUpperCase() && /[A-Z]/.test(t);
}

function baseName(description) {
  const noParens = (description || '').replace(/\([^)]*\)/g, ' ');
  const parts = noParens.split(',');
  const rawTokens = (s) =>
    (s || '')
      .replace(/[^A-Za-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  const kept = [];
  for (const t of rawTokens(parts[0])) {
    const l = t.toLowerCase();
    if (!HEAD_STRIP.has(l) && !kept.includes(l)) kept.push(l);
  }
  for (const p of parts.slice(1)) {
    for (const t of rawTokens(p)) {
      const l = t.toLowerCase();
      if (isBrand(t) || QUALIFIERS.has(l) || kept.includes(l)) continue;
      kept.push(l);
    }
  }
  return kept.join(' ').trim();
}

function scoreMatch(queryBase, productName) {
  const q = new Set(tokens(queryBase));
  if (!q.size) return 0;
  const p = new Set(tokens(productName));
  let hit = 0;
  for (const t of q) if (p.has(t)) hit++;
  return hit / q.size;
}

const CONFIDENCE = 0.6;

// Wikipedia uses sentence case ("Chicken curry", not "Chicken Curry").
function titleize(s) {
  const toks = tokens(s);
  return toks.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

// Naive singular: tomatoes->tomato, pancakes->pancake, berries->berry,
// grapes->grape, fries->fry. Conservative: never touches ss/se/us endings
// (cheese, class) or short words.
function singularize(w) {
  if (!w || w.length <= 4) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses') || w.endsWith('ses') || w.endsWith('xes') || w.endsWith('shes') || w.endsWith('ches')) {
    return w.replace(/es$/, '');
  }
  if (w.endsWith('s') && !/(ss|us|is|se|sh|ch|x)$/.test(w)) return w.slice(0, -1);
  return w;
}

// Hard aliases for names whose article is elsewhere.
const ALIAS = {
  cola: 'Soft drink',
  frankfurter: 'Hot dog',
  orange: 'Orange (fruit)',
  oranges: 'Orange (fruit)',
  peanuts: 'Peanut',
  soy: 'Soy sauce',
};

// Bare colors/tastes, anatomy words and generic nouns hit unrelated pages
// ("White", "Breast", "Protein", "Plain", "Water") — never try them alone.
const SKIP_WIKI = new Set([
  'white', 'black', 'red', 'green', 'yellow', 'sweet', 'hot', 'whole', 'brown',
  'breast', 'bar', 'diet', 'snack', 'plain', 'protein', 'based', 'powder',
  'food', 'beverage', 'beverages', 'water', 'light', 'wheat', 'milk', 'multigrain',
  'cottage', 'leaf', 'ingredient',
]);

// Page titles that are never the food itself, even on overlap.
const DENY_TITLE = [
  '(comic strip)', '(film)', '(band)', '(song)', '(album)', '(genus)',
  '(disambiguation)', 'county,',
];

function deniedTitle(pageTitle) {
  const t = (pageTitle || '').toLowerCase();
  if (EXACT_DENY.has(t)) return true;
  return DENY_TITLE.some((d) => t.includes(d));
}

// Exact page titles that are never the food (color swatches etc.).
const EXACT_DENY = new Set(['wine red', 'white']);

// Ordered Wikipedia title guesses: full base, adjective-first combos
// ("White rice", "Caesar salad"), singular variants, specific tokens
// (last, then middles nearest the head), head word.
function wikiTitles(foodName) {
  const toks = tokens(baseName(foodName));
  if (!toks.length) return [];
  if (ALIAS[toks[toks.length - 1]] || ALIAS[toks[0]]) {
    const a = ALIAS[toks[toks.length - 1]] || ALIAS[toks[0]];
    return [a, titleize(toks.join(' '))];
  }
  const head = toks[0];
  const last = toks[toks.length - 1];
  const out = [];
  const push = (t) => {
    if (t && !out.includes(t)) out.push(t);
  };
  const full = titleize(toks.join(' '));
  push(full);
  if (toks.length > 1) {
    push(titleize(`${last} ${toks.slice(0, -1).join(' ')}`));
    push(titleize(`${head} ${toks[1]}`));
    push(titleize(`${toks[1]} ${head}`));
    const singFull = titleize(toks.map(singularize).join(' '));
    push(singFull);
  }
  // Middle tokens nearest the head ("bagel" in "snacks bagel chips",
  // "taco" in "beef taco filling") — often the true subject. Tried before
  // the last token so "Taco" beats "Tomato" for taco filling.
  for (let i = 1; i <= toks.length - 2; i++) {
    const t = toks[i];
    if (t.length >= 4 && !SKIP_WIKI.has(t)) {
      push(titleize(t));
      push(titleize(singularize(t)));
    }
  }
  if (last !== head && last.length >= 4 && !SKIP_WIKI.has(last)) {
    push(titleize(last));
    push(titleize(singularize(last)));
  }
  const headTitle = titleize(head);
  if (out[out.length - 1] !== headTitle) push(headTitle);
  return out;
}

// Trust rule for a Wikipedia pick: the tried title redirected here from the
// full base or the head word (meaning preserved: "Corn" -> "Maize",
// "Potato Pancakes" -> "Potato Pancake"), otherwise the page title must
// share a token with the food (blocks "Greek" -> "Diet Food").
function trustWikiPick(triedTitle, pageTitle, foodName, redirected) {
  if (deniedTitle(pageTitle)) return false;
  const toks = tokens(baseName(foodName));
  const tried = (triedTitle || '').toLowerCase();
  if (redirected && (tried === toks.join(' ') || tried === (toks[0] || ''))) return true;
  return scoreMatch(baseName(foodName), pageTitle) > 0;
}

function pickBestImage(foodName, candidates, matchBase) {
  const base = matchBase || baseName(foodName);
  const head = tokens(base)[0];
  let best = null;
  let bestScore = 0;
  let bestExtra = Infinity;
  for (const c of candidates || []) {
    if (!c || !c.image_url || deniedTitle(c.product_name)) continue;
    const pTokens = tokens(c.product_name);
    // Head word must appear early — blocks "Alcoholic Beverage Control Board"
    // and "Frog with white mushrooms on log" style noise.
    if (head && pTokens.slice(0, 3).includes(head)) {
      const score = scoreMatch(base, c.product_name);
      const extra = pTokens.length - tokens(base).length;
      // Higher recall wins; ties go to the more exact name ("Banana" > "Banana chips").
      if (score > bestScore || (score === bestScore && extra < bestExtra)) {
        bestScore = score;
        bestExtra = extra;
        best = c.image_url;
      }
    }
  }
  return bestScore >= CONFIDENCE ? best : null;
}

module.exports = { baseName, scoreMatch, pickBestImage, wikiTitles, trustWikiPick, deniedTitle, ALIAS, CONFIDENCE };
