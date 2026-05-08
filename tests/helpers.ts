import type { BinaryContract } from "../src/types";

export function contract(input: Partial<BinaryContract> & { venue: "kalshi" | "polymarket"; contractId: string; strike: number; expiryMs?: number }): BinaryContract {
  const yesAsk = input.yesAsk === undefined ? 0.4 : input.yesAsk;
  const noAsk = input.noAsk === undefined ? 0.5 : input.noAsk;
  const yesBid = input.yesBid ?? null;
  const noBid = input.noBid ?? null;
  return {
    venue: input.venue,
    contractId: input.contractId,
    asset: "BTC",
    expiryMs: input.expiryMs ?? 1_800_000_000_000,
    strike: input.strike,
    yesAsk,
    noAsk,
    yesBid,
    noBid,
    yesAskLevels: input.yesAskLevels ?? (yesAsk == null ? [] : [{ price: yesAsk, size: 999 }]),
    noAskLevels: input.noAskLevels ?? (noAsk == null ? [] : [{ price: noAsk, size: 999 }]),
    yesBidLevels: input.yesBidLevels ?? (yesBid == null ? [] : [{ price: yesBid, size: 999 }]),
    noBidLevels: input.noBidLevels ?? (noBid == null ? [] : [{ price: noBid, size: 999 }]),
    sequence: input.sequence ?? null,
    bookHash: input.bookHash ?? null,
    tickSize: input.tickSize ?? null,
    tickSizeChangedAt: input.tickSizeChangedAt ?? null,
    yesTokenId: input.yesTokenId ?? null,
    noTokenId: input.noTokenId ?? null,
    updatedAt: input.updatedAt ?? Date.now(),
  };
}
