import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sealBytes, openBytes, sealJson, openJson, readEncryptionKey } from '../lib/secret-box.js';
import { propertyFilter, googleConfig } from '../lib/google-search-console.js';
import { createSearchSnapshot, analyzeSearchPerformance } from '../lib/search-performance.js';

test('AES-GCM binds private tokens to their account and detects wrong keys, tampering and malformed envelopes', () => {
  const key = crypto.randomBytes(32), value = { refreshToken: 'fixture-token', expiresAt: 1 };
  const box = sealJson(value, key, 'account:one');
  assert.deepEqual(openJson(box, key, 'account:one'), value);
  assert.ok(!box.includes('fixture-token'));
  assert.notEqual(sealJson(value, key, 'account:one'), box);
  assert.throws(() => openJson(box, key, 'account:two'));
  assert.throws(() => openJson(box, crypto.randomBytes(32), 'account:one'));
  const parts = box.split('.'), data = Buffer.from(parts[3], 'base64url'); data[0] ^= 1; parts[3] = data.toString('base64url');
  assert.throws(() => openJson(parts.join('.'), key, 'account:one'));
  for (const invalid of [null, '', 'v1.a.b.c', box + '.extra']) assert.throws(() => openBytes(invalid, key, 'account:one'));
  assert.deepEqual(readEncryptionKey(key.toString('base64')), key);
  for (const invalid of ['', key.toString('hex'), key.toString('base64') + '\n']) {
    assert.throws(() => readEncryptionKey(invalid));
  }
  assert.deepEqual(openBytes(sealBytes(Buffer.from('backup'), key, 'backup'), key, 'backup'), Buffer.from('backup'));
});

test('Google property matching constrains domain grants to exact project hosts and respects URL prefixes', () => {
  const expression = propertyFilter('sc-domain:example.com', ['https://blog.example.com/guide']);
  const pattern = new RegExp(expression);
  assert.ok(pattern.test('https://blog.example.com/page'));
  assert.ok(!pattern.test('https://evil.example.com/page'));
  assert.ok(!pattern.test('https://blog.example.com.evil.net/page'));
  assert.ok(!pattern.test('https://blogXexample.com/page'));
  assert.ok(propertyFilter('https://example.com/blog/', ['https://example.com/blog/post']));
  for (const [property, urls] of [
    ['sc-domain:example.com.evil.net', ['https://example.com/']],
    ['sc-domain:example.com', ['https://example.com/', 'https://other.net/']],
    ['https://example.com/blog/', ['https://example.com/blogger/post']],
    ['https://example.com/', ['https://www.example.com/']],
    ['https://user:password@example.com/', ['https://example.com/']],
    ['javascript:alert(1)', ['https://example.com/']]
  ]) assert.throws(() => propertyFilter(property, urls));
});

test('direct Google snapshots keep provider provenance and never compare against unverifiable CSV scope', () => {
  const input = { start: '2026-01-01', end: '2026-01-28', kind: 'queries', rows: [{ key: 'observed query', clicks: 0, impressions: 100, position: 9 }] };
  const provenance = { source: 'google-search-console-api', property: 'sc-domain:example.com', pageFilter: '^https' };
  const direct = createSearchSnapshot(input, ['https://example.com/'], provenance);
  const csv = createSearchSnapshot({ ...input, start: '2025-12-01', end: '2025-12-28' }, ['https://example.com/']);
  assert.equal(direct.independentlyVerified, true);
  assert.equal(direct.scope.timeZone, 'America/Los_Angeles');
  assert.equal(analyzeSearchPerformance(csv, direct).comparisonReason, 'scopeMismatch');
  assert.equal(analyzeSearchPerformance(null, direct).source, 'google-search-console-api');
  const empty = createSearchSnapshot({ ...input, rows: [] }, ['https://example.com/'], provenance);
  assert.equal(empty.totals.clicks, 0); assert.equal(empty.totals.position, null);
});

test('Google configuration fails closed without an independent key and a canonical HTTPS production origin', () => {
  const names = ['GSC_ENABLED', 'APP_ORIGIN', 'GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GSC_TOKEN_ENCRYPTION_KEY', 'NODE_ENV'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, { GSC_ENABLED: 'true', APP_ORIGIN: 'https://app.example', GSC_CLIENT_ID: 'fixture',
      GSC_CLIENT_SECRET: 'fixture', GSC_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), NODE_ENV: 'production' });
    assert.equal(googleConfig().redirectUri, 'https://app.example/integrations/gsc/callback');
    for (const origin of ['http://app.example', 'https://app.example/', 'https://app.example/path', 'https://u:p@app.example']) {
      process.env.APP_ORIGIN = origin; assert.equal(googleConfig(), null);
    }
    process.env.APP_ORIGIN = 'https://app.example'; process.env.GSC_TOKEN_ENCRYPTION_KEY = '';
    assert.equal(googleConfig(), null);
    process.env.GSC_ENABLED = 'false'; assert.equal(googleConfig(), null);
  } finally { for (const name of names) if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; }
});
