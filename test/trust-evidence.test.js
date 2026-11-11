import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import axios from 'axios';
import {observeTrustEvidence} from '../lib/trust-evidence.js';
import {getAIReport,getAISearchSimulation,generateSchemaCode} from '../aiService.js';
process.env.JWT_SECRET='test-only-secret-with-more-than-32-characters';
delete process.env.MONGODB_URI;
const {extractPageData,analyzeEEATAdvanced,calculateLocalSeoScore,scanDynamicTrustSignals}=await import('../server.js');
function page(html){const $=cheerio.load(html);return {$,data:extractPageData($,html,'https://example.com/page')};}

test('numeric strings and generic address text do not turn an informational page into a local business',()=>{
  const {$,data}=page('<html lang="en"><body><h1>Addressing a software issue</h1><p>Error 12345, address 54321, a five-digit result. Not a local business.</p></body></html>');
  const local=calculateLocalSeoScore(data,data.schema);
  assert.equal(local.applicable,false);assert.equal(local.score,null);assert.ok(local.metrics.every(x=>x.weight===0&&x.passed===null));
  assert.equal(data.trustEvidence.localApplicable,false);
  const trust=scanDynamicTrustSignals($,'',data.resolvedUrl,data);
  assert.equal(trust.metrics.find(x=>x.metric==='Declared Business Contact Tuple').passed,null);
});
test('author attribution applies to declared authored content, not every homepage',()=>{
  for(const [types,expected] of [[[],null],[['Article'],false]]) {
    const {$,data}=page(`<html lang="ur"><head><script type="application/ld+json">${JSON.stringify({'@type':types})}</script><meta name="author" content=""></head><body><h1>صفحہ</h1></body></html>`);
    const result=analyzeEEATAdvanced($,data.visibleText,data);
    assert.equal(result.metrics.find(x=>x.metric==='Author Attribution').passed,expected);
    assert.equal(result.independentlyVerified,false);
    assert.doesNotMatch(result.status,/Enterprise Ready|Verified Authority/);
  }
});
test('Urdu, Pashto and Arabic policy links are observed without requiring English paths',()=>{
  for(const [label,path] of [['رازداری','رازداری'],['د محرمیت تګلاره','محرمیت'],['سياسة الخصوصية','الخصوصية']]) {
    const {$,data}=page(`<html><body><a href="/${path}">${label}</a><a href="/رابطہ">رابطہ کریں</a></body></html>`);
    assert.equal(data.trustEvidence.roleLinks.privacy.length,1);
    assert.equal(data.trustEvidence.roleLinks.privacy[0].verified,false);
    const eeat=analyzeEEATAdvanced($,data.visibleText,data);
    assert.equal(eeat.auditMetrics.hasPrivacy,true);assert.equal(eeat.auditMetrics.hasContact,true);
  }
});
test('NAP observations must belong to one declared business and never imply external consistency',()=>{
  const businesses=[{'@type':'LocalBusiness',name:'A',telephone:'+92 1234567'},{'@type':'LocalBusiness',name:'B',address:{streetAddress:'A street'}}];
  const split=page(`<html><script type="application/ld+json">${JSON.stringify(businesses)}</script><body></body></html>`);
  assert.ok(split.data.trustEvidence.localBusinesses.every(x=>!x.completeContactTuple));
  assert.equal(calculateLocalSeoScore(split.data,split.data.schema).metrics[0].passed,false);
  const complete=page('<html><script type="application/ld+json">{"@type":"Restaurant","name":"مقامی دکان","telephone":"+92 1234567","address":{"streetAddress":"گلی 1","addressLocality":"شہر"},"openingHoursSpecification":{}}</script><body></body></html>');
  const result=calculateLocalSeoScore(complete.data,complete.data.schema);
  assert.equal(result.applicable,true);assert.equal(result.metrics[0].passed,true);assert.equal(result.consistencyVerified,false);
  assert.equal(result.metrics.find(x=>x.metric==='Opening Hours').passed,null);
  const reference=page('<html><script type="application/ld+json">{"@type":"LocalBusiness","name":"A","telephone":"12345678","address":{"@id":"#address"}}</script><body></body></html>');
  assert.equal(calculateLocalSeoScore(reference.data,reference.data.schema).metrics[0].passed,null);

});
test('hostname/query substrings cannot fake social, map, external-reference or policy evidence',()=>{
  const {$,data}=page('<html><body><a href="https://example.com.evil.net/">external</a><a href="https://evil.net/?site=example.com&policy=privacy">unrelated</a><a href="https://notfacebook.com/">social</a><a href="https://evil.net/?next=google.com/maps">map</a><a href="https://www.linkedin.com/company/example">company</a></body></html>');
  const e=observeTrustEvidence($,data);
  assert.equal(e.externalLinks.length,5);assert.equal(e.socialLinks.length,1);assert.equal(e.mapLinks.length,0);
  assert.equal(e.roleLinks.privacy.length,0);assert.equal(data.mapDetected,false);
  const embed=page('<html><body><iframe src="https://www.google.com/maps/embed?example=1"></iframe></body></html>');
  assert.equal(embed.data.mapDetected,true);

});
test('legacy AI exports cannot call paid models even if provider environment flags or credentials are set',async()=>{
  const post=axios.post;let calls=0;
  const before=process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY='test-only-not-a-real-key';
  axios.post=async()=>{calls++;throw new Error('No network allowed');};
  try {
    assert.match(await getAIReport({}),/free-only/);
    assert.match(await getAISearchSimulation({url:'https://example.com'}),/No external model/);
    const draft=JSON.parse(await generateSchemaCode('FAQ',{title:'Observed question'}));
    assert.equal(draft['@type'],'FAQPage');assert.equal(draft.name,'Observed question');assert.equal(calls,0);
    assert.equal(draft.mainEntity,undefined);
  }finally{axios.post=post;if(before===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=before;}
});
