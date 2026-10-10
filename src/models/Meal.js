const mongoose = require("mongoose");

const mealSchema = new mongoose.Schema(
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
    mealType: {
      type: String,
      enum: ["Breakfast", "Lunch", "Dinner", "Snack"],
      default: "Snack",
    },
    emoji: { type: String, default: "🍽️" },
    imageUrl: { type: String, maxlength: 2000 },
    loggedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

// Every range query filters one owner's docs by day window, so the
// compound index (not the two single-field ones) serves them.
mealSchema.index({ userId: 1, loggedAt: 1 });

mealSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Meal", mealSchema);
