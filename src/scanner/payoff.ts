import type {
  ArbCandidate,
  ArbLeg,
  BinaryContract,
  PayoffRegionKey,
  SyntheticPayoffRegion,
  SyntheticStructureRisk,
  SyntheticStructureType,
} from "../types";

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

function roundPercent(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function percentOf(value: number, base: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(base) || Math.abs(base) < 0.000_001) return 0;
  return roundPercent((value / base) * 100);
}

function regionSettlementPrice(region: PayoffRegionKey, lowerStrike: number, higherStrike: number): number {
  if (region === "below_lower") return lowerStrike - Math.max(1, higherStrike - lowerStrike || 1);
  if (region === "between_strikes") return (lowerStrike + higherStrike) / 2;
  return higherStrike;
}

function regionLabel(region: PayoffRegionKey, lowerStrike: number, higherStrike: number): string {
  if (region === "below_lower") return `< ${lowerStrike}`;
  if (region === "between_strikes") return `${lowerStrike} - ${higherStrike}`;
  return `>= ${higherStrike}`;
}

function payoffRegion(
  region: PayoffRegionKey,
  lower: ArbLeg,
  higher: ArbLeg,
  premium: number,
): SyntheticPayoffRegion {
  const lowerStrike = Math.min(lower.strike, higher.strike);
  const higherStrike = Math.max(lower.strike, higher.strike);
  const settlementPrice = regionSettlementPrice(region, lowerStrike, higherStrike);
  const payoff = spreadPayoff(lower, higher, settlementPrice);
  const width = region === "between_strikes" ? roundDollars(higherStrike - lowerStrike) : null;
  return {
    region,
    label: regionLabel(region, lowerStrike, higherStrike),
    fromStrike: region === "above_higher" ? higherStrike : region === "between_strikes" ? lowerStrike : null,
    toStrike: region === "below_lower" ? lowerStrike : region === "between_strikes" ? higherStrike : null,
    width,
    payoff,
    profit: roundDollars(payoff - premium),
    isMaxLoss: false,
  };
}

export function syntheticStructureTypeForLegs(lower: ArbLeg, higher: ArbLeg): SyntheticStructureType {
  if (lower.direction === "yes" && higher.direction === "no") return "long_up_below_down_above";
  return "long_up_above_down_below";
}

export function buildSyntheticStructureRisk(
  lower: ArbLeg,
  higher: ArbLeg,
  threshold: number,
  structureType = syntheticStructureTypeForLegs(lower, higher),
): SyntheticStructureRisk {
  const premium = roundDollars(lower.ask + higher.ask);
  const lowerStrike = Math.min(lower.strike, higher.strike);
  const higherStrike = Math.max(lower.strike, higher.strike);
  const strikeGap = roundDollars(higherStrike - lowerStrike);
  const midStrike = roundDollars((higherStrike + lowerStrike) / 2);
  const payoffProfile = (["below_lower", "between_strikes", "above_higher"] as const).map((region) => payoffRegion(region, lower, higher, premium));
  const worstCaseProfit = roundDollars(Math.min(...payoffProfile.map((region) => region.profit)));
  const bestCaseProfit = roundDollars(Math.max(...payoffProfile.map((region) => region.profit)));
  const maxLossRegion = payoffProfile.find((region) => region.width != null && region.width > 0 && region.profit === worstCaseProfit && region.profit < 0) ?? null;

  for (const region of payoffProfile) {
    region.isMaxLoss = Boolean(maxLossRegion && region.region === maxLossRegion.region);
  }

  const lossWindowWidth = maxLossRegion?.width ?? 0;
  const overlapWindowWidth = structureType === "long_up_below_down_above" ? strikeGap : 0;
  const classification = maxLossRegion
    ? "probabilistic_bet"
    : worstCaseProfit >= threshold
      ? "true_arbitrage"
      : "guaranteed_below_threshold";

  return {
    structureType,
    classification,
    strikeGap,
    midStrike,
    strikeGapPctOfMid: percentOf(strikeGap, midStrike),
    lossWindowWidth,
    lossWindowPctOfStrikeGap: percentOf(lossWindowWidth, strikeGap),
    lossWindowPctOfMid: percentOf(lossWindowWidth, midStrike),
    overlapWindowWidth,
    overlapWindowPctOfStrikeGap: percentOf(overlapWindowWidth, strikeGap),
    premium,
    worstCaseProfit,
    bestCaseProfit,
    guaranteedEdge: maxLossRegion ? null : worstCaseProfit,
    conditionalEdge: bestCaseProfit,
    maxLossRegion,
    payoffProfile,
  };
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
  structureType: SyntheticStructureType,
): ArbCandidate {
  const premium = roundDollars(lower.ask + higher.ask);
  const risk = buildSyntheticStructureRisk(lower, higher, threshold, structureType);
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
    risk,
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
    "long_up_below_down_above",
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
    "long_up_above_down_below",
  );
}

export const buildGuaranteedCandidate = guaranteedSpreadCandidate;
export const buildDeadZoneCandidate = deadZoneCandidate;
