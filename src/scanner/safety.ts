import type { ArbCandidate } from "../types";

export function protectedCandidateBlockReason(candidate: ArbCandidate, minProfitDollars: number): string | null {
  if (candidate.risk?.structureType !== "long_up_below_down_above") return "non_protected_structure";
  if (candidate.lower.direction !== "yes") return "lower_leg_not_yes";
  if (candidate.higher.direction !== "no") return "higher_leg_not_no";
  if (!(candidate.lower.strike < candidate.higher.strike)) return "lower_strike_not_below_higher";
  if (!candidate.executable) return "candidate_not_executable";
  if (candidate.guaranteedProfit < minProfitDollars) return "guaranteed_profit_below_threshold";
  return null;
}

export function isProtectedExecutableCandidate(candidate: ArbCandidate, minProfitDollars: number): boolean {
  return protectedCandidateBlockReason(candidate, minProfitDollars) == null;
}
