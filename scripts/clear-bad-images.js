require('dotenv').config();
const mongoose = require('mongoose');

// Docs whose saved image was audited as wrong — cleared for reprocessing
// with the improved matcher (SKIP_WIKI/QUALIFIERS/DENY fixes).
const BAD = [
  /fish, tuna, light/i, // -> Water
  /ketchup, restaurant/i, // -> Restaurant
  /pork, cured, bacon, cooked/i, // -> Restaurant
  /^peanuts$/i, // -> The Peanuts (comic)
  /^orange, raw$/i, // -> Orange County, California
  /turkey sandwich on wheat/i, // -> Wheat
  /beef taco filling/i, // -> Tomato
  /soup, ramen noodle/i, // -> Water
  /oatmeal, multigrain/i, // -> Multigrain bread
  /cheese, ricotta/i, // -> Milk (want Ricotta)
  /potato pancakes/i,
  /crackers, saltines \(includes/i,
  /protein bar/i,
  /protein powder whey/i,
  /bagel chips/i,
  /cheese, cottage/i, // -> Cottage (house!)
  /sugar, white, granulated/i, // -> White (color swatch)
  /tea, hot, leaf, black/i, // -> Leaf
  /wine, red/i, // -> Wine red (color swatch)
];

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB || 'caly-ai' });
  const Food = require('../src/models/Food');
  const all = await Food.find({ imageUrl: { $ne: null } }).lean();
  const bad = all.filter((d) => BAD.some((re) => re.test(d.name)));
  console.log(
    'clearing:',
    bad.map((d) => `${d.fdcId} ${d.name}`),
  );
  for (const d of bad) {
    await Food.updateOne({ _id: d._id }, { $set: { imageUrl: null } });
  }
  console.log(`cleared ${bad.length} docs for reprocessing`);
  await mongoose.disconnect();
})();
