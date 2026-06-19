import type { TradingActivitySnapshot, VenuePnlSnapshot, EquityCurveSnapshot } from "../types/trading";

export type Venue = "kalshi" | "polymarket";
export type LegDirection = "yes" | "no";
export type SignalAction = "filled" | "skipped" | "failed";
export type LiveOrderPlacementMode = "parallel_market" | "parallel_quick" | "parallel_fok" | "parallel_fak" | "parallel_limit_rest" | "polymarket_first_exact" | "kalshi_first_exact";
export type LiveKalshiHedgeOrderMode = "public_v2" | "ui_quick_order" | "fix_ioc";
export type LiveKalshiHedgeTimeInForce = "immediate_or_cancel" | "fill_or_kill";
export type LiveKalshiPrearmPricePolicy = "patch_after_fill";
export type LivePartialFillLockMode = "lock" | "quarantine";
export type LiveRecoveryStatus =
  | "none"
  | "pretrade_retry"
  | "finalizing"
  | "auto_resolved_no_exposure"
  | "auto_resolved_paired_fill"
  | "risk_quarantined"
  | "operator_required";
export type LiveRiskState = "trading" | "recovering" | "blocked" | "hard_locked" | "quarantined" | "auto_hardlocks_disabled";

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
  maxBuyPrice: number | null;
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
  // Anti-dust guard diagnostics (T2.5). Present only when LIVE_MIN_EXECUTABLE_LIQUIDITY_SHARES /
  // LIVE_MAX_EXECUTABLE_ASK_SLIPPAGE_CENTS are enabled; omitted (undefined) on the default-off path so
  // the serialized snapshot is byte-identical to today.
  executableLiquidityShares?: number | null;
  executableAskSlippageCents?: number | null;
}

// Shadow ladder capture (T2.4): read-only diagnostics persisted on below-threshold-edge skips when
// LIVE_SHADOW_LADDER_CAPTURE_ENABLED=true, to classify phantom dust vs shallow-real depth.
export interface ShadowLadderProbe {
  size: number;
  vwap: number | null;
  worstAsk: number | null;
  depth: number;
  sufficientDepth: boolean;
  levelsConsumed: BookLevel[];
}

export interface ShadowLadderLeg {
  venue: Venue;
  contractId: string;
  direction: LegDirection;
  topAsk: number | null;
  probes: ShadowLadderProbe[];
}

export interface ShadowLadderCapture {
  capturedAt: number;
  probeSizes: number[];
  minProfitDollars: number;
  topOfBookEdge: number | null;
  // Executable edge (1 - kalshiVwap(size) - polymarketVwap(size)) per probe size; null when either leg
  // lacks sufficient depth at that size.
  executableEdgeBySize: { size: number; executableEdge: number | null }[];
  kalshi: ShadowLadderLeg | null;
  polymarket: ShadowLadderLeg | null;
}

export interface QuoteSnapshot {
  capturedAt: number;
  quoteSkewMs: number | null;
  kalshi: QuoteSnapshotLeg | null;
  polymarket: QuoteSnapshotLeg | null;
  leadLagSnapshot?: LeadLagSnapshot | null;
  projectedPremium: number | null;
  projectedEdge: number | null;
  projectedPremiumAtLimit?: number | null;
  projectedEdgeAtLimit?: number | null;
  projectedEdgeAfterFees: number | null;
  takerPriceCushionCents?: number | null;
  // Expected Kalshi taker fee per share subtracted from the edge when the fee-aware gate is on
  // (undefined/null when off). Observability for calibration; not read by the trading path.
  expectedKalshiFeePerShare?: number | null;
  kalshiMaxBuyPrice?: number | null;
  polymarketMaxBuyPrice?: number | null;
  minProfitDollars: number;
  failureReason: string | null;
  shadowLadder?: ShadowLadderCapture | null;
}

export type LeadLagVenue = Venue | "none";

export interface LeadLagWindowSnapshot {
  windowMs: number;
  kalshiMove: number | null;
  polymarketMove: number | null;
  kalshiUpdateCount: number;
  polymarketUpdateCount: number;
  kalshiLiquidity: number | null;
  polymarketLiquidity: number | null;
  kalshiOfi: number | null;
  polymarketOfi: number | null;
  firstKalshiMoveAtMs: number | null;
  firstPolymarketMoveAtMs: number | null;
  leaderVenue: LeadLagVenue;
}

