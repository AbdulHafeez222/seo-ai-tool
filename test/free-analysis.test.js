import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchConsoleImport, analyzeSearchPerformance, MAX_IMPORT_ROWS } from '../lib/search-performance.js';
import { compareSavedReports } from '../lib/report-comparison.js';
import { createReportSnapshot } from '../lib/report-storage.js';

const input = csv => ({ csv, start: '2026-01-01', end: '2026-01-28' });
const imported = (csv, extra = {}) => parseSearchConsoleImport({ ...input(csv), ...extra }, ['https://example.com/']);
const queryCsv = 'Top queries,Clicks,Impressions,CTR,Position\n"سوال، question",10,200,5%,9\n"multi, word",5,100,5%,5';

test('GSC parsing handles BOM, quoted commas, Unicode and grouped counts with a real CSV parser', () => {
  const result = imported('\ufeffTop pages,Clicks,Impressions,CTR,Position\r\n"https://example.com/guide?a=x,y",123,"1,234",9.97%,8.5\r\n');
  assert.equal(result.kind, 'pages');
  assert.equal(result.rows[0].key, 'https://example.com/guide?a=x,y');
  assert.equal(result.totals.impressions, 1234);
  assert.equal(result.totals.ctr, 123 / 1234);
  assert.equal(result.independentlyVerified, false);
  assert.equal(imported(queryCsv).rows[1].key, 'multi, word');
});

test('GSC imports reject malformed CSV, wrong dimensions, duplicate rows and impossible metrics', () => {
  const invalid = [
    ['Top queries,Clicks,Impressions,Position\n"unfinished,1,2,3', 'invalidCsv'],
    ['Date,Clicks,Impressions,Position\n2026-01-01,1,2,3', 'unsupportedCsv'],
    ['Top queries,Clicks,Clicks,Impressions,Position\na,1,1,2,3', 'invalidCsv'],
    ['Top queries,Clicks,Impressions,Position\na,1,2,3\na,1,2,3', 'duplicateRows'],
    ['Top queries,Clicks,Impressions,Position\na,3,2,3', 'invalidMetrics'],
    ['Top queries,Clicks,Impressions,Position\na,-1,2,3', 'invalidMetrics'],
    ['Top queries,Clicks,Impressions,Position\na,1.5,2,3', 'invalidMetrics'],
    ['Top queries,Clicks,Impressions,Position\na,1,2,0', 'invalidMetrics'],
    ['Top queries,Clicks,Impressions,Position\na,1,2,NaN', 'invalidMetrics']
  ];
  for (const [csv, code] of invalid) assert.throws(() => imported(csv), error => error.code === code, code);
});

test('GSC pages must belong to the selected project and cannot smuggle private or deceptive URLs', () => {
  for (const url of ['https://evil.example/', 'https://example.com.evil.net/', 'http://127.0.0.1/', 'https://u:p@example.com/', 'javascript:alert(1)']) {
    assert.throws(() => imported(`Top pages,Clicks,Impressions,Position\n${url},1,10,3`));
  }
  assert.equal(imported('Top pages,Clicks,Impressions,Position\nhttps://www.example.com/Page,1,10,3').rows[0].key, 'https://www.example.com/Page');
});

test('imports require valid periods and bounded sizes instead of silently truncating data', () => {
  for (const extra of [{ start: '2026-02-30' }, { end: '2999-01-01' }, { start: '2026-02-01', end: '2026-01-01' }, { device: 'bot' }, { country: '<script>' }]) {
    assert.throws(() => imported(queryCsv, extra));
  }
  assert.throws(() => imported('x'.repeat(512 * 1024 + 1)), error => error.code === 'importTooLarge');
  assert.throws(() => imported('Top queries,Clicks,Impressions,Position\n' + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `q${i},1,10,3`).join('\n')), error => error.code === 'tooManyRows');
});

test('zero observations stay zero and absent impression positions stay unavailable', () => {
  const result = imported('Top queries,Clicks,Impressions,Position\nnone,0,0,0');
  assert.equal(result.totals.clicks, 0);
  assert.equal(result.totals.position, null);
  assert.deepEqual(analyzeSearchPerformance(null, result).opportunities, []);
});

