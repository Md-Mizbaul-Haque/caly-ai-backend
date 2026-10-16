const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { dbUp } = require('./config/db');
const { notFound, errorHandler } = require('./middleware/error');
const { requestIdMiddleware } = require('./utils/requestId');

const app = express();

app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
if (process.env.NODE_ENV === 'production' && process.env.TRUST_PROXY !== '1') {
  console.warn(
    '[config] TRUST_PROXY is not 1 in production — if this server sits behind a proxy ' +
    '(Render/Railway/Fly), every client shares one rate-limit bucket and one busy user ' +
    '429s everyone. Set TRUST_PROXY=1.'
  );
}

app.use(helmet());
const corsOptions = process.env.CORS_ORIGINS
  ? { origin: process.env.CORS_ORIGINS.split(',').map(s => s.trim()) }
  : {};
app.use(cors(corsOptions));
// JSON bodies are tiny by design (photos ride multipart, never base64 JSON).
app.use(express.json({ limit: '100kb' }));
app.use(requestIdMiddleware); // echo X-Request-Id (the app's Ref #) for log correlation
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.API_LIMIT) || 100,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_LIMIT) || 20,
  message: { error: 'Too many attempts, please try again later' },
});
// Credential endpoints only: these are the brute-forceable/abusable ones.
// GET /me and PUT /profile are JWT-authed and sit on the onboarding hot path
// (a wizard alone makes ~7 auth calls) — they stay on the general limiter.
const credentialPaths = [
  '/register', '/login', '/verify-email', '/resend-code',
  '/skip-verification', '/forgot-password', '/reset-password',
];
app.use(credentialPaths.map((p) => `/api/auth${p}`), authLimiter);
app.use('/api/auth', require('./routes/auth.routes'));

app.use('/api/meals', require('./routes/meals.routes'));
app.use('/api/favorites', require('./routes/favorites.routes'));
app.use('/api/foods', require('./routes/foods.routes'));
app.use('/api/weights', require('./routes/weights.routes'));
app.use('/api/scan', require('./routes/scan.routes'));
app.use('/api/plan', require('./routes/plan.routes'));
app.use('/api/support', require('./routes/support.routes'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', db: dbUp() ? 'up' : 'down', uptime: Math.round(process.uptime()) });
});

app.get('/api', (req, res) => {
  res.json({ message: 'Caly AI API v1 - use /health for status' });
});

app.use(notFound);
app.use(errorHandler);

module.exports = app;
