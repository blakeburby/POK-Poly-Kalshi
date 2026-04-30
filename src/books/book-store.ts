import type { BinaryContract } from "../types";
import type { KalshiTickerSnapshot } from "../kalshi/client";
import type { TokenBookSnapshot } from "../polymarket/client";

export class BookStore {
  private readonly kalshi = new Map<string, BinaryContract>();
  private readonly polymarket = new Map<string, BinaryContract>();
  private readonly polyTokenToContract = new Map<string, { contractId: string; side: "yes" | "no" }>();

  setKalshiContracts(contracts: BinaryContract[]): void {
    const nextIds = new Set(contracts.map((contract) => contract.contractId));
    for (const key of this.kalshi.keys()) {
      if (!nextIds.has(key)) this.kalshi.delete(key);
    }
    for (const contract of contracts) {
      const existing = this.kalshi.get(contract.contractId);
      this.kalshi.set(contract.contractId, { ...contract, ...this.keepQuotes(existing, contract) });
    }
  }

  setPolymarketContracts(contracts: BinaryContract[]): void {
    const nextIds = new Set(contracts.map((contract) => contract.contractId));
    for (const key of this.polymarket.keys()) {
      if (!nextIds.has(key)) this.polymarket.delete(key);
    }
    this.polyTokenToContract.clear();
    for (const contract of contracts) {
      const existing = this.polymarket.get(contract.contractId);
      const stored = { ...contract, ...this.keepQuotes(existing, contract) };
      this.polymarket.set(contract.contractId, stored);
      if (contract.yesTokenId) this.polyTokenToContract.set(contract.yesTokenId, { contractId: contract.contractId, side: "yes" });
      if (contract.noTokenId) this.polyTokenToContract.set(contract.noTokenId, { contractId: contract.contractId, side: "no" });
    }
  }

  applyKalshiSnapshot(snapshot: KalshiTickerSnapshot): void {
    const contract = this.kalshi.get(snapshot.marketTicker);
    if (!contract) return;
    this.kalshi.set(snapshot.marketTicker, {
      ...contract,
      yesAsk: snapshot.yesAsk,
      noAsk: snapshot.noAsk,
      yesBid: snapshot.yesBid,
      noBid: snapshot.noBid,
      updatedAt: snapshot.timestamp,
    });
  }

  applyPolymarketSnapshot(snapshot: TokenBookSnapshot): void {
    const mapping = this.polyTokenToContract.get(snapshot.tokenId);
    if (!mapping) return;
    const contract = this.polymarket.get(mapping.contractId);
    if (!contract) return;
    this.polymarket.set(mapping.contractId, {
      ...contract,
      yesAsk: mapping.side === "yes" ? snapshot.bestAsk : contract.yesAsk,
      noAsk: mapping.side === "no" ? snapshot.bestAsk : contract.noAsk,
      yesBid: mapping.side === "yes" ? snapshot.bestBid : contract.yesBid,
      noBid: mapping.side === "no" ? snapshot.bestBid : contract.noBid,
      updatedAt: snapshot.timestamp,
    });
  }

  getKalshiContracts(staleBookMs: number, now = Date.now()): BinaryContract[] {
    return [...this.kalshi.values()].filter((contract) => now - contract.updatedAt <= staleBookMs);
  }

  getPolymarketContracts(staleBookMs: number, now = Date.now()): BinaryContract[] {
    return [...this.polymarket.values()].filter((contract) => now - contract.updatedAt <= staleBookMs);
  }

  getPolymarketTokenIds(): string[] {
    return [...this.polyTokenToContract.keys()];
  }

  getKalshiTickers(): string[] {
    return [...this.kalshi.keys()];
  }

  snapshot(): { kalshi: BinaryContract[]; polymarket: BinaryContract[] } {
    return {
      kalshi: [...this.kalshi.values()],
      polymarket: [...this.polymarket.values()],
    };
  }

  private keepQuotes(existing: BinaryContract | undefined, incoming: BinaryContract): Partial<BinaryContract> {
    if (!existing) return {};
    return {
      yesAsk: incoming.yesAsk ?? existing.yesAsk,
      noAsk: incoming.noAsk ?? existing.noAsk,
      yesBid: incoming.yesBid ?? existing.yesBid,
      noBid: incoming.noBid ?? existing.noBid,
      updatedAt: Math.max(incoming.updatedAt, existing.updatedAt),
    };
  }
}

