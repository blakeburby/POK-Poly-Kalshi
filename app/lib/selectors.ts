/**
 * Derivation layer over DashboardSnapshot. Pure functions; every value traces
 * to a real field in the worker contract (see src/types.ts). PnL is per-share
 * guaranteed edge (1 - premium); multiply by order size for dollar terms.
 */

import type {
  DashboardSnapshot,
  DashboardSignal,
  DashboardAnalyticsWindow,
  LiveExecutionReadiness,
  Venue,
} from "./types";
import type { StatusTone } from "./format";

export const isExactPair = (s: DashboardSignal): boolean =>
  s.action === "filled" &&
  !!s.kalshiFillId &&
  !!s.polymarketFillId &&
  s.partialFill !== true &&
  (s.kalshiFillCount ?? 0) > 0 &&
  (s.polymarketFillCount ?? 0) > 0;

export function orderSize(snap: DashboardSnapshot): number {
  return snap.execution?.orderSize ?? snap.health.liveOrderSize ?? 1;
}

/** per-share contract dollars -> account dollars at the configured clip. */
export function toDollars(perShare: number | null | undefined, size: number): number | null {
  if (perShare == null || !Number.isFinite(perShare)) return null;
  return perShare * size;
}

export function accountEquity(snap: DashboardSnapshot): {
  total: number | null;
  cash: number | null;
  kalshi: number | null;
  polymarket: number | null;
} {
  const k = snap.tradingActivity?.kalshi.portfolio;
  const p = snap.tradingActivity?.polymarket.portfolio;
  const sum = (a: number | null | undefined, b: number | null | undefined) =>
    a == null && b == null ? null : (a ?? 0) + (b ?? 0);
  return {
    total: sum(k?.portfolioValue, p?.portfolioValue),
    cash: sum(k?.cashValue, p?.cashValue),
    kalshi: k?.portfolioValue ?? null,
    polymarket: p?.portfolioValue ?? null,
  };
}

export function openPositionCount(snap: DashboardSnapshot): number {
  return (snap.tradingActivity?.kalshi.positions.length ?? 0) + (snap.tradingActivity?.polymarket.positions.length ?? 0);
}

export function tradeableNow(snap: DashboardSnapshot): boolean {
  const e = snap.execution;
  if (!e) return false;
  return (
    e.liveTrading &&
    !e.circuitBreakerLocked &&
    !e.partialFillLocked &&
    e.riskState === "trading" &&
    e.kalshi.ready &&
    e.polymarket.ready
  );
}

export type OpState = "armed" | "degraded" | "quarantined" | "blocked" | "halted";

export function operationalStatus(snap: DashboardSnapshot): {
  state: OpState;
  tone: StatusTone;
  label: string;
  reason: string | null;
} {
  const e = snap.execution;
  if (!e) return { state: "halted", tone: "idle", label: "NO EXEC STATE", reason: "execution readiness unavailable" };
  if (e.circuitBreakerLocked) return { state: "blocked", tone: "halt", label: "CIRCUIT BREAKER", reason: e.circuitBreakerReason };
  if (e.riskState === "hard_locked") return { state: "blocked", tone: "halt", label: "HARD LOCKED", reason: e.riskStateReason };
  if (e.riskState === "quarantined" || (e.reconciliation.quarantinedExposureDollars ?? 0) > 0)
    return { state: "quarantined", tone: "stale", label: "QUARANTINED", reason: e.riskStateReason ?? "unhedged exposure" };
  if (e.partialFillLocked) return { state: "blocked", tone: "halt", label: "PARTIAL-FILL LOCK", reason: "partial fill lock active" };
  if (e.riskState === "recovering") return { state: "degraded", tone: "stale", label: "RECOVERING", reason: e.riskStateReason };
  if (e.riskState === "blocked") return { state: "blocked", tone: "halt", label: "BLOCKED", reason: e.riskStateReason };
  if (!e.kalshi.ready || !e.polymarket.ready)
    return { state: "degraded", tone: "stale", label: "VENUE NOT READY", reason: !e.kalshi.ready ? e.kalshi.reason : e.polymarket.reason };
  if (!e.liveTrading) return { state: "degraded", tone: "stale", label: "TRADING DISABLED", reason: "live trading off" };
  return { state: "armed", tone: "live", label: "ARMED", reason: null };
}

export interface HealthCheck {
  key: string;
  label: string;
  tone: StatusTone;
  detail: string;
}

