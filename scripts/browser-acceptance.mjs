import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import mongoose from 'mongoose';
import axios from 'axios';
import { chromium } from 'playwright';
import { safeHttp } from '../lib/outbound.js';

const uri = process.env.TEST_MONGODB_URI;
assert.match(uri || '', /^mongodb:\/\/127\.0\.0\.1:27019\/seo_beta_acceptance(?:\?|$)/);
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'ERROR';
delete process.env.MONGODB_URI;
const api = await import('../server.js');
await mongoose.connect(uri);
await Promise.all([api.User.init(), api.Report.init(), api.Project.init(), api.SiteCrawlJob.init()]);
const output = path.resolve(process.env.BROWSER_OUTPUT_DIR || 'work/browser-acceptance');
await mkdir(output, { recursive: true });
const server = api.app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const email = `browser-${crypto.randomUUID()}@example.com`;
const password = crypto.randomBytes(20).toString('hex');
const account = await api.User.create({ email, passwordHash: await api.hashPassword(password), apiKey: api.generateApiKey() });
const copy = {
  en: ['Evidence testing guide', 'How does this guide work?', 'This guide explains how to test a website using observed evidence. It includes clear examples and practical steps for readers.'],
  ur: ['ویب سائٹ کی جانچ کا طریقہ', 'ویب سائٹ کی جانچ کیسے کریں؟', 'اس رہنمائی میں ویب سائٹ کی جانچ کے لیے واضح مثالیں اور عملی اقدامات شامل ہیں۔ اصل مواد کی بنیاد پر رپورٹ تیار کی جاتی ہے۔'],
  ps: ['د وېبپاڼې د ازموینې لارښود', 'وېبپاڼه څنګه ازمویل کېږي؟', 'دا لارښود د وېبپاڼې د ازموینې لپاره روښانه بېلګې او عملي ګامونه وړاندې کوي. راپور د لیدل شوي اصلي متن پر بنسټ جوړېږي.'],
  ar: ['دليل اختبار الموقع', 'كيف يتم اختبار الموقع؟', 'يشرح هذا الدليل كيفية اختبار الموقع باستخدام الأدلة المرصودة. يتضمن أمثلة واضحة وخطوات عملية للقارئ ويعتمد على محتوى الصفحة الفعلي.']
};
const original = { get: safeHttp.get, head: safeHttp.head, psi: axios.get, lookup: dns.lookup };
dns.lookup = async (host, options, ...rest) => {
  if (host === 'example.com') return options?.all ? [{ address: '8.8.8.8', family: 4 }] : { address: '8.8.8.8', family: 4 };
  return original.lookup(host, options, ...rest);
};
safeHttp.get = async url => {
  const locale = new URL(url).pathname.split('/')[1];
  const [title, question, answer] = copy[locale] || copy.en;
  const paragraphs = Array.from({ length: 20 }, () => `<p>${answer}</p>`).join('');
  const html = `<html lang="${locale}" dir="${locale === 'en' ? 'ltr' : 'rtl'}"><head><title>${title}</title><meta name="viewport" content="width=device-width"><link rel="canonical" href="${url}"></head><body><main><h1>${title}</h1><h2>${question}</h2>${paragraphs}<h2>${question}</h2><img src="/diagram.png"></main><footer><a href="/privacy">Privacy</a></footer></body></html>`;
  return { status: 200, headers: {}, safeFinalUrl: url, safeRedirectChain: [], data: url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' : url.endsWith('/sitemap.xml') ? '<urlset><url><loc>https://example.com/en</loc></url></urlset>' : html };
};
safeHttp.head = async () => ({ status: 200 });
axios.get = async () => ({ status: 503 });
let browser;
const checks = [];
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  page.on('request', request => { if (request.url().startsWith(base)) requests.push(new URL(request.url()).pathname); });
  await page.goto(base);
  await page.evaluate(() => openAuthModal('login'));
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPassword').fill(password);
  await page.locator('#authSubmitBtn').click();
  await page.waitForFunction(() => document.getElementById('userMenuWrap').style.display !== 'none');
  for (const locale of Object.keys(copy)) {
    await page.selectOption('#reportLanguage', locale);
    await page.locator('#url').fill(`https://example.com/${locale}`);
    const completed = page.waitForResponse(response => response.url().includes('/scan?'));
    await page.locator('#scanBtn').click();
    const response = await completed;
    const result = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(result));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.persistence.fullReport, true);
    await page.locator('#contentIntelligenceCard').waitFor({ state: 'visible' });
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('html').getAttribute('dir'), locale === 'en' ? 'ltr' : 'rtl');
    assert.ok((await page.locator('#contentIntelligenceResults').textContent()).includes(copy[locale][1]));
    const before = requests.length;
    const chargedBefore = (await api.User.findById(account._id)).scansToday;
    await page.selectOption('#reportLanguage', locale === 'en' ? 'ar' : 'en');
    await page.selectOption('#reportLanguage', locale);
    assert.equal(requests.length, before, 'Language switching must not fetch anything');
    assert.equal((await api.User.findById(account._id)).scansToday, chargedBefore);
    for (const [name, width] of [['desktop', 1440], ['mobile', 390]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('#contentIntelligenceCard').scrollIntoViewIfNeeded();
      const overflow = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth,
        controls: [...document.querySelectorAll('.btn-grid button')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent.trim()) }));
      assert.ok(overflow.content <= width + 1, `${locale}/${name}: page overflows: ${JSON.stringify(overflow)}`);
      assert.deepEqual(overflow.controls, [], `${locale}/${name}: clipped controls`);
      await page.screenshot({ path: path.join(output, `${locale}-${name}.png`) });
      if (name === 'mobile') {
        await page.locator('.action-bar').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('.nav-link-group').isVisible(), true);
        await page.screenshot({ path: path.join(output, `${locale}-navigation.png`) });
      }
      checks.push({ locale, viewport: name, width, overflow: false });
    }
    await page.emulateMedia({ media: 'print' });
    const printCalls = await page.evaluate(async () => {
      const originalPrint = window.print;
      let calls = 0;
      window.print = () => { calls++; };
      try { await downloadPDF(); } finally { window.print = originalPrint; }
      return calls;
    });
    assert.equal(printCalls, 1, 'Export command must invoke the local print dialog');
    await page.pdf({ path: path.join(output, `${locale}-report.pdf`), preferCSSPageSize: true, printBackground: false });
    await page.emulateMedia({ media: 'screen' });
    api.scanCache.clear();
    await page.evaluate(id => viewReportDetail(id), result.reportId);
    await page.locator('[data-open-saved-report]').click();
    await page.waitForFunction(() => !document.getElementById('reportDetailModalOverlay').classList.contains('open'));
    assert.equal((await api.User.findById(account._id)).scansToday, chargedBefore);
    assert.ok((await page.locator('#contentIntelligenceResults').textContent()).includes(copy[locale][1]));
  }
  assert.deepEqual(errors, []);
  assert.equal((await api.User.findById(account._id)).scansToday, 4);
  assert.equal(await api.Report.countDocuments({ userId: account._id }), 4);
  const project = await api.Project.create({ userId: account._id, name: 'Search performance fixture', urls: ['https://example.com/'] });
  const fixture = { success: true, resolvedUrl: 'https://example.com/guide', analysisVersion: 'browser-workflow-v1', seoScore: 0,
    title: 'Before title', contentEvidence: { findings: [{ code: 'missingH1', params: { topic: 'Guide' }, evidence: { observed: 'No H1' } }] } };
  const beforeReport = await api.saveReportToDatabase(fixture, {}, { userId: account._id, projectId: project._id });
  const afterReport = await api.saveReportToDatabase({ ...fixture, title: 'After title', seoScore: 30, contentEvidence: { findings: [] } }, {}, { userId: account._id, projectId: project._id });
  await page.evaluate(() => openGrowthModal());
  assert.equal(await page.locator('#growthProject').inputValue(), String(project._id));
  const csv = clicks => 'Top queries,Clicks,Impressions,Position\n"<img src=x onerror=window.INJECTED=1>",' + clicks + ',1000,9\n' + Array.from({ length: 5 }, (_, i) => `peer${i},100,1000,9`).join('\n');
  for (const [slot, start, end, clicks] of [['baseline', '2026-01-01', '2026-01-28', 50], ['current', '2026-02-01', '2026-02-28', 1]]) {
    await page.selectOption('#growthSlot', slot);
    await page.locator('#growthStart').fill(start); await page.locator('#growthEnd').fill(end);
    await page.locator('#growthCsv').setInputFiles({ name: 'Queries.csv', mimeType: 'text/csv', buffer: Buffer.from(csv(clicks)) });
    const imported = page.waitForResponse(response => response.url().endsWith('/search-performance') && response.request().method() === 'POST');
    await page.locator('#growthImportButton').click(); assert.equal((await imported).status(), 200);
    await page.locator('#growthImportButton').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('growthImportButton').disabled);
  }
  assert.equal(await page.locator('#growthPerformanceResults img').count(), 0);
  assert.equal(await page.evaluate(() => window.INJECTED), undefined);
  const workflowChecks = [];
  for (const locale of Object.keys(copy)) {
    const before = requests.length;
    await page.selectOption('#growthLanguage', locale);
    assert.equal(requests.length, before);
    assert.equal(await page.locator('#growthStart').inputValue(), '2026-02-01');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('#growthModalOverlay .modal-panel').evaluate(el => { el.scrollTop = 0; });
      const heading = await page.locator('#growthTitle').boundingBox();
      const panel = await page.locator('#growthModalOverlay .modal-panel').boundingBox();
      assert.ok(heading.y >= panel.y && heading.y + heading.height <= panel.y + panel.height, 'Modal heading must be fully visible at scroll start');
      const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth > innerWidth + 1,
        panel: document.querySelector('#growthModalOverlay .modal-panel').scrollWidth > document.querySelector('#growthModalOverlay .modal-panel').clientWidth + 1 }));
      assert.equal(overflow.page, false); assert.equal(overflow.panel, false);
      await page.screenshot({ path: path.join(output, `performance-${locale}-${width}.png`) });
      workflowChecks.push({ locale, width, passed: true });
    }
  }
  await page.locator('#growthTab-comparison').click();
  await page.locator('#growthBefore').selectOption(String(beforeReport._id)); await page.locator('#growthAfter').selectOption(String(afterReport._id));
  const compared = page.waitForResponse(response => response.url().includes('/reports/compare?'));
  await page.locator('#growthCompare').click(); assert.equal((await compared).status(), 200);
  await page.waitForFunction(() => document.getElementById('growthComparisonResults').textContent.includes('Before title'));
  await page.screenshot({ path: path.join(output, 'comparison-mobile.png') });
  await page.locator('#growthTab-export').click();
  await page.selectOption('#growthExportType', 'reports');
  const firstDownload = page.waitForEvent('download'); await page.locator('#growthExportButton').click();
  await (await firstDownload).saveAs(path.join(output, 'report-export-first.json'));
  await page.waitForFunction(() => !document.getElementById('growthNextExport').disabled);
  const nextDownload = page.waitForEvent('download'); await page.locator('#growthNextExport').click();
  await (await nextDownload).saveAs(path.join(output, 'report-export-next.json'));
  assert.equal((await api.User.findById(account._id)).scansToday, 4);
  assert.equal(await api.Report.countDocuments({ userId: account._id }), 6);
  assert.deepEqual(errors, []);
  await page.locator('#growthClose').click();
  copy.ar[0] = 'Updated evidence guide';
  const refreshed = page.waitForResponse(response => response.url().includes('/scan?') && response.url().includes('refresh=true'));
  await page.evaluate(() => rescanFromReport('https://example.com/ar'));
  const refreshedResponse = await refreshed;
  const refreshedResult = await refreshedResponse.json();
  assert.equal(refreshedResponse.status(), 200);
  assert.equal(refreshedResult.title, 'Updated evidence guide');
  assert.ok(refreshedResult.observedAt);
  assert.equal((await api.User.findById(account._id)).scansToday, 5, 'One explicit fresh scan charges exactly one unit');
  assert.equal(await api.Report.countDocuments({ userId: account._id }), 7);
  await page.evaluate(() => logoutUser(false));
  assert.equal(await page.locator('#growthModalOverlay').count(), 0);
  const summary = { passed: true, checks, pdfLocales: Object.keys(copy), scans: 5, freshRescanVerified: true, consoleErrors: errors,
    workflowChecks, imports: 2, comparedReports: true, exportedBatches: 2, workflowQuotaCharged: 0,
    boundary: 'Real Chromium, HTTP APIs and isolated MongoDB. Website/PSI responses are controlled fixtures; no live crawling is implied.' };
  await writeFile(path.join(output, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch (error) {
  // Failures contain controlled fixture content, never account credentials.
  console.error(error.message);
  throw error;
} finally {
  await browser?.close();
  safeHttp.get = original.get;
  safeHttp.head = original.head;
  axios.get = original.psi;
  dns.lookup = original.lookup;
  api.scanCache.clear();
  await api.Report.deleteMany({ userId: account._id });
  await api.Project.deleteMany({ userId: account._id });
  await api.User.deleteOne({ _id: account._id });
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
}
