const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const { buildNutritionPlan, missingPlanFields } = require('../services/nutritionPlan');

const router = express.Router();

router.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'database unavailable' });
  }
  next();
});

// Onboarding surface: identity is proven (JWT sub) but mailbox may be
// unverified. Plan math is per-user only — req.user is the ONLY data source
// for identity; body can never select another user (no userId/email param).
router.use(requireAuth.allowUnverified);

// POST /api/plan/calculate — preview the server-authoritative plan.
// Returns 400 + missing[] when ANY field is absent: plan is created only
// after receiving ALL information, never partially.
router.post('/calculate', async (req, res, next) => {
  try {
    const src = req.body && Object.keys(req.body).length ? req.body : req.user.toObject();
    const plan = buildNutritionPlan({
      gender: src.gender,
      birthDate: src.birthDate,
      heightCm: src.heightCm,
      weightKg: src.weightKg,
      targetWeightKg: src.targetWeightKg,
      activityLevel: src.activityLevel,
    });
    res.json({ plan });
  } catch (e) {
    if (e.status === 400) {
      return res.status(400).json({
        error: e.message,
        missing: e.missing || missingPlanFields(req.body || {}),
        details: e.details || [],
      });
    }
    next(e);
  }
});

module.exports = router;
