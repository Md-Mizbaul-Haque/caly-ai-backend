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
  try {
    await connectDb();
    console.log('MongoDB connected db:', require('mongoose').connection.name);
  } catch (e) {
    console.error('MongoDB connect failed:', e.message);
    console.warn('Continuing without DB — /health reports db:down, /api routes return 503');
  }
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`Caly AI API running on http://localhost:${PORT}`));
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
