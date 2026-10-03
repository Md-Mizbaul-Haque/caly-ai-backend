const FROM = process.env.SMTP_FROM || 'Caly AI <no-reply@caly-ai.app>';

const testInboxEnabled = process.env.CALY_TEST_INBOX === '1';
const sentEmails = [];

async function sendMail({ to, subject, text }) {
  if (testInboxEnabled) {
    sentEmails.push({ to, subject, text });
    return { delivered: false, test: true };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from: FROM, to, subject, text }),
    });
    const data = await res.json();
    if (res.ok) return { delivered: true };
    console.error('[mailer:resend] error', data);
    return { delivered: false, resendError: data };
  }
  // No SMTP and no Resend API key: log the code so the flow stays testable.
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

module.exports = { sendMail, getTestInbox, clearTestInbox, extractCode };