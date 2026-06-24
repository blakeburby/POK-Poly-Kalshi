import type {
  TradingHistoryRow,
  TradingOpenOrder,
  TradingPortfolioSummary,
  TradingPosition,
} from "../../types/trading";
import type { TradingActivityOptions, TradingActivityStore } from "./activity";

async function polymarketActivity(store: TradingActivityStore, options?: TradingActivityOptions) {
  return store.getPlatformActivity("polymarket", options);
}

export async function getPortfolio(
  store: TradingActivityStore,
  options?: TradingActivityOptions,
): Promise<TradingPortfolioSummary> {
  return (await polymarketActivity(store, options)).portfolio;
}

export async function getPositions(
  store: TradingActivityStore,
  options?: TradingActivityOptions,
): Promise<TradingPosition[]> {
  return (await polymarketActivity(store, options)).positions;
}

export async function getOpenOrders(
  store: TradingActivityStore,
  options?: TradingActivityOptions,
): Promise<TradingOpenOrder[]> {
  return (await polymarketActivity(store, options)).openOrders;
}

export async function getHistory(
  store: TradingActivityStore,
  options?: TradingActivityOptions,
): Promise<TradingHistoryRow[]> {
  return (await polymarketActivity(store, options)).history;
}
