require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB || 'caly-ai' });
  const Food = require('../src/models/Food');
  const withImg = await Food.countDocuments({ imageUrl: { $ne: null } });
  const missing = await Food.countDocuments({ $or: [{ imageUrl: null }, { imageUrl: '' }] });
  const cloud = await Food.countDocuments({ imageUrl: /^https:\/\/res\.cloudinary\.com\// });
  console.log('with images:', withImg, '| missing:', missing, '| cloudinary-hosted:', cloud);
  const sample = await Food.find({ imageUrl: { $ne: null } })
    .sort({ fdcId: -1 })
    .limit(5)
    .lean();
  sample.forEach((d) => console.log('-', d.name, '->', d.imageUrl.slice(0, 90)));
  await mongoose.disconnect();
})();
