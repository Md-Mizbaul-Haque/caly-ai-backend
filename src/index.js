require('dotenv').config();
const app = require('./app');
const { connectDb, disconnectDb } = require('./config/db');

const rawPort = process.env.PORT;
const parsedPort = parseInt(rawPort, 10);
const PORT = Number.isSafeInteger(parsedPort) && parsedPort > 0 ? parsedPort : 5000;
if (rawPort && PORT !== Number(rawPort)) {
  console.warn(`Invalid PORT="${rawPort}" — falling back to ${PORT}. Render sets PORT automatically; do not set PORT to a URL.`);
}

async function main() {
  // Every authed request throws a masked 500 without this — fail fast with
  // a clear message instead of a running-but-broken server.
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('JWT_SECRET must be set to a random string of at least 32 characters');
    process.exit(1);
  }
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`Caly AI API running on http://localhost:${PORT}`));
  // DB connects in the BACKGROUND: every /api router answers 503 'database
  // unavailable' until it lands (/health reports db:down), so a cold boot
  // serves a fast, retryable failure instead of a hung socket. Awaiting the
  // connect before listen left cold starts (Render sleep + Atlas TLS) burning
  // the app's whole timeout budget before the server answered anything.
  connectDb().then(
    () => console.log('MongoDB connected db:', require('mongoose').connection.name),
    (e) => {
      console.error('MongoDB connect failed:', e.message);
      console.warn('Running without DB — /health reports db:down, /api routes return 503 until it connects');
    }
  );
  // Email self-check (async, never blocks boot): a missing SMTP_HOST means
  // verification codes are console-logged, NOT sent — scream about it here
  // so Render logs show the misconfiguration instead of silent no-delivery.
  // Otherwise verify the relay credentials before the first user registers.
  const { getTransporter, classifyMailError, validateSmtpConfig } = require('./services/mailer');
  for (const problem of validateSmtpConfig()) {
    console.error(`SMTP config: ${problem}`);
  }
  if (!process.env.SMTP_HOST) {
    console.error('SMTP_HOST not set — verification emails will be console-logged, NOT sent. Set SMTP_HOST/PORT/USER/PASS on the host.');
  } else {
    getTransporter().verify().then(
      () => console.log('SMTP relay verified — verification emails can send'),
      (e) => console.error(`SMTP relay verify failed class=${classifyMailError(e)} code=${e.code || '-'}: ${e.message}`)
    );
  }
  function shutdown(signal) {
    console.log(`${signal} received — shutting down`);
    server.close(async () => {
      await disconnectDb().catch(() => {});
      process.exit(0);
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
main();
