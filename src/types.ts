export type Venue = "kalshi" | "polymarket";
export type LegDirection = "yes" | "no";
export type SignalAction = "filled" | "skipped" | "failed";
export type ExecutionMode = "paper" | "live";

export interface BookLevel {
  price: number;
  size: number;
}

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
  yesAskLevels?: BookLevel[];
  noAskLevels?: BookLevel[];
  yesBidLevels?: BookLevel[];
  noBidLevels?: BookLevel[];
  sequence?: number | null;
  bookHash?: string | null;
  tickSize?: number | null;
  tickSizeChangedAt?: number | null;
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

export interface QuoteSnapshotLeg {
  venue: Venue;
  contractId: string;
  direction: LegDirection;
  topAsk: number | null;
  worstAsk: number | null;
  vwap: number | null;
  depth: number;
  depthRequired: number;
  levelsConsumed: BookLevel[];
  spread: number | null;
  quoteAgeMs: number | null;
  updatedAt: number | null;
  sequence?: number | null;
  bookHash?: string | null;
  tickSize?: number | null;
  tickSizeChangedAt?: number | null;
}

export interface QuoteSnapshot {
  capturedAt: number;
  quoteSkewMs: number | null;
  kalshi: QuoteSnapshotLeg | null;
  polymarket: QuoteSnapshotLeg | null;
  projectedPremium: number | null;
  projectedEdge: number | null;
  projectedEdgeAfterFees: number | null;
  minProfitDollars: number;
  edgeBufferDollars: number;
  entryLatencyEdgeBufferDollars?: number | null;
  totalEdgeBufferDollars?: number | null;
  failureReason: string | null;
}

export interface ExecutionTimings {
  candidateToSubmitMs?: number | null;
  kalshiRttMs?: number | null;
  polymarketRttMs?: number | null;
  preflightMs?: number | null;
  kalshiOrderRttMs?: number | null;
  postFillHedgeDecisionMs?: number | null;
  polymarketOrderRttMs?: number | null;
  venueSubmitSkewMs?: number | null;
  totalMs?: number | null;
}

export interface VenueConfirmations {
  kalshi?: Record<string, unknown> | null;
  polymarket?: Record<string, unknown> | null;
}

export interface UserStreamVenueState {
  enabled: boolean;
  connected: boolean;
  subscribed: boolean;
  reason: string | null;
  lastConnectedAt: number | null;
  lastEventAt: number | null;
  lastError: string | null;
}

export interface UserStreamReadiness {
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  confirmTimeoutMs: number;
  kalshi: UserStreamVenueState;
  polymarket: UserStreamVenueState;
  lastUserStreamEventAt: number | null;
  confirmationLagMs: number | null;
}

export interface ReconciliationReadiness {
  enabled: boolean;
  clean: boolean;
  reason: string | null;
  checkedAt: number | null;
  lastReconciliationAt: number | null;
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
  liveLockReason?: string | null;
  quoteSnapshot?: QuoteSnapshot | null;
  depthVwap?: number | null;
  projectedEdgeAfterFees?: number | null;
  executionTimings?: ExecutionTimings | null;
  venueConfirmations?: VenueConfirmations | null;
  executionStrategy?: "sequential_hedge" | "parallel_canary" | null;
  riskHedge?: boolean;
  realizedGuaranteedProfit?: number | null;
  hedgeCapPrice?: number | null;
}

export interface SignalInsert {
  candidate: ArbCandidate;
  executionMode?: ExecutionMode;
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
  quoteSnapshot?: QuoteSnapshot | null;
  depthVwap?: number | null;
  projectedEdgeAfterFees?: number | null;
  executionTimings?: ExecutionTimings | null;
  venueConfirmations?: VenueConfirmations | null;
  executionStrategy?: "sequential_hedge" | "parallel_canary" | null;
  riskHedge?: boolean;
  realizedGuaranteedProfit?: number | null;
  hedgeCapPrice?: number | null;
}

