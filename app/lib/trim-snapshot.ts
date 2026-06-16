import type { DashboardSnapshot, DashboardSignal } from "@/lib/types";

/**
 * The worker snapshot is ~1.9MB, ~94% of which is per-signal forensic blobs the
 * dashboard never renders (reconciliationResolution evidence, raw venue
 * confirmations, recovery/quarantine evidence, full quote snapshots, lead-lag
 * windows). Strip them in the proxy so the browser receives ~0.3MB. This is a
 * transport optimization only — every field the UI reads is preserved.
 */
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
  if (c.fillQualitySnapshot?.pairedFillConfidence) {
    const fq = { ...c.fillQualitySnapshot };
    delete fq.pairedFillConfidence;
    c.fillQualitySnapshot = fq;
  }
  return c;
}

export function trimSnapshot(snap: DashboardSnapshot): DashboardSnapshot {
  return { ...snap, recentSignals: (snap.recentSignals ?? []).map(trimSignal) };
}
