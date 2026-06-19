import type { DashboardSnapshot, DashboardSignal } from "@/lib/types";

/**
 * The worker snapshot is large, the vast majority of which is per-signal forensic
 * blobs the dashboard never renders. Strip them in the proxy so the browser
 * receives a small payload. Transport optimization ONLY — every field any view
 * reads is preserved (the kept key sets below are the verified union of what the
 * ledger, execution, overview, performance, and 3D views actually read).
 */
// executionTimings is ~30 fields of instrumentation; the UI reads only these scalars
// (LedgerView ExpandedTrade, executionAggregates, ThreeDView). All fields are optional,
// so a subset is still a valid ExecutionTimings.
const KEEP_TIMING_KEYS = new Set([
  "totalMs", "kalshiRttMs", "polymarketRttMs", "polymarketConfirmationMs", "venueSubmitSkewMs",
]);
// fillQualitySnapshot.features is large; ExecutionView's latency rows (firstFeature) read only these
// percentile keys, and only from the first row that has them.
const KEEP_FEATURE_KEYS = new Set([
  "kalshiRttP50Ms", "kalshiRttP95Ms", "polymarketRttP50Ms", "polymarketRttP95Ms", "polymarketConfirmationP95Ms",
]);

function pickKeys<T extends object>(obj: T, keep: Set<string>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (keep.has(k) && v != null) out[k] = v;
  return out as T;
}

function trimSignal(s: DashboardSignal): DashboardSignal {
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

export function trimSnapshot(snap: DashboardSnapshot): DashboardSnapshot {
  return { ...snap, recentSignals: (snap.recentSignals ?? []).map(trimSignal) };
}
