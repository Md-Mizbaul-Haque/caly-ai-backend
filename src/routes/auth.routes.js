const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const User = require('../models/User');
const PendingRegistration = require('../models/PendingRegistration');
const Weight = require('../models/Weight');
const WeightGoal = require('../models/WeightGoal');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../services/mailer');
const { verificationEmail, passwordResetEmail } = require('../services/emailTemplates');
const {
  CODE_TTL_MINUTES,
  MAX_RESET_ATTEMPTS,
  signToken,
  generateCode,
  hashCode,
  codesMatch,
  hashPassword,
  passwordMatches,
  codeExpiry,
} = require('../services/auth');

const router = express.Router();

router.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'database unavailable' });
  }
  next();
});

const emailSchema = z.string().trim().toLowerCase().email('email is invalid');
const passwordSchema = z.string().min(8, 'password must be at least 8 characters').max(128);

const registerSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(80),
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'password is required').max(128),
});

const verifySchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'code must be 6 digits'),
});

const resetSchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'code must be 6 digits'),
  newPassword: passwordSchema,
});

function invalid(res, details) {
  return res.status(400).json({ error: 'invalid request', details });
}

async function issueVerifyCode(user) {
  const code = generateCode();
  user.verifyCodeHash = hashCode(code);
  user.verifyCodeExpiresAt = codeExpiry();
  user.verifyCodeAttempts = 0;
  await user.save();
  await sendMail({
    to: user.email,
    ...verificationEmail({ code, ttlMinutes: CODE_TTL_MINUTES }),
  });
}

async function issuePendingCode(pending) {
  const code = generateCode();
  pending.codeHash = hashCode(code);
  pending.codeExpiresAt = codeExpiry();
  pending.codeAttempts = 0;
  await pending.save();
  await sendMail({
    to: pending.email,
    ...verificationEmail({ code, ttlMinutes: CODE_TTL_MINUTES }),
  });
}

async function issueResetCode(user) {
  const code = generateCode();
  user.resetCodeHash = hashCode(code);
  user.resetCodeExpiresAt = codeExpiry();
  user.resetCodeAttempts = 0;
  await user.save();
  await sendMail({
    to: user.email,
    ...passwordResetEmail({ code, ttlMinutes: CODE_TTL_MINUTES }),
  });
}

// POST /api/auth/register — creates a PENDING registration, not a user.
// The User row is created only after verify-email (or skip-verification).
router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  const { name, email, password } = parsed.data;

  const existing = await User.findOne({ email });
  if (existing) {
    if (existing.emailVerified) {
      return res.status(409).json({ error: 'an account with this email already exists' });
    }
    // Stale unverified row from before verify-first — drop it; the pending
    // below becomes the single source of truth for this email.
    await User.deleteOne({ _id: existing._id });
  }

  const passwordHash = await hashPassword(password);
  await PendingRegistration.findOneAndUpdate(
    { email },
    { name, email, passwordHash },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const pending = await PendingRegistration.findOne({ email });
  await issuePendingCode(pending);
  res.status(201).json({ requiresVerification: true });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  const { email, password } = parsed.data;

  const user = await User.findOne({ email });
  if (!user) {
    // Verify-first flow: the account may exist only as a pending
    // registration (no User row until verify-email). Same 401 as unknown
    // email on wrong password — no enumeration.
    const pending = await PendingRegistration.findOne({ email });
    if (pending && (await passwordMatches(password, pending.passwordHash))) {
      await issuePendingCode(pending);
      return res.status(403).json({ error: 'email not verified — a new code has been sent', needsVerification: true });
    }
    return res.status(401).json({ error: 'invalid email or password' });
  }
  if (!(await passwordMatches(password, user.passwordHash))) {
    return res.status(401).json({ error: 'invalid email or password' });
  }
  if (!user.emailVerified) {
    await issueVerifyCode(user);
    return res.status(403).json({ error: 'email not verified — a new code has been sent', needsVerification: true });
  }
  res.json({ token: signToken(user), user });
});

