import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import axios from 'axios';
import mongoose from 'mongoose';
import { parseRobots, robotsAllows } from '../lib/robots.js';
import { isPublicAddress, parsePublicUrl, resolvePublicUrl, safeHttp } from '../lib/outbound.js';
process.env.JWT_SECRET = 'test-only-secret-with-more-than-32-characters';
delete process.env.MONGODB_URI;
process.env.LOG_LEVEL = 'ERROR';
const appModule = await import('../server.js');
const { app, extractPageData, calculateDynamicAeoScore, auditPageSchemas, calculateCoreWebVitalsScore,
  compareMultipleSites, getDeterministicSearchVolume, generateRecommendedSchemaBlock, normalizeUrl } = appModule;

test('English readability is unavailable rather than failed for Urdu/Pashto and empty content', () => {
  for (const [text,lang] of [['یہ ایک مثال ہے۔','ur'],['یہ ایک مثال ہے۔','en'],['دا یوه بېلګه ده.','ps'],['Este es un texto.','es'],['','en']]) {
    const result=appModule.calculateReadability(text,lang);
    assert.equal(result.available,false); assert.equal(result.fleschScore,null);
  }
  assert.equal(appModule.calculateReadability('This is a short sentence. This is another one.','en').available,true);
  const html='<html lang="ur"><body><h1>عنوان</h1><p>یہ ایک مثال ہے۔</p></body></html>';
  const $=cheerio.load(html); const page=extractPageData($,html,'https://example.com');
  const audit=appModule.calculateContentQualityScore(page,$);
  assert.equal(audit.readability.fleschScore,null);
  const metric=audit.metrics.find(m=>m.metric==='Readability');
  assert.equal(metric.passed,null); assert.equal(metric.weight,0);
  assert.ok(appModule.tokenizeKeywords('پاکستان پاکستان کاروبار کاروبار رہنمائی رہنمائی').includes('پاکستان'));
});

