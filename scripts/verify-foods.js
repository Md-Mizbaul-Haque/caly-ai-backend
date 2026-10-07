require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB || 'caly-ai' });
  const Food = require('../src/models/Food');
  const total = await Food.countDocuments();
  const byType = await Food.aggregate([{ $group: { _id: '$dataType', n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
  console.log('total:', total);
  console.log('byType:', JSON.stringify(byType));
  const s = await Food.find({ $text: { $search: 'chicken' } }, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(3)
    .lean();
  console.log('search chicken:', s.map((d) => `${d.name} (${d.kcal}kcal)`));
  const stats = await mongoose.connection.db.stats();
  console.log('db dataSize KB:', Math.round(stats.dataSize / 1024));
  await mongoose.disconnect();
})();
