const mongoose = require('mongoose');

// Holds a registration between "user tapped Register" and "user proved the
// mailbox". No User row exists until verify-email or skip-verification.
// Stale pendings self-delete via the expiresAt TTL index.
const pendingSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'name is required'], trim: true, maxlength: 80 },
    email: {
      type: String,
      required: [true, 'email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email is invalid'],
    },
    passwordHash: { type: String, required: true },
    codeHash: { type: String, default: null },
    codeExpiresAt: { type: Date, default: null },
    codeAttempts: { type: Number, default: 0 },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 3600 * 1000),
      index: { expires: 0 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PendingRegistration', pendingSchema);
