const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const User = require('../models/User');
const PendingRegistration = require('../models/PendingRegistration');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../services/mailer');
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
    subject: 'Your Caly AI verification code',
    text: `Hi ${user.name},\n\nYour Caly AI verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.\n\nIf you didn't create an account, you can ignore this email.`,
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
    subject: 'Your Caly AI verification code',
    text: `Hi ${pending.name},\n\nYour Caly AI verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.\n\nIf you didn't create an account, you can ignore this email.`,
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
    subject: 'Your Caly AI password reset code',
    text: `Your Caly AI password reset code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.\n\nIf you didn't request a reset, you can ignore this email.`,
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
  if (!user || !(await passwordMatches(password, user.passwordHash))) {
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

// PUT /api/auth/profile — onboarding writes (gender, birthday, goals…)
// happen before verification for skip-verification accounts.
router.put('/profile', requireAuth.allowUnverified, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  Object.assign(req.user, parsed.data);
  await req.user.save();
  res.json({ user: req.user });
});

module.exports = router;
module.exports.profileSchema = profileSchema;
module.exports.skipSchema = skipSchema;
