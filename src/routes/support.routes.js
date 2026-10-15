const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../services/mailer');

const supportMessageSchema = z.object({
  message: z
    .string()
    .trim()
    .min(5, 'message must be at least 5 characters')
    .max(2000, 'message must be at most 2000 characters'),
  subject: z.string().trim().max(120).optional(),
});

const router = express.Router();
router.use(requireAuth);

// POST /api/support/message — user-submitted help message, emailed to support.
router.post('/message', async (req, res, next) => {
  const parsed = supportMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid message', details: parsed.error.issues });
  }
  const { message, subject } = parsed.data;
  const to = process.env.SUPPORT_EMAIL || 'support@caly-ai.app';
  try {
    await sendMail({
      to,
      subject: `[Caly AI support] ${subject || 'New message'}`,
      text: `From: ${req.user.email}\nUser: ${req.user.id}\n\n${message}`,
    });
    res.status(202).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.supportMessageSchema = supportMessageSchema;