export interface LeadLagSnapshot {
  version: string;
  scoredAt: number;
  shadowMode: boolean;
  gateEnabled: boolean;
  gatePassed: boolean;
  blockReason: string | null;
  leaderVenue: LeadLagVenue;
  laggingVenue: Venue | null;
  lagMsEstimate: number | null;
  confidence: number;
  stalenessScore: number;
  adverseSelectionScore: number;
  cheapLegVenue: Venue | null;
  cheapLegIsLagging: boolean | null;
  windows: LeadLagWindowSnapshot[];
  reasons: string[];
}

export interface ExecutionTimings {
  candidateToSubmitMs?: number | null;
  hotGateMs?: number | null;
  preSubmitDbMs?: number | null;
  kalshiPrearmMs?: number | null;
  kalshiPrearmAgeMs?: number | null;
  kalshiPricePatchMs?: number | null;
  polyExactToKalshiSubmitMs?: number | null;
  polymarketExactEvidenceSource?: string | null;
  polymarketExactEvidenceAtMs?: number | null;
  polyHedgeTriggerToKalshiSubmitMs?: number | null;
  polymarketHedgeTriggerSource?: string | null;
  polymarketHedgeTriggerAtMs?: number | null;
  polymarketHedgeTriggerFillCount?: number | null;
  polymarketHedgeTriggerMinFillShares?: number | null;
  polymarketHedgeTriggerMaxFillShares?: number | null;
  polymarketHedgeTriggerExact?: boolean | null;
  polymarketSignMs?: number | null;
  polymarketPostOrderMs?: number | null;
  polymarketConfirmationMs?: number | null;
  kalshiRttMs?: number | null;
  polymarketRttMs?: number | null;
  preflightMs?: number | null;
  kalshiOrderRttMs?: number | null;
  postFillHedgeDecisionMs?: number | null;
  polymarketOrderRttMs?: number | null;
  venueSubmitSkewMs?: number | null;
  parallelDispatchAtMs?: number | null;
  parallelDispatchCallSkewMs?: number | null;
  parallelSettledAtMs?: number | null;
  totalMs?: number | null;
  firstVenue?: Venue | null;
  firstVenueReason?: string | null;
  firstVenueVwap?: number | null;
}

export interface VenueConfirmations {
  kalshi?: Record<string, unknown> | null;
  polymarket?: Record<string, unknown> | null;
}

export interface ReconciliationResolution {
  resolvedBy?: string | null;
  resolutionType?: "manual_recovery" | "settlement_reconciliation" | "operator_override" | string;
  executionGroupId?: string | null;
  polymarketOrderId?: string | null;
  kalshiClientOrderId?: string | null;
  evidence?: Record<string, unknown> | null;
  notes?: string | null;
}

export type ExecutionStrategy = "sequential_hedge" | "parallel_canary" | "parallel_market" | "parallel_quick" | "parallel_fok" | "parallel_fak" | "parallel_limit_rest" | "polymarket_first_exact" | "kalshi_first_exact";

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
  quarantinedExposureDollars?: number | null;
  quarantinedSignalCount?: number | null;
  quarantineCapDollars?: number | null;
}

export interface LiveExecutionQualityStatus {
  enabled: boolean;
  ok: boolean;
  reason: string | null;
  sampleCount: number;
  lookbackMs: number;
  sampleLimit: number;
  minSamples: number;
  minExactFillRate: number;
  exactPairFillRate: number | null;
  polymarketTimeoutRate: number | null;
  mismatchRate: number | null;
  avgPolymarketRttMs: number | null;
  avgMismatchCostDollars: number | null;
  estimatedExecutableEdge: number | null;
}

