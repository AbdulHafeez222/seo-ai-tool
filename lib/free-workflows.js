import mongoose from 'mongoose';
import { parseSearchConsoleImport, restoreSearchImport, analyzeSearchPerformance } from './search-performance.js';
import { compareSavedReports } from './report-comparison.js';
import { restoreReportSnapshot } from './report-storage.js';
import { WorkflowError, workflowHandler } from './workflow-errors.js';

export function installFreeWorkflows(app, { Project, Report, requireAuth, asyncHandler }) {
  const windows = new Map();
  const limit = (req, res, next) => {
    const now = Date.now();
    for (const [key, record] of windows) if (record.until <= now) windows.delete(key);
    const key = String(req.authUser._id);
    if (!windows.has(key) && windows.size >= 5000) return res.status(503).json({ success: false, code: 'featureBusy', message: 'Try again later.' });
    const record = windows.get(key) || { count: 0, until: now + 60000 };
    windows.set(key, record);
    if (++record.count > 30) {
      res.setHeader('Retry-After', String(Math.ceil((record.until - now) / 1000)));
      return res.status(429).json({ success: false, code: 'featureRateLimit', message: 'Too many requests. Try again later.' });
    }
    next();
  };
  const handler = fn => workflowHandler(asyncHandler, fn);
  const validId = value => typeof value === 'string' && mongoose.Types.ObjectId.isValid(value);
  const selectedImports = '+performanceBaseline +performanceCurrent';
  async function projectFor(req) {
    if (!validId(req.params.id)) throw new WorkflowError('invalidProject');
    const project = await Project.findOne({ _id: req.params.id, userId: req.authUser._id }).select(selectedImports).lean();
    if (!project) throw new WorkflowError('projectNotFound', 404);
    return project;
  }
  const performance = project => ({ success: true, project: { id: String(project._id), name: project.name, urls: project.urls },
    performance: analyzeSearchPerformance(restoreSearchImport(project.performanceBaseline), restoreSearchImport(project.performanceCurrent), project.urls) });

  app.get('/projects/:id/search-performance', requireAuth, limit, handler(async (req, res) => res.json(performance(await projectFor(req)))));
  app.post('/projects/:id/search-performance', requireAuth, limit, handler(async (req, res) => {
    if (!['baseline', 'current'].includes(req.body?.slot)) throw new WorkflowError('invalidImportSlot');
    const project = await projectFor(req);
    const snapshot = parseSearchConsoleImport(req.body, project.urls);
    const field = req.body.slot === 'baseline' ? 'performanceBaseline' : 'performanceCurrent';
    const updated = await Project.findOneAndUpdate({ _id: project._id, userId: req.authUser._id },
      { $set: { [field]: JSON.stringify(snapshot) } }, { new: true }).select(selectedImports).lean();
    if (!updated) throw new WorkflowError('projectNotFound', 404);
    res.json(performance(updated));
  }));
  app.delete('/projects/:id/search-performance', requireAuth, limit, handler(async (req, res) => {
    const project = await projectFor(req);
    const updated = await Project.findOneAndUpdate({ _id: project._id, userId: req.authUser._id },
      { $unset: { performanceBaseline: 1, performanceCurrent: 1 } }, { new: true }).select(selectedImports).lean();
    if (!updated) throw new WorkflowError('projectNotFound', 404);
    res.json(performance(updated));
  }));

  // Register before /reports/:id: comparison reads two owned snapshots only.
  app.get('/reports/compare', requireAuth, limit, handler(async (req, res) => {
    if (!validId(req.query.before) || !validId(req.query.after)) throw new WorkflowError('invalidReportSelection');
    const documents = await Report.find({ _id: { $in: [req.query.before, req.query.after] }, userId: req.authUser._id })
      .select('+snapshotJSON').limit(2).lean();
    const before = documents.find(report => String(report._id) === req.query.before);
    const after = documents.find(report => String(report._id) === req.query.after);
    if (!before || !after) throw new WorkflowError('reportNotFound', 404);
    res.json({ success: true, comparison: compareSavedReports(before, after) });
  }));

  // Paginated private copies, not a consistent database backup. Whitelist fields
  // so password hashes, API keys and any future provider tokens cannot leak.
  app.get('/account/export', requireAuth, limit, handler(async (req, res) => {
    const resource = req.query.resource || 'projects';
    if (!['projects', 'reports'].includes(resource) || req.query.cursor && !validId(req.query.cursor)) throw new WorkflowError('invalidExportSelection');
    const filter = { userId: req.authUser._id, ...(req.query.cursor ? { _id: { $gt: req.query.cursor } } : {}) };
    const Model = resource === 'projects' ? Project : Report;
    const documents = await Model.find(filter).select(resource === 'projects' ? selectedImports : '+snapshotJSON').sort({ _id: 1 }).limit(6).lean();
    const items = documents.slice(0, 5).map(document => resource === 'projects' ? {
      id: String(document._id), name: document.name, urls: document.urls, description: document.description,
      createdAt: document.createdAt, updatedAt: document.updatedAt,
      searchPerformance: { baseline: restoreSearchImport(document.performanceBaseline), current: restoreSearchImport(document.performanceCurrent) }
    } : {
      id: String(document._id), projectId: document.projectId ? String(document.projectId) : null, url: document.url,
      scanDate: document.scanDate, title: document.title, overallScore: document.overallScore,
      seoScore: document.seoScore, geoScore: document.geoScore, aeoScore: document.aeoScore,
      snapshotStatus: document.snapshotStatus || 'summary', result: restoreReportSnapshot(document)
    });
    res.setHeader('Content-Disposition', `attachment; filename="aegis-${resource}-export.json"`);
    res.json({ success: true, version: 1, resource, exportedAt: new Date().toISOString(),
      account: { email: req.authUser.email, plan: req.authUser.plan }, items,
      nextCursor: documents.length > 5 ? String(documents[4]._id) : null, consistentDatabaseBackup: false });
  }));
  return { limit };
}
