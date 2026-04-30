import type { ArbCandidate, ArbLeg, BinaryContract } from "../types";

export function roundDollars(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function binaryLegPayoff(direction: "yes" | "no", strike: number, settlementPrice: number): number {
  if (direction === "yes") return settlementPrice >= strike ? 1 : 0;
  return settlementPrice < strike ? 1 : 0;
}

export function spreadPayoff(lower: ArbLeg, higher: ArbLeg, settlementPrice: number): number {
  return binaryLegPayoff(lower.direction, lower.strike, settlementPrice) + binaryLegPayoff(higher.direction, higher.strike, settlementPrice);
}

export function spreadProfit(lower: ArbLeg, higher: ArbLeg, settlementPrice: number): number {
  return roundDollars(spreadPayoff(lower, higher, settlementPrice) - lower.ask - higher.ask);
}

function leg(contract: BinaryContract, direction: "yes" | "no", ask: number): ArbLeg {
  return {
    venue: contract.venue,
    contractId: contract.contractId,
    direction,
    strike: contract.strike,
    ask,
    tokenId: direction === "yes" ? contract.yesTokenId : contract.noTokenId,
  };
}

function pairKey(lower: ArbLeg, higher: ArbLeg, expiryMs: number): string {
  return [
    expiryMs,
    lower.venue,
    lower.contractId,
    lower.direction,
    higher.venue,
    higher.contractId,
    higher.direction,
  ].join(":");
}

function candidateFromLegs(
  lower: ArbLeg,
  higher: ArbLeg,
  expiryMs: number,
  threshold: number,
  guaranteedProfit: number,
  overlapProfit: number,
  executable: boolean,
  reason: string | null,
): ArbCandidate {
  const premium = roundDollars(lower.ask + higher.ask);
  return {
    pairKey: pairKey(lower, higher, expiryMs),
    expiryMs,
    lower,
    higher,
    kalshiContractId: lower.venue === "kalshi" ? lower.contractId : higher.contractId,
    polymarketContractId: lower.venue === "polymarket" ? lower.contractId : higher.contractId,
    premium,
    guaranteedProfit: roundDollars(guaranteedProfit),
    overlapProfit: roundDollars(overlapProfit),
    threshold,
    executable,
    reason,
  };
}

export function guaranteedSpreadCandidate(lowerContract: BinaryContract, higherContract: BinaryContract, threshold: number): ArbCandidate | null {
  if (lowerContract.yesAsk == null || higherContract.noAsk == null) return null;
  const lower = leg(lowerContract, "yes", lowerContract.yesAsk);
  const higher = leg(higherContract, "no", higherContract.noAsk);
  const premium = roundDollars(lower.ask + higher.ask);
  const guaranteedProfit = roundDollars(1 - premium);
  return candidateFromLegs(
    lower,
    higher,
    lowerContract.expiryMs,
    threshold,
    guaranteedProfit,
    2 - premium,
    guaranteedProfit >= threshold,
    guaranteedProfit >= threshold ? null : "below_threshold",
  );
}

export function deadZoneCandidate(lowerContract: BinaryContract, higherContract: BinaryContract, threshold: number): ArbCandidate | null {
  if (lowerContract.noAsk == null || higherContract.yesAsk == null) return null;
  return candidateFromLegs(
    leg(lowerContract, "no", lowerContract.noAsk),
    leg(higherContract, "yes", higherContract.yesAsk),
    lowerContract.expiryMs,
    threshold,
    -roundDollars(lowerContract.noAsk + higherContract.yesAsk),
    -roundDollars(lowerContract.noAsk + higherContract.yesAsk),
    false,
    "dead_zone_configuration",
  );
}

export const buildGuaranteedCandidate = guaranteedSpreadCandidate;
export const buildDeadZoneCandidate = deadZoneCandidate;
