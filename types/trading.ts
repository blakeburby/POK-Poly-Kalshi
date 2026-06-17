export type TradingPlatform = "kalshi" | "polymarket";

export type TradingConnectionState = "live" | "reconnecting";

export type TradingActivitySide = "Buy" | "Sell";

export interface TradingPortfolioSummary {
  platform: TradingPlatform;
  portfolioValue: number | null;
  cashValue: number | null;
  dayChangeDollars: number | null;
  dayChangePercent: number | null;
  lastUpdatedAt: number | null;
}

export interface TradingPosition {
  id: string;
  market: string;
  outcome: string;
  shares: number;
  value: number | null;
  averagePrice: number | null;
  updatedAt: number | null;
}

export interface TradingOpenOrder {
  id: string;
  market: string;
  outcome: string;
  side: TradingActivitySide;
  shares: number;
  price: number | null;
  value: number | null;
  status: string;
  updatedAt: number | null;
}

export interface TradingHistoryRow {
  id: string;
  activity: TradingActivitySide;
  marketName: string;
  outcome: string;
  shares: number;
  value: number | null;
  timeMs: number;
  venueOrderId: string | null;
  clientOrderId: string | null;
  status: string | null;
}

export interface TradingSparklinePoint {
  timestamp: number;
  value: number;
}

export interface TradingPlatformActivity {
  platform: TradingPlatform;
  connectionStatus: TradingConnectionState;
  lastUpdatedAt: number | null;
  portfolio: TradingPortfolioSummary;
  positions: TradingPosition[];
  openOrders: TradingOpenOrder[];
  history: TradingHistoryRow[];
  sparkline: TradingSparklinePoint[];
}

export interface TradingActivitySnapshot {
  kalshi: TradingPlatformActivity;
  polymarket: TradingPlatformActivity;
}

/** Venue-sourced realized take-home P&L (net of fees) + open exposure, per leg.
 *  Computed directly from Kalshi settlements/positions and Polymarket positions —
 *  the authoritative source — NOT from the bot's internal signal estimates. */
export interface VenuePnlLeg {
  platform: TradingPlatform;
  connectionStatus: TradingConnectionState;
  /** Realized cash from settled arb markets, net of fees. */
  realizedTakeHome: number;
  feesPaid: number;
  grossRevenue: number;
  cost: number;
  /** Currently-open arb positions marked to current venue value. */
  openExposure: number;
  settledCount: number;
  openCount: number;
  /** Polymarket positions that resolved but haven't been redeemed to cash (0 for Kalshi). */
  unredeemedCount: number;
  lastUpdatedAt: number | null;
}

export interface VenuePnlSnapshot {
  generatedAt: number;
  /** Human label for which trades are counted, e.g. "BTC 15-minute arb". */
  scope: string;
  kalshi: VenuePnlLeg;
  polymarket: VenuePnlLeg;
  combinedRealizedTakeHome: number;
  combinedOpenExposure: number;
  combinedFeesPaid: number;
  note: string;
}

export interface TradingActivityEvent {
  platform: TradingPlatform;
  receivedAt: number;
  row: TradingHistoryRow | null;
  portfolioDelta: number | null;
  cashDelta: number | null;
  status: string | null;
  venueOrderId: string | null;
  clientOrderId: string | null;
}
