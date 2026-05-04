export type Venue = "kalshi" | "polymarket";
export type LegDirection = "yes" | "no";
export type SignalAction = "filled" | "skipped" | "failed";

export interface BinaryContract {
  venue: Venue;
  contractId: string;
  asset: "BTC";
  expiryMs: number;
  strike: number;
  yesAsk: number | null;
  noAsk: number | null;
  yesBid: number | null;
  noBid: number | null;
  yesTokenId?: string | null;
  noTokenId?: string | null;
  title?: string | null;
  marketSlug?: string | null;
  updatedAt: number;
}

export interface ArbLeg {
  venue: Venue;
  contractId: string;
  direction: LegDirection;
  strike: number;
  ask: number;
  tokenId?: string | null;
}

export type SyntheticStructureType = "long_up_below_down_above" | "long_up_above_down_below";
export type SyntheticStructureClassification = "true_arbitrage" | "guaranteed_below_threshold" | "probabilistic_bet";
export type PayoffRegionKey = "below_lower" | "between_strikes" | "above_higher";

export interface SyntheticPayoffRegion {
  region: PayoffRegionKey;
  label: string;
  fromStrike: number | null;
  toStrike: number | null;
  width: number | null;
  payoff: number;
  profit: number;
  isMaxLoss: boolean;
}

export interface SyntheticStructureRisk {
  structureType: SyntheticStructureType;
  classification: SyntheticStructureClassification;
  strikeGap: number;
  midStrike: number;
  strikeGapPctOfMid: number;
  lossWindowWidth: number;
  lossWindowPctOfStrikeGap: number;
  lossWindowPctOfMid: number;
  overlapWindowWidth: number;
  overlapWindowPctOfStrikeGap: number;
  premium: number;
  worstCaseProfit: number;
  bestCaseProfit: number;
  guaranteedEdge: number | null;
  conditionalEdge: number | null;
  maxLossRegion: SyntheticPayoffRegion | null;
  payoffProfile: SyntheticPayoffRegion[];
}

export interface ArbCandidate {
  pairKey: string;
  expiryMs: number;
  lower: ArbLeg;
  higher: ArbLeg;
  kalshiContractId: string;
  polymarketContractId: string;
  premium: number;
  guaranteedProfit: number;
  overlapProfit: number;
  threshold: number;
  executable: boolean;
  reason: string | null;
  risk?: SyntheticStructureRisk;
}

export interface ExecutionResult {
  action: SignalAction;
  failureReason: string | null;
  kalshiFillId: string | null;
  polymarketFillId: string | null;
  kalshiFillPrice: number | null;
  polymarketFillPrice: number | null;
  executionGroupId?: string | null;
  kalshiClientOrderId?: string | null;
  polymarketClientOrderId?: string | null;
  kalshiStatus?: string | null;
  polymarketStatus?: string | null;
  kalshiFillCount?: number | null;
  polymarketFillCount?: number | null;
  kalshiRequestedAt?: string | null;
  kalshiRespondedAt?: string | null;
  polymarketRequestedAt?: string | null;
  polymarketRespondedAt?: string | null;
  kalshiError?: string | null;
  polymarketError?: string | null;
  partialFill?: boolean;
}

export interface SignalInsert {
  candidate: ArbCandidate;
  action: SignalAction;
  failureReason?: string | null;
}

export interface SignalUpdate {
  action: SignalAction;
  failureReason?: string | null;
  kalshiFillId?: string | null;
  polymarketFillId?: string | null;
  kalshiFillPrice?: number | null;
  polymarketFillPrice?: number | null;
  executionGroupId?: string | null;
  kalshiClientOrderId?: string | null;
  polymarketClientOrderId?: string | null;
  kalshiStatus?: string | null;
  polymarketStatus?: string | null;
  kalshiFillCount?: number | null;
  polymarketFillCount?: number | null;
  kalshiRequestedAt?: string | null;
  kalshiRespondedAt?: string | null;
  polymarketRequestedAt?: string | null;
  polymarketRespondedAt?: string | null;
  kalshiError?: string | null;
  polymarketError?: string | null;
  partialFill?: boolean;
}

export interface DashboardSignal {
  id: number;
  createdAt: string;
  updatedAt: string;
  pairKey: string;
  expiryMs: number;
  kalshiContractId: string;
  polymarketContractId: string;
  lower: ArbLeg;
  higher: ArbLeg;
  premium: number;
  guaranteedProfit: number;
  overlapProfit: number;
  threshold: number;
  action: SignalAction;
  failureReason: string | null;
  kalshiFillId: string | null;
  polymarketFillId: string | null;
  kalshiFillPrice: number | null;
  polymarketFillPrice: number | null;
  executionGroupId?: string | null;
  kalshiClientOrderId?: string | null;
  polymarketClientOrderId?: string | null;
  kalshiStatus?: string | null;
  polymarketStatus?: string | null;
  kalshiFillCount?: number | null;
  polymarketFillCount?: number | null;
  kalshiRequestedAt?: string | null;
  kalshiRespondedAt?: string | null;
  polymarketRequestedAt?: string | null;
  polymarketRespondedAt?: string | null;
  kalshiError?: string | null;
  polymarketError?: string | null;
  partialFill?: boolean;
  risk?: SyntheticStructureRisk;
}

export interface VenueExecutionReadiness {
  configured: boolean;
  ready: boolean;
  reason: string | null;
  balance: number | null;
  allowance: number | null;
  lastCheckedAt: number | null;
}

export interface LiveExecutionLastAttempt {
  executionGroupId: string;
  action: SignalAction;
  partialFill: boolean;
  failureReason: string | null;
  kalshiStatus: string | null;
  polymarketStatus: string | null;
  completedAt: number;
}

