import type { TradingHistoryRow, TradingOpenOrder, TradingPortfolioSummary, TradingPosition } from "../../types/trading";
import { fetchTradingActivity } from "./worker-api";

async function kalshiActivity() {
  return fetchTradingActivity("kalshi");
}

export async function getPortfolio(): Promise<TradingPortfolioSummary> {
  return (await kalshiActivity()).portfolio;
}

export async function getPositions(): Promise<TradingPosition[]> {
  return (await kalshiActivity()).positions;
}

export async function getOpenOrders(): Promise<TradingOpenOrder[]> {
  return (await kalshiActivity()).openOrders;
}

export async function getHistory(): Promise<TradingHistoryRow[]> {
  return (await kalshiActivity()).history;
}
