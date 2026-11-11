import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseLifecycle, databaseFailureCategory } from '../lib/database.js';
import { createReportSnapshot, restoreReportSnapshot, MAX_SNAPSHOT_BYTES } from '../lib/report-storage.js';

test('initial MongoDB failures retry once with backoff and share the in-flight connection', async () => {
  let calls = 0;
  const scheduled = [];
  const connection = {};
  const lifecycle = createDatabaseLifecycle({
    connect: async () => { if (++calls < 3) throw new Error('not ready'); return connection; },
    onFailure() {}, random: () => 0,
    schedule: (fn, delay) => { const timer = { fn, delay }; scheduled.push(timer); return timer; },
    cancel() {}
  });
  assert.equal(lifecycle.start(), lifecycle.start());
  assert.equal(await lifecycle.start(), null);
  assert.equal(scheduled[0].delay, 1000);
  scheduled[0].fn();
  await lifecycle.start();
  assert.equal(scheduled[1].delay, 2000);
  scheduled[1].fn();
  assert.equal(await lifecycle.start(), connection);
  assert.equal(await lifecycle.start(), connection);
  assert.equal(calls, 3);
  lifecycle.stop();
  assert.equal(await lifecycle.start(), null);
});

test('stopping during an initial database connection failure prevents later retries', async () => {
  let rejectConnection;
  let scheduled = 0;
  const lifecycle = createDatabaseLifecycle({
    connect: () => new Promise((resolve, reject) => { rejectConnection = reject; }),
    onFailure() {}, schedule: () => { scheduled++; }
  });
  const pending = lifecycle.start();
  await Promise.resolve();
  lifecycle.stop();
  rejectConnection(new Error('offline'));
  assert.equal(await pending, null);
  assert.equal(scheduled, 0);
});

test('database diagnostics classify failures without returning connection details', () => {
  assert.equal(databaseFailureCategory(new Error('querySrv ENOTFOUND secret-host')), 'DNS_LOOKUP');
  assert.equal(databaseFailureCategory(new Error('bad auth: password=secret')), 'AUTHENTICATION');
  assert.equal(databaseFailureCategory(new Error('Server selection timed out')), 'NETWORK_OR_ACCESS_LIST');
});

test('versioned snapshots preserve evidence and measured zero without retaining stale persistence metadata', () => {
  const payload = { success: true, analysisVersion: 'fixture-v1', seoScore: 0, contentEvidence: { topic: 'اردو پښتو العربية' },
    reportId: 'old-report', recovered: true, persistence: { saved: false } };
  const snapshot = createReportSnapshot(payload);
  const restored = restoreReportSnapshot({ ...snapshot, _id: 'new-report' });
  assert.equal(restored.seoScore, 0);
  assert.equal(restored.contentEvidence.topic, payload.contentEvidence.topic);
  assert.equal(restored.analysisVersion, 'fixture-v1');
  assert.equal(restored.reportId, 'new-report');
  assert.deepEqual(restored.persistence, { saved: true, fullReport: true });
  assert.equal(JSON.parse(snapshot.snapshotJSON).result.reportId, undefined);
  assert.equal(payload.reportId, 'old-report');
});

test('oversized, corrupt, future and historical summary reports do not masquerade as full reports', () => {
  assert.deepEqual(createReportSnapshot({ success: true, text: 'x'.repeat(MAX_SNAPSHOT_BYTES) }), { snapshotStatus: 'too_large' });
  for (const snapshotJSON of [undefined, '{', '{"version":99,"result":{"success":true}}']) {
    assert.equal(restoreReportSnapshot({ snapshotStatus: 'complete', snapshotJSON }), null);
  }
  assert.equal(restoreReportSnapshot({}), null);
});
