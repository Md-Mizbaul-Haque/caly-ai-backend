require('dotenv').config();
const mongoose = require('mongoose');

async function countIn(dbName) {
  const conn = await mongoose.createConnection(process.env.MONGO_URI, { dbName }).asPromise();
  try {
    const users = await conn.db.collection('users').countDocuments();
    const pendings = await conn.db.collection('pendingregistrations').countDocuments().catch(() => 0);
    const meals = await conn.db.collection('meals').countDocuments().catch(() => 0);
    const sample = await conn.db.collection('users').find({}, { projection: { email: 1 } }).limit(5).toArray();
    console.log(`db=${dbName} users=${users} pendings=${pendings} meals=${meals} emails=[${sample.map((u) => u.email).join(', ')}]`);
  } finally {
    await conn.close();
  }
}



(async () => {
  await countIn('caly-ai');
  await countIn('test');
})().catch((e) => { console.error(e.message); process.exit(1); });










