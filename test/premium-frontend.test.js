import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
test('premium UI requires consent, escapes AI text and preserves idempotency on repeat requests',async()=>{
 const dom=new JSDOM(readFileSync('public/premium.html','utf8'),{url:'https://fixture.example',runScripts:'outside-only'}),{window}=dom,calls=[];
 window.fetch=async(path,options)=>{
  calls.push({path,options});
  const data=path==='/plans'?{plans:[{id:'free',monthlyUsd:0,dailyUnits:5,aiRequests:0},{id:'pro',monthlyUsd:9,dailyUnits:100,aiRequests:10}],sandboxAvailable:false}:path==='/billing/status'?{mode:'disabled',plan:'pro',state:'none',aiAvailable:true}:path.startsWith('/reports')?{reports:[{id:'507f1f77bcf86cd799439011',title:'<img src=x onerror=alert(1)>',snapshotStatus:'complete'}]}:{result:{notice:'Editorial',summary:'<script>bad()</script>',drafts:[{sourceIds:['e1'],text:'<img src=x onerror=alert(1)>'}],sources:[{id:'e1',observed:'Actual excerpt'}]}};
  return {ok:true,json:async()=>data};
 };
 try{
  window.eval(readFileSync('public/premium.js','utf8'));
  for(let i=0;i<30&&window.document.querySelectorAll('#aiReport option').length<2;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(window.document.querySelector('#planList button').disabled,true);
  window.document.getElementById('aiReport').value='507f1f77bcf86cd799439011';
  window.document.getElementById('aiGenerate').click();await new Promise(r=>setTimeout(r,5));
  assert.equal(calls.filter(x=>x.path==='/ai/drafts').length,0);
  window.document.getElementById('aiConsent').checked=true;
  for(let i=0;i<2;i++){window.document.getElementById('aiGenerate').click();await new Promise(r=>setTimeout(r,5));}
  const drafts=calls.filter(x=>x.path==='/ai/drafts');assert.equal(drafts.length,2);
  assert.equal(JSON.parse(drafts[0].options.body).requestKey,JSON.parse(drafts[1].options.body).requestKey);
  assert.equal(window.document.querySelector('#aiOutput img'),null);assert.equal(window.document.querySelector('#aiOutput script'),null);
  assert.match(window.document.getElementById('aiOutput').textContent,/Actual excerpt/);
 }finally{window.close();}
});
