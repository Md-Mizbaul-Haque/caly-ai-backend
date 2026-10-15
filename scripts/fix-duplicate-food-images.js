/* Fix duplicate Food images: keep first in each hash-group, re-fetch distinct real images for the rest.
 * Qualifier-aware: searches Commons/Wikipedia with the full variant name (not just head word),
 * rejects any candidate whose bytes match an already-seen hash.
 * Usage:
 *   node scripts/fix-duplicate-food-images.js --dry-run --limit=5
 *   node scripts/fix-duplicate-food-images.js --limit=50
 *   node scripts/fix-duplicate-food-images.js   (all duplicates)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const { connectDb, disconnectDb } = require('../src/config/db');
const Food = require('../src/models/Food');
const { baseName, pickBestImage, scoreMatch, deniedTitle, wikiTitles, trustWikiPick, ALIAS } = require('../src/services/foodImageMatch');
const ALIAS_VALUES = new Set(Object.values(ALIAS));
const { connectCloudinary } = require('../src/config/cloudinary');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args() {
  const out = { limit: Infinity, dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--limit=')) out.limit = Math.max(1, parseInt(a.split('=')[1], 10) || 1);
    if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function hashUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return { hash: crypto.createHash('md5').update(buf).digest('hex'), bytes: buf.length };
}

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
  if (!res.ok) throw new Error(`Wikipedia failed (${res.status})`);
  const json = await res.json();
  const redirectFrom = new Map(((json.query && json.query.redirects) || []).map((r) => [(r.from || '').toLowerCase(), (r.to || '').toLowerCase()]));
  const byTitle = {};
  for (const p of Object.values((json.query && json.query.pages) || {})) byTitle[(p.title || '').toLowerCase()] = p;
  if (json.query && json.query.normalized) for (const n of json.query.normalized) redirectFrom.set((n.from || '').toLowerCase(), (n.to || '').toLowerCase());
  return { byTitle, redirectFrom };
}

async function searchWikipedia(foodName) {
  const titles = wikiTitles(foodName);
  const batch = await wikiBatch(titles);
  for (const title of titles) {
    const key = title.toLowerCase();
    const target = batch.redirectFrom.get(key) || key;
    const page = batch.byTitle[target];
    if (page && !page.missing && page.thumbnail && page.thumbnail.source) {
      const redirected = batch.redirectFrom.has(key);
      const trusted = trustWikiPick(title, page.title, foodName, redirected) || (ALIAS_VALUES.has(title) && !deniedTitle(page.title));
      if (trusted) return { product_name: page.title, image_url: page.thumbnail.source, source: 'wiki' };
    }
    await sleep(300);
  }
  // full-text fallback with full base (keeps qualifiers in score)
  const q = baseName(foodName);
  const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json' + `&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=0&gsrlimit=5` + '&prop=pageimages&pithumbsize=640&origin=*';
  const res = await fetch(url, { headers: { 'User-Agent': 'CalyAI/1.0 (food-catalog-image-match)' } });
  if (!res.ok) throw new Error(`Wikipedia search failed (${res.status})`);
  const json = await res.json();
  for (const p of Object.values((json.query && json.query.pages) || {})) {
    if (p.thumbnail && p.thumbnail.source && scoreMatch(q, p.title) > 0 && !deniedTitle(p.title)) {
      return { product_name: p.title, image_url: p.thumbnail.source, source: 'wiki-search' };
    }
  }
  return null;
}

async function searchCommons(query) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json' +
    `&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=12` +
    '&prop=imageinfo&iiprop=url&iiurlwidth=640&origin=*';
  const res = await fetch(url, { headers: { 'User-Agent': 'CalyAI/1.0 (food-catalog-image-match)' } });
  if (!res.ok) throw new Error(`Commons failed (${res.status})`);
  const json = await res.json();
  return Object.values((json.query && json.query.pages) || {})
    .filter((p) => /\.(jpe?g|png|webp)$/i.test(p.title))
    .map((p) => ({
      product_name: p.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '').replace(/[-_]/g, ' '),
      image_url: (p.imageinfo && p.imageinfo[0] && p.imageinfo[0].thumburl) || null,
    }));
}

// Full variant query: keep cooking/variant qualifiers (fried, strawberry...),
// strip only brand ALL-CAPS + parens. baseName() strips qualifiers -> causes
// all variants to collapse to the head word (the duplicate root cause).
function variantFull(name) {
  const noParens = (name || '').replace(/\([^)]*\)/g, ' ');
  const raw = noParens.replace(/[^A-Za-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
  const kept = raw.filter((t) => {
    if (t.length > 1 && t === t.toUpperCase() && /[A-Z]/.test(t)) return false;
    return true;
  });
  // dedupe case-insensitive, keep order
  const seen = new Set();
  const out = [];
  for (const t of kept) { const l = t.toLowerCase(); if (!seen.has(l)) { seen.add(l); out.push(t); } }
  return out.join(' ').trim();
}

function variantQueries(name) {
  const full = variantFull(name);
  const base = baseName(name);
  const outs = [];
  if (full) outs.push(full);
  if (base && base.toLowerCase() !== full.toLowerCase()) outs.push(base);
  return outs.slice(0, 2);
}

// Curated distinct queries for clear cross-food collisions (different foods sharing
// one photo). Verified head+qualifier, avoids generic head-word fallback.
// null = keep sharing (same-food or risky auto-match worse than duplicate).
const MANUAL_FIX = {
  321360: null, // keep tomato as group keeper
  2709237: ['grapes', 'red grapes', 'green grapes'],
  174829: null, // keeper (smoothie); bananas share its image but both banana-ish — keep
  1105073: null,
  2709224: null,
  2707909: ['chocolate chip cookies', 'chocolate chip cookie'],
  2631024: ['glazed donut', 'glazed doughnut'],
  2708474: null, // corn flakes ad match is vintage art — keep sharing granola (safer)
  174660: ['oatmeal bowl', 'cooked oatmeal'],
  2706983: ['turkey sandwich', 'turkey breast sandwich'],
  2708963: ['salmon sushi roll', 'salmon sushi'],
  330415: ['strawberry yogurt', 'strawberry Greek yogurt'],
  175228: ['strawberry soy yogurt', 'strawberry yogurt'],
  173423: null, // egg prep variants share base image (safer than bird-egg mismatches)
  323604: null,
  2707152: null,
  2707168: null,
  330137: null, // plain nonfat vs lowfat — same look, keep sharing
  2057648: null, // CHEDDAR vs Cheddar — same food, keep
  2102157: null, // COTTAGE vs Cottage — same food, keep
  749420: ['cooked bacon', 'crispy bacon'],
  2706191: null, // pork sausage vs Italian sausage — keep sharing
  1104705: null, // soy flour field/noodle mismatches worse than sharing
  1104812: null, // rice brown noodle+skirt mismatch — keep sharing
  2708422: null,
  2708951: null,
  2709152: null,
  1886359: null, // HUMMUS identical — keep
  2706035: null, // chicken thigh vs breast — same look, keep
  2710182: null, // coconut oil identical — keep
  2710258: null,
  2709171: null, // orange identical — keep
  746784: null,
};

function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens2(s) {
  return normName(s).split(' ').filter((t) => t.length >= 2);
}

async function findDistinctImage(foodName, seenHashes, manualQueries) {
  const autoQs = variantQueries(foodName);
  const queries = (manualQueries && manualQueries.length ? manualQueries : [autoQs[0]]);
  const head = tokens2(baseName(foodName))[0];
  for (const q of queries) {
    const fullToks = new Set(tokens2(q));
    // qualifiers relative to head; manual queries are short so all non-head matter
    const qualifiers = [...fullToks].filter((t) => t !== head);
    const requiresQualifier = qualifiers.length > 0;
    try {
      const candidates = await searchCommons(q);
      // Require head word early + at least one qualifier word in filename.
      const scored = (candidates || [])
        .filter((c) => c.image_url && !deniedTitle(c.product_name))
        .map((c) => ({ c, s: scoreMatch(q, c.product_name) }))
        .filter((x) => {
          const pt = tokens2(x.c.product_name);
          const pset = new Set(pt);
          if (!head || !pt.slice(0, 5).includes(head)) {
            // manual queries like "corn flakes cereal" have head inside q, not base head;
            // accept if any query token appears early instead
            const qt = tokens2(q);
            if (!qt.some((t) => pt.slice(0, 5).includes(t))) return false;
          }
          if (requiresQualifier) {
            // Exact token or plural only — substring ("soybean" for "soy") caused farm-field mismatches.
            if (!qualifiers.some((t) => pset.has(t) || pset.has(t + 's'))) return false;
          } else if (x.s < 0.6) return false;
          return true;
        })
        .sort((a, b) => b.s - a.s);
      for (const { c } of scored.slice(0, 6)) {
        try {
          const { hash } = await hashUrl(c.image_url);
          if (!seenHashes.has(hash)) return { product_name: c.product_name, image_url: c.image_url, source: 'commons:' + q, hash };
          console.log(`   commons "${q}" candidate "${c.product_name}" dup hash, next`);
        } catch {}
      }
    } catch (e) { console.log(`   commons "${q}" failed: ${e.message}`); }
    await sleep(800);
    // Wikipedia with same query
    try {
      const w = await searchWikipedia(q);
      if (w) {
        try {
          const { hash } = await hashUrl(w.image_url);
          if (!seenHashes.has(hash)) return { ...w, hash };
          console.log(`   wiki "${q}" -> same hash, skipping`);
        } catch {}
      }
    } catch (e) { console.log(`   wiki "${q}" failed: ${e.message}`); }
    await sleep(800);
  }
  return null;
}

async function main() {
  const { limit, dryRun } = args();
  await connectDb();
  const all = await Food.find({ imageUrl: { $ne: null } }).lean();
  // group by current image bytes
  const hashToFoods = new Map();
  const hashOf = new Map();
  console.log('Hashing current images...');
  const CONC = 12;
  for (let i = 0; i < all.length; i += CONC) {
    const chunk = all.slice(i, i + CONC);
    const res = await Promise.all(chunk.map(async (f) => {
      try { const { hash } = await hashUrl(f.imageUrl); return [f, hash]; }
      catch (e) { console.log('WARN cannot fetch', f.name, e.message); return [f, null]; }
    }));
    for (const [f, h] of res) {
      if (!h) continue;
      hashOf.set(f._id.toString(), h);
      if (!hashToFoods.has(h)) hashToFoods.set(h, []);
      hashToFoods.get(h).push(f);
    }
    console.log(` hashed ${Math.min(i + CONC, all.length)}/${all.length}`);
  }
  const seenHashes = new Set(hashToFoods.keys());
  const dupGroups = [...hashToFoods.values()].filter((v) => v.length > 1);
  console.log(`Total ${all.length}, distinct ${hashToFoods.size}, duplicate groups ${dupGroups.length}`);
  let todo = [];
  const skippedIdentical = [];
  for (const g of dupGroups) {
    g.sort((a, b) => a.fdcId - b.fdcId);
    // Identical normalized names (BROCCOLI vs Broccoli, HUMMUS vs Hummus) —
    // same food, sharing one real image is correct. Skip.
    const norms = new Set(g.map((f) => normName(f.name)));
    if (norms.size === 1) { skippedIdentical.push(g.map((f) => f.name).join(' | ')); continue; }
    // keep first, fix rest — but only curated cross-food collisions.
    // null in MANUAL_FIX = same-food sharing, keep as is (safer).
    for (const f of g.slice(1)) {
      if (!(f.fdcId in MANUAL_FIX)) {
        // unlisted: keep sharing unless base foods differ
        const keepBase = baseName(g[0].name);
        const fBase = baseName(f.name);
        if (keepBase === fBase) continue;
      }
      if (MANUAL_FIX[f.fdcId] === null) continue;
      todo.push({ food: f, keep: g[0] });
    }
  }
  console.log(`Skipping ${skippedIdentical.length} identical-name groups (correct sharing):`);
  skippedIdentical.forEach((s) => console.log('  = ' + s));
  todo = todo.slice(0, limit);
  console.log(`${todo.length} duplicates to fix${dryRun ? ' (DRY RUN)' : ''}:`);
  todo.forEach((t) => console.log(` - ${t.food.fdcId} "${t.food.name}" dup of ${t.keep.fdcId} "${t.keep.name}"`));

  let cloudinary = null;
  if (!dryRun) cloudinary = connectCloudinary();
  let fixed = 0;
  const stillLow = [];
  for (let i = 0; i < todo.length; i++) {
    const { food, keep } = todo[i];
    console.log(`[${i + 1}/${todo.length}] "${food.name}" (dup of "${keep.name}")`);
    try {
      const found = await findDistinctImage(food.name, seenHashes, MANUAL_FIX[food.fdcId]);
      if (!found) { stillLow.push(food.name); console.log('   LOW no distinct match'); }
      else if (dryRun) { fixed++; console.log(`   MATCH <- "${found.product_name}" [${found.source}]`); seenHashes.add(found.hash); }
      else {
        const up = await cloudinary.uploader.upload(found.image_url, { folder: 'caly-ai/foods', public_id: `fdc-${food.fdcId}`, overwrite: true, resource_type: 'image' });
        await Food.updateOne({ _id: food._id }, { $set: { imageUrl: up.secure_url } });
        const { hash } = await hashUrl(up.secure_url);
        seenHashes.add(hash); seenHashes.add(found.hash);
        fixed++;
        console.log(`   SAVED <- "${found.product_name}" [${found.source}]`);
      }
    } catch (e) { stillLow.push(`${food.name} (ERR ${e.message})`); console.log('   ERROR', e.message); }
    await sleep(2500);
  }
  console.log(`\nDone: fixed ${fixed}/${todo.length}${stillLow.length ? ', low: ' + stillLow.join(' | ') : ''}`);
  await disconnectDb();
}

if (require.main === module) main().catch(async (e) => { console.error(e); try { await disconnectDb(); } catch {} process.exit(1); });