// POST /api/auth/verify-email — confirms a pending registration and
// creates the User row (verified) in the same step.
router.post('/verify-email', async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  const { email, code } = parsed.data;

  const pending = await PendingRegistration.findOne({ email });
  if (!pending || !pending.codeHash || !pending.codeExpiresAt || pending.codeExpiresAt <= new Date()) {
    return res.status(400).json({ error: 'verification code is invalid or expired' });
  }
  if (pending.codeAttempts >= MAX_RESET_ATTEMPTS) {
    return res.status(429).json({ error: 'too many attempts — request a new code' });
  }
  if (!codesMatch(code, pending.codeHash)) {
    pending.codeAttempts += 1;
    await pending.save();
    return res.status(400).json({ error: 'verification code is invalid or expired' });
  }

  const user = await User.create({ name: pending.name, email: pending.email, passwordHash: pending.passwordHash });
  user.emailVerified = true;
  await user.save();
  await PendingRegistration.deleteOne({ _id: pending._id });
  res.json({ token: signToken(user), user });
});

// POST /api/auth/resend-code — never reveals whether the email exists
router.post('/resend-code', async (req, res) => {
  const parsed = z.object({ email: emailSchema }).safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  const pending = await PendingRegistration.findOne({ email: parsed.data.email });
  if (pending) await issuePendingCode(pending);
  res.json({ ok: true });
});

const skipSchema = z.object({ email: emailSchema });

// POST /api/auth/skip-verification — creates the User row immediately as
// unverified (the "Skip for now" path) and returns a token like verify does.
// The user re-verifies naturally later: next login hits the 403 path, which
// auto-sends a fresh code.
router.post('/skip-verification', async (req, res) => {
  const parsed = skipSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  const { email } = parsed.data;

  const pending = await PendingRegistration.findOne({ email });
  if (!pending) {
    return res.status(400).json({ error: 'nothing to skip — request a verification code first' });
  }
  const user = await User.create({ name: pending.name, email: pending.email, passwordHash: pending.passwordHash });
  await PendingRegistration.deleteOne({ _id: pending._id });
  res.status(201).json({ token: signToken(user), user });
});

// POST /api/auth/forgot-password — always 200, never reveals whether the email exists
router.post('/forgot-password', async (req, res) => {
  const parsed = z.object({ email: emailSchema }).safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  const user = await User.findOne({ email: parsed.data.email });
  if (user) await issueResetCode(user);
  res.json({ ok: true });
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  const { email, code, newPassword } = parsed.data;

  const user = await User.findOne({ email });
  if (!user || !user.resetCodeHash || !user.resetCodeExpiresAt || user.resetCodeExpiresAt <= new Date()) {
    return res.status(400).json({ error: 'reset code is invalid or expired' });
  }
  if (user.resetCodeAttempts >= MAX_RESET_ATTEMPTS) {
    return res.status(429).json({ error: 'too many attempts — request a new code' });
  }
  if (!codesMatch(code, user.resetCodeHash)) {
    user.resetCodeAttempts += 1;
    await user.save();
    return res.status(400).json({ error: 'reset code is invalid or expired' });
  }

  user.passwordHash = await hashPassword(newPassword);
  user.emailVerified = true; // they proved mailbox ownership
  user.clearResetCode();
  await user.save();
  res.json({ token: signToken(user), user });
});

// GET /api/auth/me — onboarding needs the profile before verification.
router.get('/me', requireAuth.allowUnverified, (req, res) => {
  res.json({ user: req.user });
});

const genderSchema = z.enum(['male', 'female', 'nonbinary', 'prefer_not_to_say']);
const activitySchema = z.enum(['sedentary', 'light', 'moderate', 'high']);
const profileSchema = z.object({
  dailyGoalKcal: z.number().int('dailyGoalKcal must be an integer').gte(500).lte(10000).optional(),
  gender: genderSchema.optional(),
  birthDate: z.coerce.date().refine((d) => d <= new Date(Date.now() - 13 * 365.25 * 24 * 3600 * 1000), 'you must be at least 13 years old').optional(),
  heightCm: z.number().gte(100).lte(250).optional(),
  weightKg: z.number().gte(25).lte(350).optional(),
  targetWeightKg: z.number().gte(25).lte(350).optional(),
  activityLevel: activitySchema.optional(),
  onboardingCompleted: z.boolean().optional(),
});

