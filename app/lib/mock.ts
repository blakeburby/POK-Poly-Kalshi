/**
 * Realistic mock DashboardSnapshot generator.
 *
 * The dashboard is read-only and proxies to a live worker. When no worker is
 * reachable (local dev / preview), the store falls back to this generator so
 * every view renders with plausible, internally-consistent data. It mirrors the
 * real economics: protected spread, guaranteedProfit = 1 - premium, realized
 * PnL only on exact paired fills.
 */

import type {
  DashboardSnapshot,
  DashboardSignal,
  DashboardAnalytics,
  DashboardAnalyticsWindow,
  DashboardAnalyticsBucket,
  AnalyticsWindow,
  ArbCandidate,
  ArbLeg,
  BinaryContract,
  BookLevel,
  TradingActivitySnapshot,
  TradingPlatformActivity,
  TradingPlatform,
  EquityCurveSnapshot,
  Venue,
} from "./types";

/** Realistic combined Kalshi+Polymarket account-equity series (venue-truth basis for the Sharpe). */
function buildEquityCurve(now: number, rng: () => number): EquityCurveSnapshot {
  const N = 90;
  const stepMs = 16 * 60_000; // ~16-min samples over ~24h
  let v = 126000 + rng() * 4000;
  const points: { t: number; v: number }[] = [];
  for (let i = N - 1; i >= 0; i -= 1) {
    v += 16 + (rng() - 0.46) * 240; // small upward drift + mean-reverting noise
    points.push({ t: now - i * stepMs - Math.round(rng() * 60_000), v: Math.round(v * 100) / 100 });
  }
  return {
    generatedAt: now,
    currentCombinedValue: points[points.length - 1].v,
    earliestSampledAtMs: points[0].t,
    points,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v: number, p = 4) => Math.round(v * 10 ** p) / 10 ** p;

function levels(top: number, rng: () => number, dir: 1 | -1): BookLevel[] {
  const out: BookLevel[] = [];
  let price = top;
  for (let i = 0; i < 5; i++) {
    out.push({ price: round(price, 2), size: Math.round(80 + rng() * 1400) });
    price += dir * round(0.01 + rng() * 0.01, 2);
  }
  return out;
}

function contract(
  venue: Venue,
  strike: number,
  expiryMs: number,
  now: number,
  rng: () => number,
  yesMid: number,
): BinaryContract {
  const spread = 0.01 + rng() * 0.02;
  const yesAsk = round(Math.min(0.99, yesMid + spread / 2), 2);
  const yesBid = round(Math.max(0.01, yesMid - spread / 2), 2);
  const noMid = 1 - yesMid;
  const noAsk = round(Math.min(0.99, noMid + spread / 2), 2);
  const noBid = round(Math.max(0.01, noMid - spread / 2), 2);
  return {
    venue,
    contractId: `${venue.slice(0, 3).toUpperCase()}-BTC-${strike}`,
    asset: "BTC",
    expiryMs,
    strike,
    yesAsk,
    noAsk,
    yesBid,
    noBid,
    yesAskLevels: levels(yesAsk, rng, 1),
    noAskLevels: levels(noAsk, rng, 1),
    yesBidLevels: levels(yesBid, rng, -1),
    noBidLevels: levels(noBid, rng, -1),
    tickSize: 0.01,
    title: `BTC ${venue === "kalshi" ? "above" : ">"} $${strike.toLocaleString()} @ ${new Date(expiryMs).toUTCString().slice(17, 22)}`,
    marketSlug: `btc-15m-${strike}`,
    updatedAt: now - Math.round(rng() * 1800),
  };
}

function leg(venue: Venue, contractId: string, direction: "yes" | "no", strike: number, ask: number): ArbLeg {
  return { venue, contractId, direction, strike, ask, tokenId: `${contractId}-${direction}` };
}

function buildCandidate(lowerC: BinaryContract, higherC: BinaryContract, threshold: number): ArbCandidate {
  const lower = leg(lowerC.venue, lowerC.contractId, "yes", lowerC.strike, lowerC.yesAsk ?? 0.5);
  const higher = leg(higherC.venue, higherC.contractId, "no", higherC.strike, higherC.noAsk ?? 0.5);
  const premium = round(lower.ask + higher.ask);
  const guaranteedProfit = round(1 - premium);
  const overlapProfit = round(2 - premium);
  const strikeGap = round(higherC.strike - lowerC.strike);
  const midStrike = round((higherC.strike + lowerC.strike) / 2);
  const worstCaseProfit = guaranteedProfit;
  const classification =
    worstCaseProfit >= threshold
      ? "true_arbitrage"
      : worstCaseProfit >= 0
        ? "guaranteed_below_threshold"
        : "probabilistic_bet";
  return {
    pairKey: `${lowerC.expiryMs}:${lower.venue}:${lower.contractId}:yes:${higher.venue}:${higher.contractId}:no`,
    expiryMs: lowerC.expiryMs,
    lower,
    higher,
    kalshiContractId: lower.venue === "kalshi" ? lower.contractId : higher.contractId,
    polymarketContractId: lower.venue === "polymarket" ? lower.contractId : higher.contractId,
    premium,
    guaranteedProfit,
    overlapProfit,
    threshold,
    executable: guaranteedProfit >= threshold,
    reason: guaranteedProfit >= threshold ? null : "below_threshold",
    risk: {
      structureType: "long_up_below_down_above",
      classification,
      strikeGap,
      midStrike,
      strikeGapPctOfMid: round((strikeGap / midStrike) * 100, 2),
      lossWindowWidth: 0,
      lossWindowPctOfStrikeGap: 0,
      lossWindowPctOfMid: 0,
      overlapWindowWidth: strikeGap,
      overlapWindowPctOfStrikeGap: 100,
      premium,
      worstCaseProfit,
      bestCaseProfit: overlapProfit,
      guaranteedEdge: worstCaseProfit,
      conditionalEdge: overlapProfit,
      maxLossRegion: null,
      payoffProfile: [
        {
          region: "below_lower",
          label: `< ${lowerC.strike}`,
          fromStrike: null,
          toStrike: lowerC.strike,
          width: null,
          payoff: 1,
          profit: guaranteedProfit,
          isMaxLoss: false,
        },
        {
          region: "between_strikes",
          label: `${lowerC.strike} - ${higherC.strike}`,
          fromStrike: lowerC.strike,
          toStrike: higherC.strike,
          width: strikeGap,
          payoff: 2,
          profit: overlapProfit,
          isMaxLoss: false,
        },
        {
          region: "above_higher",
          label: `>= ${higherC.strike}`,
          fromStrike: higherC.strike,
          toStrike: null,
          width: null,
          payoff: 1,
          profit: guaranteedProfit,
          isMaxLoss: false,
        },
      ],
    },
  };
}

function buildSignal(
  id: number,
  createdAt: number,
  threshold: number,
  orderSize: number,
  rng: () => number,
): DashboardSignal {
  const lowerStrike = 64000 + Math.round(rng() * 8) * 250;
  const higherStrike = lowerStrike + 250;
  const lowerVenue: Venue = rng() > 0.5 ? "kalshi" : "polymarket";
  const higherVenue: Venue = lowerVenue === "kalshi" ? "polymarket" : "kalshi";
  // Protected spread only enters when ask-premium < $1 (guaranteed edge >= threshold).
  const targetPremium = round(0.9 + rng() * 0.07, 2); // 0.90 - 0.97 -> edge 0.03 - 0.10
  const lowerAsk = round(targetPremium * (0.62 + rng() * 0.08), 2);
  const higherAsk = round(targetPremium - lowerAsk, 2);
  const premium = round(lowerAsk + higherAsk);
  const askGuaranteed = round(1 - premium);

  const r = rng();
  // outcome mix: ~74% exact filled, ~12% partial, ~14% skipped/failed
  const filled = r < 0.74;
  const partial = !filled && r < 0.86;
  const failed = !filled && !partial;
  const action: DashboardSignal["action"] = filled
    ? "filled"
    : failed
      ? rng() > 0.5
        ? "skipped"
        : "failed"
      : "filled";

  // Mostly small positive slippage; ~9% of fills suffer adverse slippage that erodes the edge.
  const slip = rng() < 0.09 ? round(askGuaranteed + 0.004 + rng() * 0.02, 4) : round(rng() * 0.022, 4);
  const kalshiFillPrice = filled
    ? lowerVenue === "kalshi"
      ? round(lowerAsk + slip / 2, 4)
      : round(higherAsk + slip / 2, 4)
    : null;
  const polymarketFillPrice = filled
    ? lowerVenue === "polymarket"
      ? round(lowerAsk + slip / 2, 4)
      : round(higherAsk + slip / 2, 4)
    : null;
  const realizedPremium =
    filled && kalshiFillPrice != null && polymarketFillPrice != null
      ? round(kalshiFillPrice + polymarketFillPrice)
      : premium;
  const realized = filled ? round(1 - realizedPremium) : null;

  const fillLatency = 120 + Math.round(rng() * 900);
  const updatedAt = createdAt + fillLatency;
  const kalshiRtt = 18 + Math.round(rng() * 60);
  const polyRtt = 140 + Math.round(rng() * 380);
  const pairedFillProb = round(0.6 + rng() * 0.39, 3);

  const cand = buildCandidate(
    {
      ...({} as BinaryContract),
      venue: lowerVenue,
      contractId: `${lowerVenue.slice(0, 3).toUpperCase()}-BTC-${lowerStrike}`,
      strike: lowerStrike,
      yesAsk: lowerAsk,
      expiryMs: createdAt + 9 * 60_000,
    } as BinaryContract,
    {
      ...({} as BinaryContract),
      venue: higherVenue,
      contractId: `${higherVenue.slice(0, 3).toUpperCase()}-BTC-${higherStrike}`,
      strike: higherStrike,
      noAsk: higherAsk,
      expiryMs: createdAt + 9 * 60_000,
    } as BinaryContract,
    threshold,
  );

  const quarantined = partial && rng() > 0.72;

  return {
    id,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    pairKey: cand.pairKey,
    expiryMs: createdAt + 9 * 60_000,
    kalshiContractId: cand.kalshiContractId,
    polymarketContractId: cand.polymarketContractId,
    lower: cand.lower,
    higher: cand.higher,
    premium,
    guaranteedProfit: askGuaranteed,
    overlapProfit: round(2 - premium),
    threshold,
    action,
    failureReason: failed
      ? rng() > 0.5
        ? "fill_quality_gate"
        : "polymarket_timeout"
      : partial
        ? "leg_mismatch"
        : null,
    kalshiFillId: filled ? `kal_${id}` : null,
    polymarketFillId: filled ? `pol_${id}` : partial && rng() > 0.5 ? `pol_${id}` : null,
    kalshiFillPrice,
    polymarketFillPrice,
    executionGroupId: `grp_${id}`,
    kalshiStatus: filled ? "filled" : partial ? "filled" : "canceled",
    polymarketStatus: filled ? "filled" : partial ? "timeout" : "canceled",
    kalshiFillCount: filled ? orderSize : partial ? orderSize : 0,
    polymarketFillCount: filled ? orderSize : partial && rng() > 0.5 ? Math.round(orderSize * 0.4) : 0,
    partialFill: partial,
    depthVwap: round(realizedPremium, 4),
    projectedEdgeAfterFees: round(askGuaranteed - 0.01, 4),
    expectedExecutableEdge: round(askGuaranteed * pairedFillProb - slip, 4),
    realizedGuaranteedProfit: realized,
    executionStrategy: "parallel_fok",
    riskHedge: false,
    recoveryStatus: quarantined ? "risk_quarantined" : partial ? "finalizing" : "none",
    riskQuarantinedAt: quarantined ? new Date(updatedAt).toISOString() : null,
    riskQuarantineReason: quarantined ? "unhedged_exposure" : null,
    riskQuarantineExposureDollars: quarantined ? round(higherAsk * orderSize, 2) : null,
    fillQualitySnapshot: {
      version: "fq-1",
      scoredAt: createdAt,
      shadowMode: false,
      gateEnabled: true,
      gatePassed: !failed,
      blockReason: failed ? "expected_edge_below_min" : null,
      projectedEdgeAtLimit: round(askGuaranteed, 4),
      expectedExecutableEdge: round(askGuaranteed * pairedFillProb - slip, 4),
      minExpectedEdge: 0.02,
      pairedFillProbability: pairedFillProb,
      kalshiExactFillProbability: round(0.8 + rng() * 0.19, 3),
      polymarketExactFillProbability: round(0.62 + rng() * 0.34, 3),
      expectedSlippage: round(slip, 4),
      expectedMismatchCost: round(rng() * 0.02, 4),
      timeoutCost: round(rng() * 0.01, 4),
      penaltyReasons: [],
      features: {
        sampleCount: 240,
        minSamples: 40,
        coldStart: false,
        orderSize,
        placementMode: "parallel_fok",
        kalshiDepth: 400 + Math.round(rng() * 2000),
        polymarketDepth: 300 + Math.round(rng() * 1800),
        kalshiDepthRatio: round(1 + rng(), 2),
        polymarketDepthRatio: round(1 + rng(), 2),
        kalshiSpread: round(0.01 + rng() * 0.02, 3),
        polymarketSpread: round(0.01 + rng() * 0.03, 3),
        kalshiQuoteAgeMs: Math.round(rng() * 400),
        polymarketQuoteAgeMs: Math.round(rng() * 700),
        quoteSkewMs: Math.round(rng() * 300),
        secondsToExpiry: 480 + Math.round(rng() * 200),
        sameExpiryAttemptCount: Math.round(rng() * 3),
        recentExactPairFillRate: round(0.7 + rng() * 0.25, 3),
        recentMismatchRate: round(rng() * 0.1, 3),
        recentTimeoutRate: round(rng() * 0.08, 3),
        kalshiRecentExactFillRate: round(0.85 + rng() * 0.14, 3),
        polymarketRecentExactFillRate: round(0.7 + rng() * 0.28, 3),
        kalshiRttP50Ms: kalshiRtt,
        kalshiRttP95Ms: kalshiRtt + 40,
        polymarketRttP50Ms: polyRtt,
        polymarketRttP95Ms: polyRtt + 180,
        kalshiConfirmationP95Ms: kalshiRtt + 60,
        polymarketConfirmationP95Ms: polyRtt + 240,
        polymarketSignedOrderReuseRate: round(0.4 + rng() * 0.5, 2),
        polymarketSignedOrderFallbackRate: round(rng() * 0.2, 2),
        recentVenueEventCount: 1200 + Math.round(rng() * 800),
      },
    },
    leadLagSnapshot: {
      version: "ll-1",
      scoredAt: createdAt,
      shadowMode: false,
      gateEnabled: true,
      gatePassed: rng() > 0.15,
      blockReason: null,
      leaderVenue: rng() > 0.5 ? "kalshi" : "polymarket",
      laggingVenue: rng() > 0.5 ? "polymarket" : "kalshi",
      lagMsEstimate: Math.round(40 + rng() * 320),
      confidence: round(0.45 + rng() * 0.5, 3),
      stalenessScore: round(rng() * 0.5, 3),
      adverseSelectionScore: round(rng() * 0.85, 3),
      cheapLegVenue: rng() > 0.5 ? "kalshi" : "polymarket",
      cheapLegIsLagging: rng() > 0.5,
      windows: [],
      reasons: [],
    },
    executionTimings: {
      candidateToSubmitMs: 8 + Math.round(rng() * 40),
      hotGateMs: 2 + Math.round(rng() * 10),
      kalshiRttMs: kalshiRtt,
      polymarketRttMs: polyRtt,
      polymarketSignMs: 20 + Math.round(rng() * 60),
      polymarketConfirmationMs: polyRtt + Math.round(rng() * 200),
      venueSubmitSkewMs: Math.round(rng() * 120),
      totalMs: fillLatency,
      firstVenue: rng() > 0.5 ? "polymarket" : "kalshi",
    },
  };
}

function buildWindow(
  window: AnalyticsWindow,
  signals: DashboardSignal[],
  now: number,
  bucketMs: number,
  bucketCount: number,
): DashboardAnalyticsWindow {
  const sinceMs = now - (bucketCount - 1) * bucketMs - (now % bucketMs);
  const buckets: DashboardAnalyticsBucket[] = [];
  let cumulative = 0;
  let peak = 0;
  let maxDd = 0;
  const allPnls: number[] = [];
  const allSlips: number[] = [];
  const allLat: number[] = [];

  for (let i = 0; i < bucketCount; i++) {
    const startMs = sinceMs + i * bucketMs;
    const endMs = startMs + bucketMs;
    const inBucket = signals.filter((s) => {
      const t = new Date(s.updatedAt).getTime();
      return t >= startMs && t < endMs && s.action === "filled" && s.realizedGuaranteedProfit != null;
    });
    let net = 0;
    let wins = 0;
    let losses = 0;
    let breakevens = 0;
    let gp = 0;
    let gl = 0;
    const slips: number[] = [];
    const lats: number[] = [];
    for (const s of inBucket) {
      const pnl = s.realizedGuaranteedProfit ?? 0;
      net += pnl;
      if (pnl > 1e-9) {
        wins++;
        gp += pnl;
      } else if (pnl < -1e-9) {
        losses++;
        gl += pnl;
      } else breakevens++;
      allPnls.push(pnl);
      const slip = round((s.depthVwap ?? s.premium) - s.premium, 4);
      slips.push(slip);
      allSlips.push(slip);
      const lat = new Date(s.updatedAt).getTime() - new Date(s.createdAt).getTime();
      lats.push(lat);
      allLat.push(lat);
    }
    cumulative = round(cumulative + net);
    peak = Math.max(peak, cumulative);
    const dd = round(Math.max(0, peak - cumulative));
    maxDd = Math.max(maxDd, dd);
    const lbl =
      window === "hourly"
        ? new Date(startMs).toLocaleTimeString("en-US", { hour: "2-digit", hour12: false })
        : new Date(startMs).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" });
    buckets.push({
      startMs,
      endMs,
      label: lbl,
      tradeCount: inBucket.length,
      wins,
      losses,
      breakevens,
      netPnl: round(net),
      cumulativePnl: cumulative,
      grossProfit: round(gp),
      grossLoss: round(gl),
      avgPnl: inBucket.length ? round(net / inBucket.length) : null,
      avgSlippage: slips.length ? round(slips.reduce((a, b) => a + b, 0) / slips.length) : null,
      avgFillLatencyMs: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
      drawdown: dd,
    });
  }

  const wins = allPnls.filter((p) => p > 1e-9).length;
  const losses = allPnls.filter((p) => p < -1e-9).length;
  const filled = allPnls.length;
  const grossProfit = round(allPnls.filter((p) => p > 0).reduce((a, b) => a + b, 0));
  const grossLoss = round(allPnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  const net = round(allPnls.reduce((a, b) => a + b, 0));
  const mean = filled ? net / filled : 0;
  const variance = filled > 1 ? allPnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (filled - 1) : 0;
  const std = Math.sqrt(variance);
  const opportunityCount = Math.round(filled / 0.78);

  const distBucket = (label: string, pred: (v: number) => boolean) => ({
    label,
    count: allPnls.filter(pred).length,
    min: null,
    max: null,
  });
  const slipBucket = (label: string, pred: (v: number) => boolean) => ({
    label,
    count: allSlips.filter(pred).length,
    min: null,
    max: null,
  });

  return {
    window,
    label: window[0].toUpperCase() + window.slice(1),
    generatedAt: now,
    sinceMs,
    bucketMs,
    filledTrades: filled,
    tradesWon: wins,
    tradesLost: losses,
    breakevenTrades: filled - wins - losses,
    winRate: filled ? round(wins / filled) : 0,
    lossRate: filled ? round(losses / filled) : 0,
    grossProfit,
    grossLoss,
    netPnl: net,
    profitFactor: grossLoss < -1e-9 ? round(grossProfit / Math.abs(grossLoss)) : null,
    sharpeRatio: std > 1e-9 ? round((mean / std) * Math.sqrt(filled)) : null,
    averagePnl: filled ? round(mean) : null,
    bestTradePnl: filled ? round(Math.max(...allPnls)) : null,
    worstTradePnl: filled ? round(Math.min(...allPnls)) : null,
    maxDrawdown: round(maxDd),
    avgPremium: filled
      ? round(
          signals.filter((s) => s.action === "filled").reduce((a, s) => a + s.premium, 0) /
            Math.max(1, signals.filter((s) => s.action === "filled").length),
        )
      : null,
    avgSlippage: allSlips.length ? round(allSlips.reduce((a, b) => a + b, 0) / allSlips.length) : null,
    avgFillLatencyMs: allLat.length ? Math.round(allLat.reduce((a, b) => a + b, 0) / allLat.length) : null,
    opportunityCount,
    fillRate: opportunityCount ? round(filled / opportunityCount) : 0,
    pnlDistribution: [
      distBucket("Loss", (v) => v < -1e-9),
      distBucket("Breakeven", (v) => Math.abs(v) <= 1e-9),
      distBucket("0-5c", (v) => v > 1e-9 && v < 0.05),
      distBucket("5-10c", (v) => v >= 0.05 && v < 0.1),
      distBucket("10c+", (v) => v >= 0.1),
    ],
    slippageDistribution: [
      slipBucket("<=0c", (v) => v <= 1e-9),
      slipBucket("0-1c", (v) => v > 1e-9 && v < 0.01),
      slipBucket("1-2c", (v) => v >= 0.01 && v < 0.02),
      slipBucket("2-3c", (v) => v >= 0.02 && v < 0.03),
      slipBucket("3c+", (v) => v >= 0.03),
    ],
    fillLatencySeries: buckets.map((b) => ({
      label: b.label,
      startMs: b.startMs,
      tradeCount: b.tradeCount,
      netPnl: b.avgFillLatencyMs ?? 0,
      winRate: b.avgFillLatencyMs ?? 0,
    })),
    heatmap: buckets.map((b) => ({
      label: b.label,
      startMs: b.startMs,
      tradeCount: b.tradeCount,
      netPnl: b.netPnl,
      winRate: b.tradeCount ? round(b.wins / b.tradeCount) : 0,
    })),
    buckets,
  };
}

function buildAnalytics(signals: DashboardSignal[], now: number): DashboardAnalytics {
  return {
    hourly: buildWindow("hourly", signals, now, 3_600_000, 24),
    daily: buildWindow("daily", signals, now, 86_400_000, 7),
    weekly: buildWindow("weekly", signals, now, 604_800_000, 8),
    realtime: {
      mode: "hot_cache",
      lastUpdatedAt: now - 1200,
      lastDbReconciledAt: now - 8000,
      computeMs: 12,
      sourceSignalCount: signals.length,
      stale: false,
    },
  };
}

function tradingVenue(platform: TradingPlatform, now: number, rng: () => number): TradingPlatformActivity {
  const base = platform === "kalshi" ? 48000 : 52000;
  const sparkline = Array.from({ length: 48 }, (_, i) => ({
    timestamp: now - (48 - i) * 60_000,
    value: round(base + Math.sin(i / 5) * 600 + (rng() - 0.5) * 800 + i * 14, 2),
  }));
  const portfolioValue = sparkline[sparkline.length - 1].value;
  return {
    platform,
    connectionStatus: "live",
    lastUpdatedAt: now - Math.round(rng() * 3000),
    portfolio: {
      platform,
      portfolioValue,
      cashValue: round(portfolioValue * (0.35 + rng() * 0.25), 2),
      dayChangeDollars: round((rng() - 0.35) * 900, 2),
      dayChangePercent: round((rng() - 0.35) * 3, 2),
      lastUpdatedAt: now - 1500,
    },
    positions: Array.from({ length: platform === "kalshi" ? 4 : 3 }, (_, i) => ({
      id: `${platform}-pos-${i}`,
      market: `BTC ${64000 + i * 250} ${platform === "kalshi" ? "YES" : "NO"}`,
      outcome: platform === "kalshi" ? "Yes" : "No",
      shares: 100 + Math.round(rng() * 400),
      value: round(60 + rng() * 300, 2),
      averagePrice: round(0.4 + rng() * 0.4, 2),
      updatedAt: now - Math.round(rng() * 60000),
    })),
    openOrders: Array.from({ length: Math.round(rng() * 2) }, (_, i) => ({
      id: `${platform}-ord-${i}`,
      market: `BTC ${64500 + i * 250}`,
      outcome: "Yes",
      side: "Buy" as const,
      shares: 100,
      price: round(0.6 + rng() * 0.2, 2),
      value: round(60 + rng() * 20, 2),
      status: "open",
      updatedAt: now - Math.round(rng() * 30000),
    })),
    history: Array.from({ length: 14 }, (_, i) => ({
      id: `${platform}-h-${i}`,
      activity: (rng() > 0.5 ? "Buy" : "Sell") as "Buy" | "Sell",
      marketName: `BTC ${64000 + Math.round(rng() * 8) * 250}`,
      outcome: rng() > 0.5 ? "Yes" : "No",
      shares: 100 + Math.round(rng() * 300),
      value: round(40 + rng() * 200, 2),
      timeMs: now - i * 240_000 - Math.round(rng() * 60000),
      venueOrderId: `v_${i}`,
      clientOrderId: `c_${i}`,
      status: "filled",
    })),
    sparkline,
  };
}

export function generateMockSnapshot(seedMs = Date.now()): DashboardSnapshot {
  const now = seedMs;
  // Stable historical seed (changes every ~3s for a gentle "live" feel).
  const rng = mulberry32(Math.floor(now / 3000));
  const threshold = 0.03;
  const orderSize = 100;
  const staleBookMs = 4000;
  const expiry = now + (9 * 60_000 - (now % (15 * 60_000)));

  // Signals over the last ~7 days for analytics; ledger shows the last 100.
  const signals: DashboardSignal[] = [];
  let id = 5200;
  for (let i = 0; i < 420; i++) {
    const createdAt = now - i * 22 * 60_000 - Math.round(rng() * 60000);
    signals.push(buildSignal(id--, createdAt, threshold, orderSize, rng));
  }
  signals.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const recentSignals = signals.slice(0, 100);

  const analytics = buildAnalytics(signals, now);

  // Live books + candidates.
  const baseStrike = 64000 + Math.round(rng() * 4) * 250;
  const kBooks: BinaryContract[] = [];
  const pBooks: BinaryContract[] = [];
  for (let i = 0; i < 8; i++) {
    const strike = baseStrike + i * 250;
    const yesMid = clampMid(0.85 - i * 0.1 + (rng() - 0.5) * 0.05);
    kBooks.push(contract("kalshi", strike, expiry, now, rng, yesMid));
    pBooks.push(contract("polymarket", strike, expiry, now, rng, clampMid(yesMid + (rng() - 0.5) * 0.04)));
  }

  const liveCandidates: ArbCandidate[] = [];
  const syntheticStructures: ArbCandidate[] = [];
  for (let i = 0; i < kBooks.length - 1; i++) {
    const lowerFromK = rng() > 0.5;
    const lowerC = lowerFromK ? kBooks[i] : pBooks[i];
    const higherC = lowerFromK ? pBooks[i + 1] : kBooks[i + 1];
    const cand = buildCandidate(lowerC, higherC, threshold);
    syntheticStructures.push(cand);
    if (cand.executable) liveCandidates.push(cand);
  }
  liveCandidates.sort((a, b) => b.guaranteedProfit - a.guaranteedProfit);

  // Current unhedged exposure = only recent, still-unresolved quarantines (most auto-resolve).
  const quarantinedExposure = round(
    recentSignals
      .filter((s) => s.recoveryStatus === "risk_quarantined" && now - new Date(s.updatedAt).getTime() < 40 * 60_000)
      .reduce((a, s) => a + (s.riskQuarantineExposureDollars ?? 0), 0),
    2,
  );
  const exactRecent = recentSignals.slice(0, 40);
  const exactPairFillRate = round(
    exactRecent.filter((s) => s.action === "filled" && !s.partialFill).length / Math.max(1, exactRecent.length),
    3,
  );
  const mismatchRate = round(exactRecent.filter((s) => s.partialFill).length / Math.max(1, exactRecent.length), 3);

  const lat = (latest: number) => ({
    latestMs: latest,
    p50Ms: round(latest * 0.9),
    p95Ms: round(latest * 1.6),
    sampleCount: 500,
  });

  return {
    generatedAt: now,
    health: {
      ok: true,
      liveTrading: true,
      arbEnabled: true,
      minProfitDollars: threshold,
      reentryIntervalMs: 60_000,
      scanHeartbeatMs: 1000,
      staleBookMs,
      liveMaxTradesPerWindow: 6,
      liveOrderSize: orderSize,
      liveTakerPriceCushionCents: 1,
      liveKalshiMinCashDollars: 200,
      liveQuoteMaxAgeMs: 1500,
      liveQuoteSyncMaxSkewMs: 600,
      liveMinBookDepthShares: 50,
      liveOrderTimeoutMs: 2500,
      liveHedgeMaxLossDollars: 5,
      liveHedgeFeeBufferDollars: 1,
      liveHedgeMinCrossTicks: 2,
      liveKalshiHedgeTimeInForce: "fill_or_kill",
      liveOrderPlacementMode: "parallel_fok",
      liveAggressiveLimitRestMs: 400,
      liveParallelExecutionEnabled: true,
      liveHotPathEnabled: true,
      liveHotPathCacheMaxAgeMs: 800,
      liveHotPathWarmIntervalMs: 500,
      livePolymarketPresignEnabled: true,
      livePolymarketSignedOrderTtlMs: 4000,
      livePolymarketFirstMinFillShares: 20,
      livePolymarketFirstMaxFillShares: 200,
      liveKalshiPrearmEnabled: true,
      liveKalshiPrearmMaxAgeMs: 1200,
      liveKalshiPrearmPricePolicy: "patch_after_fill",
      liveLowLatencyHttpEnabled: true,
      liveUserStreamsEnabled: true,
      liveUserStreamPretradeGraceMs: 800,
      liveUserStreamConfirmTimeoutMs: 2500,
      livePretradeRetryAttempts: 2,
      livePretradeRetryDelayMs: 250,
      liveFinalRecoveryTimeoutMs: 8000,
      liveFinalRecoveryPollMs: 500,
      liveAutoResolveVerifiedIncidents: true,
      liveAutoHardlocksEnabled: true,
      polymarketGeoblockGateEnabled: true,
      liveExactExposureRequired: true,
      liveExecutionQualityGateEnabled: true,
      liveExecutionQualityLookbackMs: 3_600_000,
      liveExecutionQualitySampleLimit: 200,
      liveExecutionQualityMinSamples: 30,
      liveExecutionQualityMinExactFillRate: 0.6,
      liveFillQualityScoringEnabled: true,
      liveFillQualityGateEnabled: true,
      liveFillQualityMinExpectedEdge: 0.02,
      liveFillQualityLookbackMs: 3_600_000,
      liveFillQualitySampleLimit: 200,
      liveFillQualityMinSamples: 40,
      liveFillQualityModelVersion: "fq-1",
      liveLeadLagScoringEnabled: true,
      liveLeadLagGateEnabled: true,
      liveLeadLagModelVersion: "ll-1",
      liveLeadLagWindowsMs: [250, 500, 1000],
      liveLeadLagMinConfidence: 0.5,
      liveLeadLagMaxAdverseSelectionScore: 0.8,
      livePartialFillLockMode: "quarantine",
      liveMaxUnresolvedExposureDollars: 250,
      liveReconcileBeforeTrade: true,
    },
    latency: {
      generatedAt: now,
      books: { kalshi: lat(12), polymarket: lat(28) },
      wsToBookApplyMs: { kalshi: lat(3), polymarket: lat(6) },
      scanner: {
        scanDurationMs: lat(4),
        bookUpdateToDecisionMs: lat(7),
        queueDepth: Math.round(rng() * 2),
        activeExecutions: Math.round(rng() * 2),
        lastScanStartedAt: now - 400,
        lastScanCompletedAt: now - 396,
        coalescedScanCount: 14,
        duplicateCandidateSkips: 3,
      },
      persistence: { insertMs: lat(5), updateMs: lat(6), preSubmitDbMs: lat(3) },
      execution: { durationMs: lat(420), hotGateMs: lat(3) },
      dashboard: {
        snapshotBuildMs: lat(8),
        streamIntervalMs: 1000,
        signalRefreshMs: 2000,
        analyticsRefreshMs: 5000,
        snapshotAgeMs: 300,
      },
    },
    discovery: { lastDiscoveryAt: now - 4200, lastDiscoveryError: null },
    scanner: {
      scanning: true,
      lastScanAt: now - 400,
      lastScanAgeMs: 400,
      lastCandidateCount: liveCandidates.length,
      queuedExecutions: Math.round(rng() * 2),
      activeExecutions: Math.round(rng() * 2),
    },
    books: { kalshi: kBooks, polymarket: pBooks },
    diagnostics: {
      polymarket: {
        marketsFound: 18,
        readyContracts: pBooks.length,
        pendingStrikeCount: 2,
        missingStrikeCount: 1,
        invalidMarketCount: 0,
        lastChainlinkTickAt: now - 2200,
        lastChainlinkTickAgeMs: 2200,
        nextCaptureWindowStartMs: expiry,
        skippedReasons: ["pending_strike"],
        markets: pBooks.map((c) => ({
          marketSlug: c.marketSlug ?? "",
          conditionId: `0x${c.contractId}`,
          eventStartMs: now - 6 * 60_000,
          expiryMs: c.expiryMs,
          priceToBeat: c.strike,
          strikeSource: "chainlink",
          status: "ready" as const,
          reason: "ok",
        })),
      },
    },
    liveCandidates,
    syntheticStructures,
    recentSignals,
    analytics,
    equityCurve: buildEquityCurve(now, rng),
    tradingActivity: {
      kalshi: tradingVenue("kalshi", now, rng),
      polymarket: tradingVenue("polymarket", now, rng),
    } as TradingActivitySnapshot,
    execution: {
      mode: "live",
      liveTrading: true,
      protectedOnly: true,
      orderSize,
      orderType: "limit",
      takerPriceCushionCents: 1,
      minExpiryMs: 4 * 60_000,
      maxTradesPerWindow: 6,
      collateralBufferDollars: 50,
      quoteMaxAgeMs: 1500,
      quoteSyncMaxSkewMs: 600,
      minBookDepthShares: 50,
      orderTimeoutMs: 2500,
      kalshiOrderGroupEnabled: true,
      riskState: "trading",
      riskStateReason: null,
      partialFillLocked: false,
      circuitBreakerLocked: false,
      circuitBreakerReason: null,
      circuitBreaker: null,
      executionQualityGateEnabled: true,
      executionQuality: {
        enabled: true,
        ok: true,
        reason: null,
        sampleCount: 200,
        lookbackMs: 3_600_000,
        sampleLimit: 200,
        minSamples: 30,
        minExactFillRate: 0.6,
        exactPairFillRate,
        polymarketTimeoutRate: round(rng() * 0.08, 3),
        mismatchRate,
        avgPolymarketRttMs: 220,
        avgMismatchCostDollars: round(rng() * 2, 2),
        estimatedExecutableEdge: round(0.04 + rng() * 0.03, 4),
      },
      userStreams: {
        enabled: true,
        ready: true,
        reason: null,
        confirmTimeoutMs: 2500,
        kalshi: {
          enabled: true,
          connected: true,
          subscribed: true,
          reason: null,
          lastConnectedAt: now - 600000,
          lastEventAt: now - 1200,
          lastError: null,
        },
        polymarket: {
          enabled: true,
          connected: true,
          subscribed: true,
          reason: null,
          lastConnectedAt: now - 600000,
          lastEventAt: now - 2400,
          lastError: null,
        },
        lastUserStreamEventAt: now - 1200,
        confirmationLagMs: 180,
      },
      reconciliation: {
        enabled: true,
        clean: quarantinedExposure < 1,
        reason: quarantinedExposure >= 1 ? "unresolved_quarantine" : null,
        checkedAt: now - 5000,
        lastReconciliationAt: now - 5000,
        quarantinedExposureDollars: quarantinedExposure,
        quarantinedSignalCount: recentSignals.filter(
          (s) => s.recoveryStatus === "risk_quarantined" && now - new Date(s.updatedAt).getTime() < 40 * 60_000,
        ).length,
        quarantineCapDollars: 250,
      },
      kalshi: {
        configured: true,
        ready: true,
        reason: null,
        balance: round(8200 + rng() * 800, 2),
        allowance: null,
        lastCheckedAt: now - 4000,
        geoblockBlocked: false,
      },
      polymarket: {
        configured: true,
        ready: true,
        reason: null,
        balance: round(9100 + rng() * 900, 2),
        allowance: round(50000, 2),
        lastCheckedAt: now - 4000,
        geoblockBlocked: false,
      },
      lastAttempt: {
        executionGroupId: `grp_${recentSignals[0]?.id ?? 0}`,
        action: recentSignals[0]?.action ?? "filled",
        partialFill: recentSignals[0]?.partialFill ?? false,
        failureReason: recentSignals[0]?.failureReason ?? null,
        kalshiStatus: recentSignals[0]?.kalshiStatus ?? "filled",
        polymarketStatus: recentSignals[0]?.polymarketStatus ?? "filled",
        recoveryStatus: recentSignals[0]?.recoveryStatus ?? "none",
        completedAt: now - 12000,
      },
    },
    logs: buildLogs(now, rng),
  };
}

function clampMid(v: number): number {
  return Math.max(0.06, Math.min(0.94, round(v, 2)));
}

function buildLogs(now: number, rng: () => number) {
  const cats = ["scanner", "executor", "kalshi", "polymarket", "reconcile", "fill-quality", "lead-lag"];
  const sev: Array<"INFO" | "WARN" | "ERROR" | "DEBUG"> = ["INFO", "INFO", "INFO", "WARN", "DEBUG", "ERROR"];
  const msgs = [
    "scan complete, 4 candidates",
    "submitted parallel FOK order",
    "exact pair filled, edge 0.061",
    "polymarket confirmation 312ms",
    "fill-quality gate passed",
    "lead-lag confidence 0.71",
    "book applied seq 99213",
    "reconciliation clean",
    "candidate below threshold, skipped",
    "polymarket timeout, retrying",
  ];
  return Array.from({ length: 60 }, (_, i) => ({
    timestamp: new Date(now - i * 4200 - Math.round(rng() * 2000)).toISOString(),
    severity: sev[Math.floor(rng() * sev.length)],
    category: cats[Math.floor(rng() * cats.length)],
    message: msgs[Math.floor(rng() * msgs.length)],
  }));
}
