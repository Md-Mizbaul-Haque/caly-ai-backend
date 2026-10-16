// Server-authoritative nutrition plan — single source of truth.
//
// Why deterministic (Mifflin-St Jeor) instead of an LLM:
// - An LLM can hallucinate a dangerous calorie target with no audit trail.
// - A formula is reproducible, testable, and bounded (floors/caps below).
// - Per-user isolation is trivial: pure function of THIS user's inputs only,
//   never another user's row, never a shared cache.
//
// Medical safety (product engineer + clinician review):
// - Requires ALL inputs before any plan is produced (no partial plans).
// - Age 13-100 enforced; <13 rejected (backend is the gate, UI is not).
// - Teens (13-17) never get an aggressive deficit: smaller cut + higher floor.
// - Lose path floored at max(sex floor, BMR) so target never goes below basal.
// - Underweight (BMI<18.5) attempting loss is downgraded to maintenance.
// - Protein 1.6-2.0 g/kg (evidence range), NOT 2.5 (renal/GI burden, no benefit).
// - Always returns warnings[]; UI must render the disclaimer.
const { z } = require('zod');

const GENDERS = ['male', 'female', 'nonbinary', 'prefer_not_to_say'];
const ACTIVITIES = ['sedentary', 'light', 'moderate', 'high'];
const PACES = ['slow', 'steady', 'fast'];
const PACE_DEFICIT = { slow: 250, steady: 500, fast: 750 };
const PACE_SURPLUS = { slow: 250, steady: 400, fast: 500 };
const PACE_RATE_KG_WK = { slow: 0.25, steady: 0.5, fast: 0.75 };
// 7700 kcal ≈ 1 kg body mass — the constant behind every ETA.
const KCAL_PER_KG = 7700;

// Full inputs required to create a plan. All optional on partial profile
// writes, but ALL required here — plan is created ONLY after all info exists.
// pace is optional (defaults to steady) so old callers keep working.
const planInputSchema = z.object({
  gender: z.enum(GENDERS),
  birthDate: z.coerce
    .date()
    .refine((d) => !Number.isNaN(d.getTime()), 'birthDate is invalid')
    .refine((d) => d <= new Date(Date.now() - 13 * 365.25 * 24 * 3600 * 1000), 'you must be at least 13 years old')
    .refine((d) => d >= new Date(Date.now() - 100 * 365.25 * 24 * 3600 * 1000), 'birthDate is out of range'),
  heightCm: z.number().gte(100).lte(250),
  weightKg: z.number().gte(25).lte(350),
  targetWeightKg: z.number().gte(25).lte(350),
  activityLevel: z.enum(ACTIVITIES),
  pace: z.enum(PACES).optional(),
});

const REQUIRED_FIELDS = ['gender', 'birthDate', 'heightCm', 'weightKg', 'targetWeightKg', 'activityLevel'];

function missingPlanFields(obj = {}) {
  const missing = [];
  for (const f of REQUIRED_FIELDS) {
    const v = obj[f];
    if (v === undefined || v === null || v === '') missing.push(f);
    else if (f === 'birthDate' && Number.isNaN(new Date(v).getTime())) missing.push(f);
  }
  return missing;
}

function calcAge(birthDate, now = new Date()) {
  const b = new Date(birthDate);
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1;
  return age;
}

function activityFactor(level) {
  return { sedentary: 1.2, light: 1.375, moderate: 1.55, high: 1.725 }[level] ?? 1.375;
}

// Mifflin-St Jeor. Non-binary / prefer-not-to-say uses the mean of the male
// (+5) and female (-161) constants (-78) and is documented — never silently
// apply one sex's formula to another user (that would be a "wrong plan" bug).
function mifflinBmr({ gender, weightKg, heightCm, age }) {
  const sexConstant = gender === 'male' ? 5 : gender === 'female' ? -161 : -78;
  return Math.round(10 * weightKg + 6.25 * heightCm - 5 * age + sexConstant);
}

function goalFromWeights(currentKg, targetKg) {
  const d = targetKg - currentKg;
  if (Math.abs(d) <= 1) return 'Maintain Weight';
  return d > 0 ? 'Gain Weight' : 'Lose Weight';
}

