"use client";

import * as React from "react";
import type { DashboardSnapshot, VenuePnlLeg } from "@/lib/types";
import { ViewScroll, GridPanel, StatTile } from "./_layout";
import { Empty } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { fmtUsd, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Venue-truth P&L — realized take-home (net of fees) and open exposure pulled directly
 * from Kalshi settlements/positions and Polymarket positions, BTC-15m arb only. This is
 * the authoritative money view; the Trade Ledger remains the strategy/diagnostic view.
 */
export function VenuePnlView({ snap }: { snap: DashboardSnapshot }) {
  const p = snap.venuePnl;
  if (!p) {
    return (
      <ViewScroll>
        <GridPanel title="Venue P&L · Take-Home" span={12}>
          <Empty>Venue P&amp;L not available yet — waiting for the next venue read.</Empty>
        </GridPanel>
      </ViewScroll>
    );
  }
  const realizedTone = p.combinedRealizedTakeHome >= 0 ? "up" : "down";
  return (
    <ViewScroll>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Realized Take-Home" value={fmtUsd(p.combinedRealizedTakeHome, { sign: true })} tone={realizedTone} sub="net of fees · settled" />
        <StatTile label="Open Exposure" value={fmtUsd(p.combinedOpenExposure)} tone="cyan" sub="marked to market" />
        <StatTile label="Fees Paid" value={fmtUsd(p.combinedFeesPaid)} tone="amber" sub="Kalshi trading fees" />
        <StatTile label="Scope" value={p.scope} tone="neutral" sub={`updated ${fmtRelative(p.generatedAt)}`} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <LegCard leg={p.kalshi} title="Kalshi" accent="kalshi" />
        <LegCard leg={p.polymarket} title="Polymarket" accent="poly" />
      </div>

      <GridPanel title="Notes" dot="info" span={12} bodyClassName="flex flex-col gap-1.5 p-3">
        <p className="font-mono text-[11px] leading-relaxed text-fg-muted">{p.note}</p>
        {p.polymarket.unredeemedCount > 0 ? (
          <p className="font-mono text-[11px] leading-relaxed text-amber">
            {p.polymarket.unredeemedCount} resolved Polymarket position(s) are unredeemed — their P&amp;L is realized above but the USDC hasn&apos;t been claimed back to your balance yet.
          </p>
        ) : null}
        <p className="font-mono text-[11px] leading-relaxed text-fg-faint">
          Source: venue settlements/positions (not the bot&apos;s signal estimates). The Trade Ledger remains the per-signal strategy view.
        </p>
      </GridPanel>
    </ViewScroll>
  );
}

function LegCard({ leg, title, accent }: { leg: VenuePnlLeg; title: string; accent: "kalshi" | "poly" }) {
  const tone = leg.realizedTakeHome >= 0 ? "up" : "down";
  return (
    <GridPanel
      title={`${title} · realized take-home`}
      dot={leg.connectionStatus === "live" ? "live" : "stale"}
      span={6}
      bodyClassName="p-0"
      right={<Badge variant={leg.connectionStatus === "live" ? "up" : "amber"}>{leg.connectionStatus === "live" ? "LIVE" : "RECONNECTING"}</Badge>}
    >
      <div className="flex flex-col">
        <Row k="Realized take-home" sub="net of fees" v={fmtUsd(leg.realizedTakeHome, { sign: true })} tone={tone} big />
        <Row k="Open exposure" sub="marked to market" v={fmtUsd(leg.openExposure)} />
        <Row k="Gross revenue" v={fmtUsd(leg.grossRevenue)} />
        <Row k="Cost basis" v={fmtUsd(leg.cost)} />
        <Row k="Fees paid" v={fmtUsd(leg.feesPaid)} tone={leg.feesPaid > 0 ? "amber" : undefined} />
        <Row k="Settled markets" v={String(leg.settledCount)} />
        <Row k="Open markets" v={String(leg.openCount)} />
        {accent === "poly" && leg.unredeemedCount > 0 ? <Row k="Unredeemed (resolved)" v={String(leg.unredeemedCount)} tone="amber" /> : null}
      </div>
    </GridPanel>
  );
}

function Row({ k, sub, v, tone, big }: { k: string; sub?: string; v: React.ReactNode; tone?: "up" | "down" | "amber"; big?: boolean }) {
  const toneClass = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "amber" ? "text-amber" : "text-fg-secondary";
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line/40 px-3 py-2 last:border-b-0">
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] text-fg-muted">{k}</span>
        {sub ? <span className="text-[9px] text-fg-faint">{sub}</span> : null}
      </div>
      <span className={cn("font-mono tabular-nums", big ? "text-[16px]" : "text-[12px]", toneClass)}>{v}</span>
    </div>
  );
}