export interface FillQualityFeatures {
  sampleCount: number;
  minSamples: number;
  coldStart: boolean;
  orderSize: number;
  placementMode: LiveOrderPlacementMode;
  kalshiDepth: number | null;
  polymarketDepth: number | null;
  kalshiEffectiveDepth?: number | null;
  polymarketEffectiveDepth?: number | null;
  kalshiDepthRatio: number | null;
  polymarketDepthRatio: number | null;
  kalshiSpread: number | null;
  polymarketSpread: number | null;
  kalshiQuoteAgeMs: number | null;
  polymarketQuoteAgeMs: number | null;
  quoteSkewMs: number | null;
  secondsToExpiry: number | null;
  sameExpiryAttemptCount: number;
  recentExactPairFillRate: number | null;
  recentMismatchRate: number | null;
  recentTimeoutRate: number | null;
  kalshiRecentExactFillRate: number | null;
  polymarketRecentExactFillRate: number | null;
  kalshiRecentRejectRate?: number | null;
  polymarketRecentInRangeFillRate?: number | null;
  kalshiRttP50Ms: number | null;
  kalshiRttP95Ms: number | null;
  polymarketRttP50Ms: number | null;
  polymarketRttP95Ms: number | null;
  kalshiConfirmationP95Ms: number | null;
  polymarketConfirmationP95Ms: number | null;
  polymarketSignedOrderReuseRate: number | null;
  polymarketSignedOrderFallbackRate: number | null;
  recentVenueEventCount: number;
  leadLagLeaderVenue?: LeadLagVenue | null;
  leadLagConfidence?: number | null;
  leadLagStalenessScore?: number | null;
  leadLagAdverseSelectionScore?: number | null;
  leadLagCheapLegIsLagging?: boolean | null;
}

export interface PairedFillConfidenceSnapshot {
  projectedEdgeAtLimit: number | null;
  expectedExecutableEdge: number | null;
  pairedFillProbability: number;
  kalshiExactFillProbability: number;
  polymarketExactFillProbability: number;
  kalshiDisplayedDepth: number | null;
  polymarketDisplayedDepth: number | null;
  kalshiEffectiveDepth: number | null;
  polymarketEffectiveDepth: number | null;
  kalshiRecentRejectRate: number | null;
  polymarketRecentInRangeFillRate: number | null;
  recentMismatchCostDollars: number | null;
  recentMismatchRate: number | null;
  recentTimeoutRate: number | null;
  reasons: string[];
}

