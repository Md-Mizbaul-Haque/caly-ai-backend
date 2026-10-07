const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const Weight = require('../models/Weight');
const WeightGoal = require('../models/WeightGoal');
const { requireAuth } = require('../middleware/auth');

const weightBodySchema = z.object({
  value: z.number().gte(20).lte(1000),
  loggedAt: z.string().datetime({ offset: true }).optional(),
});

const goalBodySchema = z.object({
  value: z.number().gte(20).lte(1000),
});

function dayBound(s, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}

// Local-calendar-day window [00:00:00.000, 23:59:59.999] containing `date`.
function localDayWindow(date) {
  const d = date instanceof Date ? date : new Date(date);
  return {
    start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0),
    end: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999),
  };
}

const router = express.Router();

router.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'database unavailable' });
  }
  next();
});
router.use(requireAuth);

router.get('/', async (req, res) => {
  const from = dayBound(req.query.from, false);
  const to = dayBound(req.query.to, true);
  const loggedAt = from && to && from <= to ? { loggedAt: { $gte: from, $lte: to } } : {};
  const weights = await Weight.find({ userId: req.user.id, ...loggedAt }).sort({ loggedAt: 1 });
  res.json({ weights });
});

// POST / — one entry per calendar day. A second log for the same local day
// REPLACES the earlier value (like stepping on the scale twice): the trend
// chart stays free of artificial double-spikes and the client can optimistically
// re-log today without duplicating points. Returns 200 {updated:true} when an
// existing entry was replaced, 201 when a new day was created.
router.post('/', async (req, res) => {
  const parsed = weightBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid weight', details: parsed.error.issues });
  }
  const { value, loggedAt } = parsed.data;
  const { start, end } = localDayWindow(loggedAt ? new Date(loggedAt) : new Date());
  const existing = await Weight.findOne({
    userId: req.user.id,
    loggedAt: { $gte: start, $lte: end },
  }).sort({ loggedAt: -1 });
  if (existing) {
    existing.value = value;
    await existing.save();
    return res.json({ weight: existing, updated: true });
  }
  const weight = await Weight.create({ value, ...(loggedAt ? { loggedAt } : {}), userId: req.user.id });
  res.status(201).json({ weight, updated: false });
});

router.delete('/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const deleted = await Weight.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  if (!deleted) return res.status(404).json({ error: 'weight not found' });
  res.json({ deleted: true });
});

router.get('/goal', async (req, res) => {
  const goal = await WeightGoal.findOne({ userId: req.user.id });
  res.json({ goal: goal ? goal.value : null });
});

router.put('/goal', async (req, res) => {
  const parsed = goalBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid goal', details: parsed.error.issues });
  }
  const doc = await WeightGoal.findOneAndUpdate(
    { userId: req.user.id },
    { value: parsed.data.value },
    { upsert: true, new: true }
  );
  res.json({ goal: doc.value });
});

module.exports = router;
module.exports.weightBodySchema = weightBodySchema;
module.exports.goalBodySchema = goalBodySchema;
