import { parse } from 'csv-parse/sync';
import { parsePublicUrl } from './outbound.js';
import { WorkflowError } from './workflow-errors.js';

export const MAX_IMPORT_BYTES = 512 * 1024;
export const MAX_IMPORT_ROWS = 2000;
const MAX_STORED_BYTES = 384 * 1024;
const fail = code => { throw new WorkflowError(code); };
const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const normalizedHost = host => host.toLowerCase().replace(/^www\./, '');

function period(start, end) {
  const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(start) || !valid(end) || end < start || end > new Date().toISOString().slice(0, 10)) fail('invalidPeriod');
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  if (days > 366) fail('invalidPeriod');
  return { start, end, days };
}

function number(value, integer = false) {
  const text = String(value ?? '').trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) fail('invalidMetrics');
  const result = Number(text.replaceAll(',', ''));
  if (!Number.isFinite(result) || result > 1e12 || integer && !Number.isSafeInteger(result)) fail('invalidMetrics');
  return result;
}

export function parseSearchConsoleImport(input, projectUrls) {
  if (typeof input?.csv !== 'string' || Buffer.byteLength(input.csv) > MAX_IMPORT_BYTES) fail('importTooLarge');
  const dateRange = period(input.start, input.end);
  const device = input.device || 'all';
  const country = String(input.country || 'all').trim().toLowerCase();
  if (!['all', 'mobile', 'desktop', 'tablet'].includes(device) || !/^(all|[a-z]{2,3})$/.test(country)) fail('invalidScope');
  let records;
  try { records = parse(input.csv, { bom: true, trim: true, skip_empty_lines: true, max_record_size: 65536 }); }
  catch { fail('invalidCsv'); }
  if (records.length < 2) fail('emptyCsv');
  if (records.length - 1 > MAX_IMPORT_ROWS) fail('tooManyRows');
  const headers = records.shift().map(value => value.trim().toLowerCase());
  if (headers.length > 20 || new Set(headers).size !== headers.length) fail('invalidCsv');
  const column = aliases => headers.findIndex(value => aliases.includes(value));
  const pageColumn = column(['top pages', 'page', 'pages', 'url']);
  const queryColumn = column(['top queries', 'query', 'queries']);
  if ((pageColumn >= 0) === (queryColumn >= 0)) fail('unsupportedCsv');
  const kind = pageColumn >= 0 ? 'pages' : 'queries';
  const keyColumn = Math.max(pageColumn, queryColumn);
  const clicksColumn = column(['clicks']);
  const impressionsColumn = column(['impressions']);
  const positionColumn = column(['position', 'average position']);
  if ([clicksColumn, impressionsColumn, positionColumn].some(index => index < 0)) fail('unsupportedCsv');
  const hosts = new Set((Array.isArray(projectUrls) ? projectUrls : []).map(value => {
    try { return normalizedHost(new URL(value).hostname); } catch { return null; }
  }).filter(Boolean));
  if (!hosts.size) fail('projectUrlRequired');
  const seen = new Set();
  const rows = records.map(record => {
    let key = String(record[keyColumn] || '').trim();
    if (!key || Buffer.byteLength(key) > (kind === 'pages' ? 2048 : 512) || /[\u0000-\u001f]/.test(key)) fail('invalidRow');
    if (kind === 'pages') {
      let url;
      try { url = parsePublicUrl(key); } catch { fail('invalidPageUrl'); }
      if (!hosts.has(normalizedHost(url.hostname))) fail('wrongProjectDomain');
      key = url.href;
    }
    if (seen.has(key)) fail('duplicateRows');
    seen.add(key);
    const clicks = number(record[clicksColumn], true), impressions = number(record[impressionsColumn], true);
    const averagePosition = number(record[positionColumn]);
    if (clicks > impressions || averagePosition > 1000 || impressions > 0 && averagePosition < 1) fail('invalidMetrics');
    return { key, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? averagePosition : null };
  });
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const snapshot = { version: 1, source: 'uploaded-gsc-csv', independentlyVerified: false, importedAt: new Date().toISOString(),
    period: dateRange, kind, projectHosts: [...hosts].sort(), scope: { searchType: 'web', device, country }, rowCount: rows.length, rows,
    totals: { clicks, impressions, ctr: impressions ? clicks / impressions : 0,
      position: impressions ? rows.reduce((sum, row) => sum + (row.position || 0) * row.impressions, 0) / impressions : null } };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_STORED_BYTES) fail('importTooLarge');
  return snapshot;
}

export function restoreSearchImport(json) {
  if (!json) return null;
  try { const value = JSON.parse(json); return value.version === 1 && Array.isArray(value.rows) ? value : null; }
  catch { return null; }
}

