import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { crawlerPolicyMatrix, analyzePageEvidence } from '../lib/evidence.js';

test('AI search and training opt-outs stay independent and path-specific', () => {
  const raw = 'User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /\nUser-agent: OAI-SearchBot\nDisallow: /private\nAllow: /private/public\n';
  const report = crawlerPolicyMatrix('https://example.com/private/public', {available:true, found:true, raw});
  const policy = name => report.bots.find(b=>b.agent===name).policy;
  assert.equal(policy('GPTBot'), 'disallowed');
  assert.equal(policy('OAI-SearchBot'), 'allowed');
  assert.match(report.bots.find(b=>b.agent==='ChatGPT-User').note, /may not follow/);
  assert.match(report.bots.find(b=>b.agent==='Google-Extended').note, /not a separate/);
  assert.equal(crawlerPolicyMatrix('https://example.com', {available:false}).bots[0].policy, 'unknown');
  assert.equal(crawlerPolicyMatrix('https://example.com', {available:true,found:false,status:404}).bots[0].policy, 'allowed');
});

test('policy analysis uses rules beyond the old 2000-character preview', () => {
  const raw = '# padding\n'.repeat(400) + 'User-agent: OAI-SearchBot\nDisallow: /';
  assert.equal(crawlerPolicyMatrix('https://example.com', {available:true,found:true,raw}).bots[0].policy,'disallowed');
});

test('multilingual evidence finds actual syntax issues without guessing a language or remote targets', () => {
  const $=cheerio.load('<html lang="ur"><head><link rel="alternate" hreflang="ur-PK" href="/ur"><link rel="alternate" hreflang="ur-PK" href="/other"><link rel="alternate" hreflang="bad_tag" href="javascript:alert(1)"><link rel="canonical" href="https://other.example/a"></head><body><h2>سوال؟</h2><p>یہ ایک واضح جواب ہے۔</p></body></html>');
  const report=analyzePageEvidence($,{resolvedUrl:'https://example.com/ur',language:'ur',visibleText:'یہ ایک واضح جواب ہے۔',robots:'noindex'}, {available:false});
  assert.equal(report.locale.rtlReviewSuggested,true);
  assert.equal(report.locale.languageDetectedFromScript,false);
  assert.equal(report.canonical.targetVerified,false);
  for(const check of ['RTL direction','Duplicate hreflang','Hreflang syntax','Cross-origin canonical','Indexing restriction']) assert.ok(report.findings.some(f=>f.check===check),check);
  assert.equal(report.answerBlocks[0].excerpt,'یہ ایک واضح جواب ہے۔');
  assert.equal(report.alternates[2].url,null);
  assert.deepEqual(report,analyzePageEvidence($,{resolvedUrl:'https://example.com/ur',language:'ur',visibleText:'یہ ایک واضح جواب ہے۔',robots:'noindex'}, {available:false}));
});

test('single-language page does not fail for absent hreflang or missing author applicability', () => {
  const $=cheerio.load('<html lang="en"><body><h2>Opening hours</h2><p>We open at nine.</p></body></html>');
  const report=analyzePageEvidence($,{resolvedUrl:'https://example.com',language:'en',visibleText:'We open at nine.'},{available:false});
  assert.equal(report.alternates.length,0);
  assert.equal(report.findings.some(f=>f.check==='RTL direction' || f.check==='Hreflang syntax'),false);
  assert.match(report.findings.find(f=>f.check==='Attribution').action,/may not apply/);
});
