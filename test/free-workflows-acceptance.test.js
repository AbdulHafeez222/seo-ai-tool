import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

const uri = process.env.TEST_MONGODB_URI;
test('free workflows isolate real database imports, comparisons and paginated exports without charging scans', { skip: !uri }, async () => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:27019\/seo_beta_acceptance(?:\?|$)/);
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test'; process.env.LOG_LEVEL = 'ERROR'; delete process.env.MONGODB_URI;
  const api = await import('../server.js');
  await mongoose.connect(uri);
  await Promise.all([api.User.init(), api.Project.init(), api.Report.init()]);
  const server = api.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const accounts = [];
  const request = async (path, account, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: {
      ...(account ? { Authorization: `Bearer ${api.signAuthToken(account)}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  try {
    for (let i = 0; i < 2; i++) accounts.push(await api.User.create({ email: `free-${crypto.randomUUID()}@example.com`,
      passwordHash: 'fixture-hash-not-a-real-login', apiKey: api.generateApiKey(), scansToday: 4 }));
    const [owner, stranger] = accounts;
    const project = await api.Project.create({ userId: owner._id, name: 'Private project', urls: ['https://example.com/'] });
    const path = `/projects/${project._id}/search-performance`;
    const csv = 'Top pages,Clicks,Impressions,Position\nhttps://example.com/guide,50,1000,9';
    const baseline = { csv, slot: 'baseline', start: '2026-01-01', end: '2026-01-28' };
    assert.equal((await request(path, null)).status, 401);
    for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await request(path, stranger, method, method === 'POST' ? baseline : undefined)).status, 404);
    assert.equal((await request(path, owner, 'POST', { ...baseline, csv: csv.replace('example.com/guide', 'evil.net/guide') })).status, 400);
    assert.equal((await request(path, owner, 'POST', baseline)).status, 200);
    const current = await request(path, owner, 'POST', { ...baseline, slot: 'current', start: '2026-02-01', end: '2026-02-28', csv: csv.replace(',50,', ',5,') });
    assert.equal(current.status, 200);
    assert.equal(current.data.performance.comparable, true);
    assert.equal(current.data.performance.opportunities.some(item => item.kind === 'decline'), true);
    assert.equal((await api.Project.findById(project._id).lean()).performanceCurrent, undefined);
    const restored = await request(path, owner);
    assert.equal(restored.data.performance.baseline.totals.clicks, 50);
    assert.equal(restored.data.performance.current.totals.clicks, 5);
    const before = await api.saveReportToDatabase({ success: true, resolvedUrl: 'https://example.com/guide', title: 'Before',
      seoScore: 0, analysisVersion: 'fixture-v1', contentEvidence: { findings: [] } }, {}, { userId: owner._id, projectId: project._id });
    const after = await api.saveReportToDatabase({ success: true, resolvedUrl: 'https://example.com/guide', title: 'After',
      seoScore: 25, analysisVersion: 'fixture-v1', contentEvidence: { findings: [] } }, {}, { userId: owner._id, projectId: project._id });
    const compare = `/reports/compare?before=${before._id}&after=${after._id}`;
    assert.equal((await request(compare, stranger)).status, 404);
    assert.equal((await request(compare, owner)).data.comparison.scores.find(item => item.key === 'seoScore').delta, 25);
    const foreign = await api.Report.create({ userId: stranger._id, url: 'https://example.com/private' });
    assert.equal((await request(`/reports/compare?before=${before._id}&after=${foreign._id}`, owner)).status, 404);
    await api.Report.insertMany(Array.from({ length: 4 }, (_, i) => ({ userId: owner._id, url: `https://example.com/${i}` })));
    const first = await request('/account/export?resource=reports', owner);
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-disposition'), /attachment/);
    assert.equal(first.data.items.length, 5);
    assert.ok(first.data.nextCursor);
    assert.equal(first.data.consistentDatabaseBackup, false);
    const second = await request(`/account/export?resource=reports&cursor=${first.data.nextCursor}`, owner);
    assert.equal(second.data.items.length, 1); assert.equal(second.data.nextCursor, null);
    const allIds = [...first.data.items, ...second.data.items].map(item => item.id);
    assert.equal(new Set(allIds).size, 6); assert.ok(!allIds.includes(String(foreign._id)));
    const projectExport = await request('/account/export?resource=projects', owner);
    assert.equal(projectExport.data.items[0].searchPerformance.current.totals.clicks, 5);
    assert.doesNotMatch(JSON.stringify(projectExport.data), new RegExp(owner.apiKey));
    assert.doesNotMatch(JSON.stringify(projectExport.data), /passwordHash|fixture-hash|apiKey|sessionVersion/);
    const strangerExport = await request('/account/export?resource=projects', stranger);
    assert.deepEqual(strangerExport.data.items, []);
    assert.equal((await request('/account/export?resource=users', owner)).status, 400);
    assert.equal((await request('/account/export?cursor=invalid', owner)).status, 400);
    assert.equal((await api.User.findById(owner._id)).scansToday, 4);
    assert.equal((await api.User.findById(stranger._id)).scansToday, 4);
    assert.equal((await request(path, owner, 'DELETE')).status, 200);
    assert.equal((await request(path, owner)).data.performance.current, null);
    assert.equal(await api.Report.countDocuments({ userId: owner._id }), 6);
  } finally {
    const userId = { $in: accounts.map(account => account._id) };
    await api.Project.deleteMany({ userId }); await api.Report.deleteMany({ userId }); await api.User.deleteMany({ _id: userId });
    await new Promise(resolve => server.close(resolve)); await mongoose.disconnect();
  }
});
