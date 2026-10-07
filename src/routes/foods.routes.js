const express = require('express');
const Food = require('../models/Food');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/foods/search?q=chicken&limit=20 — fast prefix + text search over shared catalog
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.status(400).json({ error: 'q query param required (min 2 chars)' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const foods = await Food.find(
    { $or: [{ name: new RegExp(`^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') }, { $text: { $search: q } }] },
    { score: { $meta: 'textScore' } },
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .lean();
  res.json({ foods, count: foods.length });
});

// GET /api/foods/:fdcId — single catalog item for the log-meal sheet
router.get('/:fdcId', async (req, res) => {
  const food = await Food.findOne({ fdcId: Number(req.params.fdcId) }).lean();
  if (!food) return res.status(404).json({ error: 'food not found' });
  res.json({ food });
});

module.exports = router;
