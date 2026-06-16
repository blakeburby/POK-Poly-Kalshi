"use client";

import { create } from "zustand";
import { useEffect } from "react";
import type { DashboardSnapshot } from "@/lib/types";
import { generateMockSnapshot } from "@/lib/mock";

export type FeedSource = "connecting" | "live" | "degraded" | "mock";
export type ViewId =
  | "overview"
  | "performance"
  | "execution"
  | "risk"
  | "ledger"
  | "edge"
  | "books"
  | "health"
  | "threeD";

interface DashboardState {
  snapshot: DashboardSnapshot | null;
  source: FeedSource;
  lastEventAt: number | null;
  view: ViewId;
  reducedMotion: boolean;
  setSnapshot: (snapshot: DashboardSnapshot, source: FeedSource) => void;
  setSource: (source: FeedSource) => void;
  setView: (view: ViewId) => void;
  setReducedMotion: (v: boolean) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  snapshot: null,
  source: "connecting",
  lastEventAt: null,
  view: "overview",
  reducedMotion: false,
  setSnapshot: (snapshot, source) => set({ snapshot, source, lastEventAt: Date.now() }),
  setSource: (source) => set({ source }),
  setView: (view) => set({ view }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
}));

function demoMode(): boolean {
  if (process.env.NEXT_PUBLIC_DEMO === "1") return true;
  if (typeof window !== "undefined" && window.location.search.includes("demo=1")) return true;
  return false;
}

/** Fast poll of the lightweight live slice (books / scanner / candidates / op-status). */
const POLL_LIVE_MS = 750;
/** Slow poll of the heavy slice (trade ledger / analytics / balances / logs). */
const POLL_HEAVY_MS = 6000;
/** Heavy-slice keys pulled from the full snapshot; everything else comes from the live slice. */
const HEAVY_KEYS = ["recentSignals", "analytics", "tradingActivity", "logs"] as const;

/**
 * Two-rate polling for a near-live feel on serverless (no long-lived SSE/WS,
 * which Vercel functions cut off):
 *  - FAST (~750ms): the lightweight /dashboard/live slice (books, scanner, live
 *    candidates, op-status) — a few KB the worker serves in ~ms.
 *  - SLOW (~6s): the full snapshot, from which only the heavy slice (trade
 *    ledger, analytics, balances, logs) is merged in.
 * Both merge into one snapshot so views are unchanged. The last good snapshot
 * stays visible on a transient failure (degraded badge, never fabricated data).
 * Demo mode renders from the mock generator instead.
 */
export function useDashboardStream(): void {
  const setSnapshot = useDashboardStore((s) => s.setSnapshot);
  const setSource = useDashboardStore((s) => s.setSource);

  useEffect(() => {
    let cancelled = false;
    let liveTimer: ReturnType<typeof setTimeout> | null = null;
    let heavyTimer: ReturnType<typeof setTimeout> | null = null;
    const current: { snap: DashboardSnapshot | null } = { snap: null };

    const apply = (patch: Partial<DashboardSnapshot>) => {
      if (cancelled) return;
      current.snap = { ...(current.snap ?? {}), ...patch } as DashboardSnapshot;
      setSnapshot(current.snap, "live");
    };

    if (demoMode()) {
      const tick = () => {
        if (cancelled) return;
        current.snap = generateMockSnapshot();
        setSnapshot(current.snap, "mock");
        liveTimer = setTimeout(tick, 1500);
      };
      tick();
      return () => {
        cancelled = true;
        if (liveTimer) clearTimeout(liveTimer);
      };
    }

    const liveLoop = async () => {
      try {
        const res = await fetch("/api/dashboard/live", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        apply((await res.json()) as Partial<DashboardSnapshot>);
      } catch {
        if (!cancelled) setSource("degraded");
      } finally {
        if (!cancelled) liveTimer = setTimeout(liveLoop, POLL_LIVE_MS);
      }
    };

    const heavyLoop = async () => {
      try {
        const res = await fetch("/api/dashboard/snapshot", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const full = (await res.json()) as DashboardSnapshot;
        const heavy: Partial<DashboardSnapshot> = {};
        for (const k of HEAVY_KEYS) (heavy as Record<string, unknown>)[k] = full[k];
        apply(heavy);
      } catch {
        if (!cancelled) setSource("degraded");
      } finally {
        if (!cancelled) heavyTimer = setTimeout(heavyLoop, POLL_HEAVY_MS);
      }
    };

    // Pull one full snapshot first so the initial render is complete, then split.
    const bootstrap = async () => {
      try {
        const res = await fetch("/api/dashboard/snapshot", { cache: "no-store" });
        if (res.ok) apply((await res.json()) as DashboardSnapshot);
      } catch {
        /* the loops below will retry */
      }
      if (cancelled) return;
      void liveLoop();
      heavyTimer = setTimeout(heavyLoop, POLL_HEAVY_MS);
    };
    void bootstrap();

    return () => {
      cancelled = true;
      if (liveTimer) clearTimeout(liveTimer);
      if (heavyTimer) clearTimeout(heavyTimer);
    };
  }, [setSnapshot, setSource]);
}
