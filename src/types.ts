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
  liveCandidates: ArbCandidate[];
  recentSignals: DashboardSignal[];
  logs: DashboardLogEntry[];
}
