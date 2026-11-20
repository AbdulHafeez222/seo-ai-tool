import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { pageActions, contextualizeAudit } from '../lib/page-actions.js';
process.env.JWT_SECRET = 'isolated-test-secret-at-least-32-bytes-long';
delete process.env.MONGODB_URI;
const api = await import('../server.js');
function page(topic,paragraph,host) {
 const html=`<html lang="en"><main><h1>${topic}</h1><p>${paragraph}</p><h2>How does ${topic} work?</h2><section>Answer inside a wrapper, not an observed adjacent answer.</section><a href="/details">read more</a><img src="/${host}.png"></main></html>`;
 return api.extractPageData(cheerio.load(html),html,`https://${host}.example/guide`);
}
test('unrelated pages receive their own observed metadata drafts, question headings, images and links',()=>{
 const rose=page('Rose pruning','Rose pruning removes damaged branches from garden plants. Check each plant before deciding which branches to remove.','roses');
 const concrete=page('Concrete volume','Concrete volume is calculated from measured length, width and depth. Confirm consistent units before ordering material.','concrete');
 const a=pageActions(rose.contentEvidence).map(x=>x.action).join('\n'),b=pageActions(concrete.contentEvidence).map(x=>x.action).join('\n');
 assert.match(a,/Rose pruning removes damaged branches/);assert.match(a,/roses\.example\/details/);assert.match(a,/roses\.png/);
 assert.match(b,/Concrete volume is calculated/);assert.match(b,/concrete\.example\/details/);assert.doesNotMatch(b,/Rose pruning|roses\.png/);
 assert.match(a,/inspect existing wrappers/);assert.match(a,/visual content was not inspected/);
});
test('scores do not turn unsupported word counts, schema counts or entity counts into mandatory fixes',()=>{
 const p=page('Concrete volume','Concrete volume is calculated using the actual dimensions of the slab. Verify measurements before proceeding.','slab');
 const audit={score:30,metrics:[{metric:'Content Depth for Authority',passed:false,recommendation:'Expand to 1200 words',rawValue:2},{metric:'Entity Coverage',passed:false,recommendation:'Add more entities'},{metric:'Title Tag',passed:false,recommendation:'Write a generic title'}]};
 contextualizeAudit(audit,p);
 assert.equal(audit.score,30);assert.equal(audit.metrics[0].rawValue,2);
 assert.equal(audit.metrics[0].recommendation,null);assert.equal(audit.metrics[1].recommendation,null);
 assert.match(audit.metrics[2].recommendation,/Concrete volume/);
});
test('no copy or target descriptions are invented when the page lacks evidence',()=>{
 const html='<html><body></body></html>',p=api.extractPageData(cheerio.load(html),html,'https://blank.example/');
 assert.ok(!pageActions(p.contentEvidence).some(x=>['missingTitle','missingDescription'].includes(x.code)));
});
test('engine profiles do not promise per-engine gains or universal FAQ/HowTo/table/word requirements',()=>{
 const p=page('Garden care','Garden care depends on the actual plants, soil conditions and season. Check the observed needs before choosing a task.','garden');
 const result=api.estimateAIEngineCitations({wordCount:30,contentEvidence:p.contentEvidence});
 for(const engine of Object.values(result.engines)){
  assert.equal(engine.potentialScore,null);assert.equal(engine.estimatedGain,null);assert.deepEqual(engine.penalties,[]);
  assert.ok(engine.improvementSuggestions.some(x=>x.includes('garden.example')));
  assert.doesNotMatch(engine.improvementSuggestions.join(' '),/900 words|FAQ schema|HowTo schema|potential \+/i);
 }
});