export interface LiveExecutionReadiness {
  mode: "dry_run" | "live";
  liveTrading: boolean;
  protectedOnly: boolean;
  orderSize: number;
  orderType: string;
  maxSlippageCents: number;
  minExpiryMs: number;
  partialFillLocked: boolean;
  kalshi: VenueExecutionReadiness;
  polymarket: VenueExecutionReadiness;
  lastAttempt: LiveExecutionLastAttempt | null;
}

export interface DashboardLogEntry {
  timestamp: string;
  severity: "DEBUG" | "INFO" | "WARN" | "ERROR";
  category: string;
  message: string;
  context?: Record<string, unknown>;
}

export type AnalyticsWindow = "hourly" | "daily" | "weekly";

export interface DashboardAnalyticsBucket {
  startMs: number;
  endMs: number;
  label: string;
  tradeCount: number;
  wins: number;
  losses: number;
  breakevens: number;
  netPnl: number;
  cumulativePnl: number;
  grossProfit: number;
  grossLoss: number;
  avgPnl: number | null;
  avgSlippage: number | null;
  avgFillLatencyMs: number | null;
  drawdown: number;
}

export interface DashboardAnalyticsDistributionBucket {
  label: string;
  count: number;
  min: number | null;
  max: number | null;
}

export interface DashboardAnalyticsHeatmapCell {
  label: string;
  startMs: number;
  tradeCount: number;
  netPnl: number;
  winRate: number;
}

export interface DashboardAnalyticsWindow {
  window: AnalyticsWindow;
  label: string;
  generatedAt: number;
  sinceMs: number;
  bucketMs: number;
  filledTrades: number;
  tradesWon: number;
  tradesLost: number;
  breakevenTrades: number;
  winRate: number;
  lossRate: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  profitFactor: number | null;
  sharpeRatio: number | null;
  averagePnl: number | null;
  bestTradePnl: number | null;
  worstTradePnl: number | null;
  maxDrawdown: number;
  avgPremium: number | null;
  avgSlippage: number | null;
  avgFillLatencyMs: number | null;
  opportunityCount: number;
  fillRate: number;
  pnlDistribution: DashboardAnalyticsDistributionBucket[];
  slippageDistribution: DashboardAnalyticsDistributionBucket[];
  fillLatencySeries: DashboardAnalyticsHeatmapCell[];
  heatmap: DashboardAnalyticsHeatmapCell[];
  buckets: DashboardAnalyticsBucket[];
}

export interface DashboardAnalyticsRealtime {
  mode: "hot_cache" | "fallback_db";
  lastUpdatedAt: number | null;
  lastDbReconciledAt: number | null;
  computeMs: number;
  sourceSignalCount: number;
  stale: boolean;
}

export interface DashboardAnalytics {
  hourly: DashboardAnalyticsWindow;
  daily: DashboardAnalyticsWindow;
  weekly: DashboardAnalyticsWindow;
  realtime?: DashboardAnalyticsRealtime;
}

export type PolymarketStrikeStatus = "ready" | "pending_strike" | "missing_strike" | "invalid_market";

export interface PolymarketMarketDiagnostic {
  marketSlug: string;
  conditionId: string | null;
  eventStartMs: number | null;
  expiryMs: number | null;
  priceToBeat: number | null;
  strikeSource: string | null;
  status: PolymarketStrikeStatus;
  reason: string;
}

export interface PolymarketDiagnostics {
  marketsFound: number;
  readyContracts: number;
  pendingStrikeCount: number;
  missingStrikeCount: number;
  invalidMarketCount: number;
  lastChainlinkTickAt: number | null;
  lastChainlinkTickAgeMs: number | null;
  nextCaptureWindowStartMs: number | null;
  skippedReasons: string[];
  markets: PolymarketMarketDiagnostic[];
}

export interface DashboardLatencyStats {
  latestMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  sampleCount: number;
}

export interface DashboardLatencySnapshot {
  generatedAt: number;
  books: Record<Venue, DashboardLatencyStats>;
  wsToBookApplyMs: Record<Venue, DashboardLatencyStats>;
  scanner: {
    scanDurationMs: DashboardLatencyStats;
    queueDepth: number;
    activeExecutions: number;
    lastScanStartedAt: number | null;
    lastScanCompletedAt: number | null;
    coalescedScanCount: number;
    duplicateCandidateSkips: number;
  };
  persistence: {
    insertMs: DashboardLatencyStats;
    updateMs: DashboardLatencyStats;
  };
  execution: {
    durationMs: DashboardLatencyStats;
  };
  dashboard: {
    snapshotBuildMs: DashboardLatencyStats;
    streamIntervalMs: number;
    signalRefreshMs: number;
    analyticsRefreshMs: number;
    snapshotAgeMs: number;
  };
}

export interface DashboardSnapshot {
  generatedAt: number;
  health: {
    ok: boolean;
    liveTrading: boolean;
    arbEnabled: boolean;
    minProfitDollars: number;
    reentryIntervalMs: number;
    staleBookMs: number;
  };
  latency?: DashboardLatencySnapshot;
  discovery: {
    lastDiscoveryAt: number;
    lastDiscoveryError: string | null;
  };
  scanner: {
    scanning: boolean;
    lastScanAt: number;
    lastCandidateCount: number;
  };
  books: {
    kalshi: BinaryContract[];
    polymarket: BinaryContract[];
  };
  diagnostics: {
    polymarket: PolymarketDiagnostics;
  };
  liveCandidates: ArbCandidate[];
  syntheticStructures?: ArbCandidate[];
  recentSignals: DashboardSignal[];
  analytics?: DashboardAnalytics;
  execution?: LiveExecutionReadiness;
  logs: DashboardLogEntry[];
}