test('CTR opportunities use at least five other same-band rows and mark upside as an estimate', () => {
  const csv = 'Top queries,Clicks,Impressions,Position\nweak,1,1000,5\n' + Array.from({ length: 5 }, (_, i) => `peer${i},100,1000,6`).join('\n') + '\nother-band,900,1000,1';
  const result = analyzeSearchPerformance(null, imported(csv));
  const opportunity = result.opportunities.find(item => item.kind === 'lowCtr');
  assert.equal(opportunity.key, 'weak');
  assert.equal(opportunity.basis, 'heuristic');
  assert.equal(opportunity.evidence.peerCount, 5);
  assert.equal(opportunity.evidence.benchmarkCtr, 0.1);
  assert.equal(opportunity.estimatedAdditionalClicks, 99);
  assert.equal(analyzeSearchPerformance(null, imported(csv.replace('peer4,100,1000,6\n', ''))).opportunities.some(item => item.kind === 'lowCtr'), false);
});

test('traffic changes normalize unequal periods, and absent rows never become claimed lost rankings', () => {
  const old = imported('Top queries,Clicks,Impressions,Position\nshared,28,280,8\nmissing,28,280,8');
  const current = imported('Top queries,Clicks,Impressions,Position\nshared,2,200,10\nnew,1,100,8', { start: '2026-02-01', end: '2026-02-14' });
  const result = analyzeSearchPerformance(old, current);
  assert.equal(result.comparable, true);
  assert.equal(result.comparison.beforePerDay.clicks, 2);
  assert.deepEqual(result.unmatched, { baseline: 1, current: 1 });
  const declines = result.opportunities.filter(item => item.kind === 'decline');
  assert.equal(declines.length, 1);
  assert.equal(declines[0].key, 'shared');
  assert.equal(declines[0].evidence.beforeDays, 28);
  assert.equal(result.coverage, 'exported-rows-only');
});

test('incompatible or overlapping GSC windows withhold comparisons but retain within-export observations', () => {
  const baseline = imported(queryCsv);
  assert.equal(analyzeSearchPerformance(baseline, imported(queryCsv)).comparisonReason, 'overlappingPeriods');
  const current = imported(queryCsv, { start: '2026-02-01', end: '2026-02-28', device: 'mobile' });
  const result = analyzeSearchPerformance(baseline, current);
  assert.equal(result.comparisonReason, 'scopeMismatch');
  assert.equal(result.comparison, null);
  assert.equal(result.opportunities.some(item => item.kind === 'decline'), false);
});

test('changing project domains retains imports but withholds opportunities from the previous scope', () => {
  const current = imported(queryCsv);
  const result = analyzeSearchPerformance(null, current, ['https://different.example/']);
  assert.equal(result.comparisonReason, 'projectScopeChanged');
  assert.equal(result.current, current);
  assert.deepEqual(result.opportunities, []);
  assert.equal(analyzeSearchPerformance(null, current, ['https://www.example.com/path']).comparisonReason, null);
});

const report = (id, payload, scanDate = '2026-02-01') => ({ _id: id, projectId: 'same-project', scanDate,
  ...createReportSnapshot({ success: true, resolvedUrl: 'https://example.com/Page', analysisVersion: 'v1',
    contentEvidence: { findings: [] }, ...payload }) });
test('saved-report comparison preserves zero and unknown scores and reports actual evidence changes', () => {
  const finding = { code: 'missingH1', params: { topic: 'Guide' }, evidence: { observed: 'No H1' } };
  const before = report('before', { seoScore: 0, geoScore: null, title: 'Old title', contentEvidence: { findings: [finding] } }, '2026-01-01');
  const after = report('after', { seoScore: 40, geoScore: 60, title: 'New title', observedAt: '2026-02-01T00:00:00Z' });
  const result = compareSavedReports(before, after);
  assert.equal(result.scores.find(item => item.key === 'seoScore').delta, 40);
  assert.equal(result.scores.find(item => item.key === 'geoScore').delta, null);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.observations[0].field, 'title');
  assert.equal(result.before.observedAt, null);
});

test('saved-report comparison refuses other pages/projects/summaries and withholds changed-method deltas', () => {
  const before = report('before', { seoScore: 10 });
  for (const after of [report('after', { resolvedUrl: 'https://example.com/page' }), { ...report('after', {}), projectId: 'other' }, { _id: 'summary' }]) {
    assert.throws(() => compareSavedReports(before, after));
  }
  const changed = compareSavedReports(before, report('after', { seoScore: 100, analysisVersion: 'v2' }));
  assert.equal(changed.comparable, false);
  assert.ok(changed.scores.every(item => item.delta === null));
  assert.deepEqual(changed.resolved, []);
});
