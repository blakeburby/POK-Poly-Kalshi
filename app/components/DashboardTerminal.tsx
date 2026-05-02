"use client";

import React from "react";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import * as THREE from "three";
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
import type { RiskSurface3DProps } from "./dashboard/risk-surface-types";

type StreamState = "connecting" | "live" | "degraded";
type SignalVenue = "kalshi" | "polymarket";
type TradeDetailSource = "opportunity" | "signal";
type TradeDetailDirection = ArbCandidate["lower"]["direction"];
type TradeDetailRegionKey = "below_lower" | "between_strikes" | "above_higher";
type DashboardViewMode = "risk" | "raw" | "execution";

interface TradeDetailLeg {
  label: "A" | "B";
  venue: string | null;
  contractId: string | null;
  direction: TradeDetailDirection | null;
  strike: number | null;
  ask: number | null;
  fillPrice: number | null;
  fillId: string | null;
  strikeRole: "lower" | "upper" | "unknown";
}

interface TradeDetailRegion {
  key: TradeDetailRegionKey;
  label: string;
  settlementLabel: string;
  legAPayout: number | null;
  legBPayout: number | null;
  combinedPayout: number | null;
  pnl: number | null;
  isDoubleWin: boolean;
  isDeadZone: boolean;
}

export interface TradeDetailModel {
  key: string;
  source: TradeDetailSource;
  title: string;
  subtitle: string;
  pairKey: string | null;
  action: string | null;
  expiryMs: number | null;
  threshold: number;
  legA: TradeDetailLeg;
  legB: TradeDetailLeg;
  lowerStrike: number | null;
  upperStrike: number | null;
  strikeGap: number | null;
  strikeGapPct: number | null;
  totalAskPremium: number | null;
  premiumForPnl: number | null;
  premiumSource: "fill" | "ask" | "unknown";
  minimumPayout: number | null;
  worstCasePnl: number | null;
  bestCasePnl: number | null;
  guaranteedEdge: number | null;
  lossWindowWidth: number | null;
  structureLabel: "Protected Spread" | "Flipped / Dead-Zone" | "Synthetic Binary Spread";
  classification: "True Arb" | "Probabilistic Bet" | "Dead-Zone Risk";
  regions: TradeDetailRegion[];
}

export interface TradeRiskIntelligence {
  riskScore: number;
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  volatilitySensitivity: "low" | "medium" | "high";
  spreadProfitRatio: number | null;
  executionRisk: number;
  liquidityDepth: "ready" | "thin" | "unknown";
  stalePenalty: number;
}

