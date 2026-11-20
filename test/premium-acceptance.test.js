import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {premiumModels,Checkout,BillingEvent,Usage,AiJob,premiumHttp,reserveAi,effectivePremiumPlan} from '../lib/premium.js';
import {createReportSnapshot} from '../lib/report-storage.js';
const uri=process.env.TEST_MONGODB_URI;
test('sandbox subscriptions, owner-scoped AI and atomic global spending reservations', {skip:!uri},async()=>{
 assert.match(uri,/^mongodb:\/\/127\.0\.0\.1:27019\/seo_beta_acceptance(?:\?|$)/);
 Object.assign(process.env,{JWT_SECRET:crypto.randomBytes(32).toString('hex'),NODE_ENV:'test',LOG_LEVEL:'ERROR',APP_ORIGIN:'https://fixture.example',BILLING_MODE:'sandbox',PREMIUM_STORAGE_READY:'true',PADDLE_SANDBOX_API_KEY:'fixture-key',PADDLE_SANDBOX_CLIENT_TOKEN:'test_fixture',PADDLE_SANDBOX_WEBHOOK_SECRET:'fixture-webhook-secret-at-least20',PADDLE_PRO_PRICE_ID:'pri_'+'a'.repeat(26),PADDLE_AGENCY_PRICE_ID:'pri_'+'b'.repeat(26),AI_DRAFTS_ENABLED:'true',OPENROUTER_API_KEY:'fixture-no-live-requests',AI_DRAFT_MODEL:'openai/gpt-4.1-mini',AI_DRAFT_PROVIDER:'openai',AI_MONTHLY_BUDGET_USD:'10',AI_USER_MONTHLY_BUDGET_USD:'1',AI_MAX_REQUEST_USD:'0.01',AI_MAX_PROMPT_USD_PER_MILLION:'1',AI_MAX_COMPLETION_USD_PER_MILLION:'1'});
 delete process.env.MONGODB_URI;const api=await import('../server.js');await mongoose.connect(uri);
 for(const Model of premiumModels)await Model.createCollection();
 const original=premiumHttp.request;const calls=[];let failAi=false;
 const ids={sub:'sub_'+'a'.repeat(26),customer:'ctm_'+'a'.repeat(26),transaction:'txn_'+'a'.repeat(26)};
 let checkoutNonce;
 premiumHttp.request=async config=>{
  calls.push(config);
  if(config.url.includes('/prices/'))return {data:{data:{status:'active',unit_price:{amount:config.url.endsWith(process.env.PADDLE_AGENCY_PRICE_ID)?'1900':'900',currency_code:'USD'},billing_cycle:{interval:'month',frequency:1},trial_period:null}}};
  if(config.url.endsWith('/transactions')){checkoutNonce=config.data.custom_data.checkout_nonce;return {data:{data:{id:ids.transaction}}};}
  if(failAi)throw new Error('provider secret must not escape');
  return {data:{choices:[{message:{content:JSON.stringify({summary:'Observed title is missing.',drafts:[{sourceIds:['e1'],text:'A garden heading based on observed evidence.'}]})}}]}};
 };
 const server=api.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const users=[];let report;
 async function account(){const user=await api.User.create({email:`premium-${crypto.randomUUID()}@example.com`,passwordHash:'fixture-hash',apiKey:api.generateApiKey()});users.push(user);return user;}
 async function request(path,user,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{...(user?{Authorization:`Bearer ${api.signAuthToken(user)}`} : {}),...(body?{'Content-Type':'application/json',Origin:process.env.APP_ORIGIN}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
 async function webhook(event){const raw=JSON.stringify(event),ts=Math.floor(Date.now()/1000),sig=crypto.createHmac('sha256',process.env.PADDLE_SANDBOX_WEBHOOK_SECRET).update(ts+':'+raw).digest('hex');const r=await fetch(base+'/billing/webhook/paddle',{method:'POST',headers:{'Content-Type':'application/json','Paddle-Signature':`ts=${ts};h1=${sig}`},body:raw});return {status:r.status,data:await r.json()};}
 try{
  const owner=await account(),stranger=await account();
  assert.equal((await request('/billing/checkout',null,{plan:'pro'})).status,401);
  const checkout=await request('/billing/checkout',owner,{plan:'pro',price:1});assert.equal(checkout.status,200);assert.equal(checkout.data.mode,'sandbox');
  assert.equal((await request('/billing/checkout',owner,{plan:'pro'})).data.transactionId,ids.transaction);
  assert.equal(calls.filter(x=>x.url.endsWith('/transactions')).length,1);
  let event={event_id:'evt_'+'a'.repeat(26),event_type:'subscription.created',occurred_at:new Date(Date.now()-2000).toISOString(),data:{id:ids.sub,customer_id:ids.customer,status:'active',custom_data:{checkout_nonce:checkoutNonce},items:[{price:{id:process.env.PADDLE_PRO_PRICE_ID},quantity:1}],current_billing_period:{ends_at:new Date(Date.now()+86400000).toISOString()}}};
  assert.equal((await webhook(event)).status,200);assert.equal((await webhook(event)).status,200);assert.equal(await BillingEvent.countDocuments({_id:event.event_id}),1);
  const active=await api.User.findById(owner._id);assert.equal(effectivePremiumPlan(active),'pro');assert.equal(effectivePremiumPlan(active,Date.now()+2*86400000),'free');
  const stale={...event,event_id:'evt_'+'c'.repeat(26),occurred_at:new Date(Date.now()-5000).toISOString(),data:{...event.data,status:'canceled'}};assert.equal((await webhook(stale)).status,200);assert.equal(effectivePremiumPlan(await api.User.findById(owner._id)),'pro');
  assert.equal((await request('/billing/checkout',stranger,{plan:'agency'})).status,200);
  const rebound={...event,event_id:'evt_'+'e'.repeat(26),data:{...event.data,custom_data:{checkout_nonce:checkoutNonce},items:[{price:{id:process.env.PADDLE_AGENCY_PRICE_ID},quantity:1}]}};
  assert.equal((await webhook(rebound)).status,409);
  rebound.data.id='sub_'+'b'.repeat(26);
  assert.equal((await webhook(rebound)).status,409);assert.equal(effectivePremiumPlan(await api.User.findById(stranger._id)),'free');
  rebound.data.customer_id='ctm_'+'b'.repeat(26);
  assert.equal((await webhook(rebound)).status,200);assert.equal(effectivePremiumPlan(await api.User.findById(stranger._id)),'agency');
  report=await api.Report.create({userId:owner._id,url:'https://garden.example/',...createReportSnapshot({success:true,contentEvidence:{topic:'Garden',findings:[{code:'missingTitle',evidence:{observed:'Garden planting guide'}}]}})});
  const draft={reportId:String(report._id),kind:'explain',requestKey:crypto.randomUUID(),consent:true};
  assert.equal((await request('/ai/drafts',stranger,draft)).status,404);
  assert.equal((await request('/ai/drafts',owner,{...draft,consent:false})).status,400);
  const result=await request('/ai/drafts',owner,draft);assert.equal(result.status,200);assert.equal(result.data.result.editorialDraft,true);
  assert.equal((await request('/ai/drafts',owner,draft)).data.cached,true);assert.equal(calls.filter(x=>x.url.includes('openrouter')).length,1);
  assert.equal(calls.at(-1).data.provider.allow_fallbacks,false);assert.equal(calls.at(-1).data.provider.zdr,true);
  failAi=true;const failed=await request('/ai/drafts',owner,{...draft,requestKey:crypto.randomUUID()});assert.equal(failed.status,502);assert.doesNotMatch(JSON.stringify(failed.data),/provider secret/);
  const now=new Date('2037-01-01T00:00:00Z');await api.User.updateOne({_id:owner._id},{$set:{paidThrough:new Date('2038-01-01')}});
  await Usage.create([{_id:'2037-01:global',reservedMicroUsd:0,requests:0},{_id:'2037-01:'+owner._id,userId:owner._id,reservedMicroUsd:0,requests:0}]);
  const concurrent=await Promise.allSettled(Array.from({length:8},()=>reserveAi({User:api.User,user:active,reportId:report._id,kind:'rewrite',key:crypto.randomUUID(),amount:400000,config:{cap:1000000,perUser:1000000},now})));
  assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,2);const spent=await Usage.findById('2037-01:global');assert.equal(spent.reservedMicroUsd,800000);
  const canceled={...event,event_id:'evt_'+'d'.repeat(26),occurred_at:new Date().toISOString(),data:{...event.data,status:'canceled'}};assert.equal((await webhook(canceled)).status,200);assert.equal(effectivePremiumPlan(await api.User.findById(owner._id)),'free');
 }finally{
  premiumHttp.request=original;const userIds=users.map(x=>x._id);for(const Model of [api.User,api.Report,...premiumModels])await Model.deleteMany(Model===api.User?{_id:{$in:userIds}}:{userId:{$in:userIds}});
  await Usage.deleteMany({_id:{$in:[new Date().toISOString().slice(0,7)+':global','2037-01:global']}});
  await new Promise(r=>server.close(r));await mongoose.disconnect();
 }
});

test('accounts can still be deleted when premium is disabled and its collections do not exist', {skip:!uri},async()=>{
 assert.match(uri,/^mongodb:\/\/127\.0\.0\.1:27019\/seo_beta_acceptance(?:\?|$)/);
 process.env.PREMIUM_STORAGE_READY='false';process.env.BILLING_MODE='disabled';process.env.AI_DRAFTS_ENABLED='false';
 const fixture='seo_beta_premium_absent_'+crypto.randomBytes(6).toString('hex');
 const api=await import('../server.js');await mongoose.connect(uri.replace('/seo_beta_acceptance','/'+fixture));
 const password=crypto.randomBytes(16).toString('hex');
 const user=await api.User.create({email:'fixture@example.com',passwordHash:await api.hashPassword(password),apiKey:api.generateApiKey()});
 const server=api.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/auth/account`,{method:'DELETE',headers:{Authorization:`Bearer ${api.signAuthToken(user)}`,'Content-Type':'application/json',Origin:process.env.APP_ORIGIN},body:JSON.stringify({password,confirmation:'DELETE'})});
  assert.equal(response.status,200);assert.equal(await api.User.findById(user._id),null);
  assert.equal((await mongoose.connection.db.listCollections().toArray()).some(x=>x.name.startsWith('premium')),false);
 }finally{
  assert.match(mongoose.connection.name,/^seo_beta_premium_absent_[a-f0-9]{12}$/);await mongoose.connection.dropDatabase();
  await new Promise(r=>server.close(r));await mongoose.disconnect();
 }
});
