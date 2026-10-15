const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const User = require('../models/User');
const PendingRegistration = require('../models/PendingRegistration');
const Weight = require('../models/Weight');
const WeightGoal = require('../models/WeightGoal');
const { requireAuth } = require('../middleware/auth');
const { resolveTimezone } = require('../utils/timezone');
const { sendMail } = require('../services/mailer');
const { verificationEmail, passwordResetEmail } = require('../services/emailTemplates');
const {
  CODE_TTL_MINUTES,
  MAX_RESET_ATTEMPTS,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCK_MS,
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

// Saves the code, then tries email. Returns true when the email went out;
// a down SMTP must never fail (or hang past mailer timeouts) the request.
async function issueVerifyCode(user) {
  const code = generateCode();
  user.verifyCodeHash = hashCode(code);
  user.verifyCodeExpiresAt = codeExpiry();
  user.verifyCodeAttempts = 0;
  await user.save();
  try {
    await sendMail({
      to: user.email,
      ...verificationEmail({ code, ttlMinutes: CODE_TTL_MINUTES }),
    });
    return true;
  } catch (e) {
    console.warn(`[auth] email send failed to=${user.email}: ${e.message}`);
    return false;
  }
}

async function issuePendingCode(pending) {
  const code = generateCode();
  pending.codeHash = hashCode(code);
  pending.codeExpiresAt = codeExpiry();
  pending.codeAttempts = 0;
  await pending.save();
  try {
    await sendMail({
      to: pending.email,
      ...verificationEmail({ code, ttlMinutes: CODE_TTL_MINUTES }),
    });
    return true;
  } catch (e) {
    console.warn(`[auth] email send failed to=${pending.email}: ${e.message}`);
    return false;
  }
}

async function issueResetCode(user) {
  const code = generateCode();
  user.resetCodeHash = hashCode(code);
  user.resetCodeExpiresAt = codeExpiry();
  user.resetCodeAttempts = 0;
  await user.save();
  try {
    await sendMail({
      to: user.email,
      ...passwordResetEmail({ code, ttlMinutes: CODE_TTL_MINUTES }),
    });
    return true;
  } catch (e) {
    console.warn(`[auth] email send failed to=${user.email}: ${e.message}`);
    return false;
  }
}

// Checks a 6-digit code against a doc whose code fields are named
// `${prefix}Hash`, `${prefix}ExpiresAt`, `${prefix}Attempts` — PendingRegistration
// uses prefix 'code', the unverified User row (skip-verification accounts) uses
// 'verifyCode'. Bumps + persists attempts on a miss so brute force stays capped.
// Returns 'ok' | 'expired' | 'locked' | 'bad'.
async function checkCode(doc, prefix, code) {
  const hash = doc[`${prefix}Hash`];
  const expiresAt = doc[`${prefix}ExpiresAt`];
  const attempts = doc[`${prefix}Attempts`] || 0;
  if (!hash || !expiresAt || expiresAt <= new Date()) return 'expired';
  if (attempts >= MAX_RESET_ATTEMPTS) return 'locked';
  if (!codesMatch(code, hash)) {
    doc[`${prefix}Attempts`] = attempts + 1;
    await doc.save();
    return 'bad';
  }
  return 'ok';
}

// Per-account throttle: after MAX_LOGIN_ATTEMPTS wrong passwords the account
// locks for LOGIN_LOCK_MS. A correct password still counts as a fresh start.
async function registerFailedLogin(user) {
  const attempts = (user.failedLoginAttempts || 0) + 1;
  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    user.failedLoginAttempts = 0;
    user.loginLockedUntil = new Date(Date.now() + LOGIN_LOCK_MS);
  } else {
    user.failedLoginAttempts = attempts;
  }
  await user.save();
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
    // Unverified account (e.g. "Skip for now"): reuse the row instead of
    // deleting it — it may already own onboarding data (seeded weight rows),
    // and deleting it would orphan that data. Refresh the credentials the user
    // just typed and re-issue the code; verify-email's User fallback completes
    // this same account. Drop any leftover pending so verify cannot create a
    // duplicate User for the same email.
    await PendingRegistration.deleteOne({ email });
    existing.name = name;
    existing.passwordHash = await hashPassword(password);
    const emailSent = await issueVerifyCode(existing);
    return res.status(201).json({ requiresVerification: true, emailSent });
  }

  const passwordHash = await hashPassword(password);
  const pending = await PendingRegistration.findOneAndUpdate(
    { email },
    { name, email, passwordHash },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const emailSent = await issuePendingCode(pending);
  // If email failed to send, still create the User row as unverified so the
  // user can complete onboarding. They'll need to verify later or use
  // "skip-verification" on next login.
  if (!emailSent) {
    await User.create({ name, email, passwordHash, emailVerified: false });
    await PendingRegistration.deleteOne({ email });
    return res.status(201).json({ 
      requiresVerification: true, 
      emailSent: false,
      skipVerification: true 
    });
  }
  res.status(201).json({ requiresVerification: true, emailSent });
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
      const emailSent = await issuePendingCode(pending);
      return res.status(403).json({ error: 'email not verified — a new code has been sent', needsVerification: true, emailSent });
    }
    return res.status(401).json({ error: 'invalid email or password' });
  }
  if (user.loginLockedUntil && user.loginLockedUntil > new Date()) {
    return res.status(429).json({ error: 'too many attempts — try again in a few minutes' });
  }
  if (!(await passwordMatches(password, user.passwordHash))) {
    await registerFailedLogin(user);
    return res.status(401).json({ error: 'invalid email or password' });
  }
  if (!user.emailVerified) {
    const emailSent = await issueVerifyCode(user);
    return res.status(403).json({ error: 'email not verified — a new code has been sent', needsVerification: true, emailSent });
  }
  if (user.failedLoginAttempts || user.loginLockedUntil) {
    user.failedLoginAttempts = 0;
    user.loginLockedUntil = null;
    await user.save();
  }
  res.json({ token: signToken(user), user });
});

