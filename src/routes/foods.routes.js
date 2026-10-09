const express = require('express');
const Food = require('../models/Food');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const CATEGORIES = [
  { key: 'Fruits', emoji: '🍌', keywords: ['banana', 'apple', 'orange', 'berry', 'fruit', 'mango', 'grape'] },
  { key: 'Vegetables', emoji: '🥦', keywords: ['broccoli', 'spinach', 'carrot', 'tomato', 'vegetable', 'salad', 'kale'] },
  { key: 'Proteins', emoji: '🍗', keywords: ['chicken', 'beef', 'egg', 'fish', 'salmon', 'turkey', 'protein', 'tuna'] },
  { key: 'Grains', emoji: '🥣', keywords: ['oatmeal', 'rice', 'bread', 'pasta', 'oat', 'quinoa', 'cereal'] },
  { key: 'Dairy', emoji: '🥛', keywords: ['milk', 'yogurt', 'cheese', 'yoghurt', 'dairy'] },
  { key: 'Snacks', emoji: '🥜', keywords: ['nut', 'almond', 'peanut', 'snack', 'chip', 'cracker', 'coffee'] },
];

const SUGGESTION_TERMS = {
  Breakfast: ['oatmeal', 'egg', 'banana', 'yogurt', 'bread'],
  Lunch: ['chicken', 'rice', 'salad', 'sandwich', 'pasta'],
  Dinner: ['chicken', 'salmon', 'rice', 'beef', 'vegetable'],
  Snack: ['banana', 'yogurt', 'nut', 'coffee', 'apple'],
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/foods/categories — static Phase-1 categories for Browse-by-category row
router.get('/categories', async (req, res) => {
  res.json({ categories: CATEGORIES.map(({ key, emoji }) => ({ key, emoji })) });
});

// GET /api/foods/suggestions?mealType=Breakfast&limit=10 — curated catalog picks per meal type
router.get('/suggestions', async (req, res, next) => {
  const mealType = req.query.mealType || 'Breakfast';
  if (!SUGGESTION_TERMS[mealType]) {
    return res.status(400).json({ error: 'invalid mealType, use Breakfast|Lunch|Dinner|Snack' });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 30);
  try {
    const terms = SUGGESTION_TERMS[mealType];
    const perTerm = Math.max(2, Math.ceil(limit / terms.length));
    const seen = new Map();
    for (const term of terms) {
      const rows = await Food.find({ name: new RegExp(escapeRegex(term), 'i') })
        .limit(perTerm)
        .lean();
      for (const r of rows) {
        if (!seen.has(r.fdcId)) seen.set(r.fdcId, r);
        if (seen.size >= limit) break;
      }
      if (seen.size >= limit) break;
    }
    const foods = [...seen.values()].slice(0, limit);
    return res.json({ foods, count: foods.length, mealType });
  } catch (e) {
    return next(e);
  }
});

// GET /api/foods/search?q=chicken&limit=20&category=Proteins — fast prefix + text search over shared catalog
router.get('/search', async (req, res, next) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.status(400).json({ error: 'q query param required (min 2 chars)' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const escaped = escapeRegex(q);
  const category = CATEGORIES.find((c) => c.key.toLowerCase() === String(req.query.category || '').toLowerCase());
  const categoryFilter = category
    ? { name: new RegExp(category.keywords.map(escapeRegex).join('|'), 'i') }
    : null;
  try {
    const baseOr = [{ name: new RegExp(`^${escaped}`, 'i') }, { $text: { $search: q } }];
    const query = categoryFilter ? { $and: [{ $or: baseOr }, categoryFilter] } : { $or: baseOr };
    const foods = await Food.find(query, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean();
    return res.json({ foods, count: foods.length });
  } catch (e) {
    // Atlas/local DB without the `name: text` index throws (e.g. code 27/291,
    // NoQueryExecutionPlans) — fall back to prefix regex instead of 500ing.
    if (e && (e.code === 27 || e.code === 291 || /text index|NoQueryExecutionPlans/i.test(e.message || ''))) {
      console.warn(`[foods] text index missing, regex fallback for q=${q}`);
      const query = categoryFilter
        ? { $and: [{ name: new RegExp(`^${escaped}`, 'i') }, categoryFilter] }
        : { name: new RegExp(`^${escaped}`, 'i') };
      const foods = await Food.find(query).limit(limit).lean();
      return res.json({ foods, count: foods.length, fallback: true });
    }
    return next(e);
  }
});

// GET /api/foods/:fdcId — single catalog item for the log-meal sheet
router.get('/:fdcId', async (req, res) => {
  const food = await Food.findOne({ fdcId: Number(req.params.fdcId) }).lean();
  if (!food) return res.status(404).json({ error: 'food not found' });
  res.json({ food });
});

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
module.exports.SUGGESTION_TERMS = SUGGESTION_TERMS;
