const mongoose = require("mongoose");

// One goal weight per user.
const weightGoalSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    value: {
      type: Number,
      required: [true, "value is required"],
      min: 20,
      max: 1000,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("WeightGoal", weightGoalSchema);