export function healthChecks(snap: DashboardSnapshot, now: number): HealthCheck[] {
  const e = snap.execution;
  const us = e?.userStreams;
  const staleBook = snap.health.staleBookMs;
  const tick = snap.diagnostics?.polymarket?.lastChainlinkTickAt ?? null;
  const tickAge = tick ? now - tick : null;
  const scanAge = snap.scanner.lastScanAgeMs ?? (snap.scanner.lastScanAt ? now - snap.scanner.lastScanAt : null);

  const conn = (ok: boolean | undefined, reconnecting?: boolean): StatusTone =>
    ok ? "live" : reconnecting ? "stale" : "halt";

  return [
    {
      key: "kalshi",
      label: "Kalshi Connected",
      tone: conn(us?.kalshi.connected),
      detail: us?.kalshi.connected ? "ws subscribed" : (us?.kalshi.reason ?? "disconnected"),
    },
    {
      key: "polymarket",
      label: "Polymarket Connected",
      tone: conn(us?.polymarket.connected),
      detail: us?.polymarket.connected ? "ws subscribed" : (us?.polymarket.reason ?? "disconnected"),
    },
    {
      key: "userstreams",
      label: "Websocket Healthy",
      tone: us?.ready ? "live" : "stale",
      detail: us?.confirmationLagMs != null ? `conf lag ${Math.round(us.confirmationLagMs)}ms` : "user streams",
    },
    {
      key: "risk",
      label: "Risk Controls Active",
      tone: e?.riskState === "trading" ? "live" : e ? "stale" : "idle",
      detail: e ? e.riskState : "unknown",
    },
    {
      key: "trading",
      label: "Trading Enabled",
      tone: e?.liveTrading && !e?.circuitBreakerLocked ? "live" : "halt",
      detail: e?.circuitBreakerLocked ? "circuit breaker" : e?.liveTrading ? "live" : "disabled",
    },
    {
      key: "btc",
      label: "BTC Feed Healthy",
      tone: tickAge == null ? "idle" : tickAge > staleBook * 3 ? "halt" : tickAge > staleBook ? "stale" : "live",
      detail: tickAge != null ? `chainlink ${Math.round(tickAge / 1000)}s` : "no tick",
    },
    {
      key: "scanner",
      label: "Signal Engine Healthy",
      tone: snap.scanner.scanning && (scanAge == null || scanAge < 5000) ? "live" : "stale",
      detail: scanAge != null ? `scan ${Math.round(scanAge)}ms` : "idle",
    },
    {
      key: "fillquality",
      label: "Fill-Quality Engine",
      tone: snap.health.liveFillQualityScoringEnabled ? "live" : "idle",
      detail: snap.health.liveFillQualityModelVersion ?? "off",
    },
    {
      key: "leadlag",
      label: "Lead-Lag Engine",
      tone: snap.health.liveLeadLagScoringEnabled ? "live" : "idle",
      detail: snap.health.liveLeadLagModelVersion ?? "off",
    },
    {
      key: "reconcile",
      label: "Reconciliation Clean",
      tone: e?.reconciliation.clean ? "live" : "halt",
      detail: e?.reconciliation.clean ? "clean" : (e?.reconciliation.reason ?? "dirty"),
    },
  ];
}

/** Trade-ledger row: one complete two-leg trade. */
export interface LedgerRow {
  id: number;
  createdAt: number;
  updatedAt: number;
  market: string;
  lowerStrike: number;
  higherStrike: number;
  action: DashboardSignal["action"];
  exact: boolean;
  partial: boolean;
  failureReason: string | null;
  premium: number;
  threshold: number;
  guaranteedProfit: number;
  realizedPerShare: number | null;
  realizedDollars: number | null;
  expectedEdge: number | null;
  slippage: number | null;
  durationMs: number | null;
  kalshi: { venue: Venue; fillPrice: number | null; status: string | null; fillCount: number | null };
  polymarket: { venue: Venue; fillPrice: number | null; status: string | null; fillCount: number | null };
  pairedFillProb: number | null;
  leaderVenue: string | null;
  adverseSelection: number | null;
  totalMs: number | null;
  quarantined: boolean;
  signal: DashboardSignal;
}

export function ledgerRow(s: DashboardSignal, size: number): LedgerRow {
  const created = new Date(s.createdAt).getTime();
  const updated = new Date(s.updatedAt).getTime();
  const lower = Math.min(s.lower.strike, s.higher.strike);
  const higher = Math.max(s.lower.strike, s.higher.strike);
  const realized = s.realizedGuaranteedProfit ?? null;
  const realizedPremium = s.depthVwap ?? s.premium;
  const slippage = Number.isFinite(realizedPremium) ? realizedPremium - s.premium : null;
  const exact = isExactPair(s);
  return {
    id: s.id,
    createdAt: created,
    updatedAt: updated,
    market: `BTC ${lower.toLocaleString()}/${higher.toLocaleString()}`,
    lowerStrike: lower,
    higherStrike: higher,
    action: s.action,
    exact,
    partial: s.partialFill === true,
    failureReason: s.failureReason,
    premium: s.premium,
    threshold: s.threshold,
    guaranteedProfit: s.guaranteedProfit,
    realizedPerShare: realized,
    realizedDollars: toDollars(realized, size),
    expectedEdge: s.expectedExecutableEdge ?? s.fillQualitySnapshot?.expectedExecutableEdge ?? null,
    slippage,
    durationMs: Number.isFinite(updated - created) ? updated - created : null,
    kalshi: {
      venue: "kalshi",
      fillPrice: s.kalshiFillPrice ?? null,
      status: s.kalshiStatus ?? null,
      fillCount: s.kalshiFillCount ?? null,
    },
    polymarket: {
      venue: "polymarket",
      fillPrice: s.polymarketFillPrice ?? null,
      status: s.polymarketStatus ?? null,
      fillCount: s.polymarketFillCount ?? null,
    },
    pairedFillProb: s.fillQualitySnapshot?.pairedFillProbability ?? null,
    leaderVenue: s.leadLagSnapshot?.leaderVenue ?? null,
    adverseSelection: s.leadLagSnapshot?.adverseSelectionScore ?? null,
    totalMs: s.executionTimings?.totalMs ?? null,
    quarantined: !!s.riskQuarantinedAt,
    signal: s,
  };
}

