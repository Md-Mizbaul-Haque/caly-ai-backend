const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const Meal = require('../models/Meal');
const { requireAuth } = require('../middleware/auth');

const mealBodySchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  kcal: z.number().gt(0).lte(10000),
  protein: z.number().min(0).default(0),
  carbs: z.number().min(0).default(0),
  fat: z.number().min(0).default(0),
  mealType: z.enum(['Breakfast', 'Lunch', 'Dinner', 'Snack']).default('Snack'),
  emoji: z.string().default('🍽️'),
  imageUrl: z.string().max(2000).optional(),
  loggedAt: z.string().datetime({ offset: true }).optional(),
});

function dayBound(s, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
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
  const from = dayBound(req.query.from, false);
  const to = dayBound(req.query.to, true);
  if (!from || !to || from > to) {
    return res.status(400).json({ error: 'from and to query params required as YYYY-MM-DD' });
  }
  const meals = await Meal.find({ userId: req.user.id, loggedAt: { $gte: from, $lte: to } }).sort({ loggedAt: 1 });
  res.json({ meals });
});

router.post('/', async (req, res) => {
  const parsed = mealBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid meal', details: parsed.error.issues });
  }
  const meal = await Meal.create({ ...parsed.data, userId: req.user.id });
  res.status(201).json({ meal });
});

router.delete('/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const deleted = await Meal.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  if (!deleted) return res.status(404).json({ error: 'meal not found' });
  res.json({ deleted: true });
});

module.exports = router;
module.exports.mealBodySchema = mealBodySchema;
