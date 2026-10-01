const mongoose = require('mongoose');

const CODE_TTL_MINUTES = 10;

const userSchema = new mongoose.Schema(
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
    emailVerified: { type: Boolean, default: false },
    dailyGoalKcal: { type: Number, default: 2000, min: 500, max: 10000 },
    verifyCodeHash: { type: String, default: null },
    verifyCodeExpiresAt: { type: Date, default: null },
    verifyCodeAttempts: { type: Number, default: 0 },
    resetCodeHash: { type: String, default: null },
    resetCodeExpiresAt: { type: Date, default: null },
    resetCodeAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    delete ret.verifyCodeHash;
    delete ret.verifyCodeExpiresAt;
    delete ret.verifyCodeAttempts;
    delete ret.resetCodeHash;
    delete ret.resetCodeExpiresAt;
    delete ret.resetCodeAttempts;
    return ret;
  },
});

userSchema.methods.clearVerifyCode = function () {
  this.verifyCodeHash = null;
  this.verifyCodeExpiresAt = null;
  this.verifyCodeAttempts = 0;
};

userSchema.methods.clearResetCode = function () {
  this.resetCodeHash = null;
  this.resetCodeExpiresAt = null;
  this.resetCodeAttempts = 0;
};

module.exports = mongoose.model('User', userSchema);
module.exports.CODE_TTL_MINUTES = CODE_TTL_MINUTES;