export interface DashboardInsightModel {
  estimatedEdge: number | null;
  activeOpportunities: number;
  feedLatencyMs: number | null;
  lastScanAgeMs: number | null;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  staleBooks: number;
}

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

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatScore(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${Math.round(value)}`;
}

function formatCompactTime(ageMs: number | null): string {
  if (ageMs == null || !Number.isFinite(ageMs)) return "--";
  if (ageMs < 1000) return `${Math.round(ageMs)}ms`;
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  return `${Math.round(ageMs / 60_000)}m`;
}

export function normalizeBinaryPrice(value: number | null | undefined): number | null {
  const numeric = safeNumber(value);
  if (numeric == null) return null;
  return Math.abs(numeric) > 1 ? numeric / 100 : numeric;
}

function roundDetailDollars(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function formatDetailCents(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "unknown" : formatCents(value);
}

function formatDetailDollars(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "unknown" : formatDollars(value);
}

function formatDetailPercent(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "unknown" : formatPercent(value);
}

function directionDisplay(direction: TradeDetailDirection | null): string {
  if (!direction) return "UNKNOWN";
  return direction === "yes" ? "YES / UP" : "NO / DOWN";
}

function tradeKeyFor(source: TradeDetailSource, trade: ArbCandidate | DashboardSignal): string {
  return source === "signal" ? `signal:${(trade as DashboardSignal).id}` : `opportunity:${(trade as ArbCandidate).pairKey}`;
}

function legPayout(direction: TradeDetailDirection | null, strike: number | null, settlementPrice: number | null): number | null {
  if (!direction || strike == null || settlementPrice == null) return null;
  if (direction === "yes") return settlementPrice >= strike ? 1 : 0;
  return settlementPrice < strike ? 1 : 0;
}

function detailRegionLabel(key: TradeDetailRegionKey): string {
  if (key === "below_lower") return "Below lower";
  if (key === "between_strikes") return "Between strikes";
  return "Above upper";
}

function settlementPriceForRegion(key: TradeDetailRegionKey, lowerStrike: number | null, upperStrike: number | null): number | null {
  if (lowerStrike == null || upperStrike == null) return null;
  const gap = Math.max(1, upperStrike - lowerStrike || 1);
  if (key === "below_lower") return lowerStrike - gap;
  if (key === "between_strikes") return (lowerStrike + upperStrike) / 2;
  return upperStrike;
}

function settlementLabelForRegion(key: TradeDetailRegionKey, lowerStrike: number | null, upperStrike: number | null): string {
  if (lowerStrike == null || upperStrike == null) return "unknown settlement";
  if (key === "below_lower") return `< ${formatDollars(lowerStrike)}`;
  if (key === "between_strikes") return `${formatDollars(lowerStrike)} - ${formatDollars(upperStrike)}`;
  return `>= ${formatDollars(upperStrike)}`;
}

function normalizeDetailLeg(
  label: "A" | "B",
  leg: ArbCandidate["lower"] | null | undefined,
  fillPrice: number | null,
  fillId: string | null,
): TradeDetailLeg {
  return {
    label,
    venue: leg?.venue ?? null,
    contractId: leg?.contractId ?? null,
    direction: leg?.direction ?? null,
    strike: safeNumber(leg?.strike),
    ask: normalizeBinaryPrice(leg?.ask),
    fillPrice: normalizeBinaryPrice(fillPrice),
    fillId,
    strikeRole: "unknown",
  };
}

function assignStrikeRoles(legA: TradeDetailLeg, legB: TradeDetailLeg): { legA: TradeDetailLeg; legB: TradeDetailLeg; lowerStrike: number | null; upperStrike: number | null } {
  if (legA.strike == null || legB.strike == null) {
    return { legA, legB, lowerStrike: null, upperStrike: null };
  }
  const lowerStrike = Math.min(legA.strike, legB.strike);
  const upperStrike = Math.max(legA.strike, legB.strike);
  const aRole = legA.strike <= legB.strike ? "lower" : "upper";
  const bRole = aRole === "lower" ? "upper" : "lower";
  return {
    legA: { ...legA, strikeRole: aRole },
    legB: { ...legB, strikeRole: bRole },
    lowerStrike,
    upperStrike,
  };
}

function buildTradeRegions(
  legA: TradeDetailLeg,
  legB: TradeDetailLeg,
  lowerStrike: number | null,
  upperStrike: number | null,
  premiumForPnl: number | null,
): TradeDetailRegion[] {
  return (["below_lower", "between_strikes", "above_higher"] as const).map((key) => {
    const settlementPrice = settlementPriceForRegion(key, lowerStrike, upperStrike);
    const legAPayout = legPayout(legA.direction, legA.strike, settlementPrice);
    const legBPayout = legPayout(legB.direction, legB.strike, settlementPrice);
    const combinedPayout = legAPayout == null || legBPayout == null ? null : legAPayout + legBPayout;
    const pnl = combinedPayout == null || premiumForPnl == null ? null : roundDetailDollars(combinedPayout - premiumForPnl);
    return {
      key,
      label: detailRegionLabel(key),
      settlementLabel: settlementLabelForRegion(key, lowerStrike, upperStrike),
      legAPayout,
      legBPayout,
      combinedPayout,
      pnl,
      isDoubleWin: legAPayout === 1 && legBPayout === 1,
      isDeadZone: key === "between_strikes" && legAPayout === 0 && legBPayout === 0,
    };
  });
}

function inferStructureLabel(legA: TradeDetailLeg, legB: TradeDetailLeg): TradeDetailModel["structureLabel"] {
  const lowerLeg = legA.strikeRole === "lower" ? legA : legB.strikeRole === "lower" ? legB : null;
  const upperLeg = legA.strikeRole === "upper" ? legA : legB.strikeRole === "upper" ? legB : null;
  if (lowerLeg?.direction === "yes" && upperLeg?.direction === "no") return "Protected Spread";
  if (lowerLeg?.direction === "no" && upperLeg?.direction === "yes") return "Flipped / Dead-Zone";
  return "Synthetic Binary Spread";
}

function classifyTradeDetail(regions: TradeDetailRegion[], guaranteedEdge: number | null, threshold: number): TradeDetailModel["classification"] {
  if (regions.some((region) => region.isDeadZone)) return "Dead-Zone Risk";
  if (guaranteedEdge != null && guaranteedEdge >= threshold) return "True Arb";
  return "Probabilistic Bet";
}

function tradeDetailFromLegs({
  source,
  key,
  title,
  subtitle,
  pairKey,
  action,
  expiryMs,
  threshold,
  legA,
  legB,
}: {
  source: TradeDetailSource;
  key: string;
  title: string;
  subtitle: string;
  pairKey: string | null;
  action: string | null;
  expiryMs: number | null;
  threshold: number;
  legA: TradeDetailLeg;
  legB: TradeDetailLeg;
}): TradeDetailModel {
  const roleState = assignStrikeRoles(legA, legB);
  const askPrices = [roleState.legA.ask, roleState.legB.ask];
  const fillPrices = [roleState.legA.fillPrice, roleState.legB.fillPrice];
  const totalAskPremium = askPrices.every((price) => price != null) ? roundDetailDollars((askPrices[0] ?? 0) + (askPrices[1] ?? 0)) : null;
  const totalFillPremium = fillPrices.every((price) => price != null) ? roundDetailDollars((fillPrices[0] ?? 0) + (fillPrices[1] ?? 0)) : null;
  const premiumForPnl = totalFillPremium ?? totalAskPremium;
  const premiumSource = totalFillPremium != null ? "fill" : totalAskPremium != null ? "ask" : "unknown";
  const strikeGap = roleState.lowerStrike == null || roleState.upperStrike == null ? null : roundDetailDollars(roleState.upperStrike - roleState.lowerStrike);
  const strikeGapPct = strikeGap == null || roleState.lowerStrike == null || Math.abs(roleState.lowerStrike) < 0.000_001 ? null : strikeGap / roleState.lowerStrike;
  const regions = buildTradeRegions(roleState.legA, roleState.legB, roleState.lowerStrike, roleState.upperStrike, premiumForPnl);
  const payouts = regions.map((region) => region.combinedPayout).filter((value): value is number => value != null && Number.isFinite(value));
  const pnls = regions.map((region) => region.pnl).filter((value): value is number => value != null && Number.isFinite(value));
  const minimumPayout = payouts.length > 0 ? Math.min(...payouts) : null;
  const worstCasePnl = pnls.length > 0 ? Math.min(...pnls) : null;
  const bestCasePnl = pnls.length > 0 ? Math.max(...pnls) : null;
  const guaranteedEdge = worstCasePnl;
  const hasDeadZone = regions.some((region) => region.isDeadZone);
  const lossWindowWidth = hasDeadZone ? strikeGap : 0;

  return {
    key,
    source,
    title,
    subtitle,
    pairKey,
    action,
    expiryMs,
    threshold,
    legA: roleState.legA,
    legB: roleState.legB,
    lowerStrike: roleState.lowerStrike,
    upperStrike: roleState.upperStrike,
    strikeGap,
    strikeGapPct,
    totalAskPremium,
    premiumForPnl,
    premiumSource,
    minimumPayout,
    worstCasePnl,
    bestCasePnl,
    guaranteedEdge,
    lossWindowWidth,
    structureLabel: inferStructureLabel(roleState.legA, roleState.legB),
    classification: classifyTradeDetail(regions, guaranteedEdge, threshold),
    regions,
  };
}

export function buildTradeDetailModel(source: TradeDetailSource, trade: ArbCandidate | DashboardSignal): TradeDetailModel {
  if (source === "signal") {
    const signal = trade as DashboardSignal;
    return tradeDetailFromLegs({
      source,
      key: tradeKeyFor(source, signal),
      title: `Signal #${signal.id}`,
      subtitle: `${signal.action.toUpperCase()} · ${signal.pairKey}`,
      pairKey: signal.pairKey,
      action: signal.action,
      expiryMs: safeNumber(signal.expiryMs),
      threshold: normalizeBinaryPrice(signal.threshold) ?? 0.05,
      legA: normalizeDetailLeg("A", signal.lower, signal.lower.venue === "kalshi" ? signal.kalshiFillPrice : signal.polymarketFillPrice, signal.lower.venue === "kalshi" ? signal.kalshiFillId : signal.polymarketFillId),
      legB: normalizeDetailLeg("B", signal.higher, signal.higher.venue === "kalshi" ? signal.kalshiFillPrice : signal.polymarketFillPrice, signal.higher.venue === "kalshi" ? signal.kalshiFillId : signal.polymarketFillId),
    });
  }

  const candidate = trade as ArbCandidate;
  return tradeDetailFromLegs({
    source,
    key: tradeKeyFor(source, candidate),
    title: "Live Opportunity",
    subtitle: candidate.pairKey,
    pairKey: candidate.pairKey,
    action: candidate.executable ? "executable" : candidate.reason ?? "read-only",
    expiryMs: safeNumber(candidate.expiryMs),
    threshold: normalizeBinaryPrice(candidate.threshold) ?? 0.05,
    legA: normalizeDetailLeg("A", candidate.lower, null, null),
    legB: normalizeDetailLeg("B", candidate.higher, null, null),
  });
}

function findTradeDetailByKey(snapshot: DashboardSnapshot, key: string): TradeDetailModel | null {
  const candidate = snapshot.liveCandidates.find((item) => tradeKeyFor("opportunity", item) === key);
  if (candidate) return buildTradeDetailModel("opportunity", candidate);
  const signal = snapshot.recentSignals.find((item) => tradeKeyFor("signal", item) === key);
  if (signal) return buildTradeDetailModel("signal", signal);
  return null;
}

function riskLevelForScore(score: number): TradeRiskIntelligence["riskLevel"] {
  if (score >= 70) return "high";
  if (score >= 38) return "medium";
  return "low";
}

