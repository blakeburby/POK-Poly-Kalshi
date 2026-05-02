"use client";

import React from "react";
import { useEffect, useState } from "react";
import type {
  AnalyticsWindow,
  ArbCandidate,
  BinaryContract,
  DashboardAnalyticsWindow,
  DashboardLogEntry,
  DashboardSignal,
  DashboardSnapshot,
  PayoffRegionKey,
  SyntheticStructureClassification,
  SyntheticPayoffRegion,
  SyntheticStructureRisk,
} from "../../src/types";
import {
  formatCents,
  formatCountdown,
  formatDollars,
  isContractStale,
  sortCandidatesForBlotter,
  sortContractsForBook,
  staleContractCount,
  venueStatus,
} from "../lib/dashboard-view-model";

type StreamState = "connecting" | "live" | "degraded";
type SignalVenue = "kalshi" | "polymarket";

function VenueBadge({ venue }: { venue: string }) {
  return <span className={`venue venue-${venue}`}>{venue.toUpperCase()}</span>;
}

function StatusPill({ label, state }: { label: string; state: "live" | "stale" | "empty" | "warn" | "off" }) {
  return <span className={`status-pill status-${state}`}>{label}</span>;
}

function formatSignedCents(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${formatCents(value)}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "--";
  return `${(value * 100).toFixed(1)}%`;
}

function formatRiskPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(Math.abs(value) < 1 ? 2 : 1)}%`;
}

function formatRatio(value: number | null, analytics: DashboardAnalyticsWindow): string {
  if (value != null && Number.isFinite(value)) return `${value.toFixed(2)}x`;
  if (analytics.grossProfit > 0 && Math.abs(analytics.grossLoss) < 0.0001) return "∞";
  return "--";
}

function formatSharpe(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return value.toFixed(2);
}

function PnlGraph({ analytics }: { analytics: DashboardAnalyticsWindow }) {
  const values = analytics.buckets.map((bucket) => bucket.cumulativePnl);
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(0, ...values);
  const range = Math.max(0.01, maxValue - minValue);
  const points = analytics.buckets.map((bucket, index) => {
    const x = analytics.buckets.length <= 1 ? 50 : (index / (analytics.buckets.length - 1)) * 100;
    const y = 44 - ((bucket.cumulativePnl - minValue) / range) * 36;
    return { x, y, bucket };
  });
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const zeroY = 44 - ((0 - minValue) / range) * 36;

  return (
    <div className="pnl-chart" aria-label="Estimated Guaranteed PnL graph">
      <svg viewBox="0 0 100 52" preserveAspectRatio="none" role="img">
        <title>Estimated Guaranteed PnL Graph</title>
        <line className="pnl-zero" x1="0" x2="100" y1={zeroY} y2={zeroY} />
        <path className={analytics.netPnl >= 0 ? "pnl-line pnl-line-positive" : "pnl-line pnl-line-negative"} d={path || "M 0 26 L 100 26"} />
        {points.map((point) => (
          <circle
            className={point.bucket.netPnl >= 0 ? "pnl-dot pnl-dot-positive" : "pnl-dot pnl-dot-negative"}
            cx={point.x}
            cy={point.y}
            key={point.bucket.startMs}
            r="1.15"
          />
        ))}
      </svg>
      <div className="pnl-chart-axis">
        <span>{analytics.buckets[0]?.label ?? "--"}</span>
        <span>{formatSignedCents(analytics.netPnl)}</span>
        <span>{analytics.buckets.at(-1)?.label ?? "--"}</span>
      </div>
    </div>
  );
}

function AnalyticsPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [selected, setSelected] = useState<AnalyticsWindow>("hourly");
  const analytics = snapshot.analytics;
  const current = analytics?.[selected];

  if (!analytics || !current) {
    return (
      <section className="panel analytics-panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">performance analytics</p>
            <h2>Estimated Guaranteed PnL</h2>
          </div>
          <StatusPill label="WAITING" state="warn" />
        </div>
        <div className="analytics-empty">
          The worker has not published analytics yet. Deploy the updated worker to populate performance metrics.
        </div>
      </section>
    );
  }

  const windows: AnalyticsWindow[] = ["hourly", "daily", "weekly"];
  const noTrades = current.filledTrades === 0;
  return (
    <section className="panel analytics-panel">
      <div className="panel-header analytics-header">
        <div>
          <p className="panel-kicker">performance analytics</p>
          <h2>Estimated Guaranteed PnL</h2>
          <p className="analytics-subtitle">Dry-run/live audit fills, conservative $1.00 payoff floor, not settlement-final PnL.</p>
        </div>
        <div className="window-tabs" role="tablist" aria-label="Analytics window">
          {windows.map((window) => (
            <button
              aria-selected={selected === window}
              className={selected === window ? "active" : ""}
              key={window}
              onClick={() => setSelected(window)}
              role="tab"
              type="button"
            >
              {analytics[window].label}
            </button>
          ))}
        </div>
      </div>

      <div className="analytics-body">
        <div className="analytics-grid">
          <div className="analytics-card primary"><span>Net PnL</span><strong className={current.netPnl >= 0 ? "profit" : "loss"}>{formatSignedCents(current.netPnl)}</strong></div>
          <div className="analytics-card"><span>Win Rate</span><strong>{formatPercent(current.winRate)}</strong></div>
          <div className="analytics-card"><span>Trades Won</span><strong>{current.tradesWon}</strong></div>
          <div className="analytics-card"><span>Loss Rate</span><strong>{formatPercent(current.lossRate)}</strong></div>
          <div className="analytics-card"><span>Trades Lost</span><strong>{current.tradesLost}</strong></div>
          <div className="analytics-card"><span>Profit Factor</span><strong>{formatRatio(current.profitFactor, current)}</strong></div>
          <div className="analytics-card"><span>Sharpe Ratio</span><strong>{formatSharpe(current.sharpeRatio)}</strong></div>
          <div className="analytics-card"><span>Filled Trades</span><strong>{current.filledTrades}</strong></div>
        </div>

        <div className="pnl-chart-card">
          <div className="pnl-chart-header">
            <div>
              <span className="signal-label">PnL Curve</span>
              <strong>Cumulative estimated guaranteed PnL</strong>
            </div>
            <div>
              <span className="signal-label">Breakeven</span>
              <strong>{current.breakevenTrades}</strong>
            </div>
            <div>
              <span className="signal-label">Avg / Trade</span>
              <strong>{formatSignedCents(current.averagePnl)}</strong>
            </div>
          </div>
          {noTrades ? (
            <div className="analytics-empty">No filled trades in the selected {current.label.toLowerCase()} window yet.</div>
          ) : (
            <PnlGraph analytics={current} />
          )}
        </div>
      </div>
    </section>
  );
}

function BookTable({ title, venue, contracts, snapshot }: {
  title: string;
  venue: "kalshi" | "polymarket";
  contracts: BinaryContract[];
  snapshot: DashboardSnapshot;
}) {
  return (
    <section className="panel book-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">{venue}</p>
          <h2>{title}</h2>
        </div>
        <StatusPill label={venueStatus(snapshot, venue)} state={venueStatus(snapshot, venue)} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Expiry</th>
              <th>Strike</th>
              <th>Yes Bid</th>
              <th>Yes Ask</th>
              <th>No Bid</th>
              <th>No Ask</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {sortContractsForBook(contracts).slice(0, 24).map((contract) => (
              <tr key={contract.contractId} className={isContractStale(contract, snapshot) ? "row-stale" : ""}>
                <td>{formatCountdown(contract.expiryMs, snapshot.generatedAt)}</td>
                <td>{formatDollars(contract.strike)}</td>
                <td>{formatCents(contract.yesBid)}</td>
                <td>{formatCents(contract.yesAsk)}</td>
                <td>{formatCents(contract.noBid)}</td>
                <td>{formatCents(contract.noAsk)}</td>
                <td>{Math.max(0, Math.round((snapshot.generatedAt - contract.updatedAt) / 1000))}s</td>
              </tr>
            ))}
            {contracts.length === 0 ? <tr><td colSpan={7} className="empty-cell">No live contracts discovered.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CandidateRow({ candidate, now }: { candidate: ArbCandidate; now: number }) {
  return (
    <tr>
      <td>{formatCountdown(candidate.expiryMs, now)}</td>
      <td><VenueBadge venue={candidate.lower.venue} /> {candidate.lower.direction.toUpperCase()}</td>
      <td>{formatDollars(candidate.lower.strike)}</td>
      <td>{formatCents(candidate.lower.ask)}</td>
      <td><VenueBadge venue={candidate.higher.venue} /> {candidate.higher.direction.toUpperCase()}</td>
      <td>{formatDollars(candidate.higher.strike)}</td>
      <td>{formatCents(candidate.higher.ask)}</td>
      <td>{formatCents(candidate.premium)}</td>
      <td className="profit">{formatCents(candidate.guaranteedProfit)}</td>
      <td>{formatCents(candidate.overlapProfit)}</td>
    </tr>
  );
}

function OpportunityBlotter({ snapshot }: { snapshot: DashboardSnapshot }) {
  const candidates = sortCandidatesForBlotter(snapshot.liveCandidates);
  return (
    <section className="panel blotter-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">live structural edge</p>
          <h2>Opportunity Blotter</h2>
        </div>
        <span className="big-number">{candidates.length}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Expiry</th>
              <th>Lower Leg</th>
              <th>Lower Strike</th>
              <th>Ask</th>
              <th>Higher Leg</th>
              <th>Higher Strike</th>
              <th>Ask</th>
              <th>Premium</th>
              <th>Guaranteed</th>
              <th>Overlap</th>
            </tr>
          </thead>
          <tbody>
            {candidates.slice(0, 32).map((candidate) => <CandidateRow key={candidate.pairKey} candidate={candidate} now={snapshot.generatedAt} />)}
            {candidates.length === 0 ? <tr><td colSpan={10} className="empty-cell">No threshold-crossing spreads right now.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function structureLabel(risk: SyntheticStructureRisk): string {
  return risk.structureType === "long_up_below_down_above"
    ? "Long Up Below + Long Down Above"
    : "Long Up Above + Long Down Below";
}

function classificationLabel(classification: SyntheticStructureClassification): string {
  if (classification === "true_arbitrage") return "TRUE ARB";
  if (classification === "guaranteed_below_threshold") return "PROTECTED BELOW GATE";
  return "PROBABILISTIC DEAD ZONE";
}

function legSummary(leg: ArbCandidate["lower"]): string {
  return `${leg.direction.toUpperCase()} ${formatDollars(leg.strike)} @ ${formatCents(leg.ask)}`;
}

function payoffRegionName(region: PayoffRegionKey): string {
  if (region === "below_lower") return "Below lower";
  if (region === "between_strikes") return "Between strikes";
  return "Above higher";
}

function regionXRange(region: PayoffRegionKey): { x1: number; x2: number; labelX: number } {
  if (region === "below_lower") return { x1: 7, x2: 34, labelX: 20.5 };
  if (region === "between_strikes") return { x1: 34, x2: 66, labelX: 50 };
  return { x1: 66, x2: 93, labelX: 79.5 };
}

function payoffYScale(regions: SyntheticPayoffRegion[]): (profit: number) => number {
  const profits = regions.map((region) => region.profit);
  const minProfit = Math.min(0, ...profits);
  const maxProfit = Math.max(0, ...profits);
  const range = Math.max(0.01, maxProfit - minProfit);
  return (profit: number) => 50 - ((profit - minProfit) / range) * 34;
}

function PayoffCurve({ risk, compact = false }: { risk: SyntheticStructureRisk; compact?: boolean }) {
  const yFor = payoffYScale(risk.payoffProfile);
  const below = risk.payoffProfile.find((region) => region.region === "below_lower");
  const between = risk.payoffProfile.find((region) => region.region === "between_strikes");
  const above = risk.payoffProfile.find((region) => region.region === "above_higher");
  const zeroY = yFor(0);
  const lowerX = 34;
  const midX = 50;
  const higherX = 66;
  const connectorPath = below && between && above
    ? `M ${lowerX} ${yFor(below.profit).toFixed(2)} L ${lowerX} ${yFor(between.profit).toFixed(2)} M ${higherX} ${yFor(between.profit).toFixed(2)} L ${higherX} ${yFor(above.profit).toFixed(2)}`
    : "";
  const hasLossZone = Boolean(between?.isMaxLoss);
  const hasBonusZone = Boolean(between && !between.isMaxLoss && between.profit === risk.bestCaseProfit && risk.overlapWindowWidth > 0);
  const chartLabel = `${structureLabel(risk)} payoff curve`;

  return (
    <div className={compact ? "payoff-curve-card payoff-curve-compact" : "payoff-curve-card"}>
      <div className="payoff-curve-header">
        <div>
          <span className="signal-label">Payoff Curve</span>
          <strong>{compact ? "Net P/L by settlement zone" : chartLabel}</strong>
        </div>
        <div>
          <span className="signal-label">Worst / Best</span>
          <strong>{formatSignedCents(risk.worstCaseProfit)} / {formatSignedCents(risk.bestCaseProfit)}</strong>
        </div>
      </div>
      <svg className="payoff-curve-svg" viewBox="0 0 100 68" role="img" aria-label={chartLabel}>
        <title>{`${chartLabel}: ${risk.payoffProfile.map((region) => `${payoffRegionName(region.region)} ${formatSignedCents(region.profit)}`).join(", ")}`}</title>
        <line className="payoff-zero-line" x1="5" x2="95" y1={zeroY} y2={zeroY} />
        {hasLossZone ? (
          <rect className="payoff-loss-zone" x={lowerX} y="10" width={higherX - lowerX} height="43">
            <title>{`Max loss window: ${between?.label ?? "between strikes"} at ${formatSignedCents(between?.profit ?? null)}`}</title>
          </rect>
        ) : null}
        {hasBonusZone ? (
          <rect className="payoff-bonus-zone" x={lowerX} y="10" width={higherX - lowerX} height="43">
            <title>{`Overlap bonus window: ${between?.label ?? "between strikes"} at ${formatSignedCents(between?.profit ?? null)}`}</title>
          </rect>
        ) : null}
        <path className="payoff-step-connector" d={connectorPath} />
        {risk.payoffProfile.map((region) => {
          const { x1, x2, labelX } = regionXRange(region.region);
          const y = yFor(region.profit);
          const lineClass = region.profit < 0 ? "payoff-segment payoff-segment-loss" : region.profit > 0 ? "payoff-segment payoff-segment-profit" : "payoff-segment payoff-segment-flat";
          return (
            <g key={region.region}>
              <line className={lineClass} x1={x1} x2={x2} y1={y} y2={y}>
                <title>{`${payoffRegionName(region.region)}: ${region.label}, payoff ${region.payoff}, net P/L ${formatSignedCents(region.profit)}${region.isMaxLoss ? ", max loss region" : ""}`}</title>
              </line>
              <text className="payoff-profit-label" x={labelX} y={Math.max(8, y - 3)}>{formatSignedCents(region.profit)}</text>
              <text className="payoff-zone-label" x={labelX} y="63">{payoffRegionName(region.region)}</text>
            </g>
          );
        })}
        <line className="payoff-strike-marker" x1={lowerX} x2={lowerX} y1="8" y2="56" />
        <line className="payoff-mid-marker" x1={midX} x2={midX} y1="12" y2="53" />
        <line className="payoff-strike-marker" x1={higherX} x2={higherX} y1="8" y2="56" />
        <text className="payoff-strike-label" x={lowerX} y="7">Lower strike {formatDollars(risk.midStrike - risk.strikeGap / 2)}</text>
        <text className="payoff-mid-label" x={midX} y="36">Mid</text>
        <text className="payoff-strike-label payoff-strike-label-right" x={higherX} y="7">Higher strike {formatDollars(risk.midStrike + risk.strikeGap / 2)}</text>
      </svg>
      <div className="payoff-curve-legend">
        <span className="legend-profit">Profitable P/L</span>
        {hasBonusZone ? <span className="legend-bonus">Overlap bonus band</span> : null}
        {hasLossZone ? <span className="legend-loss">Max loss window</span> : null}
      </div>
    </div>
  );
}

function SyntheticStructureMap({ snapshot }: { snapshot: DashboardSnapshot }) {
  const structures = snapshot.syntheticStructures ?? [];
  return (
    <section className="panel structure-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">strike dispersion</p>
          <h2>Synthetic Strangle Map</h2>
        </div>
        <StatusPill label={`${structures.length} STRUCTURES`} state={structures.length > 0 ? "live" : "empty"} />
      </div>
      <div className="structure-list">
        {structures.slice(0, 12).map((candidate) => {
          const risk = candidate.risk;
          if (!risk) return null;
          const upLeg = candidate.lower.direction === "yes" ? candidate.lower : candidate.higher;
          const downLeg = candidate.lower.direction === "no" ? candidate.lower : candidate.higher;
          return (
            <article className="structure-card" key={candidate.pairKey}>
              <div className="structure-card-header">
                <div>
                  <span className={`classification classification-${risk.classification}`}>{classificationLabel(risk.classification)}</span>
                  <h3>{structureLabel(risk)}</h3>
                  <p>{formatCountdown(candidate.expiryMs, snapshot.generatedAt)} to expiry · midpoint {formatDollars(risk.midStrike)}</p>
                </div>
                <div className="structure-premium">
                  <span>Premium</span>
                  <strong>{formatCents(risk.premium)}</strong>
                </div>
              </div>

              <div className="structure-leg-grid">
                <div><span>Up Leg</span><strong><VenueBadge venue={upLeg.venue} /> {legSummary(upLeg)}</strong></div>
                <div><span>Down Leg</span><strong><VenueBadge venue={downLeg.venue} /> {legSummary(downLeg)}</strong></div>
              </div>

              <div className="structure-metrics">
                <div><span>Strike Gap</span><strong>{formatDollars(risk.strikeGap)}</strong></div>
                <div><span>Gap % Mid</span><strong>{formatRiskPercent(risk.strikeGapPctOfMid)}</strong></div>
                <div><span>Loss Window</span><strong className={risk.lossWindowWidth > 0 ? "loss" : "profit"}>{formatDollars(risk.lossWindowWidth)}</strong></div>
                <div><span>Loss % Gap</span><strong>{formatRiskPercent(risk.lossWindowPctOfStrikeGap)}</strong></div>
                <div><span>Guaranteed Edge</span><strong>{formatSignedCents(risk.guaranteedEdge)}</strong></div>
                <div><span>Conditional Edge</span><strong>{formatSignedCents(risk.conditionalEdge)}</strong></div>
              </div>

              <PayoffCurve risk={risk} />
            </article>
          );
        })}
        {structures.length === 0 ? <div className="empty-cell">No same-expiry cross-venue strike pairs are ready for risk mapping.</div> : null}
      </div>
    </section>
  );
}

function formatAgeMs(ageMs: number | null): string {
  if (ageMs == null) return "--";
  if (ageMs < 1000) return `${ageMs}ms`;
  return `${Math.round(ageMs / 1000)}s`;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatLatency(start: string, end: string): string {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "--";
  const latencyMs = Math.max(0, endMs - startMs);
  if (latencyMs < 1000) return `${latencyMs}ms`;
  return `${(latencyMs / 1000).toFixed(1)}s`;
}

function shortId(id: string | null | undefined): string {
  if (!id) return "--";
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}...${id.slice(-6)}`;
}

