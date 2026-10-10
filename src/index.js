require('dotenv').config();
const app = require('./app');
const { connectDb, disconnectDb } = require('./config/db');

const PORT = process.env.PORT || 5000;

async function main() {
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
