import type { BinaryContract } from "../src/types";

export function contract(input: Partial<BinaryContract> & { venue: "kalshi" | "polymarket"; contractId: string; strike: number; expiryMs?: number }): BinaryContract {
  return {
    venue: input.venue,
    contractId: input.contractId,
    asset: "BTC",
    expiryMs: input.expiryMs ?? 1_800_000_000_000,
    strike: input.strike,
    yesAsk: input.yesAsk ?? 0.4,
    noAsk: input.noAsk ?? 0.5,
    yesBid: input.yesBid ?? null,
    noBid: input.noBid ?? null,
    yesTokenId: input.yesTokenId ?? null,
    noTokenId: input.noTokenId ?? null,
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

