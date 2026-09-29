require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'caly-ai-backend' });
});

// TODO: routes
// app.use('/api/auth', require('./routes/auth.routes'));
// app.use('/api/meals', require('./routes/meals.routes'));
// app.use('/api/scan', require('./routes/scan.routes'));
// app.use('/api/goals', require('./routes/goals.routes'));

app.get('/api', (req, res) => {
  res.json({ message: 'Caly AI API v1 - use /health for status' });
});

// DB + Start (don't crash if MONGO_URI missing during scaffold)
const MONGO_URI = process.env.MONGO_URI;
if (MONGO_URI) {
  mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch((e) => console.error('Mongo error', e.message));
} else {
  console.log('MONGO_URI not set - skipping DB connect (see .env.example)');
}

app.listen(PORT, () => console.log(`Caly AI API running on http://localhost:${PORT}`));