function band(position) {
  return position <= 3 ? '1-3' : position <= 10 ? '4-10' : position <= 20 ? '11-20' : position <= 50 ? '21-50' : '51+';
}
function matchingScope(a, b) {
  return a.kind === b.kind && JSON.stringify(a.projectHosts) === JSON.stringify(b.projectHosts)
    && ['searchType', 'device', 'country'].every(key => a.scope[key] === b.scope[key]);
}

export function analyzeSearchPerformance(baseline, current, projectUrls = null) {
  const result = { version: 1, source: 'uploaded-gsc-csv', independentlyVerified: false, coverage: 'exported-rows-only',
    baseline, current, comparable: false, comparisonReason: null, comparison: null, opportunities: [], unmatched: { baseline: 0, current: 0 } };
  if (projectUrls) {
    const hosts = [...new Set(projectUrls.map(value => { try { return normalizedHost(new URL(value).hostname); } catch { return ''; } }).filter(Boolean))].sort();
    const reference = current || baseline;
    if (reference && JSON.stringify(reference.projectHosts) !== JSON.stringify(hosts)) {
      result.comparisonReason = 'projectScopeChanged';
      return result;
    }
  }
  if (!current) return result;
  const rows = current.rows;
  const groups = new Map();
  for (const row of rows) {
    if (row.impressions < 50 || row.position === null) continue;
    const key = band(row.position), group = groups.get(key) || { clicks: 0, impressions: 0, count: 0 };
    group.clicks += row.clicks; group.impressions += row.impressions; group.count++;
    groups.set(key, group);
  }
  // A peer benchmark comes only from other rows in the same export and position
  // band. It is an editorial estimate, never an industry CTR curve or forecast.
  for (const row of rows) {
    if (row.impressions < 100 || row.position === null) continue;
    const group = groups.get(band(row.position));
    const peerImpressions = group.impressions - row.impressions;
    const peerCount = group.count - 1;
    const benchmarkCtr = peerImpressions ? (group.clicks - row.clicks) / peerImpressions : null;
    if (peerCount >= 5 && row.ctr < benchmarkCtr * 0.7 && (benchmarkCtr - row.ctr) * row.impressions >= 1) {
      result.opportunities.push({ code: 'reviewSnippet', kind: 'lowCtr', key: row.key, basis: 'heuristic', priority: 'high',
        evidence: { ...row, benchmarkCtr, peerCount, positionBand: band(row.position) },
        estimatedAdditionalClicks: round((benchmarkCtr - row.ctr) * row.impressions, 1) });
    }
    if (row.position >= 8 && row.position <= 20) result.opportunities.push({ code: 'reviewContentLinks', kind: 'nearPageOne', key: row.key,
      basis: 'heuristic', priority: 'medium', evidence: { ...row }, estimatedAdditionalClicks: null });
  }
  if (baseline) {
    if (!matchingScope(baseline, current)) result.comparisonReason = 'scopeMismatch';
    else if (baseline.period.end >= current.period.start) result.comparisonReason = 'overlappingPeriods';
    else {
      result.comparable = true;
      const oldRows = new Map(baseline.rows.map(row => [row.key, row]));
      const currentKeys = new Set(rows.map(row => row.key));
      result.unmatched = { baseline: baseline.rows.filter(row => !currentKeys.has(row.key)).length, current: rows.filter(row => !oldRows.has(row.key)).length };
      const perDay = snapshot => ({ clicks: snapshot.totals.clicks / snapshot.period.days, impressions: snapshot.totals.impressions / snapshot.period.days });
      const before = perDay(baseline), after = perDay(current);
      result.comparison = { beforePerDay: before, afterPerDay: after,
        clicksPerDayDelta: round(after.clicks - before.clicks), impressionsPerDayDelta: round(after.impressions - before.impressions),
        ctrDelta: round(current.totals.ctr - baseline.totals.ctr),
        positionDelta: baseline.totals.position !== null && current.totals.position !== null ? round(current.totals.position - baseline.totals.position) : null };
      for (const row of rows) {
        const old = oldRows.get(row.key);
        if (!old) continue;
        const oldPerDay = old.clicks / baseline.period.days, newPerDay = row.clicks / current.period.days;
        if (old.clicks >= 5 && old.impressions >= 100 && newPerDay <= oldPerDay * 0.8) result.opportunities.push({
          code: 'reviewTrafficDecline', kind: 'decline', key: row.key, basis: 'observed-change', priority: 'high',
          evidence: { ...row, beforeClicks: old.clicks, beforeDays: baseline.period.days, currentDays: current.period.days,
            clicksPerDayDelta: round(newPerDay - oldPerDay) }, estimatedAdditionalClicks: null });
      }
    }
  }
  const order = { decline: 0, lowCtr: 1, nearPageOne: 2 };
  result.opportunities.sort((a, b) => order[a.kind] - order[b.kind] || b.evidence.impressions - a.evidence.impressions || a.key.localeCompare(b.key));
  result.totalOpportunities = result.opportunities.length;
  result.opportunities = result.opportunities.slice(0, 100);
  return result;
}
