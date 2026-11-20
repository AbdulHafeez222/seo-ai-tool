// Operator-run additive setup. Never imports server.js or enables paid features.
import mongoose from 'mongoose';
import {premiumModels} from '../lib/premium.js';
if(process.env.PREMIUM_SETUP_CONFIRM!=='CREATE_PREMIUM_COLLECTIONS'||!process.env.PREMIUM_SETUP_MONGODB_URI){
 console.error('Set PREMIUM_SETUP_MONGODB_URI securely and PREMIUM_SETUP_CONFIRM=CREATE_PREMIUM_COLLECTIONS after reviewing docs/PREMIUM_SETUP.md.');process.exit(1);
}
try{
 // One serial catalog/index setup, not the application pool. Two connections
 // suffice; a 10s selection/connect bound fails promptly on bad operator access.
 await mongoose.connect(process.env.PREMIUM_SETUP_MONGODB_URI,{autoCreate:false,autoIndex:false,maxPoolSize:2,serverSelectionTimeoutMS:10000,connectTimeoutMS:10000});
 for(const Model of premiumModels){
  try{await Model.createCollection();}catch(error){if(error.code!==48)throw error;}
  await Model.collection.createIndex({userId:1},{name:'premium_owner'});
  console.log(Model.collection.name+': collection and owner index ready');
 }
 console.log('Premium storage prepared. No user records, entitlements or feature flags changed. Review connection use during setup; this process now closes its pool.');
}catch{console.error('Premium setup failed. Check operator permissions and existing index definitions; credential details are intentionally omitted.');process.exitCode=1;}
finally{await mongoose.disconnect();}
