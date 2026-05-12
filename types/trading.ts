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
