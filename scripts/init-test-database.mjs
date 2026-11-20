import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const uri = process.env.TEST_MONGODB_URI;
assert.match(uri || '', /^mongodb:\/\/127\.0\.0\.1:27019\/seo_beta_acceptance(?:\?|$)/);
try {
  await mongoose.connect('mongodb://127.0.0.1:27019/admin?directConnection=true', { serverSelectionTimeoutMS: 15000 });
  try {
    await mongoose.connection.db.admin().command({ replSetInitiate: { _id: 'beta-test', members: [{ _id: 0, host: '127.0.0.1:27019' }] } });
  } catch (error) { if (error.code !== 23) throw error; }
  for (let attempt = 0; attempt < 30; attempt++) {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (hello.isWritablePrimary) { console.log('Isolated acceptance replica set is ready.'); break; }
    if (attempt === 29) throw new Error('Test replica set did not become writable');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} finally { await mongoose.disconnect(); }
