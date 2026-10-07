// Caly AI transactional email templates.
// Rules: never greet with the recipient's email address, never hardcode the
// OTP — code and expiry are always injected by the caller at send time.

const BRAND = '#FF6B35';
const INK = '#1A1A1A';
const MUTED = '#8A8A8A';
const BORDER = '#F1E8E0';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function baseHtml({ preheader, title, intro, code, expiryLine, outro }) {
  const safeCode = escapeHtml(code);
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '</head><body style="margin:0;padding:0;background-color:#FFF8F2;">' +
    `<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>` +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FFF8F2;padding:24px 12px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#FFFFFF;border:1px solid ' + BORDER + ';border-radius:16px;overflow:hidden;">' +
    '<tr><td style="padding:28px 32px 0 32px;text-align:center;">' +
    `<div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;color:${INK};font-family:Arial,Helvetica,sans-serif;">CALY <span style="color:${BRAND};">AI</span></div>` +
    `<div style="font-size:16px;font-weight:700;color:${INK};margin-top:16px;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(title)}</div>` +
    '</td></tr>' +
    '<tr><td style="padding:16px 32px 0 32px;">' +
    '<p style="margin:0;font-size:15px;line-height:24px;color:' + INK + ';font-family:Arial,Helvetica,sans-serif;">Hi there,</p>' +
    `<p style="margin:12px 0 0 0;font-size:15px;line-height:24px;color:${INK};font-family:Arial,Helvetica,sans-serif;">${escapeHtml(intro)}</p>` +
    '</td></tr>' +
    '<tr><td align="center" style="padding:24px 32px 0 32px;">' +
    `<div style="display:inline-block;background-color:#FFF1E9;border:1px dashed ${BRAND};border-radius:12px;padding:16px 40px;font-size:32px;font-weight:800;letter-spacing:8px;color:${INK};font-family:Arial,Helvetica,sans-serif;">${safeCode}</div>` +
    '</td></tr>' +
    '<tr><td style="padding:20px 32px 0 32px;">' +
    `<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};text-align:center;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(expiryLine)}</p>` +
    `<p style="margin:16px 0 0 0;font-size:14px;line-height:22px;color:${MUTED};font-family:Arial,Helvetica,sans-serif;">${escapeHtml(outro)}</p>` +
    '<p style="margin:16px 0 0 0;font-size:15px;line-height:24px;color:' + INK + ';font-family:Arial,Helvetica,sans-serif;">Best,<br>The Caly AI Team</p>' +
    '</td></tr>' +
    '<tr><td style="padding:24px 32px 28px 32px;border-top:1px solid ' + BORDER + ';margin-top:24px;">' +
    '<p style="margin:12px 0 0 0;font-size:12px;line-height:18px;color:' + MUTED + ';text-align:center;font-family:Arial,Helvetica,sans-serif;">© Caly AI<br>This is an automated email. Please do not reply.</p>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>'
  );
}

function verificationEmail({ code, ttlMinutes }) {
  const mins = Number(ttlMinutes) || 10;
  const subject = 'Your Caly AI verification code';
  const text =
    'Hi there,\n\n' +
    'Use the verification code below to verify your email address and continue setting up your Caly AI account.\n\n' +
    `${code}\n\n` +
    `This code will expire in ${mins} minutes.\n\n` +
    "If you didn't request this code, you can safely ignore this email.\n\n" +
    'Best,\nThe Caly AI Team';
  const html = baseHtml({
    preheader: `Your Caly AI verification code: ${code}`,
    title: 'Verify your email address',
    intro: 'Use the verification code below to verify your email address and continue setting up your Caly AI account.',
    code,
    expiryLine: `This code will expire in ${mins} minutes.`,
    outro: "If you didn't request this code, you can safely ignore this email.",
  });
  return { subject, text, html };
}

function passwordResetEmail({ code, ttlMinutes }) {
  const mins = Number(ttlMinutes) || 10;
  const subject = 'Your Caly AI password reset code';
  const text =
    'Hi there,\n\n' +
    'Use the verification code below to reset your Caly AI account password.\n\n' +
    `${code}\n\n` +
    `This code will expire in ${mins} minutes.\n\n` +
    "If you didn't request this code, you can safely ignore this email.\n\n" +
    'Best,\nThe Caly AI Team';
  const html = baseHtml({
    preheader: `Your Caly AI password reset code: ${code}`,
    title: 'Reset your password',
    intro: 'Use the verification code below to reset your Caly AI account password.',
    code,
    expiryLine: `This code will expire in ${mins} minutes.`,
    outro: "If you didn't request this code, you can safely ignore this email.",
  });
  return { subject, text, html };
}

module.exports = { verificationEmail, passwordResetEmail };
