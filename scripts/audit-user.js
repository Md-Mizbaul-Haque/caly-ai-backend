// Read-only account audit — NEVER writes. Usage: node scripts/audit-user.js [email]
// Prints profile completeness, stored calorie target, and what the app shows
// (meals/weights/goal) so demo/stale data can be told apart from real data.
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Meal = require('../src/models/Meal');
const Weight = require('../src/models/Weight');
const WeightGoal = require('../src/models/WeightGoal');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set');
  await mongoose.connect(uri, { dbName: process.env.MONGO_DB || 'caly-ai' });

  const filter = process.argv[2] ? { email: process.argv[2].toLowerCase().trim() } : {};
  const users = await User.find(filter).sort({ createdAt: 1 }).lean();
  console.log(`users: ${users.length}`);

  for (const u of users) {
    console.log('---');
    console.log(`email: ${u.email} | name: ${u.name || '?'} | verified: ${!!u.emailVerified} | onboarding: ${!!u.onboardingCompleted}`);
    console.log(`dailyGoalKcal: ${u.dailyGoalKcal}`);
    const profile = {
      gender: u.gender, birthDate: u.birthDate, heightCm: u.heightCm,
      weightKg: u.weightKg, targetWeightKg: u.targetWeightKg, activityLevel: u.activityLevel,
    };
    console.log('profile:', JSON.stringify(profile));
    console.log(`goalPace: ${u.goalPace || '-'} | timezone: ${u.timezone || '-'}`);
    const [mealCount, weightCount] = await Promise.all([
      Meal.countDocuments({ userId: u._id }),
      Weight.countDocuments({ userId: u._id }),
    ]);
    const wg = await WeightGoal.findOne({ userId: u._id }).lean();
    console.log(`meals: ${mealCount} | weights: ${weightCount} | weightGoal: ${wg ? wg.value : null}`);
    const meals = await Meal.find({ userId: u._id }).sort({ loggedAt: -1 }).limit(10).lean();
    for (const m of meals) {
      console.log(`  meal: ${m.name} | ${m.kcal} kcal | P${m.protein} C${m.carbs} F${m.fat} | ${m.mealType || '?'} | ${m.loggedAt ? new Date(m.loggedAt).toISOString() : '?'}`);
    }
    const weights = await Weight.find({ userId: u._id }).sort({ loggedAt: -1 }).limit(10).lean();
    for (const w of weights) {
      console.log(`  weight: ${w.value} lbs | ${w.loggedAt ? new Date(w.loggedAt).toISOString() : '?'}`);
    }
    if (u.email === 'test@caly.ai') console.log('FLAG: seed test account present in this DB');
    const placeholders = await Meal.countDocuments({ userId: u._id, name: 'Scanned meal' });
    if (placeholders > 0) console.log(`FLAG: ${placeholders} placeholder scan meal(s) saved in log`);
  }

  await mongoose.disconnect();
  console.log('done (read-only — nothing written)');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
