import type { ArbCandidate, BinaryContract, DashboardSnapshot } from "../../src/types";

export function sortCandidatesForBlotter(candidates: ArbCandidate[]): ArbCandidate[] {
  return [...candidates].sort((left, right) => right.guaranteedProfit - left.guaranteedProfit || left.expiryMs - right.expiryMs);
}

export function sortContractsForBook(contracts: BinaryContract[]): BinaryContract[] {
  return [...contracts].sort((left, right) => left.expiryMs - right.expiryMs || left.strike - right.strike);
}

export function isContractStale(contract: BinaryContract, snapshot: DashboardSnapshot): boolean {
  return snapshot.generatedAt - contract.updatedAt > snapshot.health.staleBookMs;
}

export function staleContractCount(snapshot: DashboardSnapshot): number {
  return [...snapshot.books.kalshi, ...snapshot.books.polymarket].filter((contract) => isContractStale(contract, snapshot)).length;
}

export function venueStatus(snapshot: DashboardSnapshot, venue: "kalshi" | "polymarket"): "empty" | "stale" | "live" {
  const contracts = snapshot.books[venue];
  if (contracts.length === 0) return "empty";
  return contracts.some((contract) => isContractStale(contract, snapshot)) ? "stale" : "live";
}

export function formatDollars(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function formatCents(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${Math.round(value * 100)}c`;
}

export function formatCountdown(expiryMs: number, now: number): string {
  const remaining = Math.max(0, expiryMs - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
