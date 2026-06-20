import type { DashboardSnapshot } from "@/lib/types";
import { trimSignalForTransport } from "../../src/dashboard/signal-transport";

/**
 * Strip the heavy per-signal forensic blobs in the snapshot proxy so the browser receives a small payload.
 * Transport optimization ONLY — every field any view reads is preserved. Shares the single-source
 * trimSignalForTransport with the worker SSE stream (src/dashboard/signal-transport), so both transports
 * emit identical lightweight signals and the key sets can't drift. Idempotent (safe on already-trimmed
 * data, e.g. the snapshot endpoint now trims at the source).
 */
export function trimSnapshot(snap: DashboardSnapshot): DashboardSnapshot {
  return { ...snap, recentSignals: (snap.recentSignals ?? []).map(trimSignalForTransport) };
}
