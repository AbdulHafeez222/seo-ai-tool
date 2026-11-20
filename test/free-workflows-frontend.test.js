import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseSearchConsoleImport, analyzeSearchPerformance } from '../lib/search-performance.js';

test('free screens preserve forms on locale changes, escape uploaded content and clear private data on logout', async () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://app.example', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom, requests = [], errors = [];
  window.addEventListener('error', event => errors.push(event.error?.message || event.message));
  window.AbortSignal = AbortSignal; window.confirm = () => true;
  window.HTMLAnchorElement.prototype.click = () => {};
  window.URL.createObjectURL = () => 'blob:fixture'; window.URL.revokeObjectURL = () => {};
  let baseline = null, current = null;
  const csv = 'Top queries,Clicks,Impressions,Position\n"<img src=x onerror=window.INJECTED=1>",1,1000,9\n' + Array.from({ length: 5 }, (_, i) => `peer${i},100,1000,9`).join('\n');
  window.fetch = async (url, options = {}) => {
    const path = new URL(url, 'https://app.example').pathname;
    requests.push({ path, method: options.method || 'GET' });
    let data = { success: true };
    if (path === '/auth/me') data = { success: true, email: 'fixture@example.com', plan: 'free' };
    if (path === '/projects') data = { success: true, projects: [{ id: 'project', name: '<script>evil</script>', urls: ['https://example.com/'] }] };
    if (path.endsWith('/search-performance')) {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        const imported = parseSearchConsoleImport(body, ['https://example.com/']);
        if (body.slot === 'baseline') baseline = imported; else current = imported;
      }
      if (options.method === 'DELETE') { baseline = null; current = null; }
      data = { success: true, performance: analyzeSearchPerformance(baseline, current) };
    }
    if (path === '/reports') data = { success: true, reports: [] };
    if (path === '/account/export') data = { success: true, resource: 'projects', items: [{ name: 'Private project' }], nextCursor: null };
    return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => data, text: async () => JSON.stringify(data) };
  };
  try {
    window.eval(readFileSync(new URL('../public/languages.js', import.meta.url), 'utf8'));
    window.eval([...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n')
      + '\n' + readFileSync(new URL('../public/features.js', import.meta.url), 'utf8')
      + '\n' + readFileSync(new URL('../public/free-workflows-language.js', import.meta.url), 'utf8')
      + '\n' + readFileSync(new URL('../public/free-workflows.js', import.meta.url), 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 0));
    await window.openGrowthModal();
    const input = window.document.getElementById('growthCountry'); input.value = 'pk';
    window.document.getElementById('growthStart').value = '2026-01-01';
    window.document.getElementById('growthEnd').value = '2026-01-28';
    const file = { size: csv.length, text: async () => csv };
    Object.defineProperty(window.document.getElementById('growthCsv'), 'files', { value: [file], configurable: true });
    const before = requests.length;
    const expectedKeys = Object.keys(window.FreeWorkflowCopy.en).sort();
    for (const locale of ['ur', 'ps', 'ar', 'en']) {
      window.setReportLanguage(locale);
      assert.deepEqual(Object.keys(window.FreeWorkflowCopy[locale]).sort(), expectedKeys);
      assert.equal(window.document.getElementById('growthCountry'), input);
      assert.equal(input.value, 'pk');
      assert.equal(window.document.getElementById('growthStart').value, '2026-01-01');
      assert.equal(window.document.getElementById('growthCsv').files[0], file);
    }
    assert.equal(requests.length, before);
    await window.document.getElementById('growthImportForm').onsubmit({ preventDefault() {} });
    assert.ok(window.document.getElementById('growthPerformanceResults').textContent.includes('<img src=x onerror=window.INJECTED=1>'));
    assert.equal(window.document.querySelector('#growthPerformanceResults img'), null);
    assert.equal(window.document.querySelector('#growthProject script'), null);
    assert.equal(window.INJECTED, undefined);
    const afterImport = requests.length;
    window.setReportLanguage('ar'); window.setReportLanguage('en');
    assert.equal(requests.length, afterImport);
    await window.document.getElementById('growthTab-export').onclick();
    await window.document.getElementById('growthExportButton').onclick();
    assert.match(window.document.getElementById('growthExportStatus').textContent, /Downloaded 1/);
    assert.equal(requests.some(request => request.path === '/scan'), false);
    window.dispatchEvent(new window.Event('account-session-cleared'));
    assert.equal(window.document.getElementById('growthModalOverlay'), null);
    assert.deepEqual(errors, []);
  } finally { window.close(); }
});
