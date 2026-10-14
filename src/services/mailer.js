const nodemailer = require('nodemailer');

const FROM = process.env.SMTP_FROM || 'Caly AI <no-reply@caly-ai.app>';

const testInboxEnabled = process.env.CALY_TEST_INBOX === '1';
const sentEmails = [];

let transporter = null;
const SMTP_TIMEOUT_MS = 10000; // Render -> Gmail can black-hole; never hang a request past this per phase

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

async function sendMail({ to, subject, text, html }) {
  if (testInboxEnabled) {
    sentEmails.push({ to, subject, text, html });
    return { delivered: false, test: true };
  }
  const transport = getTransporter();
  if (transport) {
    await transport.sendMail({ from: FROM, to, subject, text, ...(html ? { html } : {}) });
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

module.exports = { sendMail, getTestInbox, clearTestInbox, extractCode, buildSmtpOptions };
