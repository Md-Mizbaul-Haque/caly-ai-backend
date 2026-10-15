const mongoose = require("mongoose");

const favoriteSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "name is required"],
      trim: true,
      maxlength: 120,
    },
    kcal: {
      type: Number,
      required: [true, "kcal is required"],
      min: 0,
      max: 10000,
    },
    protein: { type: Number, default: 0, min: 0 },
    carbs: { type: Number, default: 0, min: 0 },
    fat: { type: Number, default: 0, min: 0 },
    imageUrl: { type: String, maxlength: 2000 },
  },
  { timestamps: true },
);

// Every read is "this user's favorites, newest first" — the compound index
// (not the single-field one) serves both the filter and the sort.
favoriteSchema.index({ userId: 1, createdAt: -1 });

favoriteSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Favorite", favoriteSchema);
