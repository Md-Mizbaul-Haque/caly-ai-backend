/* Fill Food.imageUrl with exact-match images.
 *
 * Source priority: Wikipedia article lead images (curated, exact by
 * construction) -> Wikipedia full-text search -> Wikimedia Commons file
 * search (confidence-gated). Only trusted matches are kept — the rest stay
 * null for manual review (see LOW list at the end).
 * Hosting: the source file is uploaded to Cloudinary caly-ai/foods/fdc-<id>
 * so the app serves stable URLs. (Open Food Facts was tried first but its API
 * ignored our queries and 503d from this network — dropped.)
 *
 * Usage:
 *   node scripts/fill-food-images.js --dry-run --limit=10   # match only, no writes
 *   node scripts/fill-food-images.js --limit=10             # pilot with uploads
 *   node scripts/fill-food-images.js                        # full catalog
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDb, disconnectDb } = require('../src/config/db');
const Food = require('../src/models/Food');
const { baseName, pickBestImage, scoreMatch, deniedTitle, wikiTitles, trustWikiPick, ALIAS } = require('../src/services/foodImageMatch');
const ALIAS_VALUES = new Set(Object.values(ALIAS));
const { connectCloudinary } = require('../src/config/cloudinary');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Manual overrides for names the automatic paths can't handle
// (brand-heavy names). query = Commons search input, base = match text.
const MANUAL = {
  'Formulated Bar, SOUTH BEACH protein bar': { query: 'protein bar', base: 'protein bar' },
};

function args() {
  const out = { limit: Infinity, dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--limit=')) out.limit = Math.max(1, parseInt(a.split('=')[1], 10) || 1);
    if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

// One batched titles= lookup (up to 50 titles per request) instead of one
// request per guess. Returns {pages, redirects} keyed-map and redirect set.
async function wikiBatch(titles) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1' +
    `&titles=${titles.map(encodeURIComponent).join('|')}` +
    '&prop=pageimages&pithumbsize=640&origin=*';
  let res = await fetch(url, { headers: { 'User-Agent': 'CalyAI/1.0 (food-catalog-image-match)' } });
  for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
    await sleep(20000);
    res = await fetch(url, { headers: { 'User-Agent': 'CalyAI/1.0 (food-catalog-image-match)' } });
  }
  if (!res.ok) throw new Error(`Wikipedia search failed (${res.status})`);
  const json = await res.json();
  const redirectFrom = new Map(
    ((json.query && json.query.redirects) || []).map((r) => [
      (r.from || '').toLowerCase(),
      (r.to || '').toLowerCase(),
    ]),
  );
  const byTitle = {};
  for (const p of Object.values((json.query && json.query.pages) || {})) {
    byTitle[(p.title || '').toLowerCase()] = p;
  }
  // Normalization ("Potato Pancakes" vs "Potato pancakes") is reported too.
  if (json.query && json.query.normalized) {
    for (const n of json.query.normalized) {
      redirectFrom.set((n.from || '').toLowerCase(), (n.to || '').toLowerCase());
    }
  }
  return { byTitle, redirectFrom };
}

// Relevance fallback: Wikipedia full-text search for the base name.
async function wikiSearchFallback(foodName) {
  const q = baseName(foodName);
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json' +
    `&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=0&gsrlimit=5` +
    '&prop=pageimages&pithumbsize=640&origin=*';
  const res = await fetch(url, { headers: { 'User-Agent': 'CalyAI/1.0 (food-catalog-image-match)' } });
  if (!res.ok) throw new Error(`Wikipedia search failed (${res.status})`);
  const json = await res.json();
  const pages = Object.values((json.query && json.query.pages) || {});
  for (const p of pages) {
    if (p.thumbnail && p.thumbnail.source && scoreMatch(q, p.title) > 0 && !deniedTitle(p.title)) {
      return { product_name: p.title, image_url: p.thumbnail.source, source: 'wiki-search' };
    }
  }
  return null;
}

// Wikipedia article lead image: curated and exactly about the subject.
// Order: full base, adjective-first combo, singulars, specific token, head.
async function searchWikipedia(foodName) {
  const titles = wikiTitles(foodName);
  const batch = await wikiBatch(titles);
  for (const title of titles) {
    const key = title.toLowerCase();
    const target = batch.redirectFrom.get(key) || key;
    const page = batch.byTitle[target];
    if (page && !page.missing && page.thumbnail && page.thumbnail.source) {
      const redirected = batch.redirectFrom.has(key);
      // Alias guesses (Peanut, Soy sauce, Soft drink) are curated answers:
      // trust them unless the page itself is denied.
      const trusted =
        trustWikiPick(title, page.title, foodName, redirected) ||
        (ALIAS_VALUES.has(title) && !deniedTitle(page.title));
      if (trusted) {
        return { product_name: page.title, image_url: page.thumbnail.source, source: 'wiki' };
      }
    }
    await sleep(300);
  }
  return wikiSearchFallback(foodName);
}

async function searchCommons(query) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json' +
    `&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=8` +
    '&prop=imageinfo&iiprop=url&iiurlwidth=640&origin=*';
  const res = await fetch(url, { headers: { 'User-Agent': 'CalyAI/1.0 (food-catalog-image-match)' } });
  if (!res.ok) throw new Error(`Commons search failed (${res.status})`);
  const json = await res.json();
  const pages = Object.values((json.query && json.query.pages) || {});
  return pages
    .filter((p) => /\.(jpe?g|png|webp)$/i.test(p.title))
    .map((p) => ({
      product_name: p.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '').replace(/[-_]/g, ' '),
      image_url: (p.imageinfo && p.imageinfo[0] && p.imageinfo[0].thumburl) || null,
    }));
}

async function main() {
  const { limit, dryRun } = args();
  await connectDb();
  const foods = await Food.find({ $or: [{ imageUrl: null }, { imageUrl: '' }] })
    .sort({ fdcId: 1 })
    .limit(limit)
    .lean();
  console.log(`Found ${foods.length} foods without images${dryRun ? ' (DRY RUN)' : ''}.`);

  let cloudinary = null;
  if (!dryRun) cloudinary = connectCloudinary();

  let filled = 0;
  let filledWiki = 0;
  const low = [];
  for (let i = 0; i < foods.length; i++) {
    const f = foods[i];
    const q = baseName(f.name);
    try {
      // 1) Wikipedia lead image — exact by construction.
      // Wiki failures (429s) must not block the Commons fallback.
      let wiki = null;
      try {
        wiki = await searchWikipedia(f.name);
      } catch (e) {
        console.log(`[${i + 1}/${foods.length}] WARN "${f.name}": wiki failed (${e.message}), trying Commons`);
      }
      let picked = wiki ? wiki.image_url : null;
      let label = wiki ? `"${wiki.product_name}" [wiki]` : null;
      // 2) Commons file search fallback with confidence gate.
      if (!picked) {
        const manual = MANUAL[f.name];
        const candidates = await searchCommons(manual ? manual.query : q);
        picked = pickBestImage(f.name, candidates, manual ? manual.base : undefined);
        const prod = picked && candidates.find((c) => c.image_url === picked);
        label = prod ? `"${prod.product_name}" [commons]` : null;
      }
      if (!picked) {
        low.push(`${f.name}`);
        console.log(`[${i + 1}/${foods.length}] LOW   "${f.name}" <- no confident match`);
      } else if (dryRun) {
        filled++;
        if (wiki) filledWiki++;
        console.log(`[${i + 1}/${foods.length}] MATCH "${f.name}" <- ${label}`);
      } else {
        const up = await cloudinary.uploader.upload(picked, {
          folder: 'caly-ai/foods',
          public_id: `fdc-${f.fdcId}`,
          overwrite: true, // re-runs with better logic replace stale images
          resource_type: 'image',
        });
        await Food.updateOne({ _id: f._id }, { $set: { imageUrl: up.secure_url } });
        filled++;
        if (wiki) filledWiki++;
        console.log(`[${i + 1}/${foods.length}] SAVED "${f.name}" <- ${label}`);
      }
    } catch (e) {
      low.push(`${f.name} (ERROR: ${e.message})`);
      console.log(`[${i + 1}/${foods.length}] ERROR "${f.name}": ${e.message}`);
    }
    await sleep(2500); // stay under Wikipedia/Commons rate limits
  }
  const total = await Food.countDocuments({ imageUrl: { $ne: null } });
  console.log(`\nDone: filled ${filled} (wiki ${filledWiki}), low/no-match ${low.length}, catalog with images ${total}.`);
  if (low.length) {
    console.log('\nLOW (needs manual review):');
    low.forEach((l) => console.log(' -', l));
  }
  await disconnectDb();
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(e.message);
    try {
      await disconnectDb();
    } catch {}
    process.exit(1);
  });
}
