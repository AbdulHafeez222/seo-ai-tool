import { restoreReportSnapshot } from './report-storage.js';
import { WorkflowError } from './workflow-errors.js';

const scores = ['seoScore', 'geoScore', 'aeoScore', 'eeatScore', 'trustScore', 'authorityScore', 'citationScore', 'overallAIVisibilityScore'];
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
function pageUrl(value) { try { const url = new URL(value); url.hash = ''; return url.href; } catch { return null; } }
const findingKey = finding => JSON.stringify([finding.code, finding.params?.src || '', finding.params?.heading || '', finding.params?.target || '', finding.params?.anchor || '']);

export function compareSavedReports(beforeReport, afterReport) {
  const before = restoreReportSnapshot(beforeReport), after = restoreReportSnapshot(afterReport);
  if (!before || !after) throw new WorkflowError('completeReportsRequired', 409);
  if (String(beforeReport._id) === String(afterReport._id)) throw new WorkflowError('differentReportsRequired');
  const url = pageUrl(before.resolvedUrl);
  if (!url || url !== pageUrl(after.resolvedUrl)) throw new WorkflowError('samePageRequired');
  if (String(beforeReport.projectId || '') !== String(afterReport.projectId || '')) throw new WorkflowError('sameProjectRequired');
  if (new Date(beforeReport.scanDate) > new Date(afterReport.scanDate)) throw new WorkflowError('reportOrderRequired');
  const comparable = Boolean(before.analysisVersion && before.analysisVersion === after.analysisVersion);
  const oldFindings = new Map((before.contentEvidence?.findings || []).map(finding => [findingKey(finding), finding]));
  const newFindings = new Map((after.contentEvidence?.findings || []).map(finding => [findingKey(finding), finding]));
  const identity = (report, data) => ({ id: String(report._id), savedAt: report.scanDate, observedAt: data.observedAt || null,
    title: data.title || '', analysisVersion: data.analysisVersion || null });
  const fields = ['title', 'metaDescription', 'wordCount', 'schemaCount'];
  const observations = fields.map(field => ({ field, before: before[field] ?? null, after: after[field] ?? null }))
    .filter(item => JSON.stringify(item.before) !== JSON.stringify(item.after));
  return { version: 1, url, before: identity(beforeReport, before), after: identity(afterReport, after), comparable,
    scores: scores.map(key => ({ key, before: finite(before[key]), after: finite(after[key]),
      delta: comparable && finite(before[key]) !== null && finite(after[key]) !== null ? after[key] - before[key] : null })),
    observations, findingsAvailable: comparable && Boolean(before.contentEvidence && after.contentEvidence),
    resolved: comparable && before.contentEvidence && after.contentEvidence ? [...oldFindings].filter(([key]) => !newFindings.has(key)).map(([, finding]) => finding) : [],
    added: comparable && before.contentEvidence && after.contentEvidence ? [...newFindings].filter(([key]) => !oldFindings.has(key)).map(([, finding]) => finding) : [] };
}
