const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { dbUp } = require('./config/db');
const { notFound, errorHandler } = require('./middleware/error');
const { requestIdMiddleware } = require('./utils/requestId');

const app = express();

// Production deploy target (Render/Railway/Fly) sits behind exactly one
// proxy hop: without `trust proxy` every user shares the proxy's IP and one
// bucket, so a busy minute 429s the whole user base. Default to 1 in
// production; set TRUST_PROXY=0 explicitly for a directly-exposed server.
const trustProxyEnv = process.env.TRUST_PROXY;
const trustProxy = trustProxyEnv
  ? Number(trustProxyEnv)
  : (process.env.NODE_ENV === 'production' ? 1 : false);
app.set('trust proxy', Number.isNaN(trustProxy) ? false : trustProxy);

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
  // Mobile carriers CGNAT thousands of users per IP; a per-IP bucket must be
  // generous or real users 429 through no fault of their own.
  limit: Number(process.env.API_LIMIT) || 600,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_LIMIT) || 50,
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
  const { getMailStatus } = require('./services/mailer');
  res.json({ status: 'ok', db: dbUp() ? 'up' : 'down', uptime: Math.round(process.uptime()), smtp: getMailStatus() });
});

app.get('/api', (req, res) => {
  res.json({ message: 'Caly AI API v1 - use /health for status' });
});

app.use(notFound);
app.use(errorHandler);

module.exports = app;
