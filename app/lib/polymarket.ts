import type { TradingHistoryRow, TradingOpenOrder, TradingPortfolioSummary, TradingPosition } from "../../types/trading";
import { fetchTradingActivity } from "./worker-api";

async function polymarketActivity() {
  return fetchTradingActivity("polymarket");
}

export async function getPortfolio(): Promise<TradingPortfolioSummary> {
  return (await polymarketActivity()).portfolio;
}

export async function getPositions(): Promise<TradingPosition[]> {
  return (await polymarketActivity()).positions;
}

export async function getOpenOrders(): Promise<TradingOpenOrder[]> {
  return (await polymarketActivity()).openOrders;
}

export async function getHistory(): Promise<TradingHistoryRow[]> {
  return (await polymarketActivity()).history;
}
