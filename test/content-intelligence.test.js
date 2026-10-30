import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {analyzeContentEvidence,keywordEvidence,languageProfile,lexicalSignals,includesTerm} from '../lib/content-intelligence.js';
process.env.JWT_SECRET='test-only-secret-with-more-than-32-characters';
delete process.env.MONGODB_URI;
const server=await import('../server.js');

function extract(html,url='https://example.com/guide') {const $=cheerio.load(html);return server.extractPageData($,html,url);}
test('English, Urdu, Pashto and Arabic use actual adjacent answers and never English calibration on RTL content',()=>{
  for(const [lang,q,a] of [['en','How do I grow roses?','Use a suitable pot and check the soil before watering.'],['ur','گلاب کیسے لگائیں؟','گلاب کے لیے مناسب مٹی اور پانی کا انتظام کریں۔'],['ps','ګلاب څنګه وکرو؟','د ګلاب لپاره مناسبه خاوره او اوبه برابرې کړئ.'],['ar','كيف نزرع الورد؟','اختر التربة المناسبة ثم اسق النبات عند الحاجة.']]) {
    const page=extract(`<html lang="${lang}"><body><main><h1>${q}</h1><h2>${q}</h2><p>${a}</p><h2>${q}</h2><div>Unrelated wrapper</div></main></body></html>`);
    assert.equal(page.contentEvidence.locale.base,lang);
    assert.equal(page.contentEvidence.answers[0].question,true);
    assert.equal(page.contentEvidence.answers[0].answerObserved,true);
    assert.equal(page.contentEvidence.answers[1].answerObserved,false);
    const audit=server.calculateDynamicAeoScore(page,page.visibleText);
    assert.equal(audit.structuralAeoMetrics.hasDirectAnswer,true);
    assert.equal(audit.metrics.find(x=>x.metric==='FAQ Schema').passed,null);
    if(lang!=='en') {assert.equal(audit.readabilityScore,null);assert.equal(audit.metrics.find(x=>x.metric==='Answer Length Calibration').weight,0);}
    assert.ok(page.contentEvidence.findings.some(x=>x.code==='answerHeading'&&x.params.heading===q));
    assert.equal(page.contentEvidence.provider.used,false);
  }
});
test('long text with a remote question no longer fabricates a direct-answer block',()=>{
  const page=extract(`<html lang="en"><body><main><h1>Roses</h1><p>What is a rose? ${'This is background text. '.repeat(80)}</p><h2>Care</h2><p>Details.</p></main></body></html>`);
  assert.equal(server.calculateDynamicAeoScore(page,page.visibleText).structuralAeoMetrics.hasDirectAnswer,false);
});
test('unknown and invalid languages remain unknown; phrase boundaries reject substring matches',()=>{
  assert.equal(languageProfile('', 'یہ اردو کی مثال ہے').base,null);
  assert.equal(languageProfile('', 'Bonjour le monde').base,null);
  assert.equal(languageProfile('invalid_tag!', 'English text').supported,false);
  assert.equal(lexicalSignals('ja','日本語です').available,false);
  assert.equal(includesTerm('somewhat costly','what'),false);
  assert.equal(includesTerm('یہ طریقہ ہے','طریقہ'),true);
  assert.deepEqual(keywordEvidence('اور اور گلاب گلاب پانی','ur').terms.slice(0,2),[{term:'گلاب',count:2},{term:'پانی',count:1}]);
  assert.ok(keywordEvidence('搜索引擎优化内容测试','zh').terms.length>1);
});
test('competitor lexical gaps are withheld across languages instead of treating translation as missing topics',()=>{
  const a={seoScore:60,keywords:['roses'],h2s:['Growing roses'],entities:['Rose Studio'],schema:{detectedTypes:[]},contentEvidence:{locale:{base:'en'}}};
  const b={seoScore:60,keywords:['گلاب'],h2s:['گلاب لگانا'],entities:['باغبانی'],schema:{detectedTypes:['Article']},contentEvidence:{locale:{base:'ur'}}};
  const gaps=server.compareTargetToCompetitor(a,b).gaps;
  assert.equal(gaps.contentComparison.available,false);
  assert.deepEqual(gaps.keywordGaps,[]);assert.deepEqual(gaps.headingGaps,[]);assert.deepEqual(gaps.entityGaps,[]);
  assert.deepEqual(gaps.schemaGaps,['Article']);
});
test('content briefs use observed copy and never invent a universal word target or FAQ requirement',()=>{
  const page=extract('<html lang="ur"><body><main><h1>باغبانی</h1><h2>کیا ضروری ہے؟</h2></main></body></html>');
  const brief=server.buildObservedContentBrief({contentEvidence:page.contentEvidence,wordCount:page.wordCount,keywords:['باغبانی']});
  assert.equal(brief.targetWordCount,null);
  assert.equal(brief.title,'باغبانی');
  assert.deepEqual(brief.recommendedHeadings,['کیا ضروری ہے؟']);
  assert.deepEqual(brief.recommendedSchemas,[]);
  const audit=server.calculateDynamicAeoScore(extract('<html lang="ur"><body><h1>خدمات</h1><p>ہماری خدمات کی تفصیل۔</p></body></html>'),'ہماری خدمات کی تفصیل۔');
  assert.equal(audit.metrics.find(x=>x.metric==='Question/Answer Blocks').passed,null);
  assert.equal(audit.metrics.find(x=>x.metric==='Direct Answer Blocks').passed,null);
});
test('page-specific drafts, image/link targets and declared names come only from observed evidence',()=>{
  const html=`<html lang="en"><head><script type="application/ld+json">{"@type":"Organization","name":"Rose Studio"}</script></head><body><nav><a href="/rose-pruning">Rose pruning</a></nav><main><h1>Rose pruning</h1><p>Rose pruning helps maintain the observed garden plants and encourages careful seasonal maintenance.</p><h2>How to prune roses?</h2><section>Wrapper-based answers are unverified.</section><a href="/care">click here</a><img src="/rose.png"><img role="presentation" alt="" src="/decor.png"></main></body></html>`;
  const page=extract(html),e=page.contentEvidence;
  assert.equal(e.titleDraft.text,'Rose pruning');
  assert.match(e.descriptionDraft.text,/Rose pruning helps/);
  assert.ok(e.internalLinkOpportunities.some(x=>x.url==='https://example.com/rose-pruning'));
  assert.equal(e.findings.find(x=>x.code==='linkAnchor').params.target,'https://example.com/care');
  assert.equal(e.findings.filter(x=>x.code==='imageAlt').length,1);
  assert.equal(e.declaredEntities[0].name,'Rose Studio');
  assert.equal(e.declaredEntities[0].mentionedInContent,false);
  assert.ok(e.findings.every(x=>x.evidence.url==='https://example.com/guide'));
  const other=extract('<html lang="ur"><body><main><h1>باغبانی</h1><p>باغبانی کے لیے زمین کی تیاری اور مناسب بیج کا انتخاب بہت ضروری ہے۔</p></main></body></html>');
  assert.notEqual(e.titleDraft.text,other.contentEvidence.titleDraft.text);
});
test('translated evidence report is safe, persists language, and changing language makes no network calls',async()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://app.example',runScripts:'outside-only'}),{window}=dom;
  let requests=0;
  window.AbortSignal=AbortSignal;
  window.fetch=async()=>{requests++;return {ok:false,status:401,json:async()=>({})};};
  window.HTMLCanvasElement.prototype.getContext=()=>({});
  window.eval(readFileSync(new URL('../public/languages.js',import.meta.url),'utf8'));
  window.eval([...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join('\n')+'\nwindow.setScanForTest=value=>{lastScanData=value;};\n'+readFileSync(new URL('../public/features.js',import.meta.url),'utf8'));
  await new Promise(r=>setTimeout(r,0));
  const page=extract('<html lang="ur"><body><main><h1>باغبانی</h1><h2>کیا ضروری ہے؟</h2></main></body></html>');
  page.contentEvidence.findings[0].evidence.observed='<img src=x onerror=alert(1)>';
  try {
    window.renderContentIntelligence(page.contentEvidence);
    const baseline=requests;
    for(const locale of ['ur','ps','ar','en']) {
      window.setReportLanguage(locale);
      assert.equal(window.document.documentElement.lang,locale);
      assert.equal(window.document.documentElement.dir,locale==='en'?'ltr':'rtl');
      assert.equal(window.document.getElementById('reportLanguage').value,locale);
      assert.equal(window.localStorage.getItem('aegis-report-language'),locale);
      assert.equal(window.document.querySelector('#contentIntelligenceResults img'),null);
      assert.equal(window.document.getElementById('contentIntelligenceHeading').textContent,window.ReportLanguage.t('context'));
      assert.match(window.document.getElementById('contentIntelligenceResults').textContent,/باغبانی/);
    }
    assert.equal(requests,baseline);
    // A matching completed scan already contains the optimizer; do not charge again.
    const optimizer={scores:{overallContentScore:55},priorityRoadmap:[],suggestions:{newFaqs:[]},evidence:page.contentEvidence};
    window.setScanForTest({resolvedUrl:'https://example.com/',contentOptimizer:optimizer});
    window.document.getElementById('url').value='example.com';
    await window.runContentOptimizer();
    assert.equal(requests,baseline);
    window.setReportLanguage('not-supported');assert.equal(window.document.documentElement.lang,'en');
  }finally{window.close();}
});