function legForVenue(signal: DashboardSignal, venue: SignalVenue) {
  return signal.lower.venue === venue ? signal.lower : signal.higher.venue === venue ? signal.higher : null;
}

function fillPriceForVenue(signal: DashboardSignal, venue: SignalVenue): number | null {
  return venue === "kalshi" ? signal.kalshiFillPrice : signal.polymarketFillPrice;
}

function fillIdForVenue(signal: DashboardSignal, venue: SignalVenue): string | null {
  return venue === "kalshi" ? signal.kalshiFillId : signal.polymarketFillId;
}

function SignalVenueRow({ signal, venue }: { signal: DashboardSignal; venue: SignalVenue }) {
  const leg = legForVenue(signal, venue);
  const fillPrice = fillPriceForVenue(signal, venue);
  const fillId = fillIdForVenue(signal, venue);
  const slippage = leg && fillPrice != null ? fillPrice - leg.ask : null;
  const slippageClass = slippage == null || Math.abs(slippage) < 0.0001 ? "" : slippage > 0 ? "slippage-bad" : "slippage-good";

  return (
    <div className="signal-leg-row">
      <div><VenueBadge venue={venue} /></div>
      <div>
        <span className="signal-label">Side</span>
        <strong>{leg ? leg.direction.toUpperCase() : "--"}</strong>
      </div>
      <div>
        <span className="signal-label">Strike</span>
        <strong>{leg ? formatDollars(leg.strike) : "--"}</strong>
      </div>
      <div>
        <span className="signal-label">Ask</span>
        <strong>{leg ? formatCents(leg.ask) : "--"}</strong>
      </div>
      <div>
        <span className="signal-label">Fill</span>
        <strong>{formatCents(fillPrice)}</strong>
      </div>
      <div>
        <span className="signal-label">Slip</span>
        <strong className={slippageClass}>{formatCents(slippage)}</strong>
      </div>
      <div className="signal-id-cell">
        <span className="signal-label">Fill ID</span>
        <strong title={fillId ?? undefined}>{shortId(fillId)}</strong>
      </div>
      <div className="signal-id-cell">
        <span className="signal-label">Contract</span>
        <strong title={leg?.contractId}>{shortId(leg?.contractId)}</strong>
      </div>
    </div>
  );
}

function PolymarketDiagnosticsPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const diagnostics = snapshot.diagnostics.polymarket;
  const marketRows = diagnostics.markets.slice(0, 6);
  return (
    <section className="panel diagnostics-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">polymarket hydration</p>
          <h2>Price-To-Beat Diagnostics</h2>
        </div>
        <StatusPill
          label={`${diagnostics.readyContracts}/${diagnostics.marketsFound} READY`}
          state={diagnostics.readyContracts > 0 ? "live" : diagnostics.pendingStrikeCount > 0 ? "warn" : "empty"}
        />
      </div>
      <div className="diagnostic-grid">
        <div className="diagnostic-chip"><span>Pending</span><strong>{diagnostics.pendingStrikeCount}</strong></div>
        <div className="diagnostic-chip"><span>Missing</span><strong>{diagnostics.missingStrikeCount}</strong></div>
        <div className="diagnostic-chip"><span>Chainlink Age</span><strong>{formatAgeMs(diagnostics.lastChainlinkTickAgeMs)}</strong></div>
        <div className="diagnostic-chip"><span>Next Capture</span><strong>{diagnostics.nextCaptureWindowStartMs ? formatCountdown(diagnostics.nextCaptureWindowStartMs, snapshot.generatedAt) : "--"}</strong></div>
      </div>
      {diagnostics.skippedReasons.length > 0 ? (
        <div className="diagnostic-reasons">
          {diagnostics.skippedReasons.slice(0, 4).map((reason) => <span key={reason}>{reason}</span>)}
        </div>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Market</th>
              <th>Status</th>
              <th>Strike</th>
              <th>Source</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {marketRows.map((market) => (
              <tr key={market.marketSlug}>
                <td>{market.marketSlug}</td>
                <td>{market.status}</td>
                <td>{formatDollars(market.priceToBeat)}</td>
                <td>{market.strikeSource ?? "--"}</td>
                <td>{market.reason}</td>
              </tr>
            ))}
            {marketRows.length === 0 ? <tr><td colSpan={5} className="empty-cell">No Polymarket BTC 15m markets discovered yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SignalTape({ signals, now }: { signals: DashboardSignal[]; now: number }) {
  return (
    <section className="panel tape-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">audit log</p>
          <h2>Signal Tape</h2>
        </div>
        <StatusPill label={`${signals.length} SIGNALS`} state={signals.length > 0 ? "live" : "empty"} />
      </div>
      <div className="signal-list">
        {signals.slice(0, 12).map((signal) => (
          <div className="signal-card" key={signal.id}>
            <div className="signal-card-header">
              <div className="signal-title">
                <span className={`action action-${signal.action}`}>{signal.action}</span>
                <strong>Signal #{signal.id}</strong>
                <span>{formatCountdown(signal.expiryMs, now)} to expiry</span>
              </div>
              <div className="signal-time-grid">
                <div>
                  <span className="signal-label">Signal time</span>
                  <time dateTime={signal.createdAt}>{formatTimestamp(signal.createdAt)}</time>
                </div>
                <div>
                  <span className="signal-label">Finalized time</span>
                  <time dateTime={signal.updatedAt}>{formatTimestamp(signal.updatedAt)}</time>
                </div>
                <div>
                  <span className="signal-label">Latency</span>
                  <strong>{formatLatency(signal.createdAt, signal.updatedAt)}</strong>
                </div>
              </div>
            </div>

            <div className="signal-metrics">
              <div><span className="signal-label">Premium</span><strong>{formatCents(signal.premium)}</strong></div>
              <div><span className="signal-label">Guaranteed</span><strong className="profit">{formatCents(signal.guaranteedProfit)}</strong></div>
              <div><span className="signal-label">Overlap</span><strong>{formatCents(signal.overlapProfit)}</strong></div>
              <div><span className="signal-label">Gate</span><strong>{formatCents(signal.threshold)}</strong></div>
              <div><span className="signal-label">Pair Key</span><strong title={signal.pairKey}>{shortId(signal.pairKey)}</strong></div>
            </div>

            {signal.risk ? (
              <>
                <div className="signal-risk-grid">
                  <div><span className="signal-label">Structure</span><strong>{structureLabel(signal.risk)}</strong></div>
                  <div><span className="signal-label">Classification</span><strong>{classificationLabel(signal.risk.classification)}</strong></div>
                  <div><span className="signal-label">Strike Gap</span><strong>{formatDollars(signal.risk.strikeGap)}</strong></div>
                  <div><span className="signal-label">Gap % Mid</span><strong>{formatRiskPercent(signal.risk.strikeGapPctOfMid)}</strong></div>
                  <div><span className="signal-label">Loss Window</span><strong>{formatDollars(signal.risk.lossWindowWidth)}</strong></div>
                  <div><span className="signal-label">Loss % Gap</span><strong>{formatRiskPercent(signal.risk.lossWindowPctOfStrikeGap)}</strong></div>
                </div>
                <PayoffCurve risk={signal.risk} compact />
              </>
            ) : null}

            <div className="signal-leg-grid">
              <SignalVenueRow signal={signal} venue="kalshi" />
              <SignalVenueRow signal={signal} venue="polymarket" />
            </div>

            {signal.failureReason ? <div className="signal-failure">Failure: {signal.failureReason}</div> : null}
          </div>
        ))}
        {signals.length === 0 ? <div className="empty-cell">No persisted signals yet.</div> : null}
      </div>
    </section>
  );
}

function EventTape({ logs }: { logs: DashboardLogEntry[] }) {
  return (
    <section className="panel tape-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">runtime</p>
          <h2>Event Tape</h2>
        </div>
      </div>
      <div className="tape-list">
        {logs.slice(0, 12).map((log, index) => (
          <div className={`tape-item severity-${log.severity.toLowerCase()}`} key={`${log.timestamp}-${index}`}>
            <span>{log.severity}</span>
            <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
            <span>{log.category}</span>
            <span>{log.message}</span>
          </div>
        ))}
        {logs.length === 0 ? <div className="empty-cell">No runtime events yet.</div> : null}
      </div>
    </section>
  );
}

export function DashboardTerminalView({
  dashboardName,
  snapshot,
  streamState,
}: {
  dashboardName: string;
  snapshot: DashboardSnapshot | null;
  streamState: StreamState;
}) {
  if (!snapshot) {
    return (
      <main className="terminal-shell loading-shell">
        <div className="loading-card">
          <p className="panel-kicker">{dashboardName}</p>
          <h1>{streamState === "degraded" ? "Worker stream unavailable" : "Connecting to live terminal"}</h1>
          <p>{streamState === "degraded" ? "The dashboard is waiting for the Railway worker snapshot proxy." : "Opening the read-only market data stream."}</p>
        </div>
      </main>
    );
  }

  const staleCount = staleContractCount(snapshot);
  const mode = snapshot.health.liveTrading ? "LIVE" : "DRY-RUN";
  return (
    <main className="terminal-shell">
      <header className="terminal-header">
        <div>
          <p className="panel-kicker">cross-venue binary arb</p>
          <h1>{dashboardName}</h1>
        </div>
        <div className="status-rail">
          <StatusPill label={streamState === "live" ? "SSE LIVE" : "SSE DEGRADED"} state={streamState === "live" ? "live" : "warn"} />
          <StatusPill label={snapshot.health.arbEnabled ? "STRATEGY ON" : "STRATEGY OFF"} state={snapshot.health.arbEnabled ? "live" : "off"} />
          <StatusPill label={mode} state={snapshot.health.liveTrading ? "warn" : "live"} />
          <StatusPill label={staleCount > 0 ? `${staleCount} STALE BOOKS` : "BOOKS FRESH"} state={staleCount > 0 ? "stale" : "live"} />
        </div>
      </header>

      <section className="metric-grid">
        <div className="metric"><span>Guaranteed Gate</span><strong>{formatCents(snapshot.health.minProfitDollars)}</strong></div>
        <div className="metric"><span>Re-entry Cadence</span><strong>{Math.round(snapshot.health.reentryIntervalMs / 1000)}s</strong></div>
        <div className="metric"><span>Last Scan</span><strong>{snapshot.scanner.lastScanAt ? `${Math.max(0, Math.round((snapshot.generatedAt - snapshot.scanner.lastScanAt) / 1000))}s` : "--"}</strong></div>
        <div className="metric"><span>Discovery Age</span><strong>{snapshot.discovery.lastDiscoveryAt ? `${Math.max(0, Math.round((snapshot.generatedAt - snapshot.discovery.lastDiscoveryAt) / 1000))}s` : "--"}</strong></div>
      </section>

      <AnalyticsPanel snapshot={snapshot} />

      <OpportunityBlotter snapshot={snapshot} />

      <SyntheticStructureMap snapshot={snapshot} />

      <section className="market-books-grid" aria-label="Live venue books">
        <BookTable title="Kalshi BTC 15m" venue="kalshi" contracts={snapshot.books.kalshi} snapshot={snapshot} />
        <BookTable title="Polymarket BTC 15m" venue="polymarket" contracts={snapshot.books.polymarket} snapshot={snapshot} />
      </section>

      {snapshot.discovery.lastDiscoveryError ? <div className="error-banner">Discovery error: {snapshot.discovery.lastDiscoveryError}</div> : null}

      <PolymarketDiagnosticsPanel snapshot={snapshot} />

      <section className="activity-grid" aria-label="Signal and runtime activity">
        <SignalTape signals={snapshot.recentSignals} now={snapshot.generatedAt} />
        <EventTape logs={snapshot.logs} />
      </section>
    </main>
  );
}

export default function DashboardTerminal({ dashboardName }: { dashboardName: string }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("connecting");

  useEffect(() => {
    let cancelled = false;
    const loadSnapshot = async () => {
      try {
        const response = await fetch("/api/dashboard/snapshot", { cache: "no-store" });
        if (!response.ok) throw new Error(await response.text());
        if (!cancelled) setSnapshot(await response.json() as DashboardSnapshot);
      } catch {
        if (!cancelled) setStreamState("degraded");
      }
    };

    void loadSnapshot();
    const stream = new EventSource("/api/dashboard/stream");
    stream.addEventListener("snapshot", (event) => {
      setSnapshot(JSON.parse((event as MessageEvent).data) as DashboardSnapshot);
      setStreamState("live");
    });
    stream.onerror = () => {
      setStreamState("degraded");
      void loadSnapshot();
    };

    return () => {
      cancelled = true;
      stream.close();
    };
  }, []);

  return <DashboardTerminalView dashboardName={dashboardName} snapshot={snapshot} streamState={streamState} />;
}