// POST /api/auth/verify-email — confirms a pending registration and
// creates the User row (verified) in the same step. For an account that
// already exists but is unverified (the "Skip for now" path), it verifies
// that existing row in place so its data is preserved.
router.post('/verify-email', async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  const { email, code } = parsed.data;

  const pending = await PendingRegistration.findOne({ email });
  if (pending) {
    const state = await checkCode(pending, 'code', code);
    if (state === 'ok') {
      const user = await User.create({ name: pending.name, email: pending.email, passwordHash: pending.passwordHash });
      user.emailVerified = true;
      await user.save();
      await PendingRegistration.deleteOne({ _id: pending._id });
      return res.json({ token: signToken(user), user });
    }
    if (state === 'locked') return res.status(429).json({ error: 'too many attempts — request a new code' });
    return res.status(400).json({ error: 'verification code is invalid or expired' });
  }

  // No pending: only an existing unverified account (skip-verification) can
  // still verify — its code was issued by login/register onto the User row.
  const user = await User.findOne({ email });
  if (user && !user.emailVerified) {
    const state = await checkCode(user, 'verifyCode', code);
    if (state === 'ok') {
      user.emailVerified = true;
      user.clearVerifyCode();
      await user.save();
      return res.json({ token: signToken(user), user });
    }
    if (state === 'locked') return res.status(429).json({ error: 'too many attempts — request a new code' });
  }
  return res.status(400).json({ error: 'verification code is invalid or expired' });
});

// POST /api/auth/resend-code — never reveals whether the email exists
router.post('/resend-code', async (req, res) => {
  const parsed = z.object({ email: emailSchema }).safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  const { email } = parsed.data;
  const pending = await PendingRegistration.findOne({ email });
  if (pending) return res.json({ ok: true, emailSent: await issuePendingCode(pending) });
  // Existing unverified account (skip-verification): re-issue onto the User row.
  const user = await User.findOne({ email });
  if (user && !user.emailVerified) return res.json({ ok: true, emailSent: await issueVerifyCode(user) });
  res.json({ ok: true, emailSent: true });
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
  const emailSent = user ? await issueResetCode(user) : true;
  res.json({ ok: true, emailSent });
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
  // Revoke every token issued before this reset.
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.clearResetCode();
  await user.save();
  res.json({ token: signToken(user), user });
});

// POST /api/auth/logout — bumps the token version so the caller's token (and
// any copy of it) is refused from here on. Best-effort: a client that is
// already unauthenticated just clears local state.
router.post('/logout', requireAuth.allowUnverified, async (req, res) => {
  req.user.tokenVersion = (req.user.tokenVersion || 0) + 1;
  await req.user.save();
  res.json({ ok: true });
});

// GET /api/auth/me — onboarding needs the profile before verification.
router.get('/me', requireAuth.allowUnverified, (req, res) => {
  res.json({ user: req.user });
});

const genderSchema = z.enum(['male', 'female', 'nonbinary', 'prefer_not_to_say']);
const activitySchema = z.enum(['sedentary', 'light', 'moderate', 'high']);
const profileSchema = z.object({
  // No dailyGoalKcal: the server owns the target (recomputed on onboarding
  // completion and weight-goal saves). Unknown keys are stripped, so a
  // tampered client can never inject a manual calorie number.
  gender: genderSchema.optional(),
  birthDate: z.coerce.date().refine((d) => d <= new Date(Date.now() - 13 * 365.25 * 24 * 3600 * 1000), 'you must be at least 13 years old').optional(),
  heightCm: z.number().gte(100).lte(250).optional(),
  weightKg: z.number().gte(25).lte(350).optional(),
  targetWeightKg: z.number().gte(25).lte(350).optional(),
  activityLevel: activitySchema.optional(),
  goalPace: z.enum(['slow', 'steady', 'fast']).optional(),
  onboardingCompleted: z.boolean().optional(),
  // Client's IANA zone (e.g. 'Asia/Dhaka'). Normalized server-side: anything
  // unusable becomes 'UTC' instead of a 400, so days always have a zone.
  timezone: z.string().max(100).optional(),
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
  if (parsed.data.timezone !== undefined) {
    parsed.data.timezone = resolveTimezone(parsed.data.timezone);
  }
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
module.exports.checkCode = checkCode;
module.exports.registerFailedLogin = registerFailedLogin;
module.exports.toLbs = toLbs;
module.exports.seedTrackingFromOnboarding = seedTrackingFromOnboarding;
