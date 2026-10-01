const mongoose = require('mongoose');

const weightSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    value: { type: Number, required: [true, 'value is required'], min: 20, max: 1000 },
    loggedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

weightSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Weight', weightSchema);
