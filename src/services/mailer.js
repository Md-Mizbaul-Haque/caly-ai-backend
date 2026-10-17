const nodemailer = require('nodemailer');

const testInboxEnabled = process.env.CALY_TEST_INBOX === '1';
const sentEmails = [];

let transporter = null;
const SMTP_TIMEOUT_MS = 5000; // Render -> Gmail can black-hole; never hang boot/verify past this per phase

// --- Sender identity (shared by every transport) -------------------------
// MAIL_FROM wins, then SMTP_FROM, then the authenticated SMTP user — the one
// address a relay is guaranteed to have verified — then the product default.
// parseFrom tolerates both `Name <a@b.c>` and a bare address.
function parseFrom(raw) {
  const s = String(raw || '').trim();
  const m = /^(.*?)\s*<\s*([^>\s]+)\s*>$/.exec(s);
  if (m) {
    const name = m[1].replace(/^["']|["']$/g, '').trim();
    return name ? { name, email: m[2] } : { email: m[2] };
  }
  return { email: s };
}

function resolveSender(env = process.env) {
  return parseFrom(
    env.MAIL_FROM ||
      env.SMTP_FROM ||
      (env.SMTP_USER ? `Caly AI <${env.SMTP_USER}>` : 'Caly AI <no-reply@caly-ai.app>')
  );
}

function formatFrom(sender) {
  return sender.name ? `${sender.name} <${sender.email}>` : sender.email;
}

const FROM = formatFrom(resolveSender());

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

// --- HTTPS transport (survives hosts that block outbound SMTP) -----------
// Render (and similar PaaS free tiers) drop outbound TCP to ports 25/465/587,
// so a Nodemailer client there fails at the socket layer with ESOCKET no
// matter how correct the credentials are. An HTTP API on 443 is unaffected.
// Brevo speaks one JSON POST and verifies a single sender address, so no
// custom domain or DNS records are needed to start sending.
const HTTP_MAIL_URL = process.env.MAIL_API_URL || 'https://api.brevo.com/v3/smtp/email';
const HTTP_TIMEOUT_MS = Number(process.env.MAIL_API_TIMEOUT_MS) || 8000;

// Presence of the provider key is what selects the HTTP transport.
function getHttpMailKey(env = process.env) {
  return env.BREVO_API_KEY || null;
}

function isHttpMailConfigured(env = process.env) {
  const key = getHttpMailKey(env);
  return !!(key && key.length > 20);
}

function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'EAUTH'; // bad/revoked API key
  if (status === 400 || status === 422) return 'EENVELOPE'; // unverified sender, bad payload
  if (status === 429) return 'ERATE'; // daily quota spent
  if (status >= 500) return 'EPROVIDER';
  return 'EHTTP';
}

// Pure and testable: the exact JSON body the provider receives.
function buildHttpPayload({ to, subject, text, html }, env = process.env) {
  const sender = resolveSender(env);
  const payload = {
    sender: sender.name ? { name: sender.name, email: sender.email } : { email: sender.email },
    to: [{ email: to }],
    subject,
  };
  if (html) payload.htmlContent = html;
  if (text) payload.textContent = text;
  // The API rejects a message with no body at all.
  if (!html && !text) payload.textContent = subject;
  return payload;
}

async function sendViaHttp(message, env = process.env, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  // A pending timer must never hold the process (or a test run) open.
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetchImpl(HTTP_MAIL_URL, {
      method: 'POST',
      headers: {
        'api-key': getHttpMailKey(env),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(buildHttpPayload(message, env)),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`mail api ${res.status}: ${String(detail).slice(0, 300)}`);
      err.code = httpErrorCode(res.status);
      err.status = res.status;
      throw err;
    }
    return { delivered: true, transport: 'http' };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error(`mail api timed out after ${HTTP_TIMEOUT_MS} ms`);
      err.code = 'ETIMEDOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Maps a nodemailer/HTTP send failure to a stable class for logs and the
// email health check. Read reqId + code in Render logs: AUTH means wrong
// user/app-password or a bad API key, NETWORK means host/port blocked or
// black-holed, REJECTED means the provider refused the message/recipient,
// RATE means the daily quota is spent.
function classifyMailError(e) {
  if (!isMailConfigured()) return 'NOT_CONFIGURED';
  const code = e && e.code;
  if (code === 'EAUTH') return 'AUTH';
  if (code === 'EENVELOPE') return 'REJECTED';
  if (code === 'ERATE') return 'RATE';
  if (code === 'EPROVIDER' || code === 'EHTTP') return 'PROVIDER';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNREFUSED' || code === 'EDNS' || code === 'ECONNRESET') return 'NETWORK';
  return 'UNKNOWN';
}

// Pure config audit (testable): catches the misconfigurations that hang
// until the timeout instead of failing fast — the classic being
// SMTP_SECURE=1 on port 587 (implicit TLS needs 465; 587 wants STARTTLS),
// which black-holes exactly like the Render->Gmail stall. Returns a list of
// human-readable problems; empty means sane. Never includes secrets.
function validateSmtpConfig(env = process.env) {
  const problems = [];
  if (isHttpMailConfigured(env)) return problems; // HTTP transport carries the mail
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

// True when EITHER transport can actually deliver: the HTTP API key or the
// SMTP relay. Callers use this to decide whether mailbox ownership can be
// proven by code at all.
function isMailConfigured(env = process.env) {
  return isHttpMailConfigured(env) || !!env.SMTP_HOST;
}

// Last send failure (class + provider code + time, never credentials) so
// /health can report mail status without log access.
let lastMailError = null;

function getMailStatus() {
  const transport = isHttpMailConfigured() ? 'http' : process.env.SMTP_HOST ? 'smtp' : 'none';
  return {
    configured: isMailConfigured(),
    transport,
    sender: resolveSender().email,
    lastError: lastMailError,
  };
}

async function sendMail({ to, subject, text, html }) {
  if (testInboxEnabled) {
    sentEmails.push({ to, subject, text, html });
    return { delivered: false, test: true };
  }
  if (isHttpMailConfigured()) {
    try {
      return await sendViaHttp({ to, subject, text, html });
    } catch (e) {
      lastMailError = { class: classifyMailError(e), code: e.code || null, at: new Date().toISOString() };
      throw e;
    }
  }
  const transport = getTransporter();
  if (transport) {
    try {
      await transport.sendMail({ from: FROM, to, subject, text, ...(html ? { html } : {}) });
    } catch (e) {
      lastMailError = { class: classifyMailError(e), code: e.code || null, at: new Date().toISOString() };
      throw e;
    }
    return { delivered: true, transport: 'smtp' };
  }
  // No transport configured (dev): log the code so the flow stays testable.
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

module.exports = {
  sendMail,
  getTestInbox,
  clearTestInbox,
  extractCode,
  buildSmtpOptions,
  buildHttpPayload,
  resolveSender,
  sendViaHttp,
  isMailConfigured,
  isHttpMailConfigured,
  classifyMailError,
  getTransporter,
  validateSmtpConfig,
  getMailStatus,
};