test('outbound boundary rejects private, mapped, metadata and reserved networks', async () => {
  for (const address of ['127.0.0.1','10.2.3.4','100.100.100.200','169.254.169.254','192.168.1.2','172.20.0.1','198.18.0.1','0.0.0.0','224.1.1.1','::1','fc12::1','fe80::1','::ffff:127.0.0.1','2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true);
  for (const url of ['file:///etc/passwd','http://localhost','http://127.1','http://2130706433','http://0x7f000001','http://[::1]','http://u:p@example.com','http://example.com:8080','https://example.com\\@127.0.0.1','http://metadata.internal']) assert.throws(() => parsePublicUrl(url), url);
  await assert.rejects(resolvePublicUrl('https://example.com', async () => [{ address:'8.8.8.8',family:4 }, { address:'127.0.0.1',family:4 }]), /Unsafe/);
  const resolved = await resolvePublicUrl('https://example.com/path', async () => [{ address:'8.8.8.8',family:4 }]);
  assert.equal(resolved.url.pathname, '/path');
});

test('robots user-agent groups stay separate, with longest-path and allow-tie precedence', () => {
  const parsed = parseRobots('User-agent: OtherBot\nDisallow: /\nUser-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /same\nAllow: /same\nSitemap: https://example.com/sitemap.xml');
  assert.equal(robotsAllows('https://example.com/',parsed.rules),true);
  assert.equal(robotsAllows('https://example.com/private/a',parsed.rules),false);
  assert.equal(robotsAllows('https://example.com/private/public/a',parsed.rules),true);
  assert.equal(robotsAllows('https://example.com/same',parsed.rules),true);
  assert.deepEqual(parsed.sitemaps,['https://example.com/sitemap.xml']);
});

test('extraction preserves absent metadata and does not double-count nested content', () => {
  const html = '<html><body><article><p>One <span>two</span> three.</p><ul><li>Four five.</li></ul><table><tr><td>Six.</td></tr></table></article></body></html>';
  const page = extractPageData(cheerio.load(html), html, 'https://example.com/path');
  assert.equal(page.title, ''); assert.equal(page.metaDescription, ''); assert.deepEqual(page.headings.h1s, []);
  assert.equal(page.wordCount, 6); assert.equal(page.listItemsCount, 1); assert.equal(page.tableRowsCount, 1);
  assert.equal(page.resolvedUrl, 'https://example.com/path');
});

test('AEO reads schema and DOM counts, not tags in plain text', () => {
  const html = '<html><head><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script></head><body><h1>Topic</h1><ul><li>First</li></ul><table><tr><td>value</td></tr></table></body></html>';
  const $ = cheerio.load(html); const page = extractPageData($, html, 'https://example.com');
  page.schema = auditPageSchemas($, html);
  const result = calculateDynamicAeoScore(page, page.visibleText);
  assert.equal(result.structuralAeoMetrics.hasFAQ, true);
  assert.equal(result.structuralAeoMetrics.listItemsCount, 1);
  assert.equal(result.structuralAeoMetrics.tableRowsCount, 1);
});

test('CWV missing INP is not a failed metric or an overall field pass', () => {
  const result = calculateCoreWebVitalsScore({ hasFieldData:true, fieldDataScope:'url', field:{ lcp:1800, inp:null, cls:0.05 }, lab:{}, strategy:'mobile' });
  assert.equal(result.score, 100); assert.equal(result.passesAllThresholds, null);
  const inp = result.metrics.find(m => m.metric === 'Interaction to Next Paint');
  assert.equal(inp.passed, null); assert.equal(inp.recommendation, null);
  assert.equal(calculateCoreWebVitalsScore(null).score, null);
});

test('multi-site ranks ties equally and does not replace blocked target', () => {
  const sites = [{title:'A',seoScore:70,overallAIVisibilityScore:70}, {title:'B',seoScore:70,overallAIVisibilityScore:70}];
  const result = compareMultipleSites(sites, ['https://a.com','https://b.com']);
  assert.deepEqual(result.dimensions[0].values.map(v => v.rank), [1,1]);
  assert.equal(compareMultipleSites([{blocked:true},...sites], ['x','a','b']).success, false);
  assert.equal(result.dimensions.find(d => d.key === 'coreWebVitals').values[0].value, null);
});

test('no invented keyword demand, reviews, identity or dates', () => {
  assert.equal(getDeterministicSearchVolume('example'), null);
  for (const type of ['Review','Person','Article','VideoObject','LocalBusiness']) {
    const block = generateRecommendedSchemaBlock(type, 'Observed title', '', 'https://example.com');
    for (const key of ['reviewRating','author','uploadDate','telephone','logo']) assert.equal(block[key], undefined);
  }
  assert.notEqual(normalizeUrl('https://example.com/Case?q=1'), normalizeUrl('https://example.com/case?q=2'));
});

test('HTTP API does not serve source, credentials or shared history', async () => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/server.js','/package.json','/lib/outbound.js','/Dockerfile']) assert.equal((await fetch(base+path)).status, 404);
    assert.equal((await fetch(base+'/')).status, 200);
    for (const path of ['/history','/trend?url=https://example.com','/reports','/projects','/dashboard/stats']) assert.equal((await fetch(base+path)).status, 401);
    assert.equal((await fetch(base+'/scan?url=https://example.com', {headers:{Authorization:'Bearer invalid.jwt.value'}})).status, 401);
    assert.equal((await fetch(base+'/scan?url=https://example.com', {headers:{Authorization:'Bearer pro-member-key-7777'}})).status, 503);
    assert.equal((await fetch(base+'/health/ready')).status, 503);
    assert.equal((await fetch(base+'/api/status')).status, 200);
    assert.equal((await fetch(base+'/auth/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"email":"test@example.com"}'})).status,503);
    assert.equal((await fetch(base+'/billing/checkout',{method:'POST'})).status,401);
    assert.equal((await fetch(base+'/plans').then(r=>r.json())).billingEnabled,false);
    assert.equal((await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status, 400);
  } finally { await new Promise(r => server.close(r)); }
});

test('bounded link checks use resolved page paths; protected and unreachable links remain unknown', async () => {
  const original = safeHttp.head; const visited = [];
  safeHttp.head = async url => { visited.push(url); return { status: url.endsWith('gone') ? 404 : 403 }; };
  try {
    const result = await appModule.sampleBrokenLinks('https://example.com/path', {'https://example.com/gone':1,'https://example.com/protected':1});
    assert.deepEqual(visited, ['https://example.com/gone','https://example.com/protected']);
    assert.equal(result.broken, 1); assert.equal(result.unknown, 1); assert.equal(result.checked, 1);
  } finally { safeHttp.head = original; }
});

test('JWTs and password hashing validate correctly', async () => {
  const hash = await appModule.hashPassword('test-password');
  assert.equal(await appModule.verifyPasswordHash('test-password', hash), true);
  assert.equal(await appModule.verifyPasswordHash('wrong-password', hash), false);
  const token = appModule.signAuthToken({_id:'507f1f77bcf86cd799439011',email:'test@example.com'});
  assert.equal(appModule.verifyAuthToken(token).sub, '507f1f77bcf86cd799439011');
  assert.equal(appModule.verifyAuthToken(token+'tampered'), null);
});

