import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

const uri = process.env.TEST_MONGODB_URI;
test('isolated replica-set acceptance: accounts, concurrent quotas, ownership, report persistence and deletion rollback', { skip: !uri }, async () => {
  // This suite must never be pointed at Atlas or an existing customer database.
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:27019\/seo_beta_acceptance(?:\?|$)/);
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.LOG_LEVEL = 'ERROR';
  process.env.NODE_ENV = 'test';
  delete process.env.MONGODB_URI;
  const api = await import('../server.js');
  await mongoose.connect(uri);
  const { app, User, Report, Project, SiteCrawlJob } = api;
  await Promise.all([User.init(), Report.init(), Project.init(), SiteCrawlJob.init()]);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const createdIds = [];
  const request = async (path, { method = 'GET', body, token, origin } = {}) => {
    const response = await fetch(base + path, { method, headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {})
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  try {
    const password = crypto.randomBytes(20).toString('hex');
    const accounts = [];
    for (let i = 0; i < 2; i++) {
      const email = `acceptance-${crypto.randomUUID()}@example.com`;
      const registered = await request('/auth/register', { method: 'POST', body: { email, password } });
      assert.equal(registered.status, 201);
      assert.match(registered.headers.get('set-cookie'), /HttpOnly/);
      assert.match(registered.headers.get('set-cookie'), /SameSite=Strict/);
      const user = await User.findOne({ email });
      assert.notEqual(user.passwordHash, password);
      createdIds.push(user._id);
      accounts.push({ user, token: registered.data.token, email });
    }
    const [owner, stranger] = accounts;
    assert.equal((await request('/auth/login', { method: 'POST', body: { email: owner.email, password }, origin: 'https://attacker.example' })).status, 403);
    assert.equal((await request('/auth/login', { method: 'POST', body: { email: owner.email, password: 'incorrect' } })).status, 401);
    assert.equal((await request('/auth/login', { method: 'POST', body: { email: owner.email, password } })).status, 200);
    const project = await Project.create({ userId: owner.user._id, name: 'Acceptance fixture', urls: ['https://example.com/'] });
    assert.equal((await request(`/projects/${project._id}`, { token: stranger.token })).status, 404);
    assert.equal((await request(`/scan?url=https://example.com&projectId=${project._id}`, { token: stranger.token })).status, 404);
    assert.equal((await User.findById(stranger.user._id)).scansToday, 0);
    const reservations = await Promise.all(Array.from({ length: 12 }, () => api.reserveAccountUsage(owner.user, 1)));
    assert.equal(reservations.filter(Boolean).length, 5);
    assert.equal((await User.findById(owner.user._id)).scansToday, 5);
    await User.updateOne({ _id: owner.user._id }, { $set: { lastScanReset: new Date(Date.now() - 86400001) } });
    const resetReservations = await Promise.all(Array.from({ length: 12 }, () => api.reserveAccountUsage(owner.user, 1)));
    assert.equal(resetReservations.filter(Boolean).length, 5);
    assert.equal((await User.findById(owner.user._id)).scansToday, 5);
    const payload = { success: true, resolvedUrl: 'https://example.com/', seoScore: 0, analysisVersion: 'acceptance-v1',
      contentEvidence: { topic: 'اردو پښتو العربية', findings: [] } };
    const saved = await api.saveReportToDatabase(payload, {}, { userId: owner.user._id, projectId: project._id });
    assert.ok(saved);
    assert.equal((await request(`/reports/${saved._id}/result`, { token: stranger.token })).status, 404);
    assert.equal((await request(`/reports/${saved._id}`, { method: 'DELETE', token: stranger.token })).status, 404);
    const catalog = await request('/reports', { token: owner.token });
    assert.equal(catalog.data.reports.length, 1);
    assert.equal((await Report.findById(saved._id).lean()).snapshotJSON, undefined);
    api.scanCache.clear();
    const reopened = await request(`/reports/${saved._id}/result`, { token: owner.token });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.data.seoScore, 0);
    assert.deepEqual(reopened.data.contentEvidence, payload.contentEvidence);
    assert.equal((await User.findById(owner.user._id)).scansToday, 5);
    assert.equal(await Report.countDocuments({ userId: owner.user._id }), 1);
    const historical = await Report.create({ userId: owner.user._id, url: 'https://example.com/legacy' });
    assert.equal((await request(`/reports/${historical._id}/result`, { token: owner.token })).status, 409);

    // Inject a failure inside the real transaction and prove earlier deletes roll back.
    const deleteReports = Report.deleteMany;
    Report.deleteMany = () => { throw new Error('Injected acceptance rollback'); };
    try {
      assert.equal((await request('/auth/account', { method: 'DELETE', token: owner.token, body: { password, confirmation: 'DELETE' } })).status, 500);
      assert.ok(await User.findById(owner.user._id));
      assert.ok(await Project.findById(project._id));
      assert.ok(await Report.findById(saved._id));
    } finally { Report.deleteMany = deleteReports; }
    assert.equal((await request('/auth/logout', { method: 'POST', token: stranger.token })).status, 200);
    assert.equal((await request('/projects', { token: stranger.token })).status, 401);
    assert.equal((await request('/auth/account', { method: 'DELETE', token: owner.token, body: { password, confirmation: 'DELETE' } })).status, 200);
    assert.equal(await Report.countDocuments({ userId: owner.user._id }), 0);
    assert.equal(await Project.countDocuments({ userId: owner.user._id }), 0);
  } finally {
    for (const Model of [Report, Project, SiteCrawlJob]) await Model.deleteMany({ userId: { $in: createdIds } });
    await User.deleteMany({ _id: { $in: createdIds } });
    await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
  }
});