export function buildTradeRiskIntelligence(trade: TradeDetailModel, stalePenalty = 0): TradeRiskIntelligence {
  const threshold = trade.threshold || 0.05;
  const guaranteedEdge = trade.guaranteedEdge ?? trade.worstCasePnl ?? 0;
  const edgeMultiple = guaranteedEdge / Math.max(0.01, threshold);
  const gapPct = trade.strikeGapPct ?? 0;
  const deadZonePenalty = trade.regions.some((region) => region.isDeadZone) ? 45 : 0;
  const premiumPressure = trade.premiumForPnl == null ? 16 : clamp((trade.premiumForPnl - 0.88) * 120, 0, 18);
  const gapPenalty = clamp(gapPct * 20_000, 0, 24);
  const edgeCredit = clamp(edgeMultiple * 18, -18, 30);
  const riskScore = Math.round(clamp(42 + deadZonePenalty + premiumPressure + gapPenalty + stalePenalty - edgeCredit, 0, 100));
  const confidence = Math.round(clamp(48 + edgeCredit - deadZonePenalty * 0.55 - gapPenalty * 0.7 - stalePenalty * 0.8, 0, 100));
  const spreadProfitRatio = trade.strikeGap != null && trade.bestCasePnl != null && Math.abs(trade.bestCasePnl) > 0.0001
    ? trade.strikeGap / Math.abs(trade.bestCasePnl)
    : null;
  const volatilitySensitivity = gapPct > 0.004 ? "high" : gapPct > 0.0015 ? "medium" : "low";
  const liquidityDepth = trade.legA.ask != null && trade.legB.ask != null ? "ready" : trade.legA.ask != null || trade.legB.ask != null ? "thin" : "unknown";

  return {
    riskScore,
    confidence,
    riskLevel: riskLevelForScore(riskScore),
    volatilitySensitivity,
    spreadProfitRatio,
    executionRisk: Math.round(clamp(riskScore * 0.7 + premiumPressure + stalePenalty, 0, 100)),
    liquidityDepth,
    stalePenalty,
  };
}

function buildDashboardInsights(snapshot: DashboardSnapshot): DashboardInsightModel {
  const books = [...snapshot.books.kalshi, ...snapshot.books.polymarket];
  const feedLatencyMs = books.length > 0 ? Math.max(...books.map((book) => Math.max(0, snapshot.generatedAt - book.updatedAt))) : null;
  const estimatedEdge = snapshot.liveCandidates.length > 0 ? Math.max(...snapshot.liveCandidates.map((candidate) => candidate.guaranteedProfit)) : null;
  const lastScanAgeMs = snapshot.scanner.lastScanAt ? Math.max(0, snapshot.generatedAt - snapshot.scanner.lastScanAt) : null;
  const staleBooks = staleContractCount(snapshot);
  const sampleRiskScores = snapshot.liveCandidates.slice(0, 12).map((candidate) => buildTradeRiskIntelligence(buildTradeDetailModel("opportunity", candidate), staleBooks > 0 ? 10 : 0).riskScore);
  const riskScore = sampleRiskScores.length > 0 ? Math.max(...sampleRiskScores) : staleBooks > 0 ? 48 : 18;

  return {
    estimatedEdge,
    activeOpportunities: snapshot.liveCandidates.length,
    feedLatencyMs,
    lastScanAgeMs,
    riskScore,
    riskLevel: riskLevelForScore(riskScore),
    staleBooks,
  };
}

function riskSurfacePropsForTrade(trade: TradeDetailModel): RiskSurface3DProps {
  return {
    title: trade.title,
    lowerStrike: trade.lowerStrike,
    upperStrike: trade.upperStrike,
    premium: trade.premiumForPnl,
    worstCasePnl: trade.worstCasePnl,
    bestCasePnl: trade.bestCasePnl,
    guaranteedEdge: trade.guaranteedEdge,
    regions: trade.regions.map((region) => ({
      key: region.key,
      label: region.label,
      pnl: region.pnl,
      isDeadZone: region.isDeadZone,
      isDoubleWin: region.isDoubleWin,
    })),
  };
}

function handleTradeSelectKey(event: React.KeyboardEvent, onSelect: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onSelect();
}

export function PnLChart({ analytics }: { analytics: DashboardAnalyticsWindow }) {
  const data = analytics.buckets.map((bucket) => ({
    label: bucket.label,
    cumulativePnl: bucket.cumulativePnl,
    netPnl: bucket.netPnl,
  }));

  return (
    <div className="pnl-chart" aria-label="Estimated Guaranteed PnL graph">
      <span className="sr-only">Estimated Guaranteed PnL Graph. Y-axis: Estimated PnL dollars. X-axis: selected analytics window buckets.</span>
      <AreaChart accessibilityLayer data={data} height={220} margin={{ top: 12, right: 20, bottom: 8, left: 12 }} width={820}>
        <defs>
          <linearGradient id="pnlGradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#46d67d" stopOpacity={0.34} />
            <stop offset="100%" stopColor="#46d67d" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="rgba(116, 130, 149, 0.16)" strokeDasharray="3 3" />
        <XAxis dataKey="label" minTickGap={18} stroke="#748295" tick={{ fill: "#748295", fontSize: 11 }} tickLine={false} />
        <YAxis
          label={{ value: "Y-axis: Estimated PnL ($)", angle: -90, position: "insideLeft", fill: "#91a0b5", fontSize: 11 }}
          stroke="#748295"
          tick={{ fill: "#748295", fontSize: 11 }}
          tickFormatter={(value) => `$${Number(value).toFixed(2)}`}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{ background: "#071018", border: "1px solid rgba(116, 130, 149, 0.32)", color: "#e6edf3" }}
          formatter={(value) => [`$${Number(value).toFixed(4)}`, "Cumulative estimated PnL"]}
          labelFormatter={(label) => `Bucket ${label}`}
        />
        <Area dataKey="cumulativePnl" fill="url(#pnlGradient)" isAnimationActive={false} name="Estimated Guaranteed PnL" stroke={analytics.netPnl >= 0 ? "#46d67d" : "#ff5f65"} strokeWidth={2.4} type="monotone" />
      </AreaChart>
      <div className="pnl-chart-axis">
        <span>{analytics.buckets[0]?.label ?? "--"}</span>
        <span>{formatSignedCents(analytics.netPnl)}</span>
        <span>{analytics.buckets.at(-1)?.label ?? "--"}</span>
      </div>
    </div>
  );
}

function RiskSurface3DFallback({ reason = "WebGL surface unavailable" }: { reason?: string }) {
  return (
    <div className="risk-surface-fallback" role="img" aria-label="3D risk surface fallback">
      <strong>3D Risk Surface</strong>
      <span>{reason}</span>
      <div className="risk-surface-fallback-axis">
        <span>X-axis: BTC settlement price</span>
        <span>Y-axis: time to expiry</span>
        <span>Z-axis: P&L</span>
      </div>
    </div>
  );
}

