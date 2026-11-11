import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { googleHttp, GSC_SCOPE } from '../lib/google-search-console.js';
import { openJson, sealJson, readEncryptionKey } from '../lib/secret-box.js';

const uri = process.env.TEST_MONGODB_URI;
test('Google integration: real-database account isolation, one-use PKCE state, encrypted grants, scoped pulls, revocation and race rejection', { skip: !uri }, async () => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:27019\/seo_beta_acceptance(?:\?|$)/);
  const names = ['GSC_ENABLED', 'APP_ORIGIN', 'GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GSC_TOKEN_ENCRYPTION_KEY', 'NODE_ENV', 'JWT_SECRET', 'MONGODB_URI'];
  const originalEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'ERROR', JWT_SECRET: crypto.randomBytes(32).toString('hex'), GSC_ENABLED: 'true',
    APP_ORIGIN: 'https://app.example', GSC_CLIENT_ID: 'fixture-client', GSC_CLIENT_SECRET: 'fixture-secret', GSC_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') });
  delete process.env.MONGODB_URI;
  const api = await import('../server.js');
  await mongoose.connect(uri); await Promise.all([api.User.init(), api.Project.init()]);
  const server = api.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, accounts = [], calls = [];
  const originalRequest = googleHttp.request;
  const key = readEncryptionKey(process.env.GSC_TOKEN_ENCRYPTION_KEY);
  let queryMode = 'normal', hook = null;
  googleHttp.request = async config => {
    calls.push(config);
    if (hook) await hook(config);
    if (config.url.endsWith('/token')) return { data: { access_token: 'fixture-private-access', refresh_token: 'fixture-private-refresh', token_type: 'Bearer', expires_in: 3600, scope: GSC_SCOPE } };
    if (config.url.endsWith('/revoke')) return { data: {} };
    if (config.url.endsWith('/sites')) return { data: { siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }, { siteUrl: 'sc-domain:unverified.net', permissionLevel: 'siteUnverifiedUser' }] } };
    if (queryMode === 'unavailable') throw { response: { status: 503, data: { private: 'must-never-leak' } } };
    return { data: { rows: queryMode === 'overflow' ? Array.from({ length: 2001 }, (_, i) => ({ keys: [`q${i}`], clicks: 0, impressions: 100, position: 9 }))
      : [{ keys: ['observed query'], clicks: 5, impressions: 1000, position: 9 }] } };
  };
  async function account() {
    const user = await api.User.create({ email: `gsc-${crypto.randomUUID()}@example.com`, passwordHash: 'fixture-hash', apiKey: api.generateApiKey(), scansToday: 4 });
    accounts.push(user); return user;
  }
  async function request(path, user, method = 'GET', body) {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { ...(user ? { Authorization: `Bearer ${api.signAuthToken(user)}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : null };
  }
  async function start(user) {
    const response = await request('/integrations/gsc/start', user, 'POST', {}); assert.equal(response.status, 200);
    const url = new URL(response.data.authorizationUrl);
    assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('scope'), GSC_SCOPE);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    return { url, state: url.searchParams.get('state'), code: 'fixture-code' };
  }
  try {
    const owner = await account(), stranger = await account();
    assert.equal((await request('/integrations/gsc/status', null)).status, 401);
    process.env.GSC_ENABLED = 'false';
    assert.equal((await request('/integrations/gsc/status', owner)).data.configured, false);
    assert.equal((await request('/integrations/gsc/start', owner, 'POST', {})).status, 503);
    assert.equal(calls.length, 0); process.env.GSC_ENABLED = 'true';
    const pending = await start(owner);
    assert.equal((await request('/integrations/gsc/complete', stranger, 'POST', pending)).data.code, 'gscInvalidState');
    assert.equal((await request('/integrations/gsc/complete', owner, 'POST', { ...pending, state: '0'.repeat(64) })).data.code, 'gscInvalidState');
    assert.equal(calls.length, 0);
    const callback = await request(`/integrations/gsc/callback?state=${pending.state}&code=fixture-code`, null);
    assert.equal(callback.status, 303); assert.match(callback.headers.get('location'), /^\/#gscCode=/);
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await request('/integrations/gsc/complete', owner, 'POST', pending)).status, 200);
    const exchange = new URLSearchParams(calls.at(-1).data);
    assert.equal(crypto.createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), pending.url.searchParams.get('code_challenge'));
    assert.equal((await request('/integrations/gsc/complete', owner, 'POST', pending)).data.code, 'gscInvalidState');
    const hidden = await api.User.findById(owner._id).lean(); assert.equal(hidden.gscGrant, undefined); assert.equal(hidden.gscPending, undefined);
    const stored = await api.User.findById(owner._id).select('+gscGrant').lean(); assert.ok(!stored.gscGrant.includes('fixture-private'));
    const grant = openJson(stored.gscGrant, key, `gsc:grant:${owner._id}`); assert.equal(grant.refreshToken, 'fixture-private-refresh');
    const listed = await request('/integrations/gsc/properties', owner); assert.equal(listed.data.properties.length, 1);
    const project = await api.Project.create({ userId: owner._id, name: 'Google fixture', urls: ['https://example.com/'] });
    const path = `/projects/${project._id}/search-performance/google`;
    const body = { slot: 'current', property: 'sc-domain:example.com', kind: 'queries', start: '2026-02-01', end: '2026-02-28', country: 'all' };
    const before = calls.length;
    assert.equal((await request(path, stranger, 'POST', body)).status, 404);
    assert.equal((await request(path, owner, 'POST', { ...body, property: 'sc-domain:evil.net' })).data.code, 'gscPropertyMismatch');
    assert.equal((await request(path, owner, 'POST', { ...body, country: 'us' })).data.code, 'gscInvalidCountry');
    assert.equal((await request(path, owner, 'POST', { ...body, end: new Date().toISOString().slice(0, 10) })).data.code, 'gscDatesNotSettled');
    assert.equal(calls.length, before);
    assert.equal((await request(path, owner, 'POST', body)).status, 200);
    const query = calls.at(-1);
    assert.equal(query.data.dataState, 'final'); assert.equal(query.data.rowLimit, 2001);
    assert.equal(query.data.dimensionFilterGroups[0].filters[0].dimension, 'page');
    const read = await request(`/projects/${project._id}/search-performance`, owner);
    assert.equal(read.data.performance.current.source, 'google-search-console-api');
    assert.equal(read.data.performance.current.independentlyVerified, true);
    assert.equal(read.data.performance.current.totals.clicks, 5);
    const snapshot = (await api.Project.findById(project._id).select('+performanceCurrent')).performanceCurrent;
    queryMode = 'overflow'; assert.equal((await request(path, owner, 'POST', body)).data.code, 'tooManyRows');
    queryMode = 'unavailable'; const failed = await request(path, owner, 'POST', body);
    assert.equal(failed.status, 502); assert.ok(!JSON.stringify(failed.data).includes('must-never-leak'));
    assert.equal((await api.Project.findById(project._id).select('+performanceCurrent')).performanceCurrent, snapshot);
    queryMode = 'normal';
    await api.User.updateOne({ _id: owner._id }, { $set: { gscGrant: sealJson({ ...grant, expiresAt: 0 }, key, `gsc:grant:${owner._id}`) } });
    assert.equal((await request('/integrations/gsc/properties', owner)).status, 200);
    assert.ok(calls.some(call => call.url.endsWith('/token') && new URLSearchParams(call.data).get('grant_type') === 'refresh_token'));
    const exported = await request('/account/export?resource=projects', owner);
    assert.equal(exported.data.items[0].searchPerformance.current.source, 'google-search-console-api');
    assert.doesNotMatch(JSON.stringify(exported.data), /fixture-private|gscGrant|gscPending|fixture-secret/);
    assert.equal((await api.User.findById(owner._id)).scansToday, 4);
    assert.equal((await request('/integrations/gsc', owner, 'DELETE')).data.revoked, true);
    assert.equal((await request('/integrations/gsc/status', owner)).data.connected, false);
    assert.equal((await request('/integrations/gsc/properties', owner)).data.code, 'gscNotConnected');

    const raceUser = await account(), race = await start(raceUser);
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    hook = async config => { if (config.url.endsWith('/token')) { entered(); await new Promise(resolve => { release = resolve; }); } };
    const completing = request('/integrations/gsc/complete', raceUser, 'POST', race);
    await waiting;
    assert.equal((await request('/integrations/gsc', raceUser, 'DELETE')).status, 200);
    release(); assert.equal((await completing).data.code, 'gscConnectionChanged'); hook = null;
    assert.equal((await api.User.findById(raceUser._id).select('+gscGrant')).gscGrant, undefined);

    const refreshing = await account(), refreshState = await start(refreshing);
    assert.equal((await request('/integrations/gsc/complete', refreshing, 'POST', refreshState)).status, 200);
    const refreshRecord = await api.User.findById(refreshing._id).select('+gscGrant');
    const expiredGrant = openJson(refreshRecord.gscGrant, key, `gsc:grant:${refreshing._id}`); expiredGrant.expiresAt = 0;
    await api.User.updateOne({ _id: refreshing._id }, { $set: { gscGrant: sealJson(expiredGrant, key, `gsc:grant:${refreshing._id}`) } });
    const refreshWaiting = new Promise(resolve => { entered = resolve; });
    hook = async config => { if (config.url.endsWith('/token')) { entered(); await new Promise(resolve => { release = resolve; }); } };
    const refreshingRequest = request('/integrations/gsc/properties', refreshing);
    await refreshWaiting;
    assert.equal((await request('/integrations/gsc', refreshing, 'DELETE')).status, 200);
    release(); assert.equal((await refreshingRequest).data.code, 'gscConnectionChanged'); hook = null;
    assert.equal((await api.User.findById(refreshing._id).select('+gscGrant')).gscGrant, undefined);

    const expiring = await account(), expiredState = await start(expiring);
    const expiringRecord = await api.User.findById(expiring._id).select('+gscPending');
    const expired = openJson(expiringRecord.gscPending, key, `gsc:pending:${expiring._id}`); expired.expiresAt = 0;
    await api.User.updateOne({ _id: expiring._id }, { $set: { gscPending: sealJson(expired, key, `gsc:pending:${expiring._id}`) } });
    assert.equal((await request('/integrations/gsc/complete', expiring, 'POST', expiredState)).data.code, 'gscInvalidState');
    const superseded = await start(expiring); await start(expiring);
    assert.equal((await request('/integrations/gsc/complete', expiring, 'POST', superseded)).data.code, 'gscInvalidState');
    const stale = await account(), staleState = await start(stale);
    await api.User.updateOne({ _id: stale._id }, { $inc: { sessionVersion: 1 } });
    stale.sessionVersion = 1;
    assert.equal((await request('/integrations/gsc/complete', stale, 'POST', staleState)).data.code, 'gscInvalidState');
    const wrongKeyUser = await account(), wrongKeyState = await start(wrongKeyUser);
    assert.equal((await request('/integrations/gsc/complete', wrongKeyUser, 'POST', wrongKeyState)).status, 200);
    process.env.GSC_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    const beforeWrongKey = calls.length;
    assert.equal((await request('/integrations/gsc/properties', wrongKeyUser)).data.code, 'gscCredentialsUnavailable');
    assert.equal(calls.length, beforeWrongKey);
    const disconnected = await request('/integrations/gsc', wrongKeyUser, 'DELETE');
    assert.equal(disconnected.data.revoked, false);
    assert.equal((await api.User.findById(wrongKeyUser._id).select('+gscGrant')).gscGrant, undefined);
  } finally {
    googleHttp.request = originalRequest;
    const ids = accounts.map(user => user._id); await api.Project.deleteMany({ userId: { $in: ids } }); await api.User.deleteMany({ _id: { $in: ids } });
    await new Promise(resolve => server.close(resolve)); await mongoose.disconnect();
    for (const name of names) if (originalEnv[name] === undefined) delete process.env[name]; else process.env[name] = originalEnv[name];
  }
});
