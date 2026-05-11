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
  DashboardDataSlice,
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
} from "../lib/dashboard-view-model";
import type { RiskSurface3DProps } from "./dashboard/risk-surface-types";

type StreamState = "connecting" | "live" | "degraded";
type SignalVenue = "kalshi" | "polymarket";
type TradeDetailSource = "opportunity" | "signal";
type TradeDetailDirection = ArbCandidate["lower"]["direction"];
type TradeDetailRegionKey = "below_lower" | "between_strikes" | "above_higher";
type DashboardViewMode = "risk" | "raw" | "execution";
export type DashboardKind = "live" | "paper";

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
  kalshiLatencyMs: number | null;
  polymarketLatencyMs: number | null;
  scanP95Ms: number | null;
  executionP95Ms: number | null;
  lastScanAgeMs: number | null;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  staleBooks: number;
}

interface BookHistoryPoint {
  timestamp: number;
  yesAsk: number | null;
  noAsk: number | null;
  spread: number | null;
}

type BookHistory = Record<string, BookHistoryPoint[]>;

export interface BookMetrics {
  contractCount: number;
  freshestAgeMs: number | null;
  stalestAgeMs: number | null;
  staleCount: number;
  averageYesSpread: number | null;
  averageNoSpread: number | null;
  bestYesAsk: number | null;
  bestNoAsk: number | null;
  scannerReadyCount: number;
  health: "empty" | "stale" | "live";
}

export interface BookRowViewModel {
  contract: BinaryContract;
  ageMs: number;
  yesSpread: number | null;
  noSpread: number | null;
  midpointProbability: number | null;
  freshnessScore: number;
  scannerReady: boolean;
  usedForArb: boolean;
  statusLabel: "fresh" | "stale" | "pending";
  spreadHeat: number;
}

export interface CrossVenueBookComparison {
  key: string;
  expiryMs: number;
  kalshiContractId: string;
  polymarketContractId: string;
  kalshiStrike: number;
  polymarketStrike: number;
  lowerStrike: number;
  upperStrike: number;
  strikeGap: number;
  strikeGapPctOfMid: number | null;
  protectedPremium: number | null;
  deadZonePremium: number | null;
  protectedEdge: number | null;
  classification: "protected_edge" | "protected_watch" | "dead_zone_risk" | "incomplete";
}

function VenueBadge({ venue }: { venue: string }) {
  return <span className={`venue venue-${venue}`}>{venue.toUpperCase()}</span>;
}

function StatusPill({ label, state }: { label: string; state: "live" | "stale" | "empty" | "warn" | "off" }) {
  return <span className={`status-pill status-${state}`}>{label}</span>;
}

function DashboardModeBadge({ kind, liveTrading }: { kind: DashboardKind | null; liveTrading: boolean }) {
  const label = kind == null
    ? liveTrading ? "BOTH / LIVE ARMED" : "BOTH DASHBOARDS"
    : kind === "live" ? liveTrading ? "LIVE ARMED" : "LIVE STANDBY" : "PAPER SIM";
  const modeClass = kind ?? "combined";
  return <span className={`dashboard-mode-badge dashboard-mode-${modeClass} ${liveTrading ? "worker-live" : "worker-paper"}`}>{label}</span>;
}

function formatReadiness(ready: boolean | undefined, reason: string | null | undefined): string {
  if (ready) return "READY";
  return reason ? reason : "NOT READY";
}

function formatExecutionState(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value.toUpperCase() : "--";
}

function shortReason(value: string): string {
  return value.length > 82 ? `${value.slice(0, 79)}...` : value;
}