function buildNutritionPlan(input, now = new Date()) {
  const parsed = planInputSchema.safeParse(input);
  if (!parsed.success) {
    const err = new Error('incomplete or invalid plan inputs');
    err.status = 400;
    err.details = parsed.error.issues;
    err.missing = missingPlanFields(input);
    throw err;
  }
  const { gender, birthDate, heightCm, weightKg, targetWeightKg, activityLevel } = parsed.data;
  const pace = parsed.data.pace || 'steady';

  const age = calcAge(birthDate, now);
  if (age < 13 || age > 100) {
    const err = new Error('age out of supported range (13-100)');
    err.status = 400;
    err.details = [{ path: ['birthDate'], message: 'age out of supported range (13-100)' }];
    throw err;
  }

  const bmr = mifflinBmr({ gender, weightKg, heightCm, age });
  const maintenance = Math.round(bmr * activityFactor(activityLevel));
  const heightM = heightCm / 100;
  const bmi = Math.round((weightKg / (heightM * heightM)) * 10) / 10;
  const goal = goalFromWeights(weightKg, targetWeightKg);
  const isTeen = age < 18;
  const sexFloor = gender === 'male' ? 1500 : 1200;

  const warnings = [];
  let dailyGoalKcal;

  if (goal === 'Lose Weight') {
    if (bmi < 18.5) {
      // Clinically unsafe to prescribe loss to underweight — hold at maintenance.
      dailyGoalKcal = maintenance;
      warnings.push('Your BMI is below the healthy range, so we set maintenance instead of weight loss. Please consult a clinician before pursuing loss.');
    } else if (isTeen) {
      const deficit = Math.min(PACE_DEFICIT[pace] ?? 500, 300);
      dailyGoalKcal = Math.max(maintenance - deficit, 1800, bmr);
      warnings.push('Teen account: deficit kept small for safe growth. A pediatrician should review any weight-loss goal.');
      if (pace === 'fast') warnings.push('Fast pace capped for teen safety — plan uses the same small deficit as steady.');
    } else {
      const deficit = PACE_DEFICIT[pace] ?? 500;
      dailyGoalKcal = Math.max(maintenance - deficit, sexFloor, bmr);
      if (dailyGoalKcal >= maintenance) warnings.push('Deficit limited by your safe calorie floor — loss will be slower than planned.');
      else if (pace === 'slow') warnings.push('Slow pace: gentle deficit (~0.25 kg/week).');
      else if (pace === 'fast') warnings.push('Fast pace: aggressive deficit (~0.75 kg/week). Stop and consult a clinician if you feel unwell.');
    }
    dailyGoalKcal = Math.min(dailyGoalKcal, maintenance);
  } else if (goal === 'Gain Weight') {
    const surplus = PACE_SURPLUS[pace] ?? 400;
    dailyGoalKcal = maintenance + surplus;
    if (bmi > 30) warnings.push('Your BMI is in the obesity range — weight gain is unusual. Please confirm your target with a clinician.');
    if (isTeen) warnings.push('Teen account: surplus kept moderate for safe growth.');
  } else {
    dailyGoalKcal = maintenance;
  }

  dailyGoalKcal = Math.max(500, Math.min(10000, Math.round(dailyGoalKcal)));

  // Evidence-based protein: 2.0 g/kg for loss (lean-mass retention), else 1.8.
  const proteinPerKg = goal === 'Lose Weight' ? 2.0 : 1.8;
  const proteinG = Math.max(0, Math.min(300, Math.round(proteinPerKg * weightKg)));
  const fatG = Math.round((0.3 * dailyGoalKcal) / 9);
  const carbsG = Math.max(0, Math.round((dailyGoalKcal - proteinG * 4 - fatG * 9) / 4));
  if (carbsG < 50) warnings.push('Carbohydrates are low — include at least some whole grains, fruit, or legumes daily unless advised otherwise.');
  if (proteinG >= 250) warnings.push('Protein is very high for your weight — spread intake through the day and stay hydrated.');
  warnings.push('Dietary guidance is for informational purposes only and is not medical advice. Consult your healthcare provider before making changes, especially with existing health conditions.');

  const weeklyRateKg = PACE_RATE_KG_WK[pace] ?? 0.5;
  // ETA from the EFFECTIVE rate the plan actually delivers: when a floor caps
  // the deficit (teen, BMR/sex floor, underweight→maintenance) the pace table
  // would promise a speed this plan never prescribes. No rate → no ETA (null).
  let etaWeeks;
  if (goal === 'Maintain Weight') {
    etaWeeks = 0;
  } else {
    const dailyDelta = goal === 'Lose Weight' ? maintenance - dailyGoalKcal : dailyGoalKcal - maintenance;
    const effectiveWeeklyKg = (dailyDelta * 7) / KCAL_PER_KG;
    etaWeeks = effectiveWeeklyKg > 0
      ? Math.ceil(Math.abs(targetWeightKg - weightKg) / effectiveWeeklyKg)
      : null;
  }

  return { bmr, maintenance, dailyGoalKcal, proteinG, fatG, carbsG, goal, bmi, age, warnings, pace, weeklyRateKg, etaWeeks };
}

module.exports = {
  planInputSchema,
  REQUIRED_FIELDS,
  missingPlanFields,
  calcAge,
  activityFactor,
  mifflinBmr,
  goalFromWeights,
  buildNutritionPlan,
  PACES,
  PACE_DEFICIT,
  PACE_SURPLUS,
  PACE_RATE_KG_WK,
};
