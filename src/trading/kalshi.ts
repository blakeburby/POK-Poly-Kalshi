import type { TradingHistoryRow, TradingOpenOrder, TradingPortfolioSummary, TradingPosition } from "../../types/trading";
import type { TradingActivityOptions, TradingActivityStore } from "./activity";

async function kalshiActivity(store: TradingActivityStore, options?: TradingActivityOptions) {
  return store.getPlatformActivity("kalshi", options);
}

export async function getPortfolio(store: TradingActivityStore, options?: TradingActivityOptions): Promise<TradingPortfolioSummary> {
  return (await kalshiActivity(store, options)).portfolio;
}

export async function getPositions(store: TradingActivityStore, options?: TradingActivityOptions): Promise<TradingPosition[]> {
  return (await kalshiActivity(store, options)).positions;
}

export async function getOpenOrders(store: TradingActivityStore, options?: TradingActivityOptions): Promise<TradingOpenOrder[]> {
  return (await kalshiActivity(store, options)).openOrders;
}

export async function getHistory(store: TradingActivityStore, options?: TradingActivityOptions): Promise<TradingHistoryRow[]> {
  return (await kalshiActivity(store, options)).history;
}
