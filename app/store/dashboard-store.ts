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

/**
 * Opens the worker SSE stream and feeds the store. In demo mode (or when the
 * live feed is unavailable in dev), drives the store from the mock generator so
 * every view renders. In production a dead feed yields a "degraded" state with
 * the last snapshot — never fabricated data.
 */
export function useDashboardStream(): void {
  const setSnapshot = useDashboardStore((s) => s.setSnapshot);
  const setSource = useDashboardStore((s) => s.setSource);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let mockTimer: ReturnType<typeof setInterval> | null = null;

    const startMock = () => {
      if (cancelled || mockTimer) return;
      const tick = () => {
        if (!cancelled) setSnapshot(generateMockSnapshot(), "mock");
      };
      tick();
      mockTimer = setInterval(tick, 2000);
    };

    if (demoMode()) {
      startMock();
      return () => {
        cancelled = true;
        if (mockTimer) clearInterval(mockTimer);
      };
    }

    const openStream = () => {
      es = new EventSource("/api/dashboard/stream");
      es.addEventListener("snapshot", (event) => {
        try {
          const snap = JSON.parse((event as MessageEvent).data) as DashboardSnapshot;
          if (!cancelled) setSnapshot(snap, "live");
        } catch {
          /* ignore malformed frame */
        }
      });
      es.addEventListener("error", () => {
        if (!cancelled) setSource("degraded");
      });
    };

    const bootstrap = async () => {
      try {
        const res = await fetch("/api/dashboard/snapshot", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const snap = (await res.json()) as DashboardSnapshot;
        if (cancelled) return;
        setSnapshot(snap, "live");
        openStream();
      } catch {
        if (cancelled) return;
        // No live feed reachable in dev → fall back to mock so the UI is usable.
        startMock();
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      es?.close();
      if (mockTimer) clearInterval(mockTimer);
    };
  }, [setSnapshot, setSource]);
}
