"use client";

import * as React from "react";
import { useDashboardStore } from "@/store/dashboard-store";
import { fmtMs, fmtClock } from "@/lib/format";
import { useNow } from "@/hooks/useNow";

export function StatusBar() {
  const snap = useDashboardStore((s) => s.snapshot);
  const source = useDashboardStore((s) => s.source);
  const now = useNow(1000);
  // The wall-clock is time-dependent, so SSR and the first client paint disagree — render it only after
  // mount to avoid a hydration mismatch (the rest of the bar is snapshot-derived and hydrates cleanly).
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const lat = snap?.latency;
  const items: Array<[string, string]> = snap
    ? [
        ["SNAP", fmtMs(lat?.dashboard.snapshotBuildMs.latestMs ?? null)],
        ["STREAM", `${lat?.dashboard.streamIntervalMs ?? 0}ms`],
        ["K-BOOK", fmtMs(lat?.books.kalshi.p50Ms ?? null)],
        ["P-BOOK", fmtMs(lat?.books.polymarket.p50Ms ?? null)],
        ["SCAN", fmtMs(lat?.scanner.scanDurationMs.p50Ms ?? null)],
        ["DECISION", fmtMs(lat?.scanner.bookUpdateToDecisionMs.p95Ms ?? null)],
        ["EXEC", fmtMs(lat?.execution.durationMs.p50Ms ?? null)],
        ["MODEL", `fq ${snap.health.liveFillQualityModelVersion} · ll ${snap.health.liveLeadLagModelVersion}`],
      ]
    : [];

  return (
    <footer className="hidden h-[var(--statusbar-h)] shrink-0 items-center gap-4 overflow-x-auto border-t border-line bg-surface px-3 font-mono text-[10px] text-fg-muted lg:flex">
      <span className="uppercase tracking-[0.1em] text-fg-faint">{source === "mock" ? "DEMO" : "WORKER"}</span>
      {items.map(([k, v]) => (
        <span key={k} className="flex shrink-0 items-center gap-1.5">
          <span className="uppercase tracking-wide text-fg-faint">{k}</span>
          <span className="tabular-nums text-fg-secondary">{v}</span>
        </span>
      ))}
      <button
        onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }))}
        title="Keyboard shortcuts"
        className="ml-auto shrink-0 uppercase tracking-wide text-fg-faint transition-colors hover:text-fg-secondary"
      >
        ? shortcuts
      </button>
      <span className="shrink-0 tabular-nums text-fg-secondary" suppressHydrationWarning>
        {mounted ? fmtClock(now, true) : "—"}
      </span>
    </footer>
  );
}