export function RiskSurface3D(props: RiskSurface3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasData = props.lowerStrike != null && props.upperStrike != null && props.regions.some((region) => region.pnl != null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasData || props.lowerStrike == null || props.upperStrike == null) return;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, canvas });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1.8, 0.1, 100);
    const group = new THREE.Group();
    const strikeGap = Math.max(1, props.upperStrike - props.lowerStrike);
    const minPrice = props.lowerStrike - strikeGap;
    const maxPrice = props.upperStrike + strikeGap;
    const pnls = props.regions.map((region) => region.pnl).filter((pnl): pnl is number => pnl != null && Number.isFinite(pnl));
    const minPnl = Math.min(0, ...pnls);
    const maxPnl = Math.max(0.01, ...pnls);
    const vertices: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const xSegments = 36;
    const ySegments = 14;
    const red = new THREE.Color("#ff5f65");
    const amber = new THREE.Color("#ffbd52");
    const green = new THREE.Color("#46d67d");
    const pnlForPrice = (price: number) => {
      const below = props.regions.find((region) => region.key === "below_lower")?.pnl ?? 0;
      const between = props.regions.find((region) => region.key === "between_strikes")?.pnl ?? 0;
      const above = props.regions.find((region) => region.key === "above_higher")?.pnl ?? 0;
      if (price < props.lowerStrike!) return below;
      if (price < props.upperStrike!) return between;
      return above;
    };
    const colorForPnl = (pnl: number) => {
      if (pnl < 0) return red.clone().lerp(amber, clamp((pnl - minPnl) / Math.max(0.0001, 0 - minPnl), 0, 1));
      return amber.clone().lerp(green, clamp(pnl / Math.max(0.0001, maxPnl), 0, 1));
    };

    for (let yIndex = 0; yIndex <= ySegments; yIndex += 1) {
      const time = yIndex / ySegments;
      for (let xIndex = 0; xIndex <= xSegments; xIndex += 1) {
        const priceRatio = xIndex / xSegments;
        const price = minPrice + priceRatio * (maxPrice - minPrice);
        const pnl = pnlForPrice(price);
        const x = (priceRatio - 0.5) * 5.8;
        const y = (time - 0.5) * 3.2;
        const z = ((pnl - minPnl) / Math.max(0.01, maxPnl - minPnl)) * 2.2 - 1.1;
        vertices.push(x, y, z);
        const color = colorForPnl(pnl);
        colors.push(color.r, color.g, color.b);
      }
    }

    for (let yIndex = 0; yIndex < ySegments; yIndex += 1) {
      for (let xIndex = 0; xIndex < xSegments; xIndex += 1) {
        const row = xSegments + 1;
        const a = yIndex * row + xIndex;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const surface = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      metalness: 0.12,
      roughness: 0.55,
      side: THREE.DoubleSide,
      vertexColors: true,
    }));
    surface.rotation.x = -0.55;
    group.add(surface);
    group.add(new THREE.GridHelper(6, 12, "#345166", "#1b3141"));
    scene.add(group);
    scene.add(new THREE.AmbientLight("#d8e5f0", 0.74));
    const light = new THREE.DirectionalLight("#ffffff", 1.15);
    light.position.set(2.4, -3, 4);
    scene.add(light);
    camera.position.set(4.3, -5.1, 3.6);
    camera.lookAt(0, 0, 0);

    let width = 640;
    let height = 340;
    let animationFrame = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let zoom = 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(320, Math.floor(rect.width || 640));
      height = Math.max(260, Math.floor(rect.height || 340));
      renderer.setPixelRatio(Math.min(1.75, window.devicePixelRatio || 1));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const render = () => {
      if (!dragging) group.rotation.z += 0.0016;
      camera.position.set(4.3 * zoom, -5.1 * zoom, 3.6 * zoom);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(render);
    };
    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      group.rotation.z += (event.clientX - lastX) * 0.008;
      group.rotation.x += (event.clientY - lastY) * 0.004;
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      canvas.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom = clamp(zoom + event.deltaY * 0.0012, 0.62, 1.45);
    };
    resize();
    render();
    window.addEventListener("resize", resize);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      geometry.dispose();
      renderer.dispose();
    };
  }, [hasData, props.lowerStrike, props.regions, props.upperStrike]);

  if (!hasData) return <RiskSurface3DFallback reason="Insufficient strikes or P&L data to render the risk surface." />;
  return (
    <div className="risk-surface-shell risk-surface-css" role="img" aria-label={`${props.title} 3D risk surface. X-axis: BTC settlement price. Y-axis: time to expiry. Z-axis: P&L.`}>
      <canvas className="risk-surface-canvas" ref={canvasRef} />
      <div className="risk-surface-plane">
        {props.regions.map((region, index) => {
          const pnl = region.pnl ?? 0;
          const maxMagnitude = Math.max(0.01, ...props.regions.map((item) => Math.abs(item.pnl ?? 0)));
          const height = 28 + clamp(Math.abs(pnl) / maxMagnitude, 0, 1) * 74;
          return (
            <div
              className={`risk-surface-column ${pnl >= 0 ? "risk-surface-profit" : "risk-surface-loss"} ${region.isDoubleWin ? "risk-surface-double" : ""} ${region.isDeadZone ? "risk-surface-dead" : ""}`}
              key={region.key}
              style={{ height: `${height}px`, transform: `translateX(${index * 64 - 64}px) translateY(${pnl >= 0 ? -height / 5 : height / 8}px)` }}
            >
              <span>{region.label}</span>
              <strong>{formatSignedCents(region.pnl)}</strong>
            </div>
          );
        })}
      </div>
      <div className="risk-surface-overlay" aria-hidden="true">
        <span>X-axis: BTC settlement price</span>
        <span>Y-axis: time to expiry</span>
        <span>Z-axis: P&L</span>
      </div>
      <div className="risk-surface-axis-labels">
        <span>Lower strike {formatDetailDollars(props.lowerStrike)}</span>
        <span>Upper strike {formatDetailDollars(props.upperStrike)}</span>
      </div>
    </div>
  );
}

export function RiskMeter({ insights }: { insights: DashboardInsightModel }) {
  return (
    <div className={`risk-meter risk-meter-${insights.riskLevel}`} aria-label={`Risk meter ${insights.riskLevel}`}>
      <div className="risk-meter-header">
        <span>Risk Meter</span>
        <strong>{insights.riskLevel.toUpperCase()}</strong>
      </div>
      <div className="risk-meter-track">
        <span style={{ width: `${insights.riskScore}%` }} />
      </div>
      <div className="risk-meter-footer">
        <span>Exposure score</span>
        <strong>{insights.riskScore}/100</strong>
      </div>
    </div>
  );
}

