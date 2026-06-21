import type { BinaryContract, QuoteSnapshot } from "../types";
import type { KalshiTickerSnapshot } from "../kalshi/client";
import type { TokenBookSnapshot } from "../polymarket/client";
import { RollingBookHistory, type LeadLagHistory } from "../signals/lead-lag";

export class BookStore {
  private readonly kalshi = new Map<string, BinaryContract>();
  private readonly polymarket = new Map<string, BinaryContract>();
  private readonly polyTokenToContract = new Map<string, { contractId: string; side: "yes" | "no" }>();
  private readonly history: RollingBookHistory;

  constructor(requiredHistoryDepth = 5, private readonly freshnessFromWsOnly = false) {
    this.history = new RollingBookHistory(requiredHistoryDepth);
  }

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
    const updated = {
      ...contract,
      yesAsk: snapshot.yesAsk,
      noAsk: snapshot.noAsk,
      yesBid: snapshot.yesBid,
      noBid: snapshot.noBid,
      yesAskLevels: snapshot.yesAskLevels,
      noAskLevels: snapshot.noAskLevels,
      yesBidLevels: snapshot.yesBidLevels,
      noBidLevels: snapshot.noBidLevels,
      sequence: snapshot.sequence,
      bookHash: snapshot.bookHash,
      tickSize: snapshot.tickSize,
      tickSizeChangedAt: snapshot.tickSizeChangedAt,
      updatedAt: snapshot.timestamp,
    };
    this.kalshi.set(snapshot.marketTicker, updated);
    this.history.record(updated, "yes", snapshot.timestamp);
    this.history.record(updated, "no", snapshot.timestamp);
  }

  applyPolymarketSnapshot(snapshot: TokenBookSnapshot): void {
    const mapping = this.polyTokenToContract.get(snapshot.tokenId);
    if (!mapping) return;
    const contract = this.polymarket.get(mapping.contractId);
    if (!contract) return;
    const updated = {
      ...contract,
      yesAsk: mapping.side === "yes" ? snapshot.bestAsk : contract.yesAsk,
      noAsk: mapping.side === "no" ? snapshot.bestAsk : contract.noAsk,
      yesBid: mapping.side === "yes" ? snapshot.bestBid : contract.yesBid,
      noBid: mapping.side === "no" ? snapshot.bestBid : contract.noBid,
      yesAskLevels: mapping.side === "yes" ? snapshot.askLevels : contract.yesAskLevels,
      noAskLevels: mapping.side === "no" ? snapshot.askLevels : contract.noAskLevels,
      yesBidLevels: mapping.side === "yes" ? snapshot.bidLevels : contract.yesBidLevels,
      noBidLevels: mapping.side === "no" ? snapshot.bidLevels : contract.noBidLevels,
      bookHash: snapshot.hash ?? contract.bookHash,
      tickSize: snapshot.tickSize ?? contract.tickSize,
      tickSizeChangedAt: snapshot.tickSizeChangedAt ?? contract.tickSizeChangedAt,
      updatedAt: snapshot.timestamp,
    };
    this.polymarket.set(mapping.contractId, updated);
    this.history.record(updated, mapping.side, snapshot.timestamp);
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

  getPolymarketConditionIds(): string[] {
    return [...this.polymarket.keys()];
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

  leadLagHistoryForQuoteSnapshot(snapshot: QuoteSnapshot, nowMs: number, lookbackMs: number): LeadLagHistory {
    return {
      kalshi: snapshot.kalshi
        ? this.history.get("kalshi", snapshot.kalshi.contractId, snapshot.kalshi.direction, nowMs, lookbackMs)
        : [],
      polymarket: snapshot.polymarket
        ? this.history.get("polymarket", snapshot.polymarket.contractId, snapshot.polymarket.direction, nowMs, lookbackMs)
        : [],
    };
  }

  private keepQuotes(existing: BinaryContract | undefined, incoming: BinaryContract): Partial<BinaryContract> {
    if (!existing) return {};
    return {
      yesAsk: incoming.yesAsk ?? existing.yesAsk,
      noAsk: incoming.noAsk ?? existing.noAsk,
      yesBid: incoming.yesBid ?? existing.yesBid,
      noBid: incoming.noBid ?? existing.noBid,
      yesAskLevels: incoming.yesAskLevels ?? existing.yesAskLevels,
      noAskLevels: incoming.noAskLevels ?? existing.noAskLevels,
      yesBidLevels: incoming.yesBidLevels ?? existing.yesBidLevels,
      noBidLevels: incoming.noBidLevels ?? existing.noBidLevels,
      sequence: incoming.sequence ?? existing.sequence,
      bookHash: incoming.bookHash ?? existing.bookHash,
      tickSize: incoming.tickSize ?? existing.tickSize,
      tickSizeChangedAt: incoming.tickSizeChangedAt ?? existing.tickSizeChangedAt,
      // H2: keepQuotes is the DISCOVERY merge path (WS snapshots set updatedAt directly, bypassing this). When
      // freshnessFromWsOnly is on, a periodic discovery refresh must NOT advance updatedAt — otherwise it
      // resets the freshness clock on a contract whose WS feed has gone silent, letting a dead/stale book pass
      // the 750ms quote-freshness gate for up to that window. Only a real WS snapshot then advances freshness.
      // Default off = Math.max (byte-identical).
      updatedAt: this.freshnessFromWsOnly ? existing.updatedAt : Math.max(incoming.updatedAt, existing.updatedAt),
    };
  }
}
