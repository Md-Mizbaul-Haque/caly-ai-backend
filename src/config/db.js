const mongoose = require('mongoose');
const { AppError } = require('../utils/AppError');

async function connectDb() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set — see .env.example');
  await mongoose.connect(uri, { dbName: process.env.MONGO_DB || 'caly-ai' });
}

async function disconnectDb() {
  await mongoose.disconnect();
}

function dbUp() {
  return mongoose.connection.readyState === 1;
}

function assertDbUp() {
  if (!dbUp()) throw new AppError(503, 'Database unavailable');
}

module.exports = { connectDb, disconnectDb, dbUp, assertDbUp };
