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

/** Gap between snapshot polls (after the previous one resolves). */
const POLL_MS = 4000;

/**
 * Feeds the store by polling the trimmed snapshot proxy. We deliberately do NOT
 * use the worker's SSE stream: the worker pushes a full ~1.9MB snapshot every
 * 250ms, and a long-lived proxied stream is cut by Vercel's function timeout —
 * together that produced the "slow / not connecting" behavior. Polling a
 * trimmed snapshot is short-lived, reliable on serverless, and keeps the last
 * good snapshot visible during a transient failure (never fabricated data). In
 * demo mode it renders from the mock generator instead.
 */
export function useDashboardStream(): void {
  const setSnapshot = useDashboardStore((s) => s.setSnapshot);
  const setSource = useDashboardStore((s) => s.setSource);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (demoMode()) {
      const tick = () => {
        if (cancelled) return;
        setSnapshot(generateMockSnapshot(), "mock");
        timer = setTimeout(tick, 2000);
      };
      tick();
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }

    const poll = async () => {
      try {
        const res = await fetch("/api/dashboard/snapshot", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const snap = (await res.json()) as DashboardSnapshot;
        if (!cancelled) setSnapshot(snap, "live");
      } catch {
        // Keep the last snapshot on screen; just flag the feed as degraded.
        if (!cancelled) setSource("degraded");
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [setSnapshot, setSource]);
}
