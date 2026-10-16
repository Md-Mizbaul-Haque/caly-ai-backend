const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const Weight = require('../models/Weight');
const WeightGoal = require('../models/WeightGoal');
const { requireAuth } = require('../middleware/auth');
const { dayBounds, localDayWindow: zonedDayWindow, requestTimezone } = require('../utils/timezone');

const weightBodySchema = z.object({
  value: z.number().gte(20).lte(1000),
  loggedAt: z.string().datetime({ offset: true }).optional(),
});

const goalBodySchema = z.object({
  value: z.number().gte(20).lte(1000),
  activityLevel: z.enum(['sedentary', 'light', 'moderate', 'high']).optional(),
  pace: z.enum(['slow', 'steady', 'fast']).optional(),
});

// Tracking lbs <-> profile kg live in one place so goal + plan never drift.
const LBS_PER_KG = 2.20462;
function lbsToKg(lbs) {
  return Math.round((Number(lbs) / LBS_PER_KG) * 10) / 10;
}

// Pure helper (no DB) so the pace/plan math is unit-testable.
// Returns { candidate, plan, missing } — plan null when profile incomplete.
function recomputePlanForGoal(user = {}, opts = {}) {
  const { buildNutritionPlan, missingPlanFields } = require('../services/nutritionPlan');
  const targetWeightKg = lbsToKg(opts.goalLbs);
  const candidate = {
    gender: user.gender,
    birthDate: user.birthDate,
    heightCm: user.heightCm,
    weightKg: opts.currentWeightKg ?? user.weightKg,
    targetWeightKg,
    activityLevel: opts.activityLevel ?? user.activityLevel,
    pace: opts.pace ?? user.goalPace ?? 'steady',
  };
  const missing = missingPlanFields({ ...candidate, birthDate: candidate.birthDate });
  // missingPlanFields treats pace as extra (ignored); check required only.
  const requiredMissing = missing.filter((f) => f !== 'pace');
  if (requiredMissing.length > 0 || !Number.isFinite(targetWeightKg)) {
    return { candidate, plan: null, missing: requiredMissing };
  }
  try {
    const plan = buildNutritionPlan(candidate);
    return { candidate, plan, missing: [] };
  } catch (e) {
    return { candidate, plan: null, missing: e.missing || requiredMissing };
  }
}

function dayBound(s, endOfDay, tz) {
  const b = dayBounds(s, tz);
  if (!b) return null;
  return endOfDay ? b.end : b.start;
}

// Local-calendar-day window [00:00:00.000, 23:59:59.999] containing `date`
// in the user's zone (not the server's).
function localDayWindow(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  return zonedDayWindow(d, tz);
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
  const tz = requestTimezone(req);
  const from = dayBound(req.query.from, false, tz);
  const to = dayBound(req.query.to, true, tz);
  const loggedAt = from && to && from <= to ? { loggedAt: { $gte: from, $lte: to } } : {};
  const weights = await Weight.find({ userId: req.user.id, ...loggedAt }).sort({ loggedAt: 1 }).lean();
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
  // Same-day replace is evaluated in the user's calendar day (?tz=, else
  // stored zone, else UTC) — not the server's local day.
  const { start, end } = localDayWindow(loggedAt ? new Date(loggedAt) : new Date(), requestTimezone(req));
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
  const goal = await WeightGoal.findOne({ userId: req.user.id }).lean();
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
  // Recompute the whole calorie plan from the new target so Dashboard stays
  // in sync. Goal save never fails because the plan is incomplete — plan
  // comes back null + missing[] and the client keeps the saved goal.
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user.id);
    if (!user) return res.json({ goal: doc.value, plan: null, planError: true });
    const latest = await Weight.findOne({ userId: req.user.id }).sort({ loggedAt: -1 });
    const currentWeightKg = latest ? Math.round((Number(latest.value) / LBS_PER_KG) * 10) / 10 : undefined;
    const { candidate, plan, missing } = recomputePlanForGoal(user.toObject ? user.toObject() : user, {
      goalLbs: parsed.data.value,
      activityLevel: parsed.data.activityLevel,
      pace: parsed.data.pace,
      currentWeightKg,
    });
    if (!plan) return res.json({ goal: doc.value, plan: null, missing });
    user.targetWeightKg = candidate.targetWeightKg;
    if (parsed.data.activityLevel) user.activityLevel = parsed.data.activityLevel;
    if (parsed.data.pace) user.goalPace = parsed.data.pace;
    user.dailyGoalKcal = plan.dailyGoalKcal;
    await user.save();
    return res.json({ goal: doc.value, plan, user });
  } catch {
    // Plan recompute is best-effort; the goal itself already saved.
    // planError tells the client the kcal did NOT update (vs missing[] which
    // names the profile fields to complete) — never silently claim success.
    return res.json({ goal: doc.value, plan: null, planError: true });
  }
});

module.exports = router;
module.exports.weightBodySchema = weightBodySchema;
module.exports.goalBodySchema = goalBodySchema;
module.exports.recomputePlanForGoal = recomputePlanForGoal;
module.exports.lbsToKg = lbsToKg;