test('redirects to metadata are rejected before a second network call', async () => {
  const original = axios.request; let calls = 0;
  axios.request = async options => {
    calls++;
    assert.equal(options.proxy, false); assert.equal(options.maxRedirects, 0);
    assert.equal(options.httpsAgent.options.rejectUnauthorized, true);
    assert.ok(options.httpsAgent.options.lookup);
    return {status:302,headers:{location:'http://169.254.169.254/latest/meta-data/'}};
  };
  try { await assert.rejects(safeHttp.get('https://8.8.8.8'), /Unsafe/); assert.equal(calls,1); }
  finally { axios.request = original; }
});

test('full scan pipeline reuses evidence and persists cache hits for the requesting owner (mocked I/O)', async () => {
  const get = safeHttp.get, head = safeHttp.head, psi = axios.get, create = appModule.Report.create;
  const state = mongoose.connection.readyState; const saved = [];
  const html = `<html lang="en"><head><title>Example Guide</title><meta name="description" content="A detailed example guide for readers learning how to build useful pages."><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://8.8.8.8/page"><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script></head><body><nav>${Array.from({length:6},(_,i)=>`<a href="/guide/${i}">Guide ${i}</a>`).join('')}</nav><main><h1>Example guide</h1><h2>What is a useful guide?</h2>${Array.from({length:20},(_,i)=>`<p>A useful guide provides clear information and meaningful examples to explain a subject. Section ${i} helps readers understand the topic and make a decision.</p>`).join('')}<ul><li>First action</li></ul><table><tr><td>Example</td></tr></table><img src="/pic.png" alt="Diagram"></main><footer>Contact us for details</footer></body></html>`;
  safeHttp.get = async url => ({ status:200, headers:{}, safeFinalUrl:url, safeRedirectChain:[], data:url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' : url.endsWith('/sitemap.xml') ? '<urlset><url><loc>https://8.8.8.8/page</loc></url></urlset>' : html });
  safeHttp.head = async () => ({status:200}); axios.get = async () => ({status:503});
  mongoose.connection.readyState = 1;
  appModule.Report.create = async data => { saved.push(data); return {_id:`report-${saved.length}`}; };
  appModule.scanCache.clear();
  try {
    const a = await appModule.analyzeSingleUrl('https://8.8.8.8/page',{userId:'owner-A'});
    assert.equal(a.success,true,JSON.stringify(a));
    assert.equal(a.pageEvidence.crawlerPolicies.bots[0].policy,"allowed");
    assert.equal(a.pageEvidence.answerBlocks[0].heading,"What is a useful guide?");
    assert.equal(a.aeo.metrics.find(m=>m.metric==='FAQ Schema').passed,true);
    assert.ok(a.technicalMonitor); assert.ok(a.links.linkMap['https://8.8.8.8/guide/0']);
    const b = await appModule.analyzeSingleUrl('https://8.8.8.8/page',{userId:'owner-B'});
    const a2 = await appModule.analyzeSingleUrl('https://8.8.8.8/page',{userId:'owner-A'});
    assert.deepEqual(saved.map(x=>x.userId),['owner-A','owner-B','owner-A']);
    assert.notEqual(a.reportId,b.reportId); assert.notEqual(a.reportId,a2.reportId);
    assert.equal(a.seoScore,a2.seoScore); assert.equal(a.citation.heuristic,true);
  } finally {
    safeHttp.get=get; safeHttp.head=head; axios.get=psi; appModule.Report.create=create;
    mongoose.connection.readyState=state; appModule.scanCache.clear();
  }
});

test('account middleware rejects revoked JWTs and reserves comparison cost atomically (mocked DB)', async () => {
  const state=mongoose.connection.readyState;
  const find=appModule.User.findById, reset=appModule.User.updateOne, reserve=appModule.User.findOneAndUpdate;
  const user={_id:'507f1f77bcf86cd799439011',passwordHash:'old-hash',apiKey:'old-key',plan:'free'};
  const token=appModule.signAuthToken(user);
  mongoose.connection.readyState=1;
  const calls=[];
  appModule.User.findById=async ()=>user;
  appModule.User.updateOne=async (...args)=>{calls.push(args);return {modifiedCount:0};};
  appModule.User.findOneAndUpdate=async (...args)=>{calls.push(args);return {...user,scansToday:2};};
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base+'/auth/me',{headers:{cookie:`aegis_session=${token}`}})).status,200);
    user.apiKey='new-key';
    assert.equal((await fetch(base+'/projects',{headers:{Authorization:`Bearer ${token}`}})).status,401);
    await appModule.reserveAccountUsage(user,2);
    assert.equal(calls[1][0].scansToday.$lte,3);
    assert.deepEqual(calls[1][1],{$inc:{scansToday:2}});
    assert.equal((await fetch(base+'/auth/change-password',{method:'POST',headers:{cookie:`aegis_session=${token}`,'Content-Type':'application/json',Origin:'https://attacker.example'},body:'{}'})).status,403);
  } finally {
    await new Promise(r=>server.close(r));mongoose.connection.readyState=state;
    appModule.User.findById=find;appModule.User.updateOne=reset;appModule.User.findOneAndUpdate=reserve;
  }
});