function signalLatencyMs(signal: DashboardSignal): number | null {
  const started = Date.parse(signal.createdAt);
  const finished = Date.parse(signal.updatedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

function filledSignals(signals: DashboardSignal[]): DashboardSignal[] {
  return signals.filter((signal) => signal.action === "filled");
}

function dataSliceForDashboard(snapshot: DashboardSnapshot, dashboardKind: DashboardKind): DashboardDataSlice {
  if (dashboardKind === "live") {
    return snapshot.live ?? {
      recentSignals: snapshot.recentSignals.filter((signal) => signal.executionMode === "live"),
      analytics: undefined,
    };
  }
  return snapshot.paper ?? {
    recentSignals: snapshot.recentSignals,
    analytics: snapshot.analytics,
  };
}

function snapshotForDashboardKind(snapshot: DashboardSnapshot, dashboardKind: DashboardKind): DashboardSnapshot {
  const slice = dataSliceForDashboard(snapshot, dashboardKind);
  return {
    ...snapshot,
    recentSignals: slice.recentSignals,
    analytics: slice.analytics,
  };
}

function averageSignalLatency(signals: DashboardSignal[]): number | null {
  const latencies = signals.map(signalLatencyMs).filter((value): value is number => value != null);
  if (latencies.length === 0) return null;
  return latencies.reduce((total, value) => total + value, 0) / latencies.length;
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

function formatLatencyPair(p50Ms: number | null | undefined, p95Ms: number | null | undefined): string {
  return `${formatCompactTime(p50Ms ?? null)} / ${formatCompactTime(p95Ms ?? null)}`;
}

function formatRealtimeAge(now: number, timestampMs: number | null | undefined): string {
  if (timestampMs == null || !Number.isFinite(timestampMs)) return "--";
  return formatCompactTime(Math.max(0, now - timestampMs));
}

export function normalizeBinaryPrice(value: number | null | undefined): number | null {
  const numeric = safeNumber(value);
  if (numeric == null) return null;
  return Math.abs(numeric) > 1 ? numeric / 100 : numeric;
}

function contractBookKey(contract: BinaryContract): string {
  return `${contract.venue}:${contract.contractId}:${contract.expiryMs}:${contract.strike}`;
}

function binarySpread(bid: number | null | undefined, ask: number | null | undefined): number | null {
  const normalizedBid = normalizeBinaryPrice(bid);
  const normalizedAsk = normalizeBinaryPrice(ask);
  if (normalizedBid == null || normalizedAsk == null) return null;
  return Math.max(0, roundDetailDollars(normalizedAsk - normalizedBid));
}

function averageNullable(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (numeric.length === 0) return null;
  return roundDetailDollars(numeric.reduce((total, value) => total + value, 0) / numeric.length);
}

function lowestNullable(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => value != null && Number.isFinite(value));
  return numeric.length > 0 ? Math.min(...numeric) : null;
}

function impliedYesMidpoint(contract: BinaryContract): number | null {
  const yesBid = normalizeBinaryPrice(contract.yesBid);
  const yesAsk = normalizeBinaryPrice(contract.yesAsk);
  const noBid = normalizeBinaryPrice(contract.noBid);
  const noAsk = normalizeBinaryPrice(contract.noAsk);
  if (yesBid != null && yesAsk != null) return roundDetailDollars((yesBid + yesAsk) / 2);
  if (yesAsk != null && noAsk != null) return roundDetailDollars((yesAsk + (1 - noAsk)) / 2);
  if (yesAsk != null) return yesAsk;
  if (noAsk != null) return roundDetailDollars(1 - noAsk);
  if (yesBid != null) return yesBid;
  if (noBid != null) return roundDetailDollars(1 - noBid);
  return null;
}

function askForDirection(contract: BinaryContract, direction: TradeDetailDirection): number | null {
  return direction === "yes" ? normalizeBinaryPrice(contract.yesAsk) : normalizeBinaryPrice(contract.noAsk);
}

function contractAppearsInCandidates(contract: BinaryContract, candidates: ArbCandidate[]): boolean {
  return candidates.some((candidate) => (
    candidate.lower.contractId === contract.contractId
    || candidate.higher.contractId === contract.contractId
    || candidate.kalshiContractId === contract.contractId
    || candidate.polymarketContractId === contract.contractId
  ));
}

export function buildBookMetrics(contracts: BinaryContract[], snapshot: DashboardSnapshot): BookMetrics {
  const ages = contracts.map((contract) => Math.max(0, snapshot.generatedAt - contract.updatedAt));
  const yesSpreads = contracts.map((contract) => binarySpread(contract.yesBid, contract.yesAsk));
  const noSpreads = contracts.map((contract) => binarySpread(contract.noBid, contract.noAsk));
  const staleCount = contracts.filter((contract) => isContractStale(contract, snapshot)).length;
  const scannerReadyCount = contracts.filter((contract) => (
    normalizeBinaryPrice(contract.yesAsk) != null
    && normalizeBinaryPrice(contract.noAsk) != null
    && !isContractStale(contract, snapshot)
  )).length;

  return {
    contractCount: contracts.length,
    freshestAgeMs: ages.length > 0 ? Math.min(...ages) : null,
    stalestAgeMs: ages.length > 0 ? Math.max(...ages) : null,
    staleCount,
    averageYesSpread: averageNullable(yesSpreads),
    averageNoSpread: averageNullable(noSpreads),
    bestYesAsk: lowestNullable(contracts.map((contract) => normalizeBinaryPrice(contract.yesAsk))),
    bestNoAsk: lowestNullable(contracts.map((contract) => normalizeBinaryPrice(contract.noAsk))),
    scannerReadyCount,
    health: contracts.length === 0 ? "empty" : staleCount > 0 ? "stale" : "live",
  };
}

export function buildBookRowViewModel(
  contract: BinaryContract,
  snapshot: DashboardSnapshot,
  candidates: ArbCandidate[] = snapshot.liveCandidates,
): BookRowViewModel {
  const ageMs = Math.max(0, snapshot.generatedAt - contract.updatedAt);
  const yesSpread = binarySpread(contract.yesBid, contract.yesAsk);
  const noSpread = binarySpread(contract.noBid, contract.noAsk);
  const averageSpread = averageNullable([yesSpread, noSpread]);
  const stale = isContractStale(contract, snapshot);
  const scannerReady = normalizeBinaryPrice(contract.yesAsk) != null && normalizeBinaryPrice(contract.noAsk) != null && !stale;

  return {
    contract,
    ageMs,
    yesSpread,
    noSpread,
    midpointProbability: impliedYesMidpoint(contract),
    freshnessScore: snapshot.health.staleBookMs <= 0 ? 1 : clamp(1 - ageMs / snapshot.health.staleBookMs, 0, 1),
    scannerReady,
    usedForArb: contractAppearsInCandidates(contract, candidates),
    statusLabel: scannerReady ? "fresh" : stale ? "stale" : "pending",
    spreadHeat: averageSpread == null ? 0 : clamp(averageSpread / 0.05, 0, 1),
  };
}

export function appendBookHistory(previous: BookHistory, snapshot: DashboardSnapshot): BookHistory {
  const next: BookHistory = {};
  for (const contract of [...snapshot.books.kalshi, ...snapshot.books.polymarket]) {
    const key = contractBookKey(contract);
    const yesSpread = binarySpread(contract.yesBid, contract.yesAsk);
    const noSpread = binarySpread(contract.noBid, contract.noAsk);
    const point: BookHistoryPoint = {
      timestamp: snapshot.generatedAt,
      yesAsk: normalizeBinaryPrice(contract.yesAsk),
      noAsk: normalizeBinaryPrice(contract.noAsk),
      spread: averageNullable([yesSpread, noSpread]),
    };
    const existing = previous[key] ?? [];
    const withoutDuplicate = existing.filter((sample) => sample.timestamp !== snapshot.generatedAt);
    next[key] = [...withoutDuplicate, point].slice(-32);
  }
  return next;
}

export function buildCrossVenueBookComparisons(snapshot: DashboardSnapshot): CrossVenueBookComparison[] {
  const comparisons: CrossVenueBookComparison[] = [];
  for (const kalshi of snapshot.books.kalshi) {
    for (const polymarket of snapshot.books.polymarket) {
      if (kalshi.expiryMs !== polymarket.expiryMs) continue;
      const lower = kalshi.strike <= polymarket.strike ? kalshi : polymarket;
      const upper = lower === kalshi ? polymarket : kalshi;
      const strikeGap = roundDetailDollars(Math.max(0, upper.strike - lower.strike));
      const midStrike = (upper.strike + lower.strike) / 2;
      const protectedAskA = askForDirection(lower, "yes");
      const protectedAskB = askForDirection(upper, "no");
      const deadZoneAskA = askForDirection(lower, "no");
      const deadZoneAskB = askForDirection(upper, "yes");
      const protectedPremium = protectedAskA == null || protectedAskB == null ? null : roundDetailDollars(protectedAskA + protectedAskB);
      const deadZonePremium = deadZoneAskA == null || deadZoneAskB == null ? null : roundDetailDollars(deadZoneAskA + deadZoneAskB);
      const protectedEdge = protectedPremium == null ? null : roundDetailDollars(1 - protectedPremium);
      const classification: CrossVenueBookComparison["classification"] = protectedPremium == null
        ? deadZonePremium == null ? "incomplete" : "dead_zone_risk"
        : protectedEdge != null && protectedEdge >= snapshot.health.minProfitDollars
          ? "protected_edge"
          : protectedEdge != null && protectedEdge >= 0
            ? "protected_watch"
            : "dead_zone_risk";

      comparisons.push({
        key: `${kalshi.contractId}:${polymarket.contractId}`,
        expiryMs: kalshi.expiryMs,
        kalshiContractId: kalshi.contractId,
        polymarketContractId: polymarket.contractId,
        kalshiStrike: kalshi.strike,
        polymarketStrike: polymarket.strike,
        lowerStrike: lower.strike,
        upperStrike: upper.strike,
        strikeGap,
        strikeGapPctOfMid: midStrike > 0 ? strikeGap / midStrike : null,
        protectedPremium,
        deadZonePremium,
        protectedEdge,
        classification,
      });
    }
  }
  return comparisons.sort((left, right) => left.strikeGap - right.strikeGap || left.expiryMs - right.expiryMs).slice(0, 6);
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
  const signalPools = [
    snapshot.live?.recentSignals ?? [],
    snapshot.paper?.recentSignals ?? [],
    snapshot.recentSignals,
  ];
  for (const signals of signalPools) {
    const signal = signals.find((item) => tradeKeyFor("signal", item) === key);
    if (signal) return buildTradeDetailModel("signal", signal);
  }
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
  const rawFeedLatencyMs = books.length > 0 ? Math.max(...books.map((book) => Math.max(0, snapshot.generatedAt - book.updatedAt))) : null;
  const kalshiLatencyMs = snapshot.latency?.books.kalshi.latestMs ?? (snapshot.books.kalshi.length > 0 ? Math.min(...snapshot.books.kalshi.map((book) => Math.max(0, snapshot.generatedAt - book.updatedAt))) : null);
  const polymarketLatencyMs = snapshot.latency?.books.polymarket.latestMs ?? (snapshot.books.polymarket.length > 0 ? Math.min(...snapshot.books.polymarket.map((book) => Math.max(0, snapshot.generatedAt - book.updatedAt))) : null);
  const feedLatencyMs = snapshot.latency
    ? Math.max(kalshiLatencyMs ?? 0, polymarketLatencyMs ?? 0)
    : rawFeedLatencyMs;
  const estimatedEdge = snapshot.liveCandidates.length > 0 ? Math.max(...snapshot.liveCandidates.map((candidate) => candidate.guaranteedProfit)) : null;
  const lastScanAgeMs = snapshot.scanner.lastScanAt ? Math.max(0, snapshot.generatedAt - snapshot.scanner.lastScanAt) : null;
  const staleBooks = staleContractCount(snapshot);
  const sampleRiskScores = snapshot.liveCandidates.slice(0, 12).map((candidate) => buildTradeRiskIntelligence(buildTradeDetailModel("opportunity", candidate), staleBooks > 0 ? 10 : 0).riskScore);
  const riskScore = sampleRiskScores.length > 0 ? Math.max(...sampleRiskScores) : staleBooks > 0 ? 48 : 18;

  return {
    estimatedEdge,
    activeOpportunities: snapshot.liveCandidates.length,
    feedLatencyMs,
    kalshiLatencyMs,
    polymarketLatencyMs,
    scanP95Ms: snapshot.latency?.scanner.scanDurationMs.p95Ms ?? null,
    executionP95Ms: snapshot.latency?.execution.durationMs.p95Ms ?? null,
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

function BucketPnlBars({ analytics }: { analytics: DashboardAnalyticsWindow }) {
  const data = analytics.buckets.map((bucket) => ({
    label: bucket.label,
    netPnl: bucket.netPnl,
    tradeCount: bucket.tradeCount ?? 0,
  }));

  return (
    <div className="analytics-chart-card" aria-label="Bucket PnL bars">
      <div className="analytics-chart-heading">
        <span className="signal-label">Bucket PnL Bars</span>
        <strong>Net edge by bucket</strong>
      </div>
      <span className="sr-only">Bucket PnL bars. Y-axis: Bucket PnL ($). X-axis: selected analytics buckets.</span>
      <BarChart accessibilityLayer data={data} height={180} margin={{ top: 14, right: 16, bottom: 4, left: 0 }} width={520}>
        <CartesianGrid stroke="rgba(116, 130, 149, 0.14)" strokeDasharray="3 3" />
        <XAxis dataKey="label" minTickGap={14} stroke="#748295" tick={{ fill: "#748295", fontSize: 10 }} tickLine={false} />
        <YAxis
          label={{ value: "Y-axis: Bucket PnL ($)", angle: -90, position: "insideLeft", fill: "#91a0b5", fontSize: 10 }}
          stroke="#748295"
          tick={{ fill: "#748295", fontSize: 10 }}
          tickFormatter={(value) => `$${Number(value).toFixed(2)}`}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{ background: "#071018", border: "1px solid rgba(116, 130, 149, 0.32)", color: "#e6edf3" }}
          formatter={(value, name) => [name === "tradeCount" ? Number(value).toFixed(0) : `$${Number(value).toFixed(4)}`, name === "tradeCount" ? "Filled trades" : "Net PnL"]}
          labelFormatter={(label) => `Bucket ${label}`}
        />
        <Bar dataKey="netPnl" fill="#4cc9f0" isAnimationActive={false} name="Net PnL" radius={[4, 4, 0, 0]} />
        <Bar dataKey="tradeCount" fill="rgba(145, 160, 181, 0.45)" isAnimationActive={false} name="Filled trades" radius={[4, 4, 0, 0]} />
      </BarChart>
    </div>
  );
}

function DrawdownChart({ analytics }: { analytics: DashboardAnalyticsWindow }) {
  const data = analytics.buckets.map((bucket) => ({
    label: bucket.label,
    drawdown: bucket.drawdown ?? 0,
  }));

  return (
    <div className="analytics-chart-card" aria-label="Drawdown chart">
      <div className="analytics-chart-heading">
        <span className="signal-label">Drawdown Chart</span>
        <strong>Peak-to-trough estimated PnL</strong>
      </div>
      <span className="sr-only">Drawdown chart. Y-axis: Drawdown ($). X-axis: selected analytics buckets.</span>
      <AreaChart accessibilityLayer data={data} height={180} margin={{ top: 14, right: 16, bottom: 4, left: 0 }} width={520}>
        <defs>
          <linearGradient id="drawdownGradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#ff5f65" stopOpacity={0.32} />
            <stop offset="100%" stopColor="#ff5f65" stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="rgba(116, 130, 149, 0.14)" strokeDasharray="3 3" />
        <XAxis dataKey="label" minTickGap={14} stroke="#748295" tick={{ fill: "#748295", fontSize: 10 }} tickLine={false} />
        <YAxis
          label={{ value: "Y-axis: Drawdown ($)", angle: -90, position: "insideLeft", fill: "#91a0b5", fontSize: 10 }}
          stroke="#748295"
          tick={{ fill: "#748295", fontSize: 10 }}
          tickFormatter={(value) => `$${Number(value).toFixed(2)}`}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{ background: "#071018", border: "1px solid rgba(116, 130, 149, 0.32)", color: "#e6edf3" }}
          formatter={(value) => [`$${Number(value).toFixed(4)}`, "Drawdown"]}
          labelFormatter={(label) => `Bucket ${label}`}
        />
        <Area dataKey="drawdown" fill="url(#drawdownGradient)" isAnimationActive={false} name="Drawdown" stroke="#ff5f65" strokeWidth={2.2} type="monotone" />
      </AreaChart>
    </div>
  );
}

function DistributionBars({
  buckets,
  title,
  subtitle,
  ariaLabel,
}: {
  buckets: Array<{ label: string; count: number }>;
  title: string;
  subtitle: string;
  ariaLabel: string;
}) {
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return (
    <div className="analytics-chart-card analytics-distribution-card" aria-label={ariaLabel}>
      <div className="analytics-chart-heading">
        <span className="signal-label">{title}</span>
        <strong>{subtitle}</strong>
      </div>
      <div className="distribution-bars">
        {buckets.length === 0 ? (
          <div className="analytics-empty compact">No distribution samples yet.</div>
        ) : buckets.map((bucket) => (
          <div className="distribution-row" key={bucket.label}>
            <span>{bucket.label}</span>
            <div className="distribution-track" aria-label={`${bucket.label}: ${bucket.count} trades`}>
              <i style={{ width: `${Math.max(4, (bucket.count / maxCount) * 100)}%` }} />
            </div>
            <strong>{bucket.count}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function LatencySparkline({ analytics }: { analytics: DashboardAnalyticsWindow }) {
  const series = (analytics.fillLatencySeries ?? []).map((point, index) => ({
    label: point.label,
    value: point.winRate ?? point.netPnl ?? 0,
    index,
  }));
  const maxLatency = Math.max(1, ...series.map((point) => point.value));
  const width = 420;
  const height = 120;
  const points = series.map((point) => {
    const x = series.length <= 1 ? width / 2 : (point.index / (series.length - 1)) * width;
    const y = height - (point.value / maxLatency) * (height - 18) - 8;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  return (
    <div className="analytics-chart-card" aria-label="Fill latency sparkline">
      <div className="analytics-chart-heading">
        <span className="signal-label">Latency Sparkline</span>
        <strong>Average fill latency by bucket</strong>
      </div>
      <svg className="analytics-sparkline" role="img" viewBox={`0 0 ${width} ${height}`} aria-label="Fill latency sparkline. Y-axis: fill latency milliseconds. X-axis: selected analytics buckets.">
        <title>Fill latency sparkline. Y-axis: fill latency milliseconds. X-axis: selected analytics buckets.</title>
        <line className="analytics-axis-line" x1="0" x2="420" y1="112" y2="112" />
        <line className="analytics-axis-line" x1="0" x2="0" y1="8" y2="112" />
        <text className="analytics-svg-label" x="8" y="18">Y: fill latency</text>
        <text className="analytics-svg-label" x="292" y="106">X: buckets</text>
        <polyline className="analytics-sparkline-line" points={points} />
        {series.map((point) => {
          const [x, y] = points.split(" ")[point.index]?.split(",").map(Number) ?? [0, height];
          return <circle className="analytics-sparkline-dot" cx={x} cy={y} key={`${point.label}-${point.index}`} r="2.8" />;
        })}
      </svg>
      <div className="analytics-chart-foot">
        <span>Avg {formatCompactTime(analytics.avgFillLatencyMs ?? null)}</span>
        <span>Samples {analytics.filledTrades}</span>
      </div>
    </div>
  );
}

function AnalyticsHeatmap({ analytics }: { analytics: DashboardAnalyticsWindow }) {
  const cells = analytics.heatmap ?? [];
  const maxAbsPnl = Math.max(0.01, ...cells.map((cell) => Math.abs(cell.netPnl ?? 0)));
  return (
    <div className="analytics-chart-card" aria-label="Opportunity heatmap">
      <div className="analytics-chart-heading">
        <span className="signal-label">Hourly/Day Heatmap</span>
        <strong>Opportunity frequency and edge density</strong>
      </div>
      <div className="analytics-heatmap" role="img" aria-label="Heatmap. Color shows estimated PnL, label shows trade count.">
        {cells.length === 0 ? (
          <div className="analytics-empty compact">No heatmap buckets yet.</div>
        ) : cells.map((cell) => {
          const pnl = cell.netPnl ?? 0;
          const intensity = clamp(Math.abs(pnl) / maxAbsPnl, 0.08, 1);
          const color = pnl >= 0
            ? `rgba(70, 214, 125, ${0.18 + intensity * 0.58})`
            : `rgba(255, 95, 101, ${0.18 + intensity * 0.58})`;
          return (
            <span
              className="heatmap-cell"
              key={`${cell.startMs}-${cell.label}`}
              style={{ background: color }}
              title={`${cell.label}: ${cell.tradeCount} trades, ${formatSignedCents(pnl)}`}
            >
              <small>{cell.label}</small>
              <strong>{cell.tradeCount}</strong>
            </span>
          );
        })}
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

function DashboardFocusControls({
  activeDashboard,
  onSelectDashboard,
}: {
  activeDashboard: DashboardKind | null;
  onSelectDashboard: (kind: DashboardKind | null) => void;
}) {
  const controls: Array<{ kind: DashboardKind | null; label: string }> = [
    { kind: null, label: "Show Both" },
    { kind: "live", label: "View Live Only" },
    { kind: "paper", label: "View Paper Only" },
  ];
  return (
    <div className="dashboard-focus-controls" aria-label="Dashboard focus controls">
      {controls.map((control) => (
        <button
          aria-pressed={activeDashboard === control.kind}
          className={`selector-return-button ${activeDashboard === control.kind ? "active" : ""}`}
          key={control.label}
          onClick={() => onSelectDashboard(control.kind)}
          type="button"
        >
          {control.label}
        </button>
      ))}
    </div>
  );
}

function GlobalStateBar({
  dashboardName,
  dashboardKind,
  onDashboardRouteChange,
  snapshot,
  streamState,
  viewMode,
  onViewModeChange,
}: {
  dashboardName: string;
  dashboardKind: DashboardKind | null;
  onDashboardRouteChange?: (kind: DashboardKind | null) => void;
  snapshot: DashboardSnapshot;
  streamState: StreamState;
  viewMode: DashboardViewMode;
  onViewModeChange: (mode: DashboardViewMode) => void;
}) {
  const insights = buildDashboardInsights(snapshot);
  const viewModes: DashboardViewMode[] = ["risk", "raw", "execution"];
  const execution = snapshot.execution;

  return (
    <header className="institutional-topbar">
      <div className="topbar-brand">
        <p className="panel-kicker">cross-venue binary arb</p>
        <h1>{dashboardName}</h1>
        <span>Kalshi + Polymarket BTC 15m</span>
        <div className="dashboard-mode-row">
          <DashboardModeBadge kind={dashboardKind} liveTrading={snapshot.health.liveTrading} />
          {dashboardKind === "paper" && snapshot.health.liveTrading ? <StatusPill label="WORKER LIVE" state="warn" /> : null}
          {onDashboardRouteChange ? <DashboardFocusControls activeDashboard={dashboardKind} onSelectDashboard={onDashboardRouteChange} /> : null}
        </div>
      </div>

      <div className="topbar-kpis">
        <div className="hero-kpi">
          <span>Estimated Edge</span>
          <strong className={(insights.estimatedEdge ?? 0) >= snapshot.health.minProfitDollars ? "profit" : ""}>{formatSignedCents(insights.estimatedEdge)}</strong>
        </div>
        <div className="topbar-kpi"><span>Active Opportunities</span><strong>{insights.activeOpportunities}</strong></div>
        <div className="topbar-kpi"><span>Feed Latency</span><strong>{formatCompactTime(insights.feedLatencyMs)}</strong></div>
        <div className="topbar-kpi"><span>Last Scan</span><strong>{formatCompactTime(insights.lastScanAgeMs)}</strong></div>
        <div className="topbar-kpi"><span>Kalshi Age</span><strong>{formatCompactTime(insights.kalshiLatencyMs)}</strong></div>
        <div className="topbar-kpi"><span>Polymarket Age</span><strong>{formatCompactTime(insights.polymarketLatencyMs)}</strong></div>
        <div className="topbar-kpi"><span>Scan p95</span><strong>{formatCompactTime(insights.scanP95Ms)}</strong></div>
        <div className="topbar-kpi"><span>Exec p95</span><strong>{formatCompactTime(insights.executionP95Ms)}</strong></div>
      </div>

      <div className="topbar-state">
        <div className="status-rail">
          <StatusPill label={streamState === "live" ? "SSE LIVE" : "SSE DEGRADED"} state={streamState === "live" ? "live" : "warn"} />
          <StatusPill label={snapshot.health.arbEnabled ? "STRATEGY ON" : "STRATEGY OFF"} state={snapshot.health.arbEnabled ? "live" : "off"} />
          <StatusPill label={snapshot.health.liveTrading ? "LIVE EXECUTION ENABLED" : "PAPER / DRY-RUN ENGINE"} state={snapshot.health.liveTrading ? "warn" : "live"} />
          {execution?.partialFillLocked ? <StatusPill label="PARTIAL LOCK" state="stale" /> : null}
          {snapshot.health.liveTrading && execution ? <StatusPill label={execution.polymarket.ready && execution.kalshi.ready ? "VENUES READY" : "VENUE CHECK"} state={execution.polymarket.ready && execution.kalshi.ready ? "live" : "warn"} /> : null}
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

function MobileSectionNav() {
  const sections = [
    ["Edge", "opportunities"],
    ["Risk", "risk-intelligence"],
    ["Detail", "trade-detail"],
    ["Books", "market-books"],
    ["Signals", "signals"],
  ] as const;

  return (
    <nav className="mobile-section-nav" aria-label="Dashboard sections">
      {sections.map(([label, id]) => (
        <a href={`#${id}`} key={id}>{label}</a>
      ))}
    </nav>
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
  const latency = snapshot.latency;

  return (
    <section className="panel risk-intelligence-panel" id="risk-intelligence">
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
          <div><span>Scanner p95</span><strong>{formatCompactTime(latency?.scanner.scanDurationMs.p95Ms ?? null)}</strong></div>
          <div><span>DB Insert p95</span><strong>{formatCompactTime(latency?.persistence.insertMs.p95Ms ?? null)}</strong></div>
          <div><span>Execution p95</span><strong>{formatCompactTime(latency?.execution.durationMs.p95Ms ?? null)}</strong></div>
          <div><span>Snapshot Build p95</span><strong>{formatCompactTime(latency?.dashboard.snapshotBuildMs.p95Ms ?? null)}</strong></div>
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

function AnalyticsPanel({ snapshot, dashboardKind = "paper" }: { snapshot: DashboardSnapshot; dashboardKind?: DashboardKind }) {
  const [selected, setSelected] = useState<AnalyticsWindow>("hourly");
  const analytics = snapshot.analytics;
  const current = analytics?.[selected];
  const liveView = dashboardKind === "live";

  if (!analytics || !current) {
    return (
      <section className="panel analytics-panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">performance analytics</p>
            <h2>{liveView ? "Executed Fill-Audit PnL" : "Estimated Guaranteed PnL"}</h2>
          </div>
          <StatusPill label="WAITING" state="warn" />
        </div>
        <div className="analytics-empty">
          The worker has not published {liveView ? "live" : "paper"} analytics yet.
        </div>
      </section>
    );
  }

  const windows: AnalyticsWindow[] = ["hourly", "daily", "weekly"];
  const noTrades = current.filledTrades === 0;
  const realtime = analytics.realtime;
  const realtimeMode = realtime?.mode === "fallback_db" ? "Fallback DB" : "Hot-cache";
  const realtimeState = realtime?.stale ? "STALE" : "REALTIME";
  return (
    <section className="panel analytics-panel">
      <div className="panel-header analytics-header">
        <div>
          <p className="panel-kicker">performance analytics</p>
          <h2>{liveView ? "Executed Fill-Audit PnL" : "Estimated Guaranteed PnL"}</h2>
          <p className="analytics-subtitle">
            {liveView ? "Live exchange-fill audit records only; conservative $1.00 payoff floor, not settlement-final PnL." : "Dry-run simulated fills; conservative $1.00 payoff floor, not settlement-final PnL."}
          </p>
        </div>
        <div className="analytics-header-actions">
          <StatusPill label={realtimeState} state={realtime?.stale ? "warn" : "live"} />
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
      </div>

      <div className="analytics-body">
        <div className="analytics-realtime-strip" aria-label="Realtime analytics freshness">
          <div><span>Mode</span><strong>{realtime ? realtimeMode : "Legacy snapshot"}</strong></div>
          <div><span>Last Fill Update</span><strong>{formatRealtimeAge(snapshot.generatedAt, realtime?.lastUpdatedAt)}</strong></div>
          <div><span>DB Reconcile Age</span><strong>{formatRealtimeAge(snapshot.generatedAt, realtime?.lastDbReconciledAt)}</strong></div>
          <div><span>Compute Time</span><strong>{formatCompactTime(realtime?.computeMs ?? null)}</strong></div>
          <div><span>Source Signals</span><strong>{realtime?.sourceSignalCount ?? "--"}</strong></div>
        </div>

        <div className="analytics-grid">
          <div className="analytics-card primary"><span>Net PnL</span><strong className={current.netPnl >= 0 ? "profit" : "loss"}>{formatSignedCents(current.netPnl)}</strong></div>
          <div className="analytics-card"><span>Win Rate</span><strong>{formatPercent(current.winRate)}</strong></div>
          <div className="analytics-card"><span>Trades Won</span><strong>{current.tradesWon}</strong></div>
          <div className="analytics-card"><span>Loss Rate</span><strong>{formatPercent(current.lossRate)}</strong></div>
          <div className="analytics-card"><span>Trades Lost</span><strong>{current.tradesLost}</strong></div>
          <div className="analytics-card"><span>Profit Factor</span><strong>{formatRatio(current.profitFactor, current)}</strong></div>
          <div className="analytics-card"><span>Sharpe Ratio</span><strong>{formatSharpe(current.sharpeRatio)}</strong></div>
          <div className="analytics-card"><span>Filled Trades</span><strong>{current.filledTrades}</strong></div>
          <div className="analytics-card"><span>Max Drawdown</span><strong className="loss">{formatCents(current.maxDrawdown ?? 0)}</strong></div>
          <div className="analytics-card"><span>Avg Premium</span><strong>{formatCents(current.avgPremium ?? null)}</strong></div>
          <div className="analytics-card"><span>Avg Slippage</span><strong>{formatSignedCents(current.avgSlippage ?? null)}</strong></div>
          <div className="analytics-card"><span>Avg Fill Latency</span><strong>{formatCompactTime(current.avgFillLatencyMs ?? null)}</strong></div>
          <div className="analytics-card"><span>Opportunities</span><strong>{current.opportunityCount ?? current.filledTrades}</strong></div>
          <div className="analytics-card"><span>Fill Rate</span><strong>{formatPercent(current.fillRate ?? 0)}</strong></div>
          <div className="analytics-card"><span>Best Trade</span><strong className="profit">{formatSignedCents(current.bestTradePnl)}</strong></div>
          <div className="analytics-card"><span>Worst Trade</span><strong className="loss">{formatSignedCents(current.worstTradePnl)}</strong></div>
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

        {!noTrades && (
          <div className="analytics-chart-suite" aria-label="Realtime rich analytics charts">
            <BucketPnlBars analytics={current} />
            <DrawdownChart analytics={current} />
            <DistributionBars
              ariaLabel="Win loss PnL distribution"
              buckets={current.pnlDistribution ?? []}
              subtitle="Wins, losses, breakevens, and edge bands"
              title="Win/Loss Distribution"
            />
            <DistributionBars
              ariaLabel="Slippage histogram"
              buckets={current.slippageDistribution ?? []}
              subtitle="Dry-run/live fill slippage vs observed asks"
              title="Slippage Histogram"
            />
            <LatencySparkline analytics={current} />
            <AnalyticsHeatmap analytics={current} />
          </div>
        )}
      </div>
    </section>
  );
}

function BookMetricTile({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "warn" }) {
  return (
    <div className={`book-kpi book-kpi-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProbabilityBar({
  label,
  bid,
  ask,
  tone,
}: {
  label: string;
  bid: number | null | undefined;
  ask: number | null | undefined;
  tone: "yes" | "no";
}) {
  const normalizedBid = normalizeBinaryPrice(bid);
  const normalizedAsk = normalizeBinaryPrice(ask);
  return (
    <div className={`probability-bar probability-bar-${tone}`}>
      <div className="probability-bar-label">
        <span>{label}</span>
        <strong>{formatCents(normalizedBid)} / {formatCents(normalizedAsk)}</strong>
      </div>
      <div className="probability-track" aria-label={`${label} bid ask probability bar`}>
        <span className="probability-bid-fill" style={{ width: `${clamp((normalizedBid ?? 0) * 100, 0, 100)}%` }} />
        <span className="probability-ask-fill" style={{ width: `${clamp((normalizedAsk ?? 0) * 100, 0, 100)}%` }} />
      </div>
    </div>
  );
}

function SpreadHeatStrip({ yesSpread, noSpread }: { yesSpread: number | null; noSpread: number | null }) {
  const heat = clamp(((yesSpread ?? 0) + (noSpread ?? 0)) / 0.1, 0, 1);
  return (
    <div className="spread-heat-strip" aria-label="Spread-width heat strip">
      {Array.from({ length: 12 }, (_, index) => (
        <span
          className={index / 11 <= heat ? "active" : ""}
          key={index}
          style={{ opacity: index / 11 <= heat ? 0.45 + index / 24 : 0.18 }}
        />
      ))}
    </div>
  );
}

function FreshnessPulse({ metrics }: { metrics: BookMetrics }) {
  return (
    <div className={`freshness-pulse freshness-${metrics.health}`} aria-label="Freshness pulse indicator">
      <span />
      <div>
        <strong>{metrics.health.toUpperCase()}</strong>
        <small>{metrics.freshestAgeMs == null ? "No samples" : `freshest ${formatCompactTime(metrics.freshestAgeMs)} · stalest ${formatCompactTime(metrics.stalestAgeMs)}`}</small>
      </div>
    </div>
  );
}

function StrikeLadder({ rows, snapshot }: { rows: BookRowViewModel[]; snapshot: DashboardSnapshot }) {
  const strikes = rows.map((row) => row.contract.strike).filter((strike) => Number.isFinite(strike));
  const minStrike = strikes.length > 0 ? Math.min(...strikes) : null;
  const maxStrike = strikes.length > 0 ? Math.max(...strikes) : null;
  const range = minStrike == null || maxStrike == null ? 1 : Math.max(1, maxStrike - minStrike);

  return (
    <div className="strike-ladder" aria-label="Strike Ladder">
      <div className="strike-ladder-header">
        <span>Strike Ladder</span>
        <strong>{minStrike == null ? "--" : `${formatDollars(minStrike)} - ${formatDollars(maxStrike)}`}</strong>
      </div>
      <div className="strike-ladder-track">
        {rows.slice(0, 18).map((row) => {
          const left = minStrike == null ? 50 : clamp(((row.contract.strike - minStrike) / range) * 100, 2, 98);
          return (
            <span
              aria-label={`${row.contract.venue} ${formatDollars(row.contract.strike)} expires in ${formatCountdown(row.contract.expiryMs, snapshot.generatedAt)}`}
              className={`strike-ladder-dot ${row.statusLabel}`}
              key={row.contract.contractId}
              style={{ left: `${left}%` }}
              title={`${formatDollars(row.contract.strike)} · ${formatCountdown(row.contract.expiryMs, snapshot.generatedAt)}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function BookSparkline({ label, points, field }: { label: string; points: BookHistoryPoint[]; field: "yesAsk" | "noAsk" | "spread" }) {
  const values = points.map((point) => point[field]).filter((value): value is number => value != null && Number.isFinite(value));
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 1;
  const range = Math.max(0.01, max - min);
  const path = values.map((value, index) => {
    const x = values.length === 1 ? 58 : 8 + (index / Math.max(1, values.length - 1)) * 104;
    const y = 28 - ((value - min) / range) * 22;
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");

  return (
    <div className="book-sparkline">
      <span>{label}</span>
      <svg viewBox="0 0 120 34" role="img" aria-label={label}>
        <title>{values.length > 1 ? `${label}: ${values.map((value) => formatCents(value)).join(" → ")}` : `${label}: waiting for rolling SSE samples`}</title>
        <line x1="8" x2="112" y1="28" y2="28" />
        {path ? <path d={path} /> : null}
        {values.length <= 1 ? <text x="60" y="19">live</text> : null}
      </svg>
    </div>
  );
}

function BookRowVisual({ history }: { history: BookHistoryPoint[] }) {
  return (
    <div className="book-row-visual" aria-label="Rolling top-of-book sparklines">
      <BookSparkline field="yesAsk" label="YES Ask Spark" points={history} />
      <BookSparkline field="noAsk" label="NO Ask Spark" points={history} />
      <BookSparkline field="spread" label="Spread Spark" points={history} />
    </div>
  );
}

function BookVisualSummary({
  metrics,
  rows,
  snapshot,
}: {
  metrics: BookMetrics;
  rows: BookRowViewModel[];
  snapshot: DashboardSnapshot;
}) {
  const bestYesContract = [...rows].sort((left, right) => (normalizeBinaryPrice(left.contract.yesAsk) ?? Number.POSITIVE_INFINITY) - (normalizeBinaryPrice(right.contract.yesAsk) ?? Number.POSITIVE_INFINITY))[0]?.contract;
  const bestNoContract = [...rows].sort((left, right) => (normalizeBinaryPrice(left.contract.noAsk) ?? Number.POSITIVE_INFINITY) - (normalizeBinaryPrice(right.contract.noAsk) ?? Number.POSITIVE_INFINITY))[0]?.contract;

  return (
    <div className="book-visual-summary">
      <div className="book-visual-title">
        <span>Live Top-of-Book Visuals</span>
        <strong>{metrics.scannerReadyCount}/{metrics.contractCount} scanner-ready</strong>
      </div>
      <div className="book-visual-grid">
        <ProbabilityBar
          ask={bestYesContract?.yesAsk ?? null}
          bid={bestYesContract?.yesBid ?? null}
          label="Best YES bid/ask"
          tone="yes"
        />
        <ProbabilityBar
          ask={bestNoContract?.noAsk ?? null}
          bid={bestNoContract?.noBid ?? null}
          label="Best NO bid/ask"
          tone="no"
        />
        <div className="spread-heat-card">
          <div className="strike-ladder-header">
            <span>Spread Heat</span>
            <strong>YES {formatCents(metrics.averageYesSpread)} · NO {formatCents(metrics.averageNoSpread)}</strong>
          </div>
          <SpreadHeatStrip yesSpread={metrics.averageYesSpread} noSpread={metrics.averageNoSpread} />
        </div>
        <FreshnessPulse metrics={metrics} />
      </div>
      <StrikeLadder rows={rows} snapshot={snapshot} />
    </div>
  );
}

function CrossVenueBookStrip({ snapshot }: { snapshot: DashboardSnapshot }) {
  const comparisons = buildCrossVenueBookComparisons(snapshot);
  return (
    <section className="panel cross-venue-book-strip" aria-label="Cross-venue book comparison">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">pair monitor</p>
          <h2>Cross-Venue Book Compare</h2>
          <p className="panel-subtitle">Closest same-expiry strikes, premium proxies, and protected/dead-zone structure hints from live top-of-book.</p>
        </div>
        <span className="big-number">{comparisons.length}</span>
      </div>
      <div className="cross-venue-card-row">
        {comparisons.map((comparison) => (
          <article className={`cross-venue-card comparison-${comparison.classification}`} key={comparison.key}>
            <div className="cross-venue-card-head">
              <span>{formatCountdown(comparison.expiryMs, snapshot.generatedAt)}</span>
              <strong>{comparison.classification.replaceAll("_", " ")}</strong>
            </div>
            <div className="cross-venue-strikes">
              <div><span>Kalshi</span><strong>{formatDollars(comparison.kalshiStrike)}</strong></div>
              <div><span>Polymarket</span><strong>{formatDollars(comparison.polymarketStrike)}</strong></div>
            </div>
            <div className="cross-venue-metrics">
              <span>Strike gap <strong>{formatDollars(comparison.strikeGap)}</strong></span>
              <span>Gap % mid <strong>{formatDetailPercent(comparison.strikeGapPctOfMid)}</strong></span>
              <span>Protected premium <strong>{formatCents(comparison.protectedPremium)}</strong></span>
              <span>Dead-zone premium <strong>{formatCents(comparison.deadZonePremium)}</strong></span>
              <span>Protected edge <strong className={(comparison.protectedEdge ?? -1) >= snapshot.health.minProfitDollars ? "profit" : ""}>{formatSignedCents(comparison.protectedEdge)}</strong></span>
            </div>
          </article>
        ))}
        {comparisons.length === 0 ? <div className="empty-cell">No same-expiry Kalshi/Polymarket book pairs are ready for comparison yet.</div> : null}
      </div>
    </section>
  );
}

function BookTable({
  title,
  venue,
  contracts,
  snapshot,
  candidates,
  history,
}: {
  title: string;
  venue: "kalshi" | "polymarket";
  contracts: BinaryContract[];
  snapshot: DashboardSnapshot;
  candidates: ArbCandidate[];
  history: BookHistory;
}) {
  const metrics = buildBookMetrics(contracts, snapshot);
  const rows = sortContractsForBook(contracts).slice(0, 24).map((contract) => buildBookRowViewModel(contract, snapshot, candidates));
  const venueLatency = snapshot.latency?.books[venue];
  const wsApplyLatency = snapshot.latency?.wsToBookApplyMs[venue];

  return (
    <section className="panel book-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">{venue}</p>
          <h2>{title}</h2>
          <p className="panel-subtitle">Live top-of-book, spread quality, freshness, and scanner readiness.</p>
        </div>
        <StatusPill label={metrics.health} state={metrics.health} />
      </div>
      <div className="book-kpi-section">
        <div className="book-kpi-heading">
          <span>Venue KPIs</span>
          <strong>{metrics.health.toUpperCase()} HEALTH</strong>
        </div>
        <div className="book-kpi-grid">
          <BookMetricTile label="Contracts" value={`${metrics.contractCount}`} />
          <BookMetricTile label="Freshest / Stalest" value={`${formatCompactTime(metrics.freshestAgeMs)} / ${formatCompactTime(metrics.stalestAgeMs)}`} tone={metrics.staleCount > 0 ? "warn" : "good"} />
          <BookMetricTile label="Stale Count" value={`${metrics.staleCount}`} tone={metrics.staleCount > 0 ? "warn" : "good"} />
          <BookMetricTile label="Avg YES Spread" value={formatCents(metrics.averageYesSpread)} />
          <BookMetricTile label="Avg NO Spread" value={formatCents(metrics.averageNoSpread)} />
          <BookMetricTile label="Best YES Ask" value={formatCents(metrics.bestYesAsk)} tone="good" />
          <BookMetricTile label="Best NO Ask" value={formatCents(metrics.bestNoAsk)} tone="good" />
          <BookMetricTile label="Scanner Ready" value={`${metrics.scannerReadyCount}/${metrics.contractCount}`} tone={metrics.scannerReadyCount > 0 ? "good" : "warn"} />
          <BookMetricTile label="Book p50 / p95" value={formatLatencyPair(venueLatency?.p50Ms, venueLatency?.p95Ms)} tone={venueLatency?.p95Ms && venueLatency.p95Ms > snapshot.health.staleBookMs ? "warn" : "good"} />
          <BookMetricTile label="WS Apply p95" value={formatCompactTime(wsApplyLatency?.p95Ms ?? null)} tone={wsApplyLatency?.p95Ms && wsApplyLatency.p95Ms > 250 ? "warn" : "good"} />
        </div>
      </div>
      <BookVisualSummary metrics={metrics} rows={rows} snapshot={snapshot} />
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
              <th>YES Spread</th>
              <th>NO Spread</th>
              <th>Mid Prob</th>
              <th>Freshness</th>
              <th>Readiness</th>
              <th>Live Visuals</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.contract.contractId} className={row.statusLabel === "stale" ? "row-stale" : ""}>
                <td data-label="Expiry">{formatCountdown(row.contract.expiryMs, snapshot.generatedAt)}</td>
                <td data-label="Strike">{formatDollars(row.contract.strike)}</td>
                <td data-label="Yes Bid">{formatCents(row.contract.yesBid)}</td>
                <td data-label="Yes Ask">{formatCents(row.contract.yesAsk)}</td>
                <td data-label="No Bid">{formatCents(row.contract.noBid)}</td>
                <td data-label="No Ask">{formatCents(row.contract.noAsk)}</td>
                <td data-label="YES Spread">{formatCents(row.yesSpread)}</td>
                <td data-label="NO Spread">{formatCents(row.noSpread)}</td>
                <td data-label="Mid Prob">{formatCents(row.midpointProbability)}</td>
                <td data-label="Freshness">
                  <div className="freshness-cell">
                    <span>{formatCompactTime(row.ageMs)}</span>
                    <div className="freshness-bar"><i style={{ width: `${row.freshnessScore * 100}%` }} /></div>
                  </div>
                </td>
                <td data-label="Readiness">
                  <span className={`scanner-ready-badge scanner-${row.statusLabel}`}>{row.scannerReady ? "scanner-ready" : row.statusLabel}</span>
                  {row.usedForArb ? <span className="arb-used-hint">Used for arb leg</span> : null}
                </td>
                <td data-label="Live Visuals">
                  <BookRowVisual history={history[contractBookKey(row.contract)] ?? []} />
                </td>
              </tr>
            ))}
            {contracts.length === 0 ? <tr><td colSpan={12} className="empty-cell">No live contracts discovered.</td></tr> : null}
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
      <td data-label="Expiry">{formatCountdown(candidate.expiryMs, now)}</td>
      <td data-label="Structure Type"><span className={`structure-chip structure-${structureClass}`}>{tradeDetail.structureLabel}</span></td>
      <td data-label="Strikes">{formatDollars(candidate.lower.strike)} / {formatDollars(candidate.higher.strike)}</td>
      <td data-label="Lower Leg"><VenueBadge venue={candidate.lower.venue} /> {candidate.lower.direction.toUpperCase()} @ {formatCents(candidate.lower.ask)}</td>
      <td data-label="Higher Leg"><VenueBadge venue={candidate.higher.venue} /> {candidate.higher.direction.toUpperCase()} @ {formatCents(candidate.higher.ask)}</td>
      <td data-label="Total Premium">{formatCents(candidate.premium)}</td>
      <td data-label="Guaranteed Profit" className="profit">{formatCents(candidate.guaranteedProfit)}</td>
      <td data-label="Max Profit">{formatCents(candidate.overlapProfit)}</td>
      <td data-label="Risk Score"><span className={`score-pill score-${risk.riskLevel}`}>{risk.riskScore}</span></td>
      <td data-label="Confidence">{risk.confidence}%</td>
      <td className="payoff-cell" data-label="Payoff">
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
    <section className="panel blotter-panel opportunity-table-panel" id="opportunities">
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

function isResolvedPartialSignal(signal: DashboardSignal): boolean {
  return signal.reconciliationResolvedAt != null;
}

function signalActionLabel(signal: DashboardSignal): string {
  if (isResolvedPartialSignal(signal) && signal.partialFill) return "resolved partial";
  return signal.action;
}

function signalActionClass(signal: DashboardSignal): string {
  if (isResolvedPartialSignal(signal) && signal.partialFill) return "skipped";
  return signal.action === "filled" ? "filled" : signal.action === "failed" ? "failed" : "skipped";
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

function TradeDetailSectionHeader({ eyebrow, title, note }: { eyebrow: string; title: string; note?: string }) {
  return (
    <div className="trade-detail-section-header">
      <div>
        <span>{eyebrow}</span>
        <strong>{title}</strong>
      </div>
      {note ? <p>{note}</p> : null}
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
      id="trade-detail"
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
        <section className="trade-detail-section trade-detail-snapshot-section" aria-label="Trade Snapshot">
          <TradeDetailSectionHeader
            eyebrow="trade snapshot"
            title="Trade Snapshot"
            note="Core edge, premium, strike dispersion, and risk metrics for the selected signal."
          />
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
        </section>

        <section className="trade-detail-section trade-detail-legs-section" aria-label="Venue Legs">
          <TradeDetailSectionHeader
            eyebrow="execution legs"
            title="Venue Legs"
            note="Venue, side, strike, observed ask, dry-run/live fill, and contract identifiers."
          />
          <div className="trade-detail-leg-stack">
            <TradeDetailLegCard leg={trade.legA} />
            <TradeDetailLegCard leg={trade.legB} />
          </div>
        </section>

        <section className="trade-detail-section trade-detail-payoff-section" aria-label="2D Payoff Diagram">
          <TradeDetailSectionHeader
            eyebrow="payoff geometry"
            title="2D Payoff Diagram"
            note="BTC settlement zones, individual leg payouts, and combined net P/L after premium."
          />
          <DetailedPayoffDiagram trade={trade} />
        </section>

        <section className="trade-detail-section trade-detail-risk-section" aria-label="3D Risk Mapping">
          <TradeDetailSectionHeader
            eyebrow="surface model"
            title="3D Risk Mapping"
            note="X-axis is BTC settlement price, Y-axis is time to expiry, and Z-axis is P&L."
          />
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
        </section>
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
                <td data-label="Market">{market.marketSlug}</td>
                <td data-label="Status">{market.status}</td>
                <td data-label="Strike">{formatDollars(market.priceToBeat)}</td>
                <td data-label="Source">{market.strikeSource ?? "--"}</td>
                <td data-label="Reason">{market.reason}</td>
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
  dashboardKind = "paper",
  sectionId = "signals",
}: {
  signals: DashboardSignal[];
  now: number;
  selectedTradeKey: string | null;
  onSelectTrade: (trade: TradeDetailModel) => void;
  dashboardKind?: DashboardKind;
  sectionId?: string;
}) {
  return (
    <section className="panel tape-panel" id={sectionId}>
      <div className="panel-header">
        <div>
          <p className="panel-kicker">audit log</p>
          <h2>{dashboardKind === "live" ? "Live Signal Tape" : "Paper Signal Tape"}</h2>
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
                      <span className={`action action-${signalActionClass(signal)}`}>{signalActionLabel(signal)}</span>
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
                    <div><span className="signal-label">Strategy</span><strong>{signal.executionStrategy ? signal.executionStrategy.replace(/_/g, " ") : "--"}</strong></div>
                    <div><span className="signal-label">First Venue</span><strong>{signal.executionTimings?.firstVenue ? signal.executionTimings.firstVenue.toUpperCase() : signal.executionStrategy === "parallel_canary" || signal.executionStrategy === "parallel_fok" || signal.executionStrategy === "parallel_limit_rest" ? "BOTH" : "--"}</strong></div>
                    <div><span className="signal-label">Reconciliation</span><strong className={isResolvedPartialSignal(signal) ? "warn" : signal.partialFill ? "loss" : "profit"}>{isResolvedPartialSignal(signal) ? "RESOLVED" : signal.partialFill ? "PARTIAL" : "NORMAL"}</strong></div>
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

                  {signal.reconciliationResolvedAt ? (
                    <div className="signal-reconciliation">
                      Manual reconciliation: {signal.reconciliationResolutionReason ?? "operator verified and resolved this live incident"} at {formatTimestamp(signal.reconciliationResolvedAt)}
                    </div>
                  ) : null}
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

export function DashboardSelector({
  dashboardName,
  snapshot,
  streamState,
  onSelect,
}: {
  dashboardName: string;
  snapshot: DashboardSnapshot | null;
  streamState: StreamState;
  onSelect: (kind: DashboardKind) => void;
}) {
  const liveArmed = snapshot?.health.liveTrading ?? false;
  const venuesReady = Boolean(snapshot?.execution?.kalshi.ready && snapshot?.execution?.polymarket.ready);
  const insights = snapshot ? buildDashboardInsights(snapshot) : null;
  const liveFilled = snapshot ? filledSignals(dataSliceForDashboard(snapshot, "live").recentSignals).length : 0;
  const paperFilled = snapshot ? filledSignals(dataSliceForDashboard(snapshot, "paper").recentSignals).length : 0;

  return (
    <main className="terminal-shell institutional-shell polished-shell dashboard-selector-shell">
      <section className="panel selector-hero">
        <div>
          <p className="panel-kicker">operator route</p>
          <h1>{dashboardName}</h1>
          <p>Password accepted. Pick the command surface before any live telemetry is interpreted as an instruction.</p>
        </div>
        <div className="status-rail">
          <StatusPill label={streamState === "live" ? "SSE LIVE" : streamState === "degraded" ? "SSE DEGRADED" : "SSE CONNECTING"} state={streamState === "live" ? "live" : "warn"} />
          <StatusPill label={liveArmed ? "WORKER LIVE" : "WORKER PAPER"} state={liveArmed ? "warn" : "live"} />
          <StatusPill label={venuesReady ? "VENUES READY" : "VENUE CHECK"} state={venuesReady ? "live" : "warn"} />
        </div>
      </section>

      <section className="dashboard-selector-grid" aria-label="Dashboard selector">
        <button className="dashboard-selector-card selector-live-card" onClick={() => onSelect("live")} type="button">
          <DashboardModeBadge kind="live" liveTrading={liveArmed} />
          <span className="selector-card-kicker">real execution audit</span>
          <strong>Live Trading Dashboard</strong>
          <p>Real trades only: exchange-fill-backed audit data, live PnL estimates, venue readiness, stream confirmations, and circuit-breaker state.</p>
          <div className="selector-metric-row">
            <span>Venues</span>
            <strong>{venuesReady ? "READY" : "CHECK"}</strong>
          </div>
          <div className="selector-metric-row">
            <span>Live Fills</span>
            <strong>{liveFilled}</strong>
          </div>
          {liveArmed ? (
            <small className="selector-warning">Worker is live in the background. This screen is read-only and does not arm/disarm trading.</small>
          ) : (
            <small>Live execution is currently off; this view still shows historical real live attempts only.</small>
          )}
        </button>

        <button className="dashboard-selector-card selector-paper-card" onClick={() => onSelect("paper")} type="button">
          <DashboardModeBadge kind="paper" liveTrading={liveArmed} />
          <span className="selector-card-kicker">simulation and analytics</span>
          <strong>Current Paper Trading Dashboard</strong>
          <p>Current simulated/dry-run strategy history: simulated fills, estimated guaranteed PnL, win rate, latency, opportunities, and analytics.</p>
          <div className="selector-metric-row">
            <span>Filled Tape</span>
            <strong>{paperFilled}</strong>
          </div>
          <div className="selector-metric-row">
            <span>Best Edge</span>
            <strong>{formatSignedCents(insights?.estimatedEdge ?? null)}</strong>
          </div>
          {liveArmed ? <small className="selector-warning">Worker is live in the background. Paper view is analytics-only and cannot disarm it.</small> : <small>Safe for reviewing simulated strategy quality and latency.</small>}
        </button>
      </section>
    </main>
  );
}

function LiveSafetyBanner({ snapshot }: { snapshot: DashboardSnapshot }) {
  const execution = snapshot.execution;
  const kalshiReady = execution?.kalshi.ready ?? false;
  const polymarketReady = execution?.polymarket.ready ?? false;
  const streamsReady = execution?.userStreams?.ready ?? false;
  const reconciliationClean = execution?.reconciliation?.clean ?? false;
  const partialLocked = execution?.partialFillLocked ?? false;
  const circuitLocked = execution?.circuitBreakerLocked ?? false;
  const liveReady = snapshot.health.liveTrading && kalshiReady && polymarketReady && streamsReady && reconciliationClean && !partialLocked && !circuitLocked;
  const warning = snapshot.health.liveTrading
    ? circuitLocked
      ? "LIVE EXECUTION IS ARMED BUT CIRCUIT-LOCKED. Do not re-enable until the unsafe attempt is reconciled and the lock is manually cleared."
      : "LIVE EXECUTION IS ARMED. The dashboard is read-only, but the VPS worker can place FOK canary orders from its environment settings."
    : "Live command surface selected, but backend live trading is OFF. This is safe for readiness review only.";

  return (
    <section className={`panel live-safety-banner ${snapshot.health.liveTrading ? "armed" : "standby"}`} aria-label="Live trading warning">
      <div>
        <p className="panel-kicker">live safety gate</p>
        <h2>Live Safety Gate</h2>
        <p>{warning}</p>
      </div>
      <div className="confirmation-grid" aria-label="Live confirmation states">
        <div><span>Env Flag</span><strong className={snapshot.health.liveTrading ? "loss" : "profit"}>{snapshot.health.liveTrading ? "LIVE TRUE" : "LIVE FALSE"}</strong></div>
        <div><span>Kalshi</span><strong className={kalshiReady ? "profit" : "loss"}>{kalshiReady ? "READY" : "BLOCKED"}</strong></div>
        <div><span>Polymarket</span><strong className={polymarketReady ? "profit" : "loss"}>{polymarketReady ? "READY" : "BLOCKED"}</strong></div>
        <div><span>User Streams</span><strong className={streamsReady ? "profit" : "loss"}>{streamsReady ? "CONFIRMING" : "BLOCKED"}</strong></div>
        <div><span>Reconcile</span><strong className={reconciliationClean ? "profit" : "loss"}>{reconciliationClean ? "CLEAN" : "DRIFT"}</strong></div>
        <div><span>Partial Fill Lock</span><strong className={partialLocked ? "loss" : "profit"}>{partialLocked ? "LOCKED" : "CLEAR"}</strong></div>
        <div><span>Circuit Breaker</span><strong className={circuitLocked ? "loss" : "profit"}>{circuitLocked ? "LOCKED" : "CLEAR"}</strong></div>
        <div><span>Composite</span><strong className={liveReady ? "loss" : "warn"}>{liveReady ? "CAN EXECUTE" : "NO-GO"}</strong></div>
      </div>
      {execution?.circuitBreakerReason ? <p className="live-lock-reason">LOCK REASON: {execution.circuitBreakerReason}</p> : null}
      {execution?.userStreams?.reason ? <p className="live-lock-reason">STREAM REASON: {execution.userStreams.reason}</p> : null}
      {execution?.reconciliation?.reason ? <p className="live-lock-reason">RECONCILE REASON: {execution.reconciliation.reason}</p> : null}
    </section>
  );
}

function ExecutionControlsPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const execution = snapshot.execution;
  return (
    <section className="panel operator-card execution-controls-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">execution controls</p>
          <h2>Execution Controls / Status</h2>
          <p className="panel-subtitle">Read-only mirror of the worker config. No browser button can arm or disarm trading.</p>
        </div>
        <StatusPill label={snapshot.health.liveTrading ? "LIVE SOURCE" : "PAPER SOURCE"} state={snapshot.health.liveTrading ? "warn" : "live"} />
      </div>
      <div className="ops-metric-grid">
        <div><span>Live Trading</span><strong className={snapshot.health.liveTrading ? "loss" : "profit"}>{snapshot.health.liveTrading ? "TRUE" : "FALSE"}</strong></div>
        <div><span>Order Size</span><strong>{execution ? formatDollars(execution.orderSize) : "--"}</strong></div>
        <div><span>Order Type</span><strong>{execution?.orderType ?? "--"}</strong></div>
        <div><span>Placement</span><strong>{execution?.orderPlacementMode ? execution.orderPlacementMode.replace(/_/g, " ").toUpperCase() : "--"}</strong></div>
        <div><span>Limit Rest</span><strong>{execution?.aggressiveLimitRestMs == null ? "--" : `${execution.aggressiveLimitRestMs}ms`}</strong></div>
        <div><span>Max Slippage</span><strong>{execution ? formatCents(execution.maxSlippageCents / 100) : "--"}</strong></div>
        <div><span>Protected Only</span><strong>{execution?.protectedOnly ? "YES" : "NO"}</strong></div>
        <div><span>Min Expiry</span><strong>{execution ? formatCompactTime(execution.minExpiryMs) : "--"}</strong></div>
        <div><span>Max/Window</span><strong>{execution?.maxTradesPerWindow ?? snapshot.health.liveMaxTradesPerWindow}</strong></div>
        <div><span>Collateral Buffer</span><strong>{formatDollars(execution?.collateralBufferDollars ?? null)}</strong></div>
        <div><span>Quote Max Age</span><strong>{execution ? formatCompactTime(execution.quoteMaxAgeMs) : formatCompactTime(snapshot.health.liveQuoteMaxAgeMs)}</strong></div>
        <div><span>Quote Sync Skew</span><strong>{execution ? formatCompactTime(execution.quoteSyncMaxSkewMs) : formatCompactTime(snapshot.health.liveQuoteSyncMaxSkewMs)}</strong></div>
        <div><span>Min Depth</span><strong>{execution?.minBookDepthShares ?? snapshot.health.liveMinBookDepthShares}</strong></div>
        <div><span>Edge Gate</span><strong>{formatCents(snapshot.health.minProfitDollars)}</strong></div>
        <div><span>Order Timeout</span><strong>{execution ? formatCompactTime(execution.orderTimeoutMs) : formatCompactTime(snapshot.health.liveOrderTimeoutMs)}</strong></div>
        <div><span>Stream Confirm</span><strong>{execution?.userStreams ? formatCompactTime(execution.userStreams.confirmTimeoutMs) : formatCompactTime(snapshot.health.liveUserStreamConfirmTimeoutMs)}</strong></div>
        <div><span>User Streams</span><strong className={execution?.userStreams?.ready ? "profit" : "loss"}>{execution?.userStreams?.enabled ? execution.userStreams.ready ? "READY" : "BLOCKED" : "OFF"}</strong></div>
        <div><span>Reconcile Before Trade</span><strong className={execution?.reconciliation?.clean ? "profit" : "loss"}>{execution?.reconciliation?.enabled ? execution.reconciliation.clean ? "CLEAN" : "DRIFT" : "OFF"}</strong></div>
        <div><span>Kalshi Group</span><strong className={execution?.kalshiOrderGroupEnabled ? "warn" : ""}>{execution?.kalshiOrderGroupEnabled ? "ON" : "OFF"}</strong></div>
        <div><span>Circuit Breaker</span><strong className={execution?.circuitBreakerLocked ? "loss" : "profit"}>{execution?.circuitBreakerLocked ? "LOCKED" : "CLEAR"}</strong></div>
      </div>
      <div className="readonly-control-strip">
        <span>ARMING SOURCE: /etc/pok-poly-kalshi/worker.env</span>
        <strong>Change requires SSH + systemctl restart pok-worker</strong>
      </div>
    </section>
  );
}

function VenueReadinessPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const execution = snapshot.execution;
  const kalshi = execution?.kalshi;
  const polymarket = execution?.polymarket;
  return (
    <section className="panel operator-card venue-readiness-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">venue readiness</p>
          <h2>Venue Readiness</h2>
        </div>
        <StatusPill label={kalshi?.ready && polymarket?.ready ? "BOTH READY" : "CHECK VENUES"} state={kalshi?.ready && polymarket?.ready ? "live" : "warn"} />
      </div>
      <div className="venue-readiness-grid">
        <div className="venue-readiness-card">
          <VenueBadge venue="kalshi" />
          <strong className={kalshi?.ready ? "profit" : "loss"}>{formatReadiness(kalshi?.ready, kalshi?.reason)}</strong>
          <span>Balance {formatDollars(kalshi?.balance ?? null)}</span>
          <small>Stream {execution?.userStreams?.kalshi.subscribed ? "subscribed" : "blocked"} · Last check {formatRealtimeAge(snapshot.generatedAt, kalshi?.lastCheckedAt)}</small>
        </div>
        <div className="venue-readiness-card">
          <VenueBadge venue="polymarket" />
          <strong className={polymarket?.ready ? "profit" : "loss"}>{formatReadiness(polymarket?.ready, polymarket?.reason)}</strong>
          <span>Collateral {formatDollars(polymarket?.collateralBalanceNormalized ?? polymarket?.balance ?? null)}</span>
          <small>Stream {execution?.userStreams?.polymarket.subscribed ? "subscribed" : "blocked"} · Sig {polymarket?.signatureType ?? "--"} · Geo {polymarket?.geoblockBlocked ? "blocked" : polymarket?.geoblockCountry ?? "--"}</small>
        </div>
      </div>
    </section>
  );
}

function ExposurePanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const execution = snapshot.execution;
  const recentFilled = filledSignals(snapshot.recentSignals);
  const orderSize = execution?.orderSize ?? null;
  const estimatedRecentNotional = orderSize == null ? null : recentFilled.slice(0, 12).length * orderSize;
  const polymarketCollateral = execution?.polymarket.collateralBalanceNormalized ?? execution?.polymarket.balance ?? null;
  return (
    <section className="panel operator-card exposure-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">exposure</p>
          <h2>Exposure</h2>
        </div>
        <StatusPill label={execution?.circuitBreakerLocked || execution?.partialFillLocked ? "LOCKED" : "CLEAR"} state={execution?.circuitBreakerLocked || execution?.partialFillLocked ? "stale" : "live"} />
      </div>
      <div className="ops-metric-grid">
        <div><span>Partial-Fill Lock</span><strong className={execution?.partialFillLocked ? "loss" : "profit"}>{execution?.partialFillLocked ? "LOCKED" : "CLEAR"}</strong></div>
        <div><span>Circuit Breaker</span><strong className={execution?.circuitBreakerLocked ? "loss" : "profit"}>{execution?.circuitBreakerLocked ? "LOCKED" : "CLEAR"}</strong></div>
        <div><span>Canary Size</span><strong>{formatDollars(orderSize)}</strong></div>
        <div><span>Poly Collateral</span><strong>{formatDollars(polymarketCollateral)}</strong></div>
        <div><span>Required Collateral</span><strong>{formatDollars(execution?.polymarket.requiredCollateral ?? null)}</strong></div>
        <div><span>Recent Filled Notional</span><strong>{formatDollars(estimatedRecentNotional)}</strong></div>
        <div><span>Active Opportunities</span><strong>{snapshot.liveCandidates.length}</strong></div>
      </div>
    </section>
  );
}

function ActiveOpportunitiesPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const opportunities = sortCandidatesForBlotter(snapshot.liveCandidates).slice(0, 5);
  return (
    <section className="panel active-opportunities-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">active opportunities</p>
          <h2>Active Opportunities</h2>
        </div>
        <StatusPill label={`${snapshot.liveCandidates.length} LIVE`} state={snapshot.liveCandidates.length > 0 ? "live" : "empty"} />
      </div>
      <div className="opportunity-ticker">
        {opportunities.map((candidate) => (
          <div className="opportunity-ticker-row" key={candidate.pairKey}>
            <span>{shortId(candidate.pairKey)}</span>
            <strong className={candidate.guaranteedProfit >= snapshot.health.minProfitDollars ? "profit" : "loss"}>{formatSignedCents(candidate.guaranteedProfit)}</strong>
            <span>{formatDollars(candidate.lower.strike)} / {formatDollars(candidate.higher.strike)}</span>
            <span>{formatCountdown(candidate.expiryMs, snapshot.generatedAt)}</span>
          </div>
        ))}
        {opportunities.length === 0 ? <div className="empty-cell">No active executable opportunities in the latest snapshot.</div> : null}
      </div>
    </section>
  );
}

function ExecutionAuditPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const execution = snapshot.execution;
  const auditSignals = snapshot.recentSignals.slice(0, 6);
  return (
    <section className="panel execution-audit-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">execution audit</p>
          <h2>Execution Audit</h2>
        </div>
        <StatusPill label={execution?.circuitBreakerLocked ? "CIRCUIT LOCK" : execution?.lastAttempt ? "LAST ATTEMPT" : "NO ATTEMPT"} state={execution?.circuitBreakerLocked ? "stale" : execution?.lastAttempt ? "warn" : "empty"} />
      </div>
      <div className="audit-summary-grid">
        <div><span>Last Action</span><strong>{formatExecutionState(execution?.lastAttempt?.action)}</strong></div>
        <div><span>Partial Fill</span><strong className={execution?.lastAttempt?.partialFill ? "loss" : "profit"}>{execution?.lastAttempt?.partialFill ? "YES" : "NO"}</strong></div>
        <div><span>Kalshi Status</span><strong>{formatExecutionState(execution?.lastAttempt?.kalshiStatus)}</strong></div>
        <div><span>Polymarket Status</span><strong>{formatExecutionState(execution?.lastAttempt?.polymarketStatus)}</strong></div>
        <div><span>Lock Reason</span><strong className={execution?.circuitBreakerReason ? "loss" : ""}>{execution?.circuitBreakerReason ? shortReason(execution.circuitBreakerReason) : "--"}</strong></div>
      </div>
      <div className="audit-tape">
        {auditSignals.map((signal) => (
          <div className="audit-tape-row" key={signal.id}>
            <span>#{signal.id}</span>
            <strong className={signal.action === "filled" ? "profit" : signal.action === "failed" ? "loss" : ""}>{signal.action.toUpperCase()}</strong>
            <span>VWAP {formatDollars(signal.depthVwap ?? null)}</span>
            <span>Edge {formatSignedCents(signal.projectedEdgeAfterFees ?? signal.guaranteedProfit)}</span>
            <span>Skew {signal.quoteSnapshot?.quoteSkewMs == null ? "--" : `${Math.round(signal.quoteSnapshot.quoteSkewMs)}ms`}</span>
            <span>Strategy {signal.executionStrategy ? signal.executionStrategy.replace(/_/g, " ") : "--"}</span>
            <span>First {signal.executionTimings?.firstVenue ? signal.executionTimings.firstVenue.toUpperCase() : signal.executionStrategy === "parallel_canary" || signal.executionStrategy === "parallel_fok" || signal.executionStrategy === "parallel_limit_rest" ? "BOTH" : "--"}</span>
            <span>RTT K {signal.executionTimings?.kalshiRttMs == null ? "--" : `${Math.round(signal.executionTimings.kalshiRttMs)}ms`}</span>
            <span>Partial {signal.partialFill ? "YES" : "NO"}</span>
            <span>K {signal.kalshiFillCount ?? "--"} / P {signal.polymarketFillCount ?? "--"}</span>
          </div>
        ))}
        {auditSignals.length === 0 ? <div className="empty-cell">No execution audit signals persisted yet.</div> : null}
      </div>
    </section>
  );
}

function LiveSafetyBadgeRow({ snapshot }: { snapshot: DashboardSnapshot }) {
  const execution = snapshot.execution;
  const kalshiReady = execution?.kalshi.ready ?? false;
  const polymarketReady = execution?.polymarket.ready ?? false;
  const streamsReady = execution?.userStreams?.ready ?? false;
  const reconciliationClean = execution?.reconciliation?.clean ?? false;
  const circuitLocked = execution?.circuitBreakerLocked ?? false;
  const partialLocked = execution?.partialFillLocked ?? false;
  return (
    <section className="panel live-safety-compact" aria-label="Live execution safety state">
      <div>
        <p className="panel-kicker">live safety state</p>
        <h2>Read-Only Live Audit</h2>
        <p>Real execution history only. Arming/disarming still requires SSH and a worker restart.</p>
      </div>
      <div className="status-rail">
        <StatusPill label={snapshot.health.liveTrading ? "LIVE ENABLED" : "LIVE OFF"} state={snapshot.health.liveTrading ? "warn" : "off"} />
        <StatusPill label={circuitLocked ? "CIRCUIT LOCK" : "CIRCUIT CLEAR"} state={circuitLocked ? "stale" : "live"} />
        <StatusPill label={kalshiReady && polymarketReady ? "VENUES READY" : "VENUE CHECK"} state={kalshiReady && polymarketReady ? "live" : "warn"} />
        <StatusPill label={streamsReady ? "STREAMS READY" : "STREAM CHECK"} state={streamsReady ? "live" : "warn"} />
        <StatusPill label={reconciliationClean ? "RECON CLEAN" : "RECON DRIFT"} state={reconciliationClean ? "live" : "stale"} />
        <StatusPill label={partialLocked ? "PARTIAL LOCK" : "PARTIAL CLEAR"} state={partialLocked ? "stale" : "live"} />
      </div>
      {execution?.circuitBreakerReason ? <p className="live-lock-reason">LOCK REASON: {execution.circuitBreakerReason}</p> : null}
    </section>
  );
}

function PerformanceDashboardSections({ snapshot, dashboardKind }: { snapshot: DashboardSnapshot; dashboardKind: DashboardKind }) {
  const slice = dataSliceForDashboard(snapshot, dashboardKind);
  const current = slice.analytics?.hourly;
  const filled = filledSignals(slice.recentSignals);
  const avgLatency = averageSignalLatency(filled);
  const estimatedGuaranteed = filled.reduce((total, signal) => total + signal.guaranteedProfit, 0);
  const failedAttempts = slice.recentSignals.filter((signal) => signal.action === "failed").length;
  const liveView = dashboardKind === "live";
  return (
    <section className={`${liveView ? "live" : "paper"}-dashboard-stack paper-dashboard-stack`} aria-label={liveView ? "Live dashboard analytics" : "Paper dashboard analytics"}>
      {liveView ? <LiveSafetyBadgeRow snapshot={snapshot} /> : null}
      {!liveView && snapshot.health.liveTrading ? (
        <div className="paper-live-warning">
          <strong>Paper view selected while worker is LIVE.</strong>
          <span>This screen is analytics-only. It does not pause, disarm, or modify the VPS worker.</span>
        </div>
      ) : null}
      <section className="paper-summary-grid">
        <div className="paper-summary-card">
          <span>{liveView ? "Real Live Fills" : "Simulated Fills"}</span>
          <strong>{filled.length}</strong>
          <small>{failedAttempts} failed/skipped attempts in visible {liveView ? "live" : "paper"} tape</small>
        </div>
        <div className="paper-summary-card">
          <span>{liveView ? "Executed Fill-Audit PnL" : "Estimated Guaranteed PnL"}</span>
          <strong className={estimatedGuaranteed >= 0 ? "profit" : "loss"}>{formatSignedCents(estimatedGuaranteed)}</strong>
          <small>{liveView ? "Real live records only; not settlement-final PnL" : "From recent simulated guaranteed edges"}</small>
        </div>
        <div className="paper-summary-card">
          <span>Win Rate</span>
          <strong>{current ? formatPercent(current.winRate) : "--"}</strong>
          <small>{current?.filledTrades ?? 0} historical {liveView ? "live" : "paper"} filled trades</small>
        </div>
        <div className="paper-summary-card">
          <span>{liveView ? "Order / Stream Latency" : "Latency"}</span>
          <strong>{formatCompactTime(current?.avgFillLatencyMs ?? avgLatency)}</strong>
          <small>Average fill/audit turnaround</small>
        </div>
        <div className="paper-summary-card">
          <span>Opportunities</span>
          <strong>{current?.opportunityCount ?? snapshot.liveCandidates.length}</strong>
          <small>{snapshot.liveCandidates.length} live opportunities now</small>
        </div>
        <div className="paper-summary-card">
          <span>{liveView ? "Historical Live Analytics" : "Historical Analytics"}</span>
          <strong>{current ? formatSignedCents(current.netPnl) : "--"}</strong>
          <small>Hourly net {liveView ? "executed fill-audit" : "estimated guaranteed"} PnL</small>
        </div>
      </section>
    </section>
  );
}

function LiveDashboardSections({ snapshot }: { snapshot: DashboardSnapshot }) {
  return <PerformanceDashboardSections dashboardKind="live" snapshot={snapshot} />;
}

function PaperDashboardSections({ snapshot }: { snapshot: DashboardSnapshot }) {
  return <PerformanceDashboardSections dashboardKind="paper" snapshot={snapshot} />;
}

function CombinedDashboardSections({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <section className="combined-dashboard-stack" aria-label="Combined live and paper dashboards">
      <article className="combined-dashboard-section combined-live-section">
        <section className="panel combined-dashboard-heading">
          <p className="panel-kicker">exchange-fill-backed audit</p>
          <h2>Live Trading Dashboard</h2>
          <p>Real trades only. This section is fed exclusively from the authoritative live execution slice.</p>
        </section>
        <LiveDashboardSections snapshot={snapshot} />
      </article>

      <article className="combined-dashboard-section combined-paper-section">
        <section className="panel combined-dashboard-heading">
          <p className="panel-kicker">simulated strategy history</p>
          <h2>Current Paper Trading Dashboard</h2>
          <p>Dry-run fills and simulated performance only. This section is fed exclusively from the paper slice.</p>
        </section>
        <PaperDashboardSections snapshot={snapshot} />
      </article>
    </section>
  );
}

export function DashboardTerminalView({
  dashboardName,
  dashboardKind = null,
  onDashboardRouteChange,
  snapshot,
  streamState,
}: {
  dashboardName: string;
  dashboardKind?: DashboardKind | null;
  onDashboardRouteChange?: (kind: DashboardKind | null) => void;
  snapshot: DashboardSnapshot | null;
  streamState: StreamState;
}) {
  const [selectedTrade, setSelectedTrade] = useState<TradeDetailModel | null>(null);
  const [viewMode, setViewMode] = useState<DashboardViewMode>("risk");
  const [bookHistory, setBookHistory] = useState<BookHistory>({});
  const selectedTradeKey = selectedTrade?.key ?? null;

  useEffect(() => {
    if (!snapshot || !selectedTradeKey) return;
    const refreshed = findTradeDetailByKey(snapshot, selectedTradeKey);
    if (refreshed) setSelectedTrade(refreshed);
  }, [snapshot, selectedTradeKey]);

  useEffect(() => {
    if (!snapshot) return;
    setBookHistory((current) => appendBookHistory(current, snapshot));
  }, [snapshot]);

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

  const combinedView = dashboardKind == null;
  const focusedDashboardKind: DashboardKind = dashboardKind ?? "live";
  const liveSnapshot = snapshotForDashboardKind(snapshot, "live");
  const paperSnapshot = snapshotForDashboardKind(snapshot, "paper");
  const selectedSnapshot = combinedView ? liveSnapshot : snapshotForDashboardKind(snapshot, focusedDashboardKind);
  const shellDashboardClass = combinedView ? "dashboard-combined" : `dashboard-${focusedDashboardKind}`;

  return (
    <main className={`terminal-shell institutional-shell polished-shell ${shellDashboardClass} view-mode-${viewMode}`}>
      <GlobalStateBar
        dashboardKind={dashboardKind}
        dashboardName={dashboardName}
        onDashboardRouteChange={onDashboardRouteChange}
        onViewModeChange={setViewMode}
        snapshot={snapshot}
        streamState={streamState}
        viewMode={viewMode}
      />
      <MobileSectionNav />

      <section className="metric-grid institutional-metrics">
        <div className="metric"><span>Guaranteed Gate</span><strong>{formatCents(snapshot.health.minProfitDollars)}</strong></div>
        <div className="metric"><span>Re-entry Cadence</span><strong>{Math.round(snapshot.health.reentryIntervalMs / 1000)}s</strong></div>
        <div className="metric"><span>Discovery Age</span><strong>{snapshot.discovery.lastDiscoveryAt ? formatCompactTime(Math.max(0, snapshot.generatedAt - snapshot.discovery.lastDiscoveryAt)) : "--"}</strong></div>
        <div className="metric"><span>Selected Dashboard</span><strong>{combinedView ? "BOTH" : focusedDashboardKind === "live" ? "LIVE" : "PAPER"}</strong></div>
        <div className="metric"><span>Selected Mode</span><strong>{viewMode.toUpperCase()}</strong></div>
        <div className="metric"><span>Venue Readiness</span><strong>{snapshot.execution ? `${snapshot.execution.kalshi.ready ? "K" : "K!"}/${snapshot.execution.polymarket.ready ? "P" : "P!"}` : "--"}</strong></div>
        <div className="metric"><span>Partial Fill Lock</span><strong>{snapshot.execution?.partialFillLocked ? "LOCKED" : "CLEAR"}</strong></div>
      </section>

      {combinedView ? <CombinedDashboardSections snapshot={snapshot} /> : focusedDashboardKind === "live" ? <LiveDashboardSections snapshot={snapshot} /> : <PaperDashboardSections snapshot={snapshot} />}

      <section className={`institutional-command-grid ${combinedView ? "combined-command-grid" : ""}`}>
        {combinedView ? (
          <>
            <AnalyticsPanel dashboardKind="live" snapshot={liveSnapshot} />
            <AnalyticsPanel dashboardKind="paper" snapshot={paperSnapshot} />
          </>
        ) : <AnalyticsPanel dashboardKind={focusedDashboardKind} snapshot={selectedSnapshot} />}
        <RiskIntelligencePanel selectedTrade={selectedTrade} snapshot={selectedSnapshot} />
      </section>

      <OpportunityBlotter onSelectTrade={setSelectedTrade} selectedTradeKey={selectedTradeKey} snapshot={snapshot} />

      <AnimatePresence mode="wait">
        {selectedTrade ? <TradeDetailDrawer key={selectedTrade.key} now={snapshot.generatedAt} onClose={() => setSelectedTrade(null)} trade={selectedTrade} /> : null}
      </AnimatePresence>

      <SyntheticStructureMap snapshot={snapshot} />

      <CrossVenueBookStrip snapshot={snapshot} />

      <section className="market-books-grid" id="market-books" aria-label="Live venue books">
        <BookTable candidates={snapshot.liveCandidates} history={bookHistory} title="Kalshi BTC 15m" venue="kalshi" contracts={snapshot.books.kalshi} snapshot={snapshot} />
        <BookTable candidates={snapshot.liveCandidates} history={bookHistory} title="Polymarket BTC 15m" venue="polymarket" contracts={snapshot.books.polymarket} snapshot={snapshot} />
      </section>

      {snapshot.discovery.lastDiscoveryError ? <div className="error-banner">Discovery error: {snapshot.discovery.lastDiscoveryError}</div> : null}

      <PolymarketDiagnosticsPanel snapshot={snapshot} />

      <section className={`activity-grid ${combinedView ? "combined-activity-grid" : ""}`} aria-label="Signal and runtime activity">
        {combinedView ? (
          <>
            <SignalTape dashboardKind="live" onSelectTrade={setSelectedTrade} selectedTradeKey={selectedTradeKey} signals={liveSnapshot.recentSignals} now={snapshot.generatedAt} />
            <SignalTape dashboardKind="paper" onSelectTrade={setSelectedTrade} selectedTradeKey={selectedTradeKey} signals={paperSnapshot.recentSignals} now={snapshot.generatedAt} sectionId="signals-paper" />
          </>
        ) : <SignalTape dashboardKind={focusedDashboardKind} onSelectTrade={setSelectedTrade} selectedTradeKey={selectedTradeKey} signals={selectedSnapshot.recentSignals} now={snapshot.generatedAt} />}
        <EventTape logs={snapshot.logs} />
      </section>
    </main>
  );
}

function writeDashboardRoute(kind: DashboardKind | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (kind) url.searchParams.set("dashboard", kind);
  else url.searchParams.delete("dashboard");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export default function DashboardTerminal({
  dashboardName,
  initialDashboard = null,
}: {
  dashboardName: string;
  initialDashboard?: DashboardKind | null;
}) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [selectedDashboard, setSelectedDashboard] = useState<DashboardKind | null>(initialDashboard);

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

  const selectDashboard = (kind: DashboardKind | null) => {
    setSelectedDashboard(kind);
    writeDashboardRoute(kind);
  };

  return (
    <DashboardTerminalView
      dashboardKind={selectedDashboard}
      dashboardName={dashboardName}
      onDashboardRouteChange={selectDashboard}
      snapshot={snapshot}
      streamState={streamState}
    />
  );
}
