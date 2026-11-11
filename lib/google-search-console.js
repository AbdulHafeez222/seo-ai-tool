import crypto from 'node:crypto';
import axios from 'axios';
import mongoose from 'mongoose';
import { readEncryptionKey, sealJson, openJson } from './secret-box.js';
import { createSearchSnapshot, searchPeriod, MAX_IMPORT_ROWS } from './search-performance.js';
import { WorkflowError, workflowHandler } from './workflow-errors.js';

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const googleHttp = axios.create({ timeout: 15000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, maxBodyLength: 32768 });
const fail = (code, status = 400) => { throw new WorkflowError(code, status); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const purpose = (user, kind) => `gsc:${kind}:${user._id}`;
const host = value => value.toLowerCase().replace(/^www\./, '');
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function googleConfig() {
  if (process.env.GSC_ENABLED !== 'true') return null;
  try {
    const origin = new URL(process.env.APP_ORIGIN);
    if (origin.origin !== process.env.APP_ORIGIN || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(origin.hostname))) return null;
    const clientId = process.env.GSC_CLIENT_ID, clientSecret = process.env.GSC_CLIENT_SECRET;
    if (!clientId || !clientSecret || clientId.length > 512 || clientSecret.length > 512) return null;
    return { clientId, clientSecret, key: readEncryptionKey(process.env.GSC_TOKEN_ENCRYPTION_KEY),
      redirectUri: `${origin.origin}/integrations/gsc/callback` };
  } catch { return null; }
}
function configured() { const config = googleConfig(); if (!config) fail('gscNotConfigured', 503); return config; }
const sessionFilter = user => ({ _id: user._id, passwordHash: user.passwordHash, apiKey: user.apiKey,
  $or: [{ sessionVersion: user.sessionVersion || 0 }, ...(user.sessionVersion ? [] : [{ sessionVersion: { $exists: false } }])] });
async function call(config) {
  try { return (await googleHttp.request(config)).data; }
  catch (error) {
    if (error.response?.status === 429) fail('gscProviderBusy', 429);
    if ([400, 401].includes(error.response?.status)) fail('gscReconnectRequired', 409);
    if (error.response?.status === 403) fail('gscPermissionDenied', 403);
    fail('gscProviderUnavailable', 502);
  }
}
async function token(config, parameters) {
  const data = await call({ url: 'https://oauth2.googleapis.com/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: new URLSearchParams({ client_id: config.clientId,
      client_secret: config.clientSecret, ...parameters }).toString() });
  if (typeof data?.access_token !== 'string' || data.access_token.length > 8192 || !data.access_token
    || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400
    || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'
    || data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 8192)) fail('gscReconnectRequired', 409);
  if (data.scope && !String(data.scope).split(' ').includes(GSC_SCOPE)) fail('gscPermissionDenied', 403);
  return data;
}
function readGrant(box, user, config) {
  try {
    const grant = openJson(box, config.key, purpose(user, 'grant'));
    if (!grant.refreshToken || !grant.accessToken || !Number.isFinite(grant.expiresAt)) throw new Error('Invalid grant');
    return grant;
  } catch { fail('gscCredentialsUnavailable', 409); }
}

// Every pull is constrained to the project's exact hosts, even when Google
// grants access to a larger domain property. Property prefixes remain in force.
export function propertyFilter(property, projectUrls) {
  if (typeof property !== 'string' || property.length > 2048 || !Array.isArray(projectUrls) || !projectUrls.length) fail('gscPropertyMismatch');
  let domain, prefix;
  if (property.startsWith('sc-domain:')) {
    domain = property.slice(10).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || !domain.includes('.')) fail('gscPropertyMismatch');
  } else {
    try { prefix = new URL(property); } catch { fail('gscPropertyMismatch'); }
    if (!['http:', 'https:'].includes(prefix.protocol) || prefix.username || prefix.password || prefix.search || prefix.hash || !['', '80', '443'].includes(prefix.port)) fail('gscPropertyMismatch');
  }
  const hosts = new Set();
  for (const value of projectUrls) {
    let url; try { url = new URL(value); } catch { fail('gscPropertyMismatch'); }
    if (domain ? !(url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      : url.origin !== prefix.origin || !url.pathname.startsWith(prefix.pathname)) fail('gscPropertyMismatch');
    hosts.add(url.hostname.toLowerCase());
    if (domain) hosts.add(url.hostname.startsWith('www.') ? host(url.hostname) : `www.${url.hostname}`);
  }
  const filter = `^https?://(${[...hosts].sort().map(escapeRegex).join('|')})(:80|:443)?/`;
  if (filter.length > 4096) fail('gscPropertyMismatch');
  return filter;
}

