import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { sealBytes, openBytes, readEncryptionKey, sealJson, openJson } from '../lib/secret-box.js';
import { createReportSnapshot, restoreReportSnapshot } from '../lib/report-storage.js';
import { createSearchSnapshot } from '../lib/search-performance.js';

const execute = promisify(execFile);
const uri = process.env.TEST_MONGODB_URI;
assert.ok(/^mongodb:\/\/127\.0\.0\.1:27019\/seo_beta_acceptance(?:\?replicaSet=beta-test)?$/.test(uri || ''),
  'Rehearsal only accepts the isolated loopback replica set, never production.');
const { MongoClient, BSON } = mongoose.mongo;
// One serial fixture rehearsal needs at most two pooled connections. Loopback
// selection/connect limits fail fast; 30 seconds comfortably bounds tiny reads.
const client = new MongoClient(uri, { maxPoolSize: 2, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 30000 });
let connected = false;
const suffix = crypto.randomBytes(8).toString('hex');
const sourceName = `seo_beta_backup_rehearsal_${suffix}`, targetName = `seo_beta_restore_rehearsal_${suffix}`;
const sourceUri = uri.replace('/seo_beta_acceptance', `/${sourceName}`);
const targetUri = uri.replace('/seo_beta_acceptance', `/${targetName}`);
const bin = process.env.MONGODB_TOOLS_BIN || '';
const output = path.resolve(process.env.BACKUP_REHEARSAL_OUTPUT || 'work/backup-rehearsal');
const temporary = await mkdtemp(path.join(tmpdir(), 'aegis-backup-rehearsal-'));
const archive = path.join(temporary, 'fixture.archive.gz');
const verifiedArchive = path.join(temporary, 'verified.archive.gz');
const key = process.env.BACKUP_ENCRYPTION_KEY ? readEncryptionKey(process.env.BACKUP_ENCRYPTION_KEY) : crypto.randomBytes(32);
const purpose = 'aegis:backup-rehearsal:v1';
const summary = { version: 1, fixtureOnly: true, productionDataAccessed: false, concurrentWritesTested: false,
  verifiedAt: new Date().toISOString(), collections: [], encryption: 'AES-256-GCM', cleanup: false };
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const canonical = value => JSON.stringify(stable(BSON.EJSON.serialize(value, { relaxed: false })));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
async function tool(name, args) {
  // These commands receive only isolated loopback URIs, never production secrets.
  try { return await execute(bin ? path.join(bin, name) : name, args, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }); }
  catch { throw new Error(`${name} failed. Install MongoDB Database Tools and check the isolated replica set.`); }
}
await mkdir(output, { recursive: true, mode: 0o700 });
try {
  await client.connect();
  connected = true;
  const source = client.db(sourceName), target = client.db(targetName);
  const userId = new mongoose.Types.ObjectId(), projectId = new mongoose.Types.ObjectId();
  const fixtureGrant = sealJson({ refreshToken: 'synthetic-refresh-only', accessToken: 'synthetic-access-only', expiresAt: Date.now() + 3600000 }, key, `gsc:grant:${userId}`);
  await source.collection('users').insertOne({ _id: userId, email: 'backup-fixture@example.com', passwordHash: await bcrypt.hash('fixture-rehearsal-password', 12),
    apiKey: 'synthetic-api-key', sessionVersion: 3, scansToday: 0, gscGrant: fixtureGrant, createdAt: new Date('2026-01-01T00:00:00Z') });
  await source.collection('users').createIndex({ email: 1 }, { unique: true });
  await source.collection('users').createIndex({ apiKey: 1 }, { unique: true });
  await source.collection('projects').insertOne({ _id: projectId, userId, name: '\u0645\u0634\u0631\u0648\u0639', urls: ['https://example.com/'],
    performanceCurrent: JSON.stringify(createSearchSnapshot({ start: '2026-01-01', end: '2026-01-28', kind: 'queries',
      rows: [{ key: '\u0646\u0645\u0648\u0646\u06c1', clicks: 0, impressions: 100, position: 9 }] }, ['https://example.com/'])) });
  await source.collection('projects').createIndex({ userId: 1 });
  await source.collection('reports').insertOne({ userId, projectId, url: 'https://example.com/', seoScore: 0,
    ...createReportSnapshot({ success: true, resolvedUrl: 'https://example.com/', analysisVersion: 'backup-fixture-v1', title: '\u0631\u067e\u0648\u0631\u0679',
      seoScore: 0, geoScore: null, contentEvidence: { findings: [] } }) });
  await source.collection('sitecrawljobs').insertOne({ userId, status: 'interrupted', pages: [{ url: 'https://example.com/', status: 'success' }] });
  await source.collection('passwordresets').insertOne({ userId, tokenHash: digest('synthetic-reset'), expiresAt: new Date(Date.now() + 86400000) });
  await source.collection('passwordresets').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const names = (await source.listCollections().toArray()).map(item => item.name).sort();
  const expected = new Map();
  for (const name of names) expected.set(name, {
    documents: canonical(await source.collection(name).find().sort({ _id: 1 }).toArray()),
    indexes: canonical((await source.collection(name).indexes()).sort((a, b) => a.name.localeCompare(b.name)))
  });
  const dumpVersion = await tool('mongodump', ['--version']);
  summary.tools = dumpVersion.stdout.split('\n')[0];
  await tool('mongodump', ['--uri', sourceUri, `--archive=${archive}`, '--gzip']);
  assert.ok((await stat(archive)).size < 20 * 1024 * 1024, 'Fixture archive unexpectedly large');
  const plaintext = await readFile(archive);
  const encrypted = sealBytes(plaintext, key, purpose);
  const encryptedFile = path.join(output, 'synthetic-backup.aesgcm');
  await writeFile(encryptedFile, encrypted, { mode: 0o600 });
  const fromDisk = await readFile(encryptedFile, 'utf8');
  assert.throws(() => openBytes(fromDisk, crypto.randomBytes(32), purpose));
  const parts = fromDisk.split('.');
  const changed = Buffer.from(parts[3], 'base64url'); changed[0] ^= 1; parts[3] = changed.toString('base64url');
  assert.throws(() => openBytes(parts.join('.'), key, purpose));
  const decrypted = openBytes(fromDisk, key, purpose);
  assert.equal(digest(decrypted), digest(plaintext));
  await writeFile(verifiedArchive, decrypted, { mode: 0o600 });
  await tool('mongorestore', ['--uri', targetUri, `--archive=${verifiedArchive}`, '--gzip', '--stopOnError',
    `--nsInclude=${sourceName}.*`, `--nsFrom=${sourceName}.*`, `--nsTo=${targetName}.*`]);
  assert.deepEqual((await target.listCollections().toArray()).map(item => item.name).sort(), names);
  for (const name of names) {
    const rows = await target.collection(name).find().sort({ _id: 1 }).toArray();
    const indexes = (await target.collection(name).indexes()).sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(canonical(rows), expected.get(name).documents, `${name}: BSON document mismatch`);
    assert.equal(canonical(indexes), expected.get(name).indexes, `${name}: index mismatch`);
    summary.collections.push({ name, documents: rows.length, indexes: indexes.length, digest: digest(canonical(rows)) });
  }
  const restoredReport = await target.collection('reports').findOne({ userId });
  assert.ok(await target.collection('projects').findOne({ _id: restoredReport.projectId, userId }));
  assert.equal(restoreReportSnapshot(restoredReport).seoScore, 0);
  assert.equal(restoreReportSnapshot(restoredReport).geoScore, null);
  assert.equal((await target.collection('users').findOne({ _id: userId })).gscGrant, fixtureGrant);
  assert.equal(openJson(fixtureGrant, key, `gsc:grant:${userId}`).refreshToken, 'synthetic-refresh-only');
  assert.ok(await bcrypt.compare('fixture-rehearsal-password', (await target.collection('users').findOne({ _id: userId })).passwordHash));
  await assert.rejects(target.collection('users').insertOne({ email: 'backup-fixture@example.com', apiKey: 'another-fixture-key' }), error => error.code === 11000);
  summary.restoredReportOpened = true; summary.restoredPasswordVerified = true; summary.uniqueIndexEnforced = true; summary.restoredGrantDecrypted = true;
  summary.encryptedArchiveSha256 = digest(fromDisk);
  summary.wrongKeyRejected = true; summary.tamperingRejected = true; summary.passed = true;
} catch (error) {
  summary.passed = false; summary.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    if (connected) {
      await client.db(sourceName).dropDatabase(); await client.db(targetName).dropDatabase(); summary.cleanup = true;
    }
  } catch { summary.cleanupError = 'Could not remove an isolated rehearsal database.'; process.exitCode = 1; }
  await client.close().catch(() => { process.exitCode = 1; });
  await rm(temporary, { recursive: true, force: true });
  await writeFile(path.join(output, 'results.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary));
}
