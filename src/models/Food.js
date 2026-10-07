const mongoose = require('mongoose');

const foodSchema = new mongoose.Schema(
  {
    fdcId: { type: Number, required: [true, 'fdcId is required'], unique: true, index: true },
    name: { type: String, required: [true, 'name is required'], trim: true, maxlength: 200 },
    dataType: {
      type: String,
      enum: ['Foundation', 'SR Legacy', 'Survey (FNDDS)', 'Branded', 'Experimental'],
      default: 'Foundation',
    },
    kcal: { type: Number, required: [true, 'kcal is required'], min: 0, max: 10000 },
    protein: { type: Number, default: 0, min: 0 },
    carbs: { type: Number, default: 0, min: 0 },
    fat: { type: Number, default: 0, min: 0 },
    fiber: { type: Number, default: 0, min: 0 },
    sugar: { type: Number, default: 0, min: 0 },
    servingGram: { type: Number, default: 100, min: 0 },
    servingUnit: { type: String, default: 'g', maxlength: 20 },
    brand: { type: String, default: null, maxlength: 200 },
    gtinUpc: { type: String, default: null },
    imageUrl: { type: String, default: null, maxlength: 2000 },
    source: { type: String, default: 'FDC', maxlength: 60 },
  },
  { timestamps: true },
);

foodSchema.index({ name: 'text' });

foodSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Food', foodSchema);
