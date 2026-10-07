require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Meal = require('../src/models/Meal');
const Weight = require('../src/models/Weight');
const WeightGoal = require('../src/models/WeightGoal');

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB || 'caly-ai' });
  console.log('connected db:', mongoose.connection.name);

  const email = 'test@caly.ai';
  const user = await User.findOne({ email });
  if (!user) {
    console.log('no test user found');
  } else {
    const meals = await Meal.deleteMany({ userId: user._id });
    const weights = await Weight.deleteMany({ userId: user._id });
    const goals = await WeightGoal.deleteMany({ userId: user._id });
    await User.deleteOne({ _id: user._id });
    console.log(`removed user ${email}`, { meals: meals.deletedCount, weights: weights.deletedCount, goals: goals.deletedCount });
  }

  const remaining = await User.countDocuments({ email });
  console.log('remaining test users:', remaining);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
