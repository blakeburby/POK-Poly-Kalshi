"use client";

import { useEffect, useRef, useState } from "react";
import type { DashboardSnapshot } from "../../src/types";
import type { TradingActivityEvent, TradingPlatform, TradingPlatformActivity } from "../../types/trading";

function mergeActivityEvent(current: TradingPlatformActivity, event: TradingActivityEvent): TradingPlatformActivity {
  const seen = new Set(current.history.map((row) => row.id));
  const history =
    event.row && !seen.has(event.row.id) ? [event.row, ...current.history].slice(0, 100) : current.history;
  const cashValue =
    current.portfolio.cashValue == null || event.cashDelta == null
      ? current.portfolio.cashValue
      : current.portfolio.cashValue + event.cashDelta;
  const portfolioValue =
    current.portfolio.portfolioValue == null || event.portfolioDelta == null
      ? current.portfolio.portfolioValue
      : current.portfolio.portfolioValue + event.portfolioDelta;
  const lastUpdatedAt = event.row?.timeMs ?? event.receivedAt;
  return {
    ...current,
    connectionStatus: "live",
    lastUpdatedAt,
    portfolio: {
      ...current.portfolio,
      cashValue,
      portfolioValue,
      lastUpdatedAt,
    },
    history,
  };
}

export function useTradingData(
  platform: TradingPlatform,
  initial?: TradingPlatformActivity,
): TradingPlatformActivity | null {
  const [activity, setActivity] = useState<TradingPlatformActivity | null>(initial ?? null);
  const fallbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const clearFallback = () => {
      if (fallbackTimerRef.current) {
        clearInterval(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };

    const loadActivity = async () => {
      try {
        const response = await fetch(`/api/trading/activity?platform=${platform}`, { cache: "no-store" });
        if (!response.ok) throw new Error(await response.text());
        const next = (await response.json()) as TradingPlatformActivity;
        if (!cancelled) setActivity({ ...next, connectionStatus: "live" });
      } catch {
        if (!cancelled)
          setActivity((current) => (current ? { ...current, connectionStatus: "reconnecting" } : current));
      }
    };

    void loadActivity();
    const stream = new EventSource("/api/dashboard/stream");
    stream.onopen = () => {
      clearFallback();
      setActivity((current) => (current ? { ...current, connectionStatus: "live" } : current));
    };
    stream.addEventListener("snapshot", (event) => {
      const snapshot = JSON.parse((event as MessageEvent).data) as DashboardSnapshot;
      const next = snapshot.tradingActivity?.[platform];
      if (next) setActivity({ ...next, connectionStatus: "live" });
    });
    stream.addEventListener("tradingActivity", (event) => {
      const tradingEvent = JSON.parse((event as MessageEvent).data) as TradingActivityEvent;
      if (tradingEvent.platform !== platform) return;
      setActivity((current) => (current ? mergeActivityEvent(current, tradingEvent) : current));
    });
    stream.onerror = () => {
      setActivity((current) => (current ? { ...current, connectionStatus: "reconnecting" } : current));
      if (!fallbackTimerRef.current) {
        fallbackTimerRef.current = setInterval(() => void loadActivity(), 10_000);
      }
    };

    return () => {
      cancelled = true;
      clearFallback();
      stream.close();
    };
  }, [platform]);

  return activity;
}
