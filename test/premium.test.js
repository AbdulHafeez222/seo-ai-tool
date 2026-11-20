import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyPaddle,validateDraft,aiSources,aiConfig,billingConfig } from '../lib/premium.js';
test('Paddle signatures bind raw bytes and reject stale, future or ambiguous timestamps',()=>{
 const raw=Buffer.from('{"event":"fixture"}'),secret='fixture-signing-secret';const now=Date.now(),ts=Math.floor(now/1000);
 const h1=crypto.createHmac('sha256',secret).update(ts+':').update(raw).digest('hex');
 assert.equal(verifyPaddle(raw,`ts=${ts};h1=${h1}`,secret,now),true);
 assert.equal(verifyPaddle(Buffer.from(raw+' '),`ts=${ts};h1=${h1}`,secret,now),false);
 assert.equal(verifyPaddle(raw,`ts=${ts};h1=${h1}`,secret,now+6000),false);
 assert.equal(verifyPaddle(raw,`ts=${ts};h1=${h1}`,secret,now-6000),false);
 assert.equal(verifyPaddle(raw,`ts=${ts};ts=${ts};h1=${h1}`,secret,now),false);
});
test('AI inputs exclude Google/account fields and outputs require real source references',()=>{
 const sources=aiSources({apiKey:'private-key',gscGrant:'private-token',performanceCurrent:'private-query',contentEvidence:{topic:'Garden',findings:[{evidence:{observed:'Observed rose heading'}}]}});
 assert.doesNotMatch(JSON.stringify(sources),/private/);
 assert.throws(()=>validateDraft({summary:'Unsupported',drafts:[{sourceIds:['invented'],text:'Draft'}]},sources));
 assert.throws(()=>validateDraft({summary:'Unsupported',drafts:[],score:99},sources));
 const result=validateDraft({summary:'Editorial',drafts:[{sourceIds:['e1'],text:'Rose heading'}]},sources);assert.equal(result.editorialDraft,true);
});
test('live billing and missing budgets cannot enable charges even when a key is present',()=>{
 process.env.BILLING_MODE='live';process.env.PREMIUM_STORAGE_READY='true';process.env.AI_DRAFTS_ENABLED='true';process.env.OPENROUTER_API_KEY='fixture';
 assert.equal(billingConfig(),null);assert.equal(aiConfig(),null);
 process.env.AI_MONTHLY_BUDGET_USD='100';assert.equal(aiConfig(),null);
 delete process.env.BILLING_MODE;delete process.env.AI_DRAFTS_ENABLED;delete process.env.PREMIUM_STORAGE_READY;
});
