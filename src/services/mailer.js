const nodemailer = require('nodemailer');

const FROM = process.env.SMTP_FROM || 'Caly AI <no-reply@caly-ai.app>';

const testInboxEnabled = process.env.CALY_TEST_INBOX === '1';
const sentEmails = [];

let transporter = null;
const SMTP_TIMEOUT_MS = 5000; // Render -> Gmail can black-hole; never hang boot/verify past this per phase

function buildSmtpOptions() {
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === '1',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  };
}

function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) transporter = nodemailer.createTransport(buildSmtpOptions());
  return transporter;
}

// Maps a nodemailer send/verify failure to a stable class for logs and the
// email health check. Read reqId + code in Render logs: AUTH means wrong
// user/app-password, NETWORK means host/port blocked or black-holed,
// REJECTED means the provider refused the message/recipient.
function classifyMailError(e) {
  if (!process.env.SMTP_HOST) return 'NOT_CONFIGURED';
  const code = e && e.code;
  if (code === 'EAUTH' || code === 'EENVELOPE') return code === 'EAUTH' ? 'AUTH' : 'REJECTED';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNREFUSED' || code === 'EDNS' || code === 'ECONNRESET') return 'NETWORK';
  if (code) return 'UNKNOWN';
  return 'UNKNOWN';
}

// Pure config audit (testable): catches the misconfigurations that hang
// until the 10 s timeout instead of failing fast — the classic being
// SMTP_SECURE=1 on port 587 (implicit TLS needs 465; 587 wants STARTTLS),
// which black-holes exactly like the Render->Gmail stall. Returns a list of
// human-readable problems; empty means sane. Never includes secrets.
function validateSmtpConfig(env = process.env) {
  const problems = [];
  if (!env.SMTP_HOST) {
    problems.push('SMTP_HOST not set — emails are console-logged, NOT sent');
    return problems;
  }
  const port = Number(env.SMTP_PORT) || 587;
  if (env.SMTP_PORT && !Number.isSafeInteger(Number(env.SMTP_PORT))) {
    problems.push(`SMTP_PORT="${env.SMTP_PORT}" is not a number — falling back to 587`);
  }
  const secure = env.SMTP_SECURE === '1';
  if (secure && port !== 465) {
    problems.push(`SMTP_SECURE=1 with port ${port} — implicit TLS needs port 465; for 587 unset SMTP_SECURE (STARTTLS). This mismatch hangs until timeout.`);
  }
  if (!secure && port === 465) {
    problems.push('Port 465 without SMTP_SECURE=1 — 465 speaks implicit TLS from the first byte; the handshake will fail.');
  }
  if (!env.SMTP_USER) {
    problems.push('SMTP_USER not set — most relays refuse unauthenticated mail');
  }
  return problems;
}

// Last send failure (class + provider code + time, never credentials) so
// /health can report mail status without log access.
let lastMailError = null;

function getMailStatus() {
  return { configured: !!process.env.SMTP_HOST, lastError: lastMailError };
}

async function sendMail({ to, subject, text, html }) {
  if (testInboxEnabled) {
    sentEmails.push({ to, subject, text, html });
    return { delivered: false, test: true };
  }
  const transport = getTransporter();
  if (transport) {
    try {
      await transport.sendMail({ from: FROM, to, subject, text, ...(html ? { html } : {}) });
    } catch (e) {
      lastMailError = { class: classifyMailError(e), code: e.code || null, at: new Date().toISOString() };
      throw e;
    }
    return { delivered: true };
  }
  // No SMTP configured (dev): log the code so the flow stays testable.
  console.log(`[mailer:dev] to=${to} subject="${subject}"\n${text}`);
  return { delivered: false, dev: true };
}

function getTestInbox() {
  return sentEmails;
}

function clearTestInbox() {
  sentEmails.length = 0;
}

function extractCode(text) {
  const m = /\b(\d{6})\b/.exec(text || '');
  return m ? m[1] : null;
}

module.exports = { sendMail, getTestInbox, clearTestInbox, extractCode, buildSmtpOptions, classifyMailError, getTransporter, validateSmtpConfig, getMailStatus };
