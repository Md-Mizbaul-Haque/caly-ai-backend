const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const Favorite = require('../models/Favorite');
const { requireAuth } = require('../middleware/auth');

const favoriteBodySchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  kcal: z.number().gt(0).lte(10000),
  protein: z.number().min(0).max(5000).default(0),
  carbs: z.number().min(0).max(5000).default(0),
  fat: z.number().min(0).max(5000).default(0),
  imageUrl: z
    .string()
    .max(2000)
    // Same portability rule as meals: no data:/blob: payloads in the DB.
    .refine((v) => /^(https?|file):\/\//.test(v), { message: 'imageUrl must be an http(s) or file URL' })
    .optional(),
});

// Dedupe identity: one favorite per food name per user, case/space-insensitive —
// same key the frontend and the "Recent foods" list use.
function nameKey(name) {
  return String(name || '').trim().toLowerCase();
}

function dbDown(res) {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ error: 'database unavailable' });
    return true;
  }
  return false;
}

const router = express.Router();

router.use((req, res, next) => {
  if (dbDown(res)) return;
  next();
});
router.use(requireAuth);

router.get('/', async (req, res) => {
  const favorites = await Favorite.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(100);
  res.json({ favorites, count: favorites.length });
});

router.post('/', async (req, res) => {
  const parsed = favoriteBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid favorite', details: parsed.error.issues });
  }
  // Idempotent: re-favoriting an existing food returns its row instead of
  // creating a duplicate. $toLower match (not regex) so names with special
  // characters like "Tea, hot, leaf, black" match literally.
  const existing = await Favorite.findOne({
    userId: req.user.id,
    $expr: { $eq: [{ $toLower: '$name' }, nameKey(parsed.data.name)] },
  });
  if (existing) return res.json({ favorite: existing, existed: true });
  const favorite = await Favorite.create({ ...parsed.data, userId: req.user.id });
  res.status(201).json({ favorite });
});

router.delete('/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const deleted = await Favorite.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  if (!deleted) return res.status(404).json({ error: 'favorite not found' });
  res.json({ deleted: true });
});

module.exports = router;
module.exports.favoriteBodySchema = favoriteBodySchema;
module.exports.nameKey = nameKey;
