const express = require('express');
const { z } = require('zod');

const mealBodySchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  kcal: z.number().gt(0).lte(10000),
  protein: z.number().min(0).default(0),
  carbs: z.number().min(0).default(0),
  fat: z.number().min(0).default(0),
  mealType: z.enum(['Breakfast', 'Lunch', 'Dinner', 'Snack']).default('Snack'),
  emoji: z.string().default('🍽️'),
  loggedAt: z.string().datetime({ offset: true }).optional(),
});

const router = express.Router();
router.get('/', (_req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/', (_req, res) => res.status(501).json({ error: 'not implemented' }));
router.delete('/:id', (_req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
module.exports.mealBodySchema = mealBodySchema;