function GlobalStateBar({
  dashboardName,
  snapshot,
  streamState,
  viewMode,
  onViewModeChange,
}: {
  dashboardName: string;
  snapshot: DashboardSnapshot;
  streamState: StreamState;
  viewMode: DashboardViewMode;
  onViewModeChange: (mode: DashboardViewMode) => void;
}) {
  const insights = buildDashboardInsights(snapshot);
  const mode = snapshot.health.liveTrading ? "LIVE" : "DRY-RUN";
  const viewModes: DashboardViewMode[] = ["risk", "raw", "execution"];

  return (
    <header className="institutional-topbar">
      <div className="topbar-brand">
        <p className="panel-kicker">cross-venue binary arb</p>
        <h1>{dashboardName}</h1>
        <span>Kalshi + Polymarket BTC 15m</span>
      </div>

      <div className="topbar-kpis">
        <div className="hero-kpi">
          <span>Estimated Edge</span>
          <strong className={(insights.estimatedEdge ?? 0) >= snapshot.health.minProfitDollars ? "profit" : ""}>{formatSignedCents(insights.estimatedEdge)}</strong>
        </div>
        <div className="topbar-kpi"><span>Active Opportunities</span><strong>{insights.activeOpportunities}</strong></div>
        <div className="topbar-kpi"><span>Feed Latency</span><strong>{formatCompactTime(insights.feedLatencyMs)}</strong></div>
        <div className="topbar-kpi"><span>Last Scan</span><strong>{formatCompactTime(insights.lastScanAgeMs)}</strong></div>
      </div>

      <div className="topbar-state">
        <div className="status-rail">
          <StatusPill label={streamState === "live" ? "SSE LIVE" : "SSE DEGRADED"} state={streamState === "live" ? "live" : "warn"} />
          <StatusPill label={snapshot.health.arbEnabled ? "STRATEGY ON" : "STRATEGY OFF"} state={snapshot.health.arbEnabled ? "live" : "off"} />
          <StatusPill label={mode} state={snapshot.health.liveTrading ? "warn" : "live"} />
          <StatusPill label={insights.staleBooks > 0 ? `${insights.staleBooks} STALE BOOKS` : "BOOKS FRESH"} state={insights.staleBooks > 0 ? "stale" : "live"} />
        </div>
        <RiskMeter insights={insights} />
        <div className="view-mode-tabs" role="tablist" aria-label="Dashboard view mode">
          {viewModes.map((modeName) => (
            <button
              aria-selected={viewMode === modeName}
              className={viewMode === modeName ? "active" : ""}
              key={modeName}
              onClick={() => onViewModeChange(modeName)}
              role="tab"
              type="button"
            >
              {modeName === "risk" ? "Risk View" : modeName === "raw" ? "Raw View" : "Execution View"}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function RiskIntelligencePanel({ snapshot, selectedTrade }: { snapshot: DashboardSnapshot; selectedTrade: TradeDetailModel | null }) {
  const insights = buildDashboardInsights(snapshot);
  const focusTrade = selectedTrade ?? (snapshot.liveCandidates[0] ? buildTradeDetailModel("opportunity", sortCandidatesForBlotter(snapshot.liveCandidates)[0]) : null);
  const tradeRisk = focusTrade ? buildTradeRiskIntelligence(focusTrade, insights.staleBooks > 0 ? 10 : 0) : null;
  const latencyData = [...snapshot.books.kalshi, ...snapshot.books.polymarket].slice(0, 12).map((book) => ({
    name: `${book.venue.slice(0, 1).toUpperCase()} ${Math.round(book.strike)}`,
    age: Math.max(0, Math.round((snapshot.generatedAt - book.updatedAt) / 1000)),
  }));
  const opportunityFrequency = snapshot.scanner.lastCandidateCount;

  return (
    <section className="panel risk-intelligence-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">risk intelligence</p>
          <h2>Decision Engine</h2>
        </div>
        <StatusPill label={tradeRisk ? `${tradeRisk.confidence}% CONF` : "WAITING"} state={tradeRisk && tradeRisk.confidence >= 65 ? "live" : tradeRisk ? "warn" : "empty"} />
      </div>

      <div className="risk-intelligence-body">
        <div className="risk-question-grid">
          <div><span>Is there edge?</span><strong>{formatSignedCents(insights.estimatedEdge)}</strong><small>Best guaranteed edge in live blotter</small></div>
          <div><span>Where is risk?</span><strong>{focusTrade?.lossWindowWidth && focusTrade.lossWindowWidth > 0 ? "Dead-zone" : "Execution"}</strong><small>{focusTrade ? `${focusTrade.structureLabel}` : "No selected trade"}</small></div>
          <div><span>What should I do?</span><strong>{focusTrade?.classification === "True Arb" ? "Monitor / dry-run fill" : "Observe only"}</strong><small>UI is read-only; no controls exposed</small></div>
        </div>

        <div className="risk-factor-grid">
          <div><span>Vol Sensitivity</span><strong>{tradeRisk?.volatilitySensitivity.toUpperCase() ?? "--"}</strong></div>
          <div><span>Spread / Profit</span><strong>{tradeRisk?.spreadProfitRatio == null ? "--" : `${tradeRisk.spreadProfitRatio.toFixed(2)}x`}</strong></div>
          <div><span>Execution Risk</span><strong>{formatScore(tradeRisk?.executionRisk ?? null)}/100</strong></div>
          <div><span>Liquidity Proxy</span><strong>{tradeRisk?.liquidityDepth.toUpperCase() ?? "UNKNOWN"}</strong></div>
          <div><span>Opportunity Freq</span><strong>{opportunityFrequency}</strong></div>
          <div><span>Book Staleness</span><strong>{insights.staleBooks}</strong></div>
        </div>

        <div className="latency-chart-card">
          <div>
            <span className="signal-label">Latency Distribution</span>
            <strong>Book age by venue/strike</strong>
          </div>
          {latencyData.length > 0 ? (
            <div className="latency-bars" role="img" aria-label="Latency distribution. Y-axis: Latency seconds. X-axis: venue strike.">
              <span className="sr-only">Y-axis: Latency (s). X-axis: venue / strike.</span>
              <BarChart accessibilityLayer data={latencyData} height={150} margin={{ top: 8, right: 8, bottom: 8, left: 0 }} width={360}>
                <CartesianGrid stroke="rgba(116, 130, 149, 0.14)" strokeDasharray="3 3" />
                <XAxis dataKey="name" stroke="#748295" tick={{ fill: "#748295", fontSize: 10 }} tickLine={false} />
                <YAxis
                  label={{ value: "Y-axis: Latency (s)", angle: -90, position: "insideLeft", fill: "#91a0b5", fontSize: 10 }}
                  stroke="#748295"
                  tick={{ fill: "#748295", fontSize: 10 }}
                  tickLine={false}
                />
                <Tooltip contentStyle={{ background: "#071018", border: "1px solid rgba(116, 130, 149, 0.32)", color: "#e6edf3" }} formatter={(value) => [`${value}s`, "Book age"]} />
                <Bar dataKey="age" fill="#4cc9f0" isAnimationActive={false} radius={[4, 4, 0, 0]} />
              </BarChart>
            </div>
          ) : (
            <div className="analytics-empty">No book latency data yet.</div>
          )}
        </div>
      </div>
    </section>
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
            <PnLChart analytics={current} />
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

function CandidateRow({
  candidate,
  now,
  selected,
  onSelect,
  onPreview,
}: {
  candidate: ArbCandidate;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onPreview: () => void;
}) {
  const tradeDetail = buildTradeDetailModel("opportunity", candidate);
  const risk = buildTradeRiskIntelligence(tradeDetail);
  const structureClass = tradeDetail.structureLabel === "Protected Spread" ? "protected-spread" : tradeDetail.structureLabel === "Flipped / Dead-Zone" ? "flipped-dead-zone" : "synthetic";
  return (
    <tr
      aria-label={`Open payoff detail for ${candidate.pairKey}`}
      aria-selected={selected}
      className={selected ? "clickable-row selected-trade-row" : "clickable-row"}
      onClick={onSelect}
      onKeyDown={(event) => handleTradeSelectKey(event, onSelect)}
      onMouseEnter={onPreview}
      role="button"
      tabIndex={0}
    >
      <td>{formatCountdown(candidate.expiryMs, now)}</td>
      <td><span className={`structure-chip structure-${structureClass}`}>{tradeDetail.structureLabel}</span></td>
      <td>{formatDollars(candidate.lower.strike)} / {formatDollars(candidate.higher.strike)}</td>
      <td><VenueBadge venue={candidate.lower.venue} /> {candidate.lower.direction.toUpperCase()} @ {formatCents(candidate.lower.ask)}</td>
      <td><VenueBadge venue={candidate.higher.venue} /> {candidate.higher.direction.toUpperCase()} @ {formatCents(candidate.higher.ask)}</td>
      <td>{formatCents(candidate.premium)}</td>
      <td className="profit">{formatCents(candidate.guaranteedProfit)}</td>
      <td>{formatCents(candidate.overlapProfit)}</td>
      <td><span className={`score-pill score-${risk.riskLevel}`}>{risk.riskScore}</span></td>
      <td>{risk.confidence}%</td>
      <td className="payoff-cell">
        <InlineTradePayoffGraph trade={tradeDetail} variant="table" />
      </td>
    </tr>
  );
}

function OpportunityBlotter({
  snapshot,
  selectedTradeKey,
  onSelectTrade,
}: {
  snapshot: DashboardSnapshot;
  selectedTradeKey: string | null;
  onSelectTrade: (trade: TradeDetailModel) => void;
}) {
  const candidates = sortCandidatesForBlotter(snapshot.liveCandidates);
  return (
    <section className="panel blotter-panel opportunity-table-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">primary decision table</p>
          <h2>Opportunity Blotter</h2>
          <p className="panel-subtitle">Rows answer edge, risk, confidence, and the synthetic payoff shape before you click.</p>
        </div>
        <span className="big-number">{candidates.length}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Expiry</th>
              <th>Structure Type</th>
              <th>Strikes Lower / Upper</th>
              <th>Lower Leg</th>
              <th>Higher Leg</th>
              <th>Total Premium</th>
              <th>Guaranteed Profit</th>
              <th>Max Profit</th>
              <th>Risk Score</th>
              <th>Confidence</th>
              <th>Payoff</th>
            </tr>
          </thead>
          <tbody>
            {candidates.slice(0, 32).map((candidate) => (
              <CandidateRow
                candidate={candidate}
                key={candidate.pairKey}
                now={snapshot.generatedAt}
                onSelect={() => onSelectTrade(buildTradeDetailModel("opportunity", candidate))}
                onPreview={() => onSelectTrade(buildTradeDetailModel("opportunity", candidate))}
                selected={selectedTradeKey === tradeKeyFor("opportunity", candidate)}
              />
            ))}
            {candidates.length === 0 ? <tr><td colSpan={11} className="empty-cell">No threshold-crossing spreads right now.</td></tr> : null}
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

function detailSeriesPath(regions: TradeDetailRegion[], valueFor: (region: TradeDetailRegion) => number | null, yFor: (value: number) => number): string {
  const values = regions.map(valueFor);
  if (values.some((value) => value == null || !Number.isFinite(value))) return "";
  const below = values[0] as number;
  const between = values[1] as number;
  const above = values[2] as number;
  const belowY = yFor(below).toFixed(2);
  const betweenY = yFor(between).toFixed(2);
  const aboveY = yFor(above).toFixed(2);
  return `M 7 ${belowY} L 34 ${belowY} L 34 ${betweenY} L 66 ${betweenY} L 66 ${aboveY} L 93 ${aboveY}`;
}

function detailYScale(trade: TradeDetailModel): (value: number) => number {
  const values = trade.regions
    .flatMap((region) => [region.legAPayout, region.legBPayout, region.combinedPayout, region.pnl])
    .filter((value): value is number => value != null && Number.isFinite(value));
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(1, ...values);
  const range = Math.max(0.01, maxValue - minValue);
  return (value: number) => 56 - ((value - minValue) / range) * 42;
}

function detailLegClass(leg: TradeDetailLeg): string {
  if (leg.direction === "yes") return "detail-leg-yes";
  if (leg.direction === "no") return "detail-leg-no";
  return "detail-leg-unknown";
}

function DetailMetric({ label, value, tone }: { label: string; value: string; tone?: "profit" | "loss" | "warn" }) {
  return (
    <div className="trade-detail-metric">
      <span>{label}</span>
      <strong className={tone ? `detail-tone-${tone}` : undefined}>{value}</strong>
    </div>
  );
}

function TradeDetailLegCard({ leg }: { leg: TradeDetailLeg }) {
  return (
    <div className={`trade-detail-leg-card ${detailLegClass(leg)}`}>
      <div className="trade-detail-leg-card-header">
        <span>Contract {leg.label}</span>
        <strong>{directionDisplay(leg.direction)}</strong>
      </div>
      <div className="trade-detail-leg-grid">
        <div><span>Venue</span><strong>{leg.venue ? <VenueBadge venue={leg.venue} /> : "unknown"}</strong></div>
        <div><span>Role</span><strong>{leg.strikeRole}</strong></div>
        <div><span>Strike</span><strong>{formatDetailDollars(leg.strike)}</strong></div>
        <div><span>Ask</span><strong>{formatDetailCents(leg.ask)}</strong></div>
        <div><span>Fill</span><strong>{formatDetailCents(leg.fillPrice)}</strong></div>
        <div><span>Fill ID</span><strong title={leg.fillId ?? undefined}>{leg.fillId ? shortId(leg.fillId) : "unknown"}</strong></div>
        <div className="trade-detail-contract-id"><span>Contract ID</span><strong title={leg.contractId ?? undefined}>{leg.contractId ? shortId(leg.contractId) : "unknown"}</strong></div>
      </div>
    </div>
  );
}

export function InlineTradePayoffGraph({ trade, variant = "card" }: { trade: TradeDetailModel; variant?: "table" | "card" }) {
  const yFor = detailYScale(trade);
  const zeroY = yFor(0);
  const legAPath = detailSeriesPath(trade.regions, (region) => region.legAPayout, yFor);
  const legBPath = detailSeriesPath(trade.regions, (region) => region.legBPayout, yFor);
  const combinedPath = detailSeriesPath(trade.regions, (region) => region.pnl, yFor);
  const hasDoubleWin = trade.regions.some((region) => region.isDoubleWin);
  const hasDeadZone = trade.regions.some((region) => region.isDeadZone);
  const label = `${trade.title} inline payoff graph`;

  return (
    <div className={`inline-payoff inline-payoff-${variant}`}>
      <div className="inline-payoff-header">
        <span>{trade.structureLabel}</span>
        <strong>{trade.classification}</strong>
      </div>
      <svg className="inline-payoff-svg" viewBox="0 0 100 64" role="img" aria-label={label}>
        <title>{`${label}: Y-axis is payout / net P/L in dollars. Lower ${formatDetailDollars(trade.lowerStrike)}, upper ${formatDetailDollars(trade.upperStrike)}, YES / UP leg, NO / DOWN leg, combined P/L.`}</title>
        <text className="inline-y-axis-label" x="4" y="32" transform="rotate(-90 4 32)">Y-axis: Payout / Net P/L ($)</text>
        <line className="inline-zero-line" x1="5" x2="95" y1={zeroY} y2={zeroY} />
        <text className="inline-y-zero-label" x="7" y={Math.max(10, zeroY - 1)}>0</text>
        {trade.regions.map((region) => {
          const { x1, x2, labelX } = regionXRange(region.key);
          return (
            <g key={region.key}>
              {region.isDeadZone ? <rect className="inline-dead-zone" x={x1} y="8" width={x2 - x1} height="42" /> : null}
              {region.isDoubleWin ? <rect className="inline-double-win-zone" x={x1} y="8" width={x2 - x1} height="42" /> : null}
              <rect className="detail-region-hitbox" x={x1} y="8" width={x2 - x1} height="42">
                <title>{`${region.label}: ${region.settlementLabel}. A pays ${region.legAPayout ?? "unknown"}, B pays ${region.legBPayout ?? "unknown"}, combined ${region.combinedPayout ?? "unknown"}, P/L ${formatSignedCents(region.pnl)}.`}</title>
              </rect>
              <text className="inline-region-label" x={labelX} y="60">{region.label}</text>
            </g>
          );
        })}
        <line className="inline-strike-marker" x1="34" x2="34" y1="6" y2="53" />
        <line className="inline-strike-marker" x1="66" x2="66" y1="6" y2="53" />
        <text className="inline-strike-label" x="34" y="6">Lower {formatDetailDollars(trade.lowerStrike)}</text>
        <text className="inline-strike-label" x="66" y="6">Upper {formatDetailDollars(trade.upperStrike)}</text>
        {legAPath ? <path className={`inline-leg-line ${detailLegClass(trade.legA)}`} d={legAPath} /> : null}
        {legBPath ? <path className={`inline-leg-line ${detailLegClass(trade.legB)}`} d={legBPath} /> : null}
        {combinedPath ? <path className="inline-combined-line" d={combinedPath} /> : null}
      </svg>
      <div className="inline-payoff-legend">
        <span className="legend-yes">YES / UP</span>
        <span className="legend-no">NO / DOWN</span>
        <span className="legend-combined">Combined P/L</span>
        {hasDoubleWin ? <span className="legend-bonus">Double-win zone</span> : null}
        {hasDeadZone ? <span className="legend-loss">Dead-zone</span> : null}
      </div>
    </div>
  );
}

function DetailedPayoffDiagram({ trade }: { trade: TradeDetailModel }) {
  const yFor = detailYScale(trade);
  const zeroY = yFor(0);
  const legAPath = detailSeriesPath(trade.regions, (region) => region.legAPayout, yFor);
  const legBPath = detailSeriesPath(trade.regions, (region) => region.legBPayout, yFor);
  const combinedPath = detailSeriesPath(trade.regions, (region) => region.pnl, yFor);
  const lowerX = 34;
  const midX = 50;
  const upperX = 66;

  return (
    <div className="trade-payoff-card">
      <div className="trade-payoff-header">
        <div>
          <span className="signal-label">Payoff Diagram</span>
          <strong>{trade.structureLabel} · {trade.classification}</strong>
        </div>
        <div>
          <span className="signal-label">Premium basis</span>
          <strong>{trade.premiumSource === "fill" ? "actual fills" : trade.premiumSource === "ask" ? "observed asks" : "unknown"}</strong>
        </div>
      </div>
      <svg className="trade-payoff-svg" viewBox="0 0 100 72" role="img" aria-label={`${trade.title} detailed payoff diagram`}>
        <title>{`${trade.title}: ${trade.structureLabel}. Y-axis is payout / net P/L in dollars. ${trade.regions.map((region) => `${region.label} payout ${region.combinedPayout ?? "unknown"}, P/L ${region.pnl == null ? "unknown" : formatSignedCents(region.pnl)}`).join("; ")}`}</title>
        <text className="detail-y-axis-label" x="4" y="36" transform="rotate(-90 4 36)">Y-axis: Payout / Net P/L ($)</text>
        <line className="detail-zero-line" x1="5" x2="95" y1={zeroY} y2={zeroY} />
        <text className="detail-y-zero-label" x="7" y={Math.max(10, zeroY - 1)}>0</text>
        {trade.regions.map((region) => {
          const { x1, x2, labelX } = regionXRange(region.key);
          return (
            <g key={region.key}>
              {region.isDeadZone ? (
                <rect className="detail-dead-zone" x={x1} y="8" width={x2 - x1} height="50">
                  <title>{`Dead-zone loss window: ${region.settlementLabel}. Both legs lose, net P/L ${formatSignedCents(region.pnl)}`}</title>
                </rect>
              ) : null}
              {region.isDoubleWin ? (
                <rect className="detail-double-win-zone" x={x1} y="8" width={x2 - x1} height="50">
                  <title>{`Double-profit zone: ${region.settlementLabel}. Both legs win, net P/L ${formatSignedCents(region.pnl)}`}</title>
                </rect>
              ) : null}
              <rect className="detail-region-hitbox" x={x1} y="8" width={x2 - x1} height="50">
                <title>{`${region.label}: ${region.settlementLabel}. Contract A pays ${region.legAPayout ?? "unknown"}, Contract B pays ${region.legBPayout ?? "unknown"}, combined payout ${region.combinedPayout ?? "unknown"}, net P/L ${formatSignedCents(region.pnl)}.`}</title>
              </rect>
              <text className="detail-region-label" x={labelX} y="68">{region.label}</text>
            </g>
          );
        })}
        <line className="detail-strike-marker" x1={lowerX} x2={lowerX} y1="6" y2="60" />
        <line className="detail-mid-marker" x1={midX} x2={midX} y1="11" y2="57" />
        <line className="detail-strike-marker" x1={upperX} x2={upperX} y1="6" y2="60" />
        <text className="detail-strike-label" x={lowerX} y="6">Lower {formatDetailDollars(trade.lowerStrike)}</text>
        <text className="detail-mid-label" x={midX} y="35">Mid</text>
        <text className="detail-strike-label" x={upperX} y="6">Upper {formatDetailDollars(trade.upperStrike)}</text>
        {legAPath ? (
          <path className={`detail-leg-line ${detailLegClass(trade.legA)}`} d={legAPath}>
            <title>{`Contract ${trade.legA.label} ${directionDisplay(trade.legA.direction)} payoff line`}</title>
          </path>
        ) : null}
        {legBPath ? (
          <path className={`detail-leg-line ${detailLegClass(trade.legB)}`} d={legBPath}>
            <title>{`Contract ${trade.legB.label} ${directionDisplay(trade.legB.direction)} payoff line`}</title>
          </path>
        ) : null}
        {combinedPath ? (
          <path className="detail-combined-line" d={combinedPath}>
            <title>Combined net P/L after premium</title>
          </path>
        ) : null}
        {trade.regions.map((region) => {
          const { labelX } = regionXRange(region.key);
          const y = region.pnl == null ? 14 : Math.max(10, yFor(region.pnl) - 4);
          return (
            <text className={region.pnl != null && region.pnl < 0 ? "detail-pnl-label detail-pnl-loss" : "detail-pnl-label"} x={labelX} y={y} key={`${region.key}-pnl`}>
              {formatSignedCents(region.pnl)}
            </text>
          );
        })}
      </svg>
      <div className="trade-payoff-legend">
        <span className="legend-yes">YES / UP leg payoff</span>
        <span className="legend-no">NO / DOWN leg payoff</span>
        <span className="legend-combined">Combined net P/L</span>
        {trade.regions.some((region) => region.isDoubleWin) ? <span className="legend-bonus">Double-win zone</span> : null}
        {trade.regions.some((region) => region.isDeadZone) ? <span className="legend-loss">Dead-zone window</span> : null}
      </div>
      <div className="trade-region-table">
        {trade.regions.map((region) => (
          <div key={region.key}>
            <span>{region.label}</span>
            <strong>{region.settlementLabel}</strong>
            <span>A pays {region.legAPayout ?? "unknown"} · B pays {region.legBPayout ?? "unknown"} · combined {region.combinedPayout ?? "unknown"} · P/L {formatSignedCents(region.pnl)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TradeDetailDrawer({
  trade,
  now,
  onClose,
}: {
  trade: TradeDetailModel | null;
  now: number;
  onClose: () => void;
}) {
  if (!trade) return null;
  const expiry = trade.expiryMs == null ? "unknown" : `${formatCountdown(trade.expiryMs, now)} to expiry`;
  const pnlTone = trade.worstCasePnl == null ? undefined : trade.worstCasePnl < 0 ? "loss" : "profit";
  const risk = buildTradeRiskIntelligence(trade);

  return (
    <motion.section
      animate={{ opacity: 1, y: 0 }}
      aria-label="Selected trade payoff detail"
      className="panel trade-detail-drawer"
      exit={{ opacity: 0, y: 12 }}
      initial={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.18 }}
    >
      <div className="trade-detail-header">
        <div>
          <p className="panel-kicker">selected trade payoff</p>
          <h2>{trade.title}</h2>
          <p>{trade.subtitle}</p>
        </div>
        <div className="trade-detail-header-actions">
          <span className={`trade-classification trade-classification-${trade.classification.toLowerCase().replaceAll(" ", "-")}`}>{trade.classification}</span>
          <button aria-label="Close selected trade payoff detail" onClick={onClose} type="button">Close</button>
        </div>
      </div>

      <div className="trade-detail-body">
        <div className="trade-detail-summary">
          <DetailMetric label="Structure" value={trade.structureLabel} />
          <DetailMetric label="Expiry" value={expiry} />
          <DetailMetric label="Lower Strike" value={formatDetailDollars(trade.lowerStrike)} />
          <DetailMetric label="Upper Strike" value={formatDetailDollars(trade.upperStrike)} />
          <DetailMetric label="Strike Gap" value={formatDetailDollars(trade.strikeGap)} />
          <DetailMetric label="Gap % Lower" value={formatDetailPercent(trade.strikeGapPct)} />
          <DetailMetric label="Ask Premium" value={formatDetailCents(trade.totalAskPremium)} />
          <DetailMetric label="P/L Premium" value={formatDetailCents(trade.premiumForPnl)} />
          <DetailMetric label="Minimum Payout" value={formatDetailDollars(trade.minimumPayout)} />
          <DetailMetric label="Worst-case P/L" value={formatSignedCents(trade.worstCasePnl)} tone={pnlTone} />
          <DetailMetric label="Best-case P/L" value={formatSignedCents(trade.bestCasePnl)} tone={trade.bestCasePnl != null && trade.bestCasePnl < 0 ? "loss" : "profit"} />
          <DetailMetric label="Guaranteed Edge" value={formatSignedCents(trade.guaranteedEdge)} tone={pnlTone} />
          <DetailMetric label="Loss Window" value={formatDetailDollars(trade.lossWindowWidth)} tone={trade.lossWindowWidth && trade.lossWindowWidth > 0 ? "loss" : undefined} />
          <DetailMetric label="Risk Score" value={`${risk.riskScore}/100`} tone={risk.riskLevel === "high" ? "loss" : risk.riskLevel === "medium" ? "warn" : "profit"} />
          <DetailMetric label="Confidence" value={`${risk.confidence}%`} tone={risk.confidence >= 65 ? "profit" : "warn"} />
          <DetailMetric label="Spread / Profit" value={risk.spreadProfitRatio == null ? "unknown" : `${risk.spreadProfitRatio.toFixed(2)}x`} />
          <DetailMetric label="Vol Sensitivity" value={risk.volatilitySensitivity} tone={risk.volatilitySensitivity === "high" ? "loss" : risk.volatilitySensitivity === "medium" ? "warn" : "profit"} />
          <DetailMetric label="Pair Key" value={trade.pairKey ? shortId(trade.pairKey) : "unknown"} />
        </div>

        <div className="trade-detail-leg-stack">
          <TradeDetailLegCard leg={trade.legA} />
          <TradeDetailLegCard leg={trade.legB} />
        </div>

        <div className="trade-detail-visual-grid">
          <DetailedPayoffDiagram trade={trade} />
          <div className="trade-risk-surface-card">
            <div className="trade-payoff-header">
              <div>
                <span className="signal-label">3D Risk Mapping</span>
                <strong>X: price · Y: time · Z: P&L</strong>
              </div>
              <div>
                <span className="signal-label">Floor</span>
                <strong>{formatSignedCents(trade.guaranteedEdge)}</strong>
              </div>
            </div>
            <RiskSurface3D {...riskSurfacePropsForTrade(trade)} />
          </div>
        </div>
      </div>
    </motion.section>
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

function SignalTape({
  signals,
  now,
  selectedTradeKey,
  onSelectTrade,
}: {
  signals: DashboardSignal[];
  now: number;
  selectedTradeKey: string | null;
  onSelectTrade: (trade: TradeDetailModel) => void;
}) {
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
        {signals.slice(0, 12).map((signal) => {
          const signalKey = tradeKeyFor("signal", signal);
          const tradeDetail = buildTradeDetailModel("signal", signal);
          const selectSignal = () => onSelectTrade(buildTradeDetailModel("signal", signal));
          return (
            <article
              aria-label={`Open payoff detail for Signal #${signal.id}`}
              aria-selected={selectedTradeKey === signalKey}
              className={selectedTradeKey === signalKey ? "signal-card selected-trade-card" : "signal-card"}
              key={signal.id}
              onClick={selectSignal}
              onKeyDown={(event) => handleTradeSelectKey(event, selectSignal)}
              role="button"
              tabIndex={0}
            >
              <div className="signal-card-main">
                <div className="signal-card-details">
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
                </>
              ) : null}

                  <div className="signal-leg-grid">
                    <SignalVenueRow signal={signal} venue="kalshi" />
                    <SignalVenueRow signal={signal} venue="polymarket" />
                  </div>

                  {signal.failureReason ? <div className="signal-failure">Failure: {signal.failureReason}</div> : null}
                </div>

                <aside className="signal-inline-payoff" aria-label={`Inline payoff graph for Signal #${signal.id}`}>
                  <InlineTradePayoffGraph trade={tradeDetail} variant="card" />
                </aside>
              </div>
            </article>
          );
        })}
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
  const [selectedTrade, setSelectedTrade] = useState<TradeDetailModel | null>(null);
  const [viewMode, setViewMode] = useState<DashboardViewMode>("risk");
  const selectedTradeKey = selectedTrade?.key ?? null;

  useEffect(() => {
    if (!snapshot || !selectedTradeKey) return;
    const refreshed = findTradeDetailByKey(snapshot, selectedTradeKey);
    if (refreshed) setSelectedTrade(refreshed);
  }, [snapshot, selectedTradeKey]);

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

  return (
    <main className={`terminal-shell institutional-shell view-mode-${viewMode}`}>
      <GlobalStateBar
        dashboardName={dashboardName}
        onViewModeChange={setViewMode}
        snapshot={snapshot}
        streamState={streamState}
        viewMode={viewMode}
      />

      <section className="metric-grid institutional-metrics">
        <div className="metric"><span>Guaranteed Gate</span><strong>{formatCents(snapshot.health.minProfitDollars)}</strong></div>
        <div className="metric"><span>Re-entry Cadence</span><strong>{Math.round(snapshot.health.reentryIntervalMs / 1000)}s</strong></div>
        <div className="metric"><span>Discovery Age</span><strong>{snapshot.discovery.lastDiscoveryAt ? formatCompactTime(Math.max(0, snapshot.generatedAt - snapshot.discovery.lastDiscoveryAt)) : "--"}</strong></div>
        <div className="metric"><span>Selected Mode</span><strong>{viewMode.toUpperCase()}</strong></div>
      </section>

      <section className="institutional-command-grid">
        <AnalyticsPanel snapshot={snapshot} />
        <RiskIntelligencePanel selectedTrade={selectedTrade} snapshot={snapshot} />
      </section>

      <OpportunityBlotter onSelectTrade={setSelectedTrade} selectedTradeKey={selectedTradeKey} snapshot={snapshot} />

      <AnimatePresence mode="wait">
        {selectedTrade ? <TradeDetailDrawer key={selectedTrade.key} now={snapshot.generatedAt} onClose={() => setSelectedTrade(null)} trade={selectedTrade} /> : null}
      </AnimatePresence>

      <SyntheticStructureMap snapshot={snapshot} />

      <section className="market-books-grid" aria-label="Live venue books">
        <BookTable title="Kalshi BTC 15m" venue="kalshi" contracts={snapshot.books.kalshi} snapshot={snapshot} />
        <BookTable title="Polymarket BTC 15m" venue="polymarket" contracts={snapshot.books.polymarket} snapshot={snapshot} />
      </section>

      {snapshot.discovery.lastDiscoveryError ? <div className="error-banner">Discovery error: {snapshot.discovery.lastDiscoveryError}</div> : null}

      <PolymarketDiagnosticsPanel snapshot={snapshot} />

      <section className="activity-grid" aria-label="Signal and runtime activity">
        <SignalTape onSelectTrade={setSelectedTrade} selectedTradeKey={selectedTradeKey} signals={snapshot.recentSignals} now={snapshot.generatedAt} />
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