export interface FillQualitySnapshot {
  version: string;
  scoredAt: number;
  shadowMode: boolean;
  gateEnabled: boolean;
  gatePassed: boolean;
  blockReason: string | null;
  projectedEdgeAtLimit: number | null;
  expectedExecutableEdge: number | null;
  minExpectedEdge: number;
  pairedFillProbability: number;
  kalshiExactFillProbability: number;
  polymarketExactFillProbability: number;
  expectedSlippage: number;
  expectedMismatchCost: number;
  timeoutCost: number;
  penaltyReasons: string[];
  pairedFillConfidence?: PairedFillConfidenceSnapshot;
  features: FillQualityFeatures;
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
  leadLagSnapshot?: LeadLagSnapshot | null;
  fillQualitySnapshot?: FillQualitySnapshot | null;
  expectedExecutableEdge?: number | null;
  executionTimings?: ExecutionTimings | null;
  venueConfirmations?: VenueConfirmations | null;
  executionStrategy?: ExecutionStrategy | null;
  riskHedge?: boolean;
  realizedGuaranteedProfit?: number | null;
  hedgeCapPrice?: number | null;
  reconciliationResolvedAt?: string | null;
  reconciliationResolutionReason?: string | null;
  reconciliationResolution?: ReconciliationResolution | null;
  recoveryStatus?: LiveRecoveryStatus | null;
  recoveryAttempts?: number | null;
  recoveryEvidence?: Record<string, unknown> | null;
  finalizationMs?: number | null;
  riskQuarantinedAt?: string | null;
  riskQuarantineReason?: string | null;
  riskQuarantineExposureDollars?: number | null;
  riskQuarantineEvidence?: Record<string, unknown> | null;
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
  quoteSnapshot?: QuoteSnapshot | null;
  depthVwap?: number | null;
  projectedEdgeAfterFees?: number | null;
  leadLagSnapshot?: LeadLagSnapshot | null;
  fillQualitySnapshot?: FillQualitySnapshot | null;
  expectedExecutableEdge?: number | null;
  executionTimings?: ExecutionTimings | null;
  venueConfirmations?: VenueConfirmations | null;
  executionStrategy?: ExecutionStrategy | null;
  riskHedge?: boolean;
  realizedGuaranteedProfit?: number | null;
  hedgeCapPrice?: number | null;
  reconciliationResolvedAt?: string | null;
  reconciliationResolutionReason?: string | null;
  reconciliationResolution?: ReconciliationResolution | null;
  recoveryStatus?: LiveRecoveryStatus | null;
  recoveryAttempts?: number | null;
  recoveryEvidence?: Record<string, unknown> | null;
  finalizationMs?: number | null;
  riskQuarantinedAt?: string | null;
  riskQuarantineReason?: string | null;
  riskQuarantineExposureDollars?: number | null;
  riskQuarantineEvidence?: Record<string, unknown> | null;
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
  quoteSnapshot?: QuoteSnapshot | null;
  depthVwap?: number | null;
  projectedEdgeAfterFees?: number | null;
  leadLagSnapshot?: LeadLagSnapshot | null;
  fillQualitySnapshot?: FillQualitySnapshot | null;
  expectedExecutableEdge?: number | null;
  executionTimings?: ExecutionTimings | null;
  venueConfirmations?: VenueConfirmations | null;
  executionStrategy?: ExecutionStrategy | null;
  riskHedge?: boolean;
  realizedGuaranteedProfit?: number | null;
  hedgeCapPrice?: number | null;
  reconciliationResolvedAt?: string | null;
  reconciliationResolutionReason?: string | null;
  reconciliationResolution?: ReconciliationResolution | null;
  recoveryStatus?: LiveRecoveryStatus | null;
  recoveryAttempts?: number | null;
  recoveryEvidence?: Record<string, unknown> | null;
  finalizationMs?: number | null;
  riskQuarantinedAt?: string | null;
  riskQuarantineReason?: string | null;
  riskQuarantineExposureDollars?: number | null;
  riskQuarantineEvidence?: Record<string, unknown> | null;
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
  kalshiBalanceField?: string | null;
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
  recoveryStatus?: LiveRecoveryStatus | null;
  recoveryAttempts?: number | null;
  finalizationMs?: number | null;
  riskQuarantinedAt?: string | null;
  riskQuarantineExposureDollars?: number | null;
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
  mode: "live";
  liveTrading: boolean;
  protectedOnly: boolean;
  orderSize: number;
  orderType: string;
  takerPriceCushionCents?: number;
  minExpiryMs: number;
  maxTradesPerWindow: number;
  collateralBufferDollars: number;
  quoteMaxAgeMs: number;
  quoteSyncMaxSkewMs: number;
  minBookDepthShares: number;
  hedgeMaxLossDollars?: number;
  hedgeFeeBufferDollars?: number;
  orderPlacementMode?: LiveOrderPlacementMode;
  aggressiveLimitRestMs?: number;
  parallelExecutionEnabled?: boolean;
  hotPathEnabled?: boolean;
  hotPathCacheMaxAgeMs?: number;
  polymarketPresignEnabled?: boolean;
  polymarketFirstMinFillShares?: number;
  polymarketFirstMaxFillShares?: number;
  kalshiHedgeTimeInForce?: LiveKalshiHedgeTimeInForce;
  kalshiPrearmEnabled?: boolean;
  kalshiPrearmMaxAgeMs?: number;
  kalshiPrearmPricePolicy?: LiveKalshiPrearmPricePolicy;
  partialFillLockMode?: LivePartialFillLockMode;
  autoHardlocksEnabled?: boolean;
  maxUnresolvedExposureDollars?: number;
  exactExposureRequired?: boolean;
  executionQualityGateEnabled?: boolean;
  executionQuality?: LiveExecutionQualityStatus;
  orderTimeoutMs: number;
  kalshiOrderGroupEnabled: boolean;
  userStreams: UserStreamReadiness;
  reconciliation: ReconciliationReadiness;
  riskState: LiveRiskState;
  riskStateReason: string | null;
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
    bookUpdateToDecisionMs: DashboardLatencyStats;
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
    preSubmitDbMs: DashboardLatencyStats;
  };
  execution: {
    durationMs: DashboardLatencyStats;
    hotGateMs: DashboardLatencyStats;
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
    scanHeartbeatMs: number;
    staleBookMs: number;
    liveMaxTradesPerWindow: number;
    liveOrderSize: number;
    liveTakerPriceCushionCents?: number;
    liveKalshiMinCashDollars: number;
    liveQuoteMaxAgeMs: number;
    liveQuoteSyncMaxSkewMs: number;
    liveMinBookDepthShares: number;
    liveOrderTimeoutMs: number;
    liveHedgeMaxLossDollars: number;
    liveHedgeFeeBufferDollars: number;
    liveHedgeMinCrossTicks: number;
    liveOrderPlacementMode?: LiveOrderPlacementMode;
    kalshiHedgeOrderMode?: LiveKalshiHedgeOrderMode;
    kalshiUiQuickOrderCapValidated?: boolean;
    kalshiFixHost?: string;
    kalshiFixPort?: number;
    kalshiFixTargetCompId?: string;
    kalshiFixUseDollars?: boolean;
    liveAggressiveLimitRestMs?: number;
    liveParallelExecutionEnabled: boolean;
    liveHotPathEnabled: boolean;
    liveHotPathCacheMaxAgeMs: number;
    liveHotPathWarmIntervalMs: number;
    livePolymarketPresignEnabled: boolean;
    livePolymarketSignedOrderTtlMs: number;
    livePolymarketFirstMinFillShares?: number;
    livePolymarketFirstMaxFillShares?: number;
    liveKalshiHedgeTimeInForce: LiveKalshiHedgeTimeInForce;
    liveKalshiPrearmEnabled: boolean;
    liveKalshiPrearmMaxAgeMs: number;
    liveKalshiPrearmPricePolicy: LiveKalshiPrearmPricePolicy;
    liveLowLatencyHttpEnabled: boolean;
    liveUserStreamsEnabled: boolean;
    liveUserStreamPretradeGraceMs: number;
    liveUserStreamConfirmTimeoutMs: number;
    livePretradeRetryAttempts: number;
    livePretradeRetryDelayMs: number;
    liveFinalRecoveryTimeoutMs: number;
    liveFinalRecoveryPollMs: number;
    liveAutoResolveVerifiedIncidents: boolean;
    liveAutoHardlocksEnabled: boolean;
    liveExactExposureRequired: boolean;
    liveExecutionQualityGateEnabled: boolean;
    liveExecutionQualityLookbackMs: number;
    liveExecutionQualitySampleLimit: number;
    liveExecutionQualityMinSamples: number;
    liveExecutionQualityMinExactFillRate: number;
    liveFillQualityScoringEnabled: boolean;
    liveFillQualityGateEnabled: boolean;
    liveFillQualityMinExpectedEdge: number;
    liveFillQualityLookbackMs: number;
    liveFillQualitySampleLimit: number;
    liveFillQualityMinSamples: number;
    liveFillQualityModelVersion: string;
    liveLeadLagScoringEnabled: boolean;
    liveLeadLagGateEnabled: boolean;
    liveLeadLagModelVersion: string;
    liveLeadLagWindowsMs: number[];
    liveLeadLagMinConfidence: number;
    liveLeadLagMaxAdverseSelectionScore: number;
    livePartialFillLockMode: LivePartialFillLockMode;
    liveMaxUnresolvedExposureDollars: number;
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
    lastScanAgeMs?: number | null;
    lastCandidateCount: number;
    queuedExecutions?: number;
    activeExecutions?: number;
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
  tradingActivity: TradingActivitySnapshot;
  /** Venue-sourced realized take-home P&L (net of fees) + open exposure, BTC-15m arb only. */
  venuePnl?: VenuePnlSnapshot;
  /** Persistent unified combined-portfolio equity curve (cash + MTM, both venues) over time. */
  equityCurve?: EquityCurveSnapshot;
  execution?: LiveExecutionReadiness;
  logs: DashboardLogEntry[];
}
