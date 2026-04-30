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
}

export interface ExecutionResult {
  action: SignalAction;
  failureReason: string | null;
  kalshiFillId: string | null;
  polymarketFillId: string | null;
  kalshiFillPrice: number | null;
  polymarketFillPrice: number | null;
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
}

export interface DashboardLogEntry {
  timestamp: string;
  severity: "DEBUG" | "INFO" | "WARN" | "ERROR";
  category: string;
  message: string;
  context?: Record<string, unknown>;
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
  recentSignals: DashboardSignal[];
  logs: DashboardLogEntry[];
}
