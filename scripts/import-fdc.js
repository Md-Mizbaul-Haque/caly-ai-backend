/* Bulk-seed the shared Food catalog from USDA FoodData Central.
 *
 * Usage:
 *   FDC_API_KEY=xxxx node scripts/import-fdc.js [--limit=120] [--type=Foundation,SRLegacy]
 *   Get a free key in ~30s: https://api.data.gov/signup/ (1,000 req/hr).
 *   Falls back to DEMO_KEY (30 req/hr) for smoke tests: --limit=5
 *
 * What it does per query in src/services/commonFoods.js:
 *   POST /foods/search -> picks best Foundation/SR Legacy hit ->
 *   normalizeFdcFood -> upsert by fdcId.
 * Stores lean per-100g docs (~0.8KB each, CC0-licensed, permanent).
 * FDC provides no images — imageUrl stays null for a later OFF/cloud pass.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDb, disconnectDb } = require('../src/config/db');
const Food = require('../src/models/Food');
const { normalizeFdcFood } = require('../src/services/fdcNormalize');
const QUERIES = require('../src/services/commonFoods');

const API_KEY = process.env.FDC_API_KEY || 'DEMO_KEY';
const BASE = 'https://api.nal.usda.gov/fdc/v1';

function args() {
  const out = { limit: QUERIES.length, dataType: ['Foundation', 'SR Legacy'] };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--limit=')) out.limit = Math.max(1, parseInt(a.split('=')[1], 10) || 1);
    if (a.startsWith('--type=')) out.dataType = a.split('=')[1].split(',').map((s) => s.trim());
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchOne(query) {
  // No dataType filter, no sortBy: FDC relevance ranking gives the best
  // exact match first (filtering/sorting promoted irrelevant items,
  // e.g. "butter" -> almond butter, "grapes" -> grape tomatoes).
  const res = await fetch(`${BASE}/foods/search?api_key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, pageSize: 10 }),
  });
  if (res.status === 429) throw new Error('FDC rate limit (429) — wait an hour or use your own FDC_API_KEY');
  if (!res.ok) throw new Error(`FDC search failed (${res.status}) for "${query}"`);
  const json = await res.json();
  return json.foods || [];
}

function pickBest(foods) {
  if (!foods.length) return null;
  // Preserve FDC relevance order: first hit in a preferred type wins.
  // (Sorting all 10 by type alone promoted irrelevant Foundation items,
  // e.g. "milk whole" -> ricotta cheese.)
  const preferred = new Set(['Foundation', 'SR Legacy', 'Survey (FNDDS)']);
  return foods.find((f) => preferred.has(f.dataType)) || foods[0];
}

async function fetchDetail(fdcId) {
  // No ?nutrients filter: filtered details can omit Energy entirely
  // (e.g. almond butter returned protein/fat/carbs/fiber but no kcal).
  const res = await fetch(`${BASE}/food/${fdcId}?api_key=${API_KEY}`);
  if (res.status === 429) throw new Error('FDC rate limit (429) — wait an hour or use your own FDC_API_KEY');
  if (!res.ok) throw new Error(`FDC detail failed (${res.status}) for fdcId ${fdcId}`);
  return res.json();
}

async function main() {
  const { limit } = args();
  const list = QUERIES.slice(0, limit);
  await connectDb();
  let saved = 0;
  let skipped = 0;
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    try {
      const foods = await searchOne(q);
      const best = pickBest(foods);
      if (!best) {
        skipped++;
        console.log(`[${i + 1}/${list.length}] SKIP  "${q}" (no search hit)`);
      } else {
        // Search payloads often omit full nutrients — fetch the detail record.
        const detail = await fetchDetail(best.fdcId);
        const doc = normalizeFdcFood(detail);
        if (!doc) {
          skipped++;
          console.log(`[${i + 1}/${list.length}] SKIP  "${q}" (no caloric match)`);
        } else {
          await Food.updateOne({ fdcId: doc.fdcId }, { $set: doc }, { upsert: true });
          saved++;
          console.log(`[${i + 1}/${list.length}] OK    "${q}" -> ${doc.name} (${doc.kcal} kcal)`);
        }
      }
    } catch (e) {
      skipped++;
      console.log(`[${i + 1}/${list.length}] ERROR "${q}": ${e.message}`);
      if (/429/.test(e.message)) break;
    }
    await sleep(API_KEY === 'DEMO_KEY' ? 2500 : 1200); // stay under rate limits
  }
  const total = await Food.countDocuments();
  console.log(`\nDone: saved ${saved}, skipped ${skipped}, catalog total ${total}.`);
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

module.exports = { searchOne, pickBest };
