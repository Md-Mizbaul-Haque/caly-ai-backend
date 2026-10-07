require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI not set');
  const conn = await mongoose.createConnection(process.env.MONGO_URI, { dbName: 'test' }).asPromise();
  try {
    const cols = await conn.db.listCollections().toArray();
    console.log('test collections before:', cols.map((c) => c.name).sort().join(', ') || '(none)');
    for (const c of cols) {
      const r = await conn.db.collection(c.name).deleteMany({});
      console.log(`cleared ${c.name}: ${r.deletedCount}`);
    }
  } finally {
    await conn.close();
  }
  console.log('test db wiped (database kept, all documents removed)');
}
main().catch((e) => { console.error(e); process.exit(1); });
