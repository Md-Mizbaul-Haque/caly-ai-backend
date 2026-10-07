require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');
const Meal = require('../src/models/Meal');
const Weight = require('../src/models/Weight');
const WeightGoal = require('../src/models/WeightGoal');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set');

  // Force correct database: caly-ai (fixes default "test" db when URI has no path)
  await mongoose.connect(uri, { dbName: 'caly-ai' });
  console.log('connected db:', mongoose.connection.name);

  const email = 'test@caly.ai';
  let user = await User.findOne({ email });
  if (user) {
    await Meal.deleteMany({ userId: user._id });
    await Weight.deleteMany({ userId: user._id });
    await WeightGoal.deleteMany({ userId: user._id });
    await User.deleteOne({ _id: user._id });
    console.log('cleared old test user');
  }

  const passwordHash = await bcrypt.hash('Test1234!', 10);
  user = await User.create({
    name: 'Test User',
    email,
    passwordHash,
    emailVerified: true,
    dailyGoalKcal: 2332,
    gender: 'male',
    birthDate: new Date(2008, 8, 29),
    heightCm: 173,
    weightKg: 70,
    targetWeightKg: 70,
    activityLevel: 'light',
    onboardingCompleted: true,
  });
  console.log('user:', user.email, user._id.toString());

  const now = new Date();
  const meals = await Meal.insertMany([
    { userId: user._id, name: 'Oatmeal', kcal: 350, protein: 12, carbs: 60, fat: 8, mealType: 'Breakfast', emoji: '🥣', loggedAt: now },
    { userId: user._id, name: 'Chicken Rice', kcal: 650, protein: 45, carbs: 70, fat: 15, mealType: 'Lunch', emoji: '🍗', loggedAt: now },
  ]);
  console.log('meals:', meals.length);

  const weights = await Weight.insertMany([
    { userId: user._id, value: 70.2, loggedAt: new Date(now.getTime() - 86400000) },
    { userId: user._id, value: 70, loggedAt: now },
  ]);
  console.log('weights:', weights.length);

  const goal = await WeightGoal.create({ userId: user._id, value: 70 });
  console.log('weightGoal:', goal.value);

  const cols = await mongoose.connection.db.listCollections().toArray();
  console.log('collections in', mongoose.connection.name + ':', cols.map((c) => c.name).sort().join(', '));

  await mongoose.disconnect();
  console.log('done — login with test@caly.ai / Test1234!');
}

main().catch((e) => { console.error(e); process.exit(1); });