export function ledgerRows(snap: DashboardSnapshot): LedgerRow[] {
  const size = orderSize(snap);
  return (snap.recentSignals ?? []).map((s) => ledgerRow(s, size));
}

/** Execution-quality aggregates derived from recent signals + point-in-time exec state. */
export function executionAggregates(snap: DashboardSnapshot): {
  fillRate: number | null;
  partialRate: number | null;
  failedHedgeRate: number | null;
  rejectionRate: number | null;
  exactPairRate: number | null;
  mismatchRate: number | null;
  timeoutRate: number | null;
  avgSlippage: number | null;
  avgTimeToFillMs: number | null;
  avgKalshiRtt: number | null;
  avgPolyRtt: number | null;
  avgPolyConfirmation: number | null;
  avgSubmitSkew: number | null;
  sampleCount: number;
} {
  const sigs = snap.recentSignals ?? [];
  const n = sigs.length || 1;
  const filled = sigs.filter((s) => s.action === "filled");
  const exact = sigs.filter(isExactPair);
  const partial = sigs.filter((s) => s.partialFill);
  const failed = sigs.filter((s) => s.action === "failed");
  const skipped = sigs.filter((s) => s.action === "skipped");
  const avg = (vals: Array<number | null | undefined>) => {
    const f = vals.filter((v): v is number => v != null && Number.isFinite(v));
    return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
  };
  const eq = snap.execution?.executionQuality;
  return {
    fillRate: snap.analytics?.daily.fillRate ?? (filled.length / n),
    partialRate: partial.length / n,
    failedHedgeRate: failed.length / n,
    rejectionRate: (failed.length + skipped.length) / n,
    exactPairRate: eq?.exactPairFillRate ?? exact.length / Math.max(1, filled.length),
    mismatchRate: eq?.mismatchRate ?? partial.length / n,
    timeoutRate: eq?.polymarketTimeoutRate ?? null,
    avgSlippage: snap.analytics?.daily.avgSlippage ?? avg(filled.map((s) => (s.depthVwap ?? s.premium) - s.premium)),
    avgTimeToFillMs: snap.analytics?.daily.avgFillLatencyMs ?? avg(filled.map((s) => new Date(s.updatedAt).getTime() - new Date(s.createdAt).getTime())),
    avgKalshiRtt: avg(sigs.map((s) => s.executionTimings?.kalshiRttMs)),
    avgPolyRtt: eq?.avgPolymarketRttMs ?? avg(sigs.map((s) => s.executionTimings?.polymarketRttMs)),
    avgPolyConfirmation: avg(sigs.map((s) => s.executionTimings?.polymarketConfirmationMs)),
    avgSubmitSkew: avg(sigs.map((s) => s.executionTimings?.venueSubmitSkewMs)),
    sampleCount: sigs.length,
  };
}

/** Edge capture: expected risk-adjusted edge vs realized, with retention. */
export function edgeCapture(win: DashboardAnalyticsWindow | undefined, snap: DashboardSnapshot): {
  expected: number | null;
  realized: number | null;
  retention: number | null;
} {
  const sigs = (snap.recentSignals ?? []).filter(isExactPair);
  const expected = sigs.length
    ? sigs.reduce((a, s) => a + (s.expectedExecutableEdge ?? s.guaranteedProfit), 0) / sigs.length
    : (snap.execution?.executionQuality?.estimatedExecutableEdge ?? null);
  const realized = sigs.length
    ? sigs.reduce((a, s) => a + (s.realizedGuaranteedProfit ?? 0), 0) / sigs.length
    : null;
  const retention = expected && realized != null && Math.abs(expected) > 1e-9 ? realized / expected : null;
  return { expected, realized, retention };
}

export function venueReady(e: LiveExecutionReadiness | undefined, venue: Venue): boolean {
  if (!e) return false;
  return venue === "kalshi" ? e.kalshi.ready : e.polymarket.ready;
}
