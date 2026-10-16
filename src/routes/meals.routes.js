const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const Meal = require('../models/Meal');
const { requireAuth } = require('../middleware/auth');
const { dayBounds, requestTimezone } = require('../utils/timezone');

const mealBodySchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  kcal: z.number().gt(0).lte(10000),
  protein: z.number().min(0).max(5000).default(0),
  carbs: z.number().min(0).max(5000).default(0),
  fat: z.number().min(0).max(5000).default(0),
  mealType: z.enum(['Breakfast', 'Lunch', 'Dinner', 'Snack']).default('Snack'),
  emoji: z.string().max(20).default('🍽️'),
  imageUrl: z
    .string()
    .max(2000)
    // Only portable references: native file:// photos and http(s) CDN URLs.
    // data:/blob:/javascript: either bloat every diary fetch or invite trouble.
    .refine((v) => /^(https?|file):\/\//.test(v), { message: 'imageUrl must be an http(s) or file URL' })
    .optional(),
  loggedAt: z.string().datetime({ offset: true }).optional(),
});

function dayBound(s, endOfDay, tz) {
  const b = dayBounds(s, tz);
  if (!b) return null;
  return endOfDay ? b.end : b.start;
}

function rangeTooLarge(from, to) {
  return to - from > MAX_RANGE_DAYS * 24 * 3600 * 1000;
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

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
// Longest window GET /api/meals serves. The app asks for 365 days; without a
// cap a crafted from=1970 makes the server serialize a lifetime diary.
const MAX_RANGE_DAYS = 400;

router.get('/my-foods', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const grouped = await Meal.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
    { $sort: { loggedAt: -1 } },
    {
      $group: {
        _id: { $toLower: { $trim: { input: '$name' } } },
        name: { $first: '$name' },
        kcal: { $avg: '$kcal' },
        protein: { $avg: '$protein' },
        carbs: { $avg: '$carbs' },
        fat: { $avg: '$fat' },
        imageUrl: { $first: '$imageUrl' },
        mealType: { $first: '$mealType' },
        loggedAt: { $first: '$loggedAt' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1, loggedAt: -1 } },
    { $limit: limit },
  ]);
  const foods = grouped.map((g) => ({
    name: g.name,
    kcal: Math.round(g.kcal),
    protein: Math.round(g.protein * 10) / 10,
    carbs: Math.round(g.carbs * 10) / 10,
    fat: Math.round(g.fat * 10) / 10,
    imageUrl: g.imageUrl || null,
    mealType: g.mealType,
    count: g.count,
  }));
  res.json({ foods, count: foods.length });
});

router.get('/', async (req, res) => {
  // Calendar days are interpreted in the caller's zone: explicit ?tz=,
  // else this user's stored zone, else UTC.
  const tz = requestTimezone(req);
  const from = dayBound(req.query.from, false, tz);
  const to = dayBound(req.query.to, true, tz);
  if (!from || !to || from > to) {
    return res.status(400).json({ error: 'from and to query params required as YYYY-MM-DD' });
  }
  if (rangeTooLarge(from, to)) {
    return res.status(400).json({ error: `range too large — max ${MAX_RANGE_DAYS} days` });
  }
  const filter = { userId: req.user.id, loggedAt: { $gte: from, $lte: to } };
  if (req.query.mealType !== undefined) {
    if (!MEAL_TYPES.includes(req.query.mealType)) {
      return res.status(400).json({ error: 'invalid mealType, use Breakfast|Lunch|Dinner|Snack' });
    }
    filter.mealType = req.query.mealType;
  }
  const meals = await Meal.find(filter).sort({ loggedAt: 1 });
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
module.exports.MAX_RANGE_DAYS = MAX_RANGE_DAYS;
module.exports.rangeTooLarge = rangeTooLarge;
