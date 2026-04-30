import test from "node:test";
import assert from "node:assert/strict";
import type { PolymarketPriceBeatRecord, PolymarketPriceBeatRepository } from "../src/db/polymarket-price-beats";
import {
  buildPolymarketPriceSubscriptionMessage,
  parsePolymarketChainlinkTicks,
  PolymarketPriceToBeatService,
} from "../src/polymarket/price-to-beat";

class MemoryPriceBeatStore implements PolymarketPriceBeatRepository {
  readonly records = new Map<string, PolymarketPriceBeatRecord>();

  async upsert(record: PolymarketPriceBeatRecord): Promise<void> {
    this.records.set(record.marketSlug, record);
  }

  async getBySlug(marketSlug: string): Promise<PolymarketPriceBeatRecord | null> {
    return this.records.get(marketSlug) ?? null;
  }

  async getBySlugs(marketSlugs: string[]): Promise<Map<string, PolymarketPriceBeatRecord>> {
    return new Map(marketSlugs.flatMap((slug) => {
      const record = this.records.get(slug);
      return record ? [[slug, record] as const] : [];
    }));
  }
}

test("Polymarket live price subscription message targets Chainlink BTC/USD updates", () => {
  assert.deepEqual(buildPolymarketPriceSubscriptionMessage("btc/usd"), {
    action: "subscribe",
    subscriptions: [{
      topic: "crypto_prices_chainlink",
      type: "update",
      filters: "{\"symbol\":\"btc/usd\"}",
    }],
  });
});

test("Polymarket Chainlink parser handles initial history and update payloads", () => {
  const history = parsePolymarketChainlinkTicks({
    payload: {
      data: [
        { symbol: "btc/usd", timestamp: 1_800_000_000_000, value: 76000.25 },
        { symbol: "btc/usd", timestamp: 1_800_000_001_000, full_accuracy_value: "76001.50" },
      ],
    },
  }, 1_800_000_002_000);
  assert.equal(history.length, 2);
  assert.equal(history[0].value, 76000.25);
  assert.equal(history[1].value, 76001.5);

  const [update] = parsePolymarketChainlinkTicks({
    topic: "crypto_prices_chainlink",
    type: "update",
    payload: {
      full_accuracy_value: "76355.13184162127",
      symbol: "btc/usd",
      timestamp: 1_800_000_015_000,
      value: 76355.13184162127,
    },
  }, 1_800_000_015_500);
  assert.equal(update.symbol, "btc/usd");
  assert.equal(update.timestampMs, 1_800_000_015_000);
  assert.equal(update.value, 76355.13184162127);
});

test("price-to-beat service captures opening and within-tolerance ticks only", async () => {
  const eventStartMs = 1_800_000_000_000;
  const expiryMs = eventStartMs + 15 * 60_000;
  const store = new MemoryPriceBeatStore();
  const service = new PolymarketPriceToBeatService({
    url: "ws://unused",
    symbol: "btc/usd",
    toleranceMs: 5_000,
    store,
  });

  service.setCaptureWindows([
    { marketSlug: "btc-updown-15m-1800000000", conditionId: "condition-a", eventStartMs, expiryMs },
    { marketSlug: "btc-updown-15m-1800000900", conditionId: "condition-b", eventStartMs: eventStartMs + 15 * 60_000, expiryMs: expiryMs + 15 * 60_000 },
    { marketSlug: "btc-updown-15m-1800001800", conditionId: "condition-c", eventStartMs: eventStartMs + 30 * 60_000, expiryMs: expiryMs + 30 * 60_000 },
  ], eventStartMs - 1_000);

  await service.handleTicksForTest([{ symbol: "btc/usd", value: 76000, timestampMs: eventStartMs, receivedAtMs: eventStartMs }]);
  assert.equal(store.records.get("btc-updown-15m-1800000000")?.priceToBeat, 76000);

  await service.handleTicksForTest([{ symbol: "btc/usd", value: 76001, timestampMs: eventStartMs + 6_000, receivedAtMs: eventStartMs + 6_000 }]);
  assert.equal(store.records.get("btc-updown-15m-1800000900"), undefined);

  await service.handleTicksForTest([{
    symbol: "btc/usd",
    value: 76100,
    timestampMs: eventStartMs + 15 * 60_000 + 5_000,
    receivedAtMs: eventStartMs + 15 * 60_000 + 5_000,
  }]);
  assert.equal(store.records.get("btc-updown-15m-1800000900")?.priceToBeat, 76100);

  await service.handleTicksForTest([{
    symbol: "btc/usd",
    value: 76200,
    timestampMs: eventStartMs + 30 * 60_000 + 6_000,
    receivedAtMs: eventStartMs + 30 * 60_000 + 6_000,
  }]);
  assert.equal(store.records.get("btc-updown-15m-1800001800"), undefined);
});
