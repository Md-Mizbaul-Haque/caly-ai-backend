const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { dbUp } = require('./config/db');
const { notFound, errorHandler } = require('./middleware/error');

const app = express();

app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);

app.use(helmet());
const corsOptions = process.env.CORS_ORIGINS
  ? { origin: process.env.CORS_ORIGINS.split(',').map(s => s.trim()) }
  : {};
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
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
app.use('/api/auth', authLimiter, require('./routes/auth.routes'));

app.use('/api/meals', require('./routes/meals.routes'));
app.use('/api/foods', require('./routes/foods.routes'));
app.use('/api/weights', require('./routes/weights.routes'));
app.use('/api/scan', require('./routes/scan.routes'));
app.use('/api/plan', require('./routes/plan.routes'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', db: dbUp() ? 'up' : 'down', uptime: Math.round(process.uptime()) });
});

app.get('/api', (req, res) => {
  res.json({ message: 'Caly AI API v1 - use /health for status' });
});

app.use(notFound);
app.use(errorHandler);

module.exports = app;
