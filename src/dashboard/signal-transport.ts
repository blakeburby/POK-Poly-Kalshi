import type { DashboardSignal } from "../types";

// The ONLY keys any dashboard view reads from the heavy per-signal blobs (verified union across the Ledger,
// Execution, Overview, Performance, and 3D views). Everything else is forensic instrumentation the UI never
// renders. executionTimings is ~30 fields (UI reads 5); fillQualitySnapshot.features is ~1KB/row that
// ExecutionView reads 5 percentile keys from (and only from the first row that has them).
const KEEP_TIMING_KEYS = new Set([
  "totalMs",
  "kalshiRttMs",
  "polymarketRttMs",
  "polymarketConfirmationMs",
  "venueSubmitSkewMs",
]);
const KEEP_FEATURE_KEYS = new Set([
  "kalshiRttP50Ms",
  "kalshiRttP95Ms",
  "polymarketRttP50Ms",
  "polymarketRttP95Ms",
  "polymarketConfirmationP95Ms",
]);

function pickKeys<T extends object>(obj: T, keep: Set<string>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (keep.has(k) && v != null) out[k] = v;
  return out as T;
}

/**
 * Transport-trim ONE signal for the dashboard: keep every field a view reads, drop the heavy forensic
 * blobs/sub-objects. Used by BOTH the snapshot proxy (app/lib/trim-snapshot) and the worker SSE stream so
 * the browser never receives the unused bulk over either transport. Pure + dependency-free (types only).
 */
export function trimSignalForTransport(s: DashboardSignal): DashboardSignal {
  const c: DashboardSignal = { ...s };
  delete c.quoteSnapshot;
  delete c.venueConfirmations;
  delete c.recoveryEvidence;
  delete c.riskQuarantineEvidence;
  delete c.reconciliationResolution;
  if (c.leadLagSnapshot && c.leadLagSnapshot.windows.length > 0) {
    c.leadLagSnapshot = { ...c.leadLagSnapshot, windows: [] };
  }
  if (c.fillQualitySnapshot) {
    const fq = { ...c.fillQualitySnapshot };
    delete fq.pairedFillConfidence;
    if (fq.features) fq.features = pickKeys(fq.features, KEEP_FEATURE_KEYS);
    c.fillQualitySnapshot = fq;
  }
  if (c.executionTimings) c.executionTimings = pickKeys(c.executionTimings, KEEP_TIMING_KEYS);
  return c;
}

/**
 * Cheap change-fingerprint of the recent-signals list: row count + newest updated_at. Inserts bump the
 * count/newest; any signal update sets updated_at=NOW(), so this changes on every meaningful ledger change.
 * Used to push recentSignals over the realtime stream ONLY when it actually changed (not every frame).
 */
export function recentSignalsSignature(signals: DashboardSignal[]): string {
  let maxUpdated = 0;
  for (const s of signals) {
    const t = Date.parse(s.updatedAt);
    if (Number.isFinite(t) && t > maxUpdated) maxUpdated = t;
  }
  return `${signals.length}:${maxUpdated}`;
}
