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

/** Fallback poll of the live slice when the realtime stream is unavailable. */
const POLL_LIVE_MS = 750;
/** Slow poll of the heavy slice (trade ledger / analytics / balances / logs). */
const POLL_HEAVY_MS = 6000;
/** Refresh the realtime token before its 60s expiry (reconnect with a fresh one). */
const RT_REFRESH_MS = 50_000;
/** Backoff before retrying the realtime connection after an error. */
const RT_RECONNECT_MS = 8000;
/** Heavy-slice keys pulled from the full snapshot; everything else comes from the live slice. */
const HEAVY_KEYS = ["recentSignals", "analytics", "tradingActivity", "logs"] as const;

/**
 * Realtime-first feed:
 *  - PRIMARY: a direct EventSource to the worker (api.pokstrategies.com/dashboard/
 *    live/stream), authed with a short-lived token from /api/realtime-token. The
 *    worker pushes the live slice the instant it changes — true sub-second updates,
 *    bypassing the Vercel hop. Token is refreshed before expiry.
 *  - FALLBACK: if realtime isn't configured/reachable, fast-poll /api/dashboard/live.
 *  - HEAVY: always slow-poll the full snapshot for ledger/analytics/balances/logs.
 * All sources merge into one snapshot (live keys vs heavy keys are disjoint), so
 * views are unchanged. Last good snapshot stays on transient failure. Demo mode
 * renders from the mock generator.
 */
export function useDashboardStream(): void {
  const setSnapshot = useDashboardStore((s) => s.setSnapshot);
  const setSource = useDashboardStore((s) => s.setSource);

  useEffect(() => {
    let cancelled = false;
    let liveTimer: ReturnType<typeof setTimeout> | null = null;
    let heavyTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;
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

    // --- fallback live polling (only while the realtime stream is not active) ---
    const liveLoop = async () => {
      if (cancelled || es) return;
      try {
        const res = await fetch("/api/dashboard/live", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        apply((await res.json()) as Partial<DashboardSnapshot>);
      } catch {
        if (!cancelled) setSource("degraded");
      } finally {
        if (!cancelled && !es) liveTimer = setTimeout(liveLoop, POLL_LIVE_MS);
      }
    };
    const startFallbackPoll = () => {
      if (!cancelled && !liveTimer && !es) void liveLoop();
    };
    const stopFallbackPoll = () => {
      if (liveTimer) clearTimeout(liveTimer);
      liveTimer = null;
    };

    // --- heavy slice (always polled slowly) ---
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

    // --- realtime stream (primary) ---
    const scheduleReconnect = () => {
      if (!cancelled && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void connectRealtime();
        }, RT_RECONNECT_MS);
      }
    };
    const connectRealtime = async () => {
      if (cancelled) return;
      try {
        const res = await fetch("/api/realtime-token", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const { token, url } = (await res.json()) as { token?: string; url?: string };
        if (cancelled) return;
        if (!token || !url) throw new Error("realtime_unconfigured");
        const source = new EventSource(`${url}?token=${encodeURIComponent(token)}`);
        es = source;
        source.addEventListener("live", (event) => {
          stopFallbackPoll();
          try {
            apply(JSON.parse((event as MessageEvent).data) as Partial<DashboardSnapshot>);
          } catch {
            /* ignore malformed frame */
          }
        });
        source.onerror = () => {
          source.close();
          if (es === source) es = null;
          if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
          }
          startFallbackPoll();
          scheduleReconnect();
        };
        // Reconnect with a fresh token before the current one expires.
        refreshTimer = setTimeout(() => {
          source.close();
          if (es === source) es = null;
          void connectRealtime();
        }, RT_REFRESH_MS);
      } catch {
        es = null;
        startFallbackPoll();
        scheduleReconnect();
      }
    };

    // Pull one full snapshot first for a complete initial render, then go live.
    const bootstrap = async () => {
      try {
        const res = await fetch("/api/dashboard/snapshot", { cache: "no-store" });
        if (res.ok) apply((await res.json()) as DashboardSnapshot);
      } catch {
        /* loops below will retry */
      }
      if (cancelled) return;
      heavyTimer = setTimeout(heavyLoop, POLL_HEAVY_MS);
      startFallbackPoll();
      void connectRealtime();
    };
    void bootstrap();

    return () => {
      cancelled = true;
      es?.close();
      if (liveTimer) clearTimeout(liveTimer);
      if (heavyTimer) clearTimeout(heavyTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [setSnapshot, setSource]);
}