// Tracking surface works in lbs (WeightLogSheet + Progress labels) while the
// profile stores kg. Seeds use this conversion — never store raw kg into the
// weights collections.
const KG_TO_LBS = 2.20462;
function toLbs(kg) {
  return Math.round(Number(kg) * KG_TO_LBS * 10) / 10;
}

// Onboarding completion seeds the tracking collections from the profile the
// user just finished: first weigh-in + goal weight. Never overwrites —
// existing rows win (e.g. user logged during onboarding, or is retrying
// completion after a failed response). Idempotent by construction.
async function seedTrackingFromOnboarding(user, deps = {}) {
  const WeightModel = deps.Weight || Weight;
  const WeightGoalModel = deps.WeightGoal || WeightGoal;
  if (typeof user.weightKg === 'number') {
    const count = await WeightModel.countDocuments({ userId: user._id });
    if (count === 0) {
      await WeightModel.create({ userId: user._id, value: toLbs(user.weightKg) });
    }
  }
  if (typeof user.targetWeightKg === 'number') {
    const existing = await WeightGoalModel.findOne({ userId: user._id });
    if (!existing) {
      await WeightGoalModel.create({ userId: user._id, value: toLbs(user.targetWeightKg) });
    }
  }
}

// PUT /api/auth/profile — onboarding writes (gender, birthday, goals…)
// happen before verification for skip-verification accounts.
// SECURITY + SAFETY: onboarding can only complete for req.user (JWT sub —
// body can never pick another user). When onboardingCompleted=true the
// server merges body over the stored user, requires ALL plan fields, and
// recomputes dailyGoalKcal server-side — the client's calorie number is
// IGNORED so a buggy/tampered client can never inject a dangerous or
// wrong-user plan. Incomplete completions get 400 + missing[] and nothing
// is marked complete.
router.put('/profile', requireAuth.allowUnverified, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  if (parsed.data.onboardingCompleted === true) {
    const { buildNutritionPlan, missingPlanFields } = require('../services/nutritionPlan');
    const candidate = {
      gender: parsed.data.gender !== undefined ? parsed.data.gender : req.user.gender,
      birthDate: parsed.data.birthDate !== undefined ? parsed.data.birthDate : req.user.birthDate,
      heightCm: parsed.data.heightCm !== undefined ? parsed.data.heightCm : req.user.heightCm,
      weightKg: parsed.data.weightKg !== undefined ? parsed.data.weightKg : req.user.weightKg,
      targetWeightKg: parsed.data.targetWeightKg !== undefined ? parsed.data.targetWeightKg : req.user.targetWeightKg,
      activityLevel: parsed.data.activityLevel !== undefined ? parsed.data.activityLevel : req.user.activityLevel,
    };
    try {
      const plan = buildNutritionPlan(candidate);
      Object.assign(req.user, parsed.data, { dailyGoalKcal: plan.dailyGoalKcal, onboardingCompleted: true });
      await req.user.save();
      // First weigh-in + goal for the Progress screen, from the profile the
      // user just completed. Retry-safe (seed skips when rows exist).
      await seedTrackingFromOnboarding(req.user);
      return res.json({ user: req.user, plan });
    } catch (e) {
      if (e.status === 400) {
        return res.status(400).json({
          error: 'cannot complete onboarding — all profile fields are required for a safe plan',
          missing: e.missing || missingPlanFields(candidate),
          details: e.details || [],
        });
      }
      throw e;
    }
  }
  Object.assign(req.user, parsed.data);
  await req.user.save();
  res.json({ user: req.user });
});

module.exports = router;
module.exports.profileSchema = profileSchema;
module.exports.skipSchema = skipSchema;
module.exports.toLbs = toLbs;
module.exports.seedTrackingFromOnboarding = seedTrackingFromOnboarding;