export function installSearchConsoleRoutes(app, { User, Project, requireAuth, asyncHandler, authStamp, limit }) {
  const handler = fn => workflowHandler(asyncHandler, fn);
  async function connection(user) {
    const config = configured();
    const stored = await User.findById(user._id).select('+gscGrant').lean();
    if (!stored?.gscGrant) fail('gscNotConnected', 409);
    let box = stored.gscGrant, grant = readGrant(box, user, config);
    if (grant.expiresAt <= Date.now() + 60000) {
      const refreshed = await token(config, { grant_type: 'refresh_token', refresh_token: grant.refreshToken });
      grant = { ...grant, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || grant.refreshToken,
        expiresAt: Date.now() + refreshed.expires_in * 1000 };
      const next = sealJson(grant, config.key, purpose(user, 'grant'));
      const result = await User.updateOne({ ...sessionFilter(user), gscGrant: box }, { $set: { gscGrant: next } });
      if (!result.modifiedCount) fail('gscConnectionChanged', 409);
      box = next;
    }
    return { grant, box };
  }
  async function properties(grant) {
    const data = await call({ url: 'https://www.googleapis.com/webmasters/v3/sites', method: 'GET', headers: { Authorization: `Bearer ${grant.accessToken}` } });
    if (!data || typeof data !== 'object' || data.siteEntry !== undefined && !Array.isArray(data.siteEntry)) fail('gscProviderUnavailable', 502);
    return (data.siteEntry || []).filter(site => site && typeof site.siteUrl === 'string' && site.siteUrl.length <= 2048
      && ['siteOwner', 'siteFullUser', 'siteRestrictedUser'].includes(site.permissionLevel)).slice(0, 1000)
      .map(site => ({ siteUrl: site.siteUrl, permissionLevel: site.permissionLevel }));
  }

  app.get('/integrations/gsc/status', requireAuth, limit, handler(async (req, res) => {
    const user = await User.findById(req.authUser._id).select('+gscGrant').lean();
    res.json({ success: true, configured: Boolean(googleConfig()), connected: Boolean(user?.gscGrant), scope: GSC_SCOPE });
  }));
  app.post('/integrations/gsc/start', requireAuth, limit, handler(async (req, res) => {
    const config = configured(), user = req.authUser;
    const state = crypto.randomBytes(32).toString('hex'), verifier = crypto.randomBytes(32).toString('base64url');
    const pending = sealJson({ stateHash: hash(state), verifier, stamp: authStamp(user), expiresAt: Date.now() + 10 * 60000 }, config.key, purpose(user, 'pending'));
    const result = await User.updateOne(sessionFilter(user), { $set: { gscPending: pending } });
    if (!result.modifiedCount) fail('gscConnectionChanged', 409);
    const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: GSC_SCOPE,
      access_type: 'offline', prompt: 'consent', state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    res.json({ success: true, authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}` });
  }));
  // Strict session cookies do not accompany Google's cross-site redirect.
  // Return to the app first; a same-origin authenticated POST completes OAuth.
  app.get('/integrations/gsc/callback', (req, res) => {
    const validState = typeof req.query.state === 'string' && /^[a-f0-9]{64}$/.test(req.query.state);
    const code = req.query.code;
    const query = new URLSearchParams(validState && typeof code === 'string' && code.length > 0 && code.length <= 4096
      ? { gscCode: code, gscState: req.query.state } : { gscError: 'gscAuthorizationFailed' });
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(303, `/#${query}`);
  });
  app.post('/integrations/gsc/complete', requireAuth, limit, handler(async (req, res) => {
    const config = configured(), user = req.authUser, { state, code } = req.body || {};
    if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state) || typeof code !== 'string' || !code || code.length > 4096) fail('gscInvalidState');
    const stored = await User.findById(user._id).select('+gscPending').lean();
    let pending;
    try { pending = openJson(stored?.gscPending, config.key, purpose(user, 'pending')); } catch { fail('gscInvalidState'); }
    if (pending.expiresAt <= Date.now() || pending.stamp !== authStamp(user) || pending.stateHash !== hash(state)) fail('gscInvalidState');
    const consumedMarker = sealJson({ consumed: true, expiresAt: pending.expiresAt }, config.key, purpose(user, 'pending'));
    const consumed = await User.updateOne({ ...sessionFilter(user), gscPending: stored.gscPending }, { $set: { gscPending: consumedMarker } });
    if (!consumed.modifiedCount) fail('gscInvalidState');
    const data = await token(config, { code, code_verifier: pending.verifier, redirect_uri: config.redirectUri, grant_type: 'authorization_code' });
    if (typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 8192) fail('gscReconnectRequired', 409);
    const grant = sealJson({ refreshToken: data.refresh_token, accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }, config.key, purpose(user, 'grant'));
    const saved = await User.updateOne({ ...sessionFilter(user), gscPending: consumedMarker }, { $set: { gscGrant: grant }, $unset: { gscPending: 1 } });
    if (!saved.modifiedCount) fail('gscConnectionChanged', 409);
    res.json({ success: true, connected: true });
  }));
  app.get('/integrations/gsc/properties', requireAuth, limit, handler(async (req, res) => {
    const { grant } = await connection(req.authUser);
    res.json({ success: true, properties: await properties(grant) });
  }));
  app.delete('/integrations/gsc', requireAuth, limit, handler(async (req, res) => {
    const user = await User.findOneAndUpdate(sessionFilter(req.authUser), { $unset: { gscGrant: 1, gscPending: 1 } }, { new: false }).select('+gscGrant').lean();
    if (!user) fail('gscConnectionChanged', 409);
    let revoked = !user?.gscGrant;
    const config = googleConfig();
    if (user?.gscGrant && config) {
      try {
        const grant = readGrant(user.gscGrant, user, config);
        await call({ url: 'https://oauth2.googleapis.com/revoke', method: 'POST', timeout: 8000,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: new URLSearchParams({ token: grant.refreshToken }).toString() });
        revoked = true;
      } catch { /* Local credentials remain removed if Google cannot be reached. */ }
    }
    res.json({ success: true, connected: false, revoked });
  }));
  app.post('/projects/:id/search-performance/google', requireAuth, limit, handler(async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) fail('invalidProject');
    const project = await Project.findOne({ _id: req.params.id, userId: req.authUser._id }).lean();
    if (!project) fail('projectNotFound', 404);
    const { slot, property, kind = 'queries', start, end, device = 'all', country = 'all' } = req.body || {};
    if (!['baseline', 'current'].includes(slot) || !['queries', 'pages'].includes(kind)) fail('invalidImportSlot');
    searchPeriod(start, end);
    if (end > new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)) fail('gscDatesNotSettled');
    if (!['all', 'mobile', 'desktop', 'tablet'].includes(device) || typeof country !== 'string' || !/^(all|[a-z]{3})$/.test(country)) fail('gscInvalidCountry');
    const pageFilter = propertyFilter(property, project.urls);
    const { grant, box } = await connection(req.authUser);
    const available = await properties(grant);
    if (!available.some(site => site.siteUrl === property)) fail('gscPermissionDenied', 403);
    const filters = [{ dimension: 'page', operator: 'includingRegex', expression: pageFilter }];
    if (device !== 'all') filters.push({ dimension: 'device', operator: 'equals', expression: device });
    if (country !== 'all') filters.push({ dimension: 'country', operator: 'equals', expression: country });
    const data = await call({ url: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, method: 'POST',
      headers: { Authorization: `Bearer ${grant.accessToken}` }, data: { startDate: start, endDate: end, dimensions: [kind === 'pages' ? 'page' : 'query'],
        type: 'web', dataState: 'final', aggregationType: 'auto', rowLimit: MAX_IMPORT_ROWS + 1, startRow: 0, dimensionFilterGroups: [{ groupType: 'and', filters }] } });
    if (!data || typeof data !== 'object' || data.rows !== undefined && !Array.isArray(data.rows)) fail('gscProviderUnavailable', 502);
    const rows = (data.rows || []).map(row => {
      if (!row || !Array.isArray(row.keys) || row.keys.length !== 1 || typeof row.keys[0] !== 'string'
        || !['clicks', 'impressions', 'position'].every(key => typeof row[key] === 'number')) fail('gscProviderUnavailable', 502);
      return { key: row.keys[0], clicks: row.clicks, impressions: row.impressions, position: row.position };
    });
    const snapshot = createSearchSnapshot({ kind, start, end, device, country, rows }, project.urls,
      { source: 'google-search-console-api', property, pageFilter });
    if (!await User.exists({ ...sessionFilter(req.authUser), gscGrant: box })) fail('gscConnectionChanged', 409);
    const field = slot === 'baseline' ? 'performanceBaseline' : 'performanceCurrent';
    const saved = await Project.updateOne({ _id: project._id, userId: req.authUser._id, updatedAt: project.updatedAt }, { $set: { [field]: JSON.stringify(snapshot) } });
    if (!saved.modifiedCount) fail('gscProjectChanged', 409);
    res.json({ success: true, importedRows: snapshot.rowCount });
  }));
}