test('project editing always scopes writes to the authenticated owner and rejects invalid URLs (mocked DB)', async () => {
  const state=mongoose.connection.readyState;
  const find=appModule.User.findById, update=appModule.Project.findOneAndUpdate;
  const user={_id:'507f1f77bcf86cd799439011',passwordHash:'hash',apiKey:'key',plan:'free'};
  mongoose.connection.readyState=1;
  appModule.User.findById=async()=>user;
  const writes=[];
  appModule.Project.findOneAndUpdate=(...args)=>{writes.push(args);return {lean:async()=>null};};
  const token=appModule.signAuthToken(user);
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const endpoint=`http://127.0.0.1:${server.address().port}/projects/507f1f77bcf86cd799439022`;
  const put=body=>fetch(endpoint,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    assert.equal((await put({name:'Changed',userId:'other-owner',urls:['https://example.com/guide']})).status,404);
    assert.deepEqual(writes[0][0],{_id:'507f1f77bcf86cd799439022',userId:user._id});
    assert.equal(writes[0][1].userId,undefined);
    assert.equal((await put({urls:['http://127.0.0.1/private']})).status,400);
    assert.equal(writes.length,1);
  } finally {
    await new Promise(r=>server.close(r)); mongoose.connection.readyState=state;
    appModule.User.findById=find; appModule.Project.findOneAndUpdate=update;
  }
});

test('production startup does not create collections or indexes implicitly (mocked connection)', async () => {
  const connect=mongoose.connect, mode=process.env.NODE_ENV, uri=process.env.MONGODB_URI;
  const connection={host:'test-only',name:'test-only'}; let options;
  process.env.NODE_ENV='production'; process.env.MONGODB_URI='mongodb://127.0.0.1/test-only';
  mongoose.connect=async (_uri,config)=>{options=config;return {connection};};
  try {
    assert.equal(await appModule.connectToDatabase(),connection);
    assert.equal(options.autoIndex,false); assert.equal(options.autoCreate,false);
  } finally {
    mongoose.connect=connect; mongoose.connection.emit('disconnected');
    if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=mode;
    if (uri === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI=uri;
  }
});


test('completed result recovery is owner/project scoped, expires and never reserves quota or writes reports', async () => {
  const state=mongoose.connection.readyState;
  const find=appModule.User.findById, reserve=appModule.User.findOneAndUpdate, create=appModule.Report.create;
  const user={_id:'507f1f77bcf86cd799439011',passwordHash:'hash',apiKey:'key',plan:'free'};
  const other={...user,_id:'507f1f77bcf86cd799439012'};
  mongoose.connection.readyState=1;
  appModule.User.findById=async id=>String(id)===user._id?user:other;
  appModule.User.findOneAndUpdate=()=>{throw new Error('Recovery must not reserve quota');};
  appModule.Report.create=()=>{throw new Error('Recovery must not write data');};
  const key=`${user._id}:none:${normalizeUrl('https://example.com')}`;
  const payload={success:true,title:'Observed guide',seoScore:55,reportId:'saved-report'};
  appModule.scanCache.set(key,{timestamp:Date.now(),data:payload});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}/scan-result?url=https://example.com`;
  const request=(url=base,account=user)=>fetch(url,{headers:{Authorization:`Bearer ${appModule.signAuthToken(account)}`}});
  try {
    const recovered=await request();
    assert.equal(recovered.status,200);assert.match(recovered.headers.get('content-type'),/application\/json/);
    assert.deepEqual(await recovered.json(),{...payload,recovered:true});
    assert.equal((await request(base,other)).status,404);
    assert.equal((await request(base+'&projectId=invalid')).status,400);
    assert.equal((await request(base.replace('https://example.com','http://127.0.0.1'))).status,400);
    assert.equal((await fetch(base)).status,401);
    appModule.scanCache.get(key).timestamp=Date.now()-appModule.CACHE_TTL_MS;
    assert.equal((await request()).status,404);
  } finally {
    await new Promise(r=>server.close(r));mongoose.connection.readyState=state;
    appModule.User.findById=find;appModule.User.findOneAndUpdate=reserve;appModule.Report.create=create;appModule.scanCache.clear();
  }
});
