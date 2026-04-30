import type { ArbCandidate, BinaryContract } from "../types";
import { deadZoneCandidate, guaranteedSpreadCandidate } from "./payoff";

function sameContractWindow(left: BinaryContract, right: BinaryContract): boolean {
  return left.asset === "BTC" && right.asset === "BTC" && left.expiryMs === right.expiryMs;
}

function orderByStrike(left: BinaryContract, right: BinaryContract): [BinaryContract, BinaryContract] {
  if (left.strike < right.strike) return [left, right];
  if (right.strike < left.strike) return [right, left];
  return left.venue <= right.venue ? [left, right] : [right, left];
}

export function enumerateCandidates(
  polymarketContracts: BinaryContract[],
  kalshiContracts: BinaryContract[],
  threshold: number,
): { executable: ArbCandidate[]; rejected: ArbCandidate[] } {
  const executable: ArbCandidate[] = [];
  const rejected: ArbCandidate[] = [];

  for (const polymarket of polymarketContracts) {
    for (const kalshi of kalshiContracts) {
      if (!sameContractWindow(polymarket, kalshi)) continue;
      const [lower, higher] = orderByStrike(polymarket, kalshi);
      const guaranteed = guaranteedSpreadCandidate(lower, higher, threshold);
      if (guaranteed?.executable) executable.push(guaranteed);
      else if (guaranteed) rejected.push(guaranteed);
      const flipped = deadZoneCandidate(lower, higher, threshold);
      if (flipped) rejected.push(flipped);
    }
  }

  return { executable, rejected };
}

export function pairExecutableCandidates(
  polymarketContracts: BinaryContract[],
  kalshiContracts: BinaryContract[],
  threshold: number,
): ArbCandidate[] {
  return enumerateCandidates(polymarketContracts, kalshiContracts, threshold).executable;
}

export function enumerateExecutableCandidates(input: {
  polymarket: BinaryContract[];
  kalshi: BinaryContract[];
  threshold: number;
}): ArbCandidate[] {
  return pairExecutableCandidates(input.polymarket, input.kalshi, input.threshold);
}
