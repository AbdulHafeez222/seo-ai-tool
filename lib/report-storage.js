export const SNAPSHOT_VERSION = 1;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export function createReportSnapshot(payload) {
  // Persistence metadata belongs to the new document, never a cached report.
  const { reportId, persistence, recovered, ...result } = payload;
  const json = JSON.stringify({ version: SNAPSHOT_VERSION, capturedAt: new Date().toISOString(), result });
  if (Buffer.byteLength(json) > MAX_SNAPSHOT_BYTES) return { snapshotStatus: 'too_large' };
  return { snapshotStatus: 'complete', snapshotJSON: json };
}

export function restoreReportSnapshot(report) {
  if (report.snapshotStatus !== 'complete' || !report.snapshotJSON) return null;
  try {
    const snapshot = JSON.parse(report.snapshotJSON);
    if (snapshot.version !== SNAPSHOT_VERSION || snapshot.result?.success !== true) return null;
    return { ...snapshot.result, reportId: String(report._id), recovered: true,
      capturedAt: snapshot.capturedAt, persistence: { saved: true, fullReport: true } };
  } catch { return null; }
}