export interface DashboardSignal {
  id: number;
  createdAt: string;
  updatedAt: string;
  executionMode: ExecutionMode;
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
  quoteSnapshot?: QuoteSnapshot | null;
  depthVwap?: number | null;
  projectedEdgeAfterFees?: number | null;
  executionTimings?: ExecutionTimings | null;
  venueConfirmations?: VenueConfirmations | null;
  executionStrategy?: "sequential_hedge" | "parallel_canary" | null;
  riskHedge?: boolean;
  realizedGuaranteedProfit?: number | null;
  hedgeCapPrice?: number | null;
  risk?: SyntheticStructureRisk;
}

export interface VenueExecutionReadiness {
  configured: boolean;
  ready: boolean;
  reason: string | null;
  balance: number | null;
  allowance: number | null;
  lastCheckedAt: number | null;
  signerAddress?: string | null;
  funderAddress?: string | null;
  signatureType?: number | null;
  collateralBalanceRaw?: number | null;
  collateralBalanceNormalized?: number | null;
  collateralAllowanceRaw?: number | null;
  collateralAllowanceNormalized?: number | null;
  clobCredentialsSource?: "configured" | "derived" | "created" | null;
  clobCredentialsDerived?: boolean | null;
  clobBalanceSynced?: boolean | null;
  requiredCollateral?: number | null;
  geoblockBlocked?: boolean | null;
  geoblockCountry?: string | null;
  geoblockRegion?: string | null;
  geoblockCheckedAt?: number | null;
}

export interface LiveExecutionLastAttempt {
  executionGroupId: string;
  action: SignalAction;
  partialFill: boolean;
  failureReason: string | null;
  liveLockReason?: string | null;
  kalshiStatus: string | null;
  polymarketStatus: string | null;
  completedAt: number;
}

export interface LiveExecutionLock {
  id: number;
  createdAt: string;
  reason: string;
  severity: "warn" | "critical";
  sourceSignalId: number | null;
  executionGroupId: string | null;
  details: Record<string, unknown>;
  clearedAt: string | null;
  clearReason: string | null;
}

export interface LiveExecutionReadiness {
  mode: "dry_run" | "live";
  liveTrading: boolean;
  protectedOnly: boolean;
  orderSize: number;
  orderType: string;
  maxSlippageCents: number;
  minExpiryMs: number;
  maxTradesPerWindow: number;
  collateralBufferDollars: number;
  quoteMaxAgeMs: number;
  quoteSyncMaxSkewMs: number;
  minBookDepthShares: number;
  edgeBufferDollars: number;
  entryLatencyEdgeBufferDollars?: number;
  hedgeMaxLossDollars?: number;
  hedgeFeeBufferDollars?: number;
  parallelExecutionEnabled?: boolean;
  orderTimeoutMs: number;
  kalshiOrderGroupEnabled: boolean;
  userStreams: UserStreamReadiness;
  reconciliation: ReconciliationReadiness;
  partialFillLocked: boolean;
  circuitBreakerLocked: boolean;
  circuitBreakerReason: string | null;
  circuitBreaker: LiveExecutionLock | null;
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

export interface DashboardDataSlice {
  recentSignals: DashboardSignal[];
  analytics?: DashboardAnalytics;
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
    liveMaxTradesPerWindow: number;
    liveQuoteMaxAgeMs: number;
    liveQuoteSyncMaxSkewMs: number;
    liveMinBookDepthShares: number;
    liveEdgeBufferDollars: number;
    liveEntryLatencyEdgeBufferDollars: number;
    liveOrderTimeoutMs: number;
    liveHedgeMaxLossDollars: number;
    liveHedgeFeeBufferDollars: number;
    liveParallelExecutionEnabled: boolean;
    liveUserStreamsEnabled: boolean;
    liveUserStreamPretradeGraceMs: number;
    liveUserStreamConfirmTimeoutMs: number;
    liveReconcileBeforeTrade: boolean;
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
  live: DashboardDataSlice;
  paper: DashboardDataSlice;
  recentSignals: DashboardSignal[];
  analytics?: DashboardAnalytics;
  execution?: LiveExecutionReadiness;
  logs: DashboardLogEntry[];
}
