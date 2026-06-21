import type { Queryable } from "../db/signals";
import type { VenueOrderEventInput } from "../db/venue-order-events";
import type { LiveExecutionReadiness, Venue } from "../types";
import type { AppConfig } from "../config";
import { accountBackedPlatformActivity } from "./account-sources";
import { defaultPolymarketClientFactory, type PolymarketClobLike } from "../execution/live-clients";
import type {
  TradingActivityEvent,
  TradingActivitySide,
  TradingActivitySnapshot,
  TradingHistoryRow,
  TradingOpenOrder,
  TradingPlatform,
  TradingPlatformActivity,
  TradingPortfolioSummary,
  TradingPosition,
  TradingSparklinePoint,
} from "../../types/trading";

interface VenueOrderEventRow {
  id: string | number;
  created_at: string | Date;
  execution_group_id: string | null;
  venue: Venue;
  client_order_id: string | null;
  venue_order_id: string | null;
  event_type: string | null;
  asset_id: string | null;
  market_id: string | null;
  side: string | null;
  status: string;
  fill_count: string | number | null;
  remaining_count: string | number | null;
  fill_price: string | number | null;
  fee: string | number | null;
  exchange_ts: string | Date | null;
  received_at: string | Date | null;
  raw: Record<string, unknown> | string | null;
}

export interface TradingActivityOptions {
  now?: number;
  readiness?: LiveExecutionReadiness | null;
  limit?: number;
}

const OPEN_STATUSES = new Set(["accepted", "delayed", "live", "open", "placed", "resting", "unfilled", "working"]);
const FILLED_STATUSES = new Set(["fill", "filled", "matched", "trade"]);
const ACCOUNT_HISTORY_WINDOW_MS = 24 * 60 * 60_000;
// Carry a venue's last-known account value forward across a SHORT outage only. Past this bound, stop
// carrying it (return null -> the venue surfaces as genuinely "unavailable") so a multi-hour venue outage
// can never bake a frozen, healthy-looking value into the equity curve.
const CARRY_FORWARD_MAX_AGE_MS = 10 * 60_000;
// Per-venue account-activity result cache. The account fetch is several upstream calls (data-api + CLOB);
// the dashboard polls per-platform activity (~10s) AND the snapshot, so an UNCACHED getPlatformActivity
// turns every poll into a fresh multi-call fetch — which, when those calls are slow, floods the worker and
// starves the event loop. Serving a recent (≤ this) cached result keeps the dashboard read path cheap and
// bounds upstream account calls to ~1 per venue per window regardless of poll/client count.
const ACCOUNT_ACTIVITY_CACHE_MS = 20_000;

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toMs(value: string | Date | null | undefined): number | null {
  if (value == null) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function roundCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeAccountValuePoints(points: TradingSparklinePoint[], now: number): TradingSparklinePoint[] {
  const since = now - ACCOUNT_HISTORY_WINDOW_MS;
  const bounded = points
    .filter((point) => point.timestamp >= since && point.timestamp <= now && isFiniteNumber(point.value))
    .sort((left, right) => left.timestamp - right.timestamp);
  const hasRealAccountValue = bounded.some((point) => Math.abs(point.value) > 0.000001);
  const withoutPlaceholders = hasRealAccountValue
    ? bounded.filter((point) => Math.abs(point.value) > 0.000001)
    : bounded;

  const deduped = new Map<number, TradingSparklinePoint>();
  for (const point of withoutPlaceholders) {
    deduped.set(point.timestamp, { timestamp: point.timestamp, value: roundCurrency(point.value) });
  }
  return [...deduped.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function shouldSeedAccountHistory(activity: TradingPlatformActivity): boolean {
  return isFiniteNumber(activity.portfolio.dayChangeDollars) && Math.abs(activity.portfolio.dayChangeDollars) > 0.000001;
}

function portfolioWithAccountValueChange(
  portfolio: TradingPortfolioSummary,
  points: TradingSparklinePoint[],
): TradingPortfolioSummary {
  const latestValue = isFiniteNumber(portfolio.portfolioValue)
    ? portfolio.portfolioValue
    : points.at(-1)?.value ?? null;
  if (!isFiniteNumber(latestValue)) return portfolio;

  const baseline = points[0]?.value ?? latestValue;
  const dayChangeDollars = roundCurrency(latestValue - baseline);
  const dayChangePercent = Math.abs(baseline) > 0.000001 ? dayChangeDollars / Math.abs(baseline) : 0;
  return {
    ...portfolio,
    dayChangeDollars,
    dayChangePercent,
  };
}

function normalizePlatform(value: Venue): TradingPlatform {
  return value === "kalshi" ? "kalshi" : "polymarket";
}

function normalizeSide(value: string | null | undefined): TradingActivitySide {
  return value?.toLowerCase().includes("sell") ? "Sell" : "Buy";
}

function statusKey(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasFill(status: string | null | undefined, fillCount: number | null): boolean {
  if (fillCount != null && fillCount > 0) return true;
  return FILLED_STATUSES.has(statusKey(status));
}

function marketNameFromEvent(event: Pick<VenueOrderEventRow, "market_id" | "asset_id" | "venue_order_id" | "client_order_id">): string {
  return event.market_id
    ?? event.asset_id
    ?? event.venue_order_id
    ?? event.client_order_id
    ?? "Live market";
}

function outcomeFromEvent(side: string | null | undefined, assetId?: string | null): string {
  if (side && side.trim()) return side.trim().toUpperCase();
  if (assetId && assetId.trim()) return assetId.trim();
  return "OUTCOME";
}

function eventTimestamp(event: VenueOrderEventRow): number {
  return toMs(event.exchange_ts) ?? toMs(event.received_at) ?? toMs(event.created_at) ?? Date.now();
}

function historyRowFromDbEvent(event: VenueOrderEventRow): TradingHistoryRow | null {
  const fillCount = toNumber(event.fill_count);
  const fillPrice = toNumber(event.fill_price);
  if (!hasFill(event.event_type ?? event.status, fillCount)) return null;
  const shares = fillCount ?? 0;
  if (shares <= 0) return null;
  const activity = normalizeSide(event.side);
  const grossValue = fillPrice == null ? null : roundCurrency(shares * fillPrice);
  const signedValue = grossValue == null ? null : activity === "Buy" ? -grossValue : grossValue;
  return {
    id: String(event.id),
    activity,
    marketName: marketNameFromEvent(event),
    outcome: outcomeFromEvent(event.side, event.asset_id),
    shares,
    value: signedValue,
    timeMs: eventTimestamp(event),
    venueOrderId: event.venue_order_id,
    clientOrderId: event.client_order_id,
    status: event.status,
  };
}

function openOrderFromDbEvent(event: VenueOrderEventRow): TradingOpenOrder | null {
  if (!OPEN_STATUSES.has(statusKey(event.status))) return null;
  const remaining = toNumber(event.remaining_count);
  const shares = remaining == null || remaining <= 0 ? toNumber(event.fill_count) ?? 0 : remaining;
  if (shares <= 0) return null;
  const price = toNumber(event.fill_price);
  return {
    id: event.venue_order_id ?? event.client_order_id ?? String(event.id),
    market: marketNameFromEvent(event),
    outcome: outcomeFromEvent(event.side, event.asset_id),
    side: normalizeSide(event.side),
    shares,
    price,
    value: price == null ? null : roundCurrency(shares * price),
    status: event.status,
    updatedAt: eventTimestamp(event),
  };
}

function buildPositions(history: TradingHistoryRow[]): TradingPosition[] {
  const byMarket = new Map<string, { position: TradingPosition; grossCost: number; boughtShares: number }>();
  for (const row of history) {
    const key = `${row.marketName}:${row.outcome}`;
    const current = byMarket.get(key) ?? {
      position: {
        id: key,
        market: row.marketName,
        outcome: row.outcome,
        shares: 0,
        value: null,
        averagePrice: null,
        updatedAt: row.timeMs,
      },
      grossCost: 0,
      boughtShares: 0,
    };
    const signedShares = row.activity === "Buy" ? row.shares : -row.shares;
    current.position.shares += signedShares;
    current.position.updatedAt = Math.max(current.position.updatedAt ?? 0, row.timeMs);
    if (row.activity === "Buy" && row.value != null) {
      current.grossCost += Math.abs(row.value);
      current.boughtShares += row.shares;
    }
    current.position.averagePrice = current.boughtShares > 0 ? current.grossCost / current.boughtShares : null;
    current.position.value = current.position.averagePrice == null ? null : current.position.shares * current.position.averagePrice;
    byMarket.set(key, current);
  }
  return [...byMarket.values()]
    .map((entry) => entry.position)
    .filter((position) => Math.abs(position.shares) > 0.000001)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

function buildSparkline(history: TradingHistoryRow[], cashValue: number | null, now: number): TradingSparklinePoint[] {
  const since = now - 24 * 60 * 60_000;
  const recent = history
    .filter((row) => row.timeMs >= since && row.value != null)
    .sort((left, right) => left.timeMs - right.timeMs);
  let running = cashValue ?? 0;
  const points: TradingSparklinePoint[] = [{ timestamp: since, value: running }];
  for (const row of recent) {
    running += row.value ?? 0;
    points.push({ timestamp: row.timeMs, value: running });
  }
  points.push({ timestamp: now, value: running });
  return points;
}

function portfolioFromReadiness(platform: TradingPlatform, readiness: LiveExecutionReadiness | null | undefined, positions: TradingPosition[], history: TradingHistoryRow[], now: number): TradingPortfolioSummary {
  const venueReadiness = platform === "kalshi" ? readiness?.kalshi : readiness?.polymarket;
  const cashValue = venueReadiness?.collateralBalanceNormalized ?? venueReadiness?.balance ?? null;
  const positionValue = positions.reduce((total, position) => total + (position.value ?? 0), 0);
  const portfolioValue = cashValue == null ? (positionValue > 0 ? positionValue : null) : cashValue + positionValue;
  const dayChangeDollars = history
    .filter((row) => row.timeMs >= now - 24 * 60 * 60_000)
    .reduce((total, row) => total + (row.value ?? 0), 0);
  const basis = portfolioValue == null || Math.abs(portfolioValue - dayChangeDollars) < 0.000001
    ? null
    : portfolioValue - dayChangeDollars;
  return {
    platform,
    portfolioValue,
    cashValue,
    dayChangeDollars,
    dayChangePercent: basis == null ? null : dayChangeDollars / Math.abs(basis),
    lastUpdatedAt: venueReadiness?.lastCheckedAt ?? (history[0]?.timeMs ?? null),
  };
}

export function emptyTradingPlatformActivity(platform: TradingPlatform, now = Date.now()): TradingPlatformActivity {
  return {
    platform,
    connectionStatus: "live",
    lastUpdatedAt: now,
    portfolio: {
      platform,
      portfolioValue: null,
      cashValue: null,
      dayChangeDollars: 0,
      dayChangePercent: null,
      lastUpdatedAt: now,
    },
    positions: [],
    openOrders: [],
    history: [],
    sparkline: [
      { timestamp: now - 24 * 60 * 60_000, value: 0 },
      { timestamp: now, value: 0 },
    ],
  };
}

export function emptyTradingActivity(now = Date.now()): TradingActivitySnapshot {
  return {
    kalshi: emptyTradingPlatformActivity("kalshi", now),
    polymarket: emptyTradingPlatformActivity("polymarket", now),
  };
}

export class TradingActivityStore {
  private polymarketClientPromise: Promise<PolymarketClobLike> | null = null;
  private readonly accountValueHistory: Record<TradingPlatform, TradingSparklinePoint[]> = {
    kalshi: [],
    polymarket: [],
  };
  // "Latest available" per-venue account value, carried forward when a live fetch is unavailable so the
  // combined total stays Kalshi + Polymarket (and the equity curve does not collapse to one venue).
  private readonly lastKnownAccountValue: Record<TradingPlatform, { portfolioValue: number; cashValue: number | null; positions: TradingPosition[]; at: number } | null> = {
    kalshi: null,
    polymarket: null,
  };
  // Recent computed activity per venue, to keep the dashboard read path off the multi-call account fetch.
  private readonly activityCache: Record<TradingPlatform, { at: number; value: TradingPlatformActivity } | null> = {
    kalshi: null,
    polymarket: null,
  };

  constructor(
    private readonly db: Queryable,
    private readonly config?: AppConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async getPlatformActivity(platform: TradingPlatform, options: TradingActivityOptions = {}): Promise<TradingPlatformActivity> {
    const now = options.now ?? Date.now();
    // Cache only the account-backed (config) path — that is the one doing the expensive multi-call upstream
    // fetch that needs to stay off the dashboard poll hot path. The db-only/readiness path is cheap and
    // deterministic (and unit tests depend on it recomputing per call).
    const cached = this.activityCache[platform];
    if (this.config && cached && now - cached.at < ACCOUNT_ACTIVITY_CACHE_MS) return cached.value;
    const limit = options.limit ?? 250;
    const result = await this.db.query<VenueOrderEventRow>(`
      SELECT
        id, created_at, execution_group_id, venue, client_order_id, venue_order_id,
        event_type, asset_id, market_id, side, status,
        fill_count, remaining_count, fill_price, fee, exchange_ts, received_at
      FROM venue_order_events
      WHERE venue = $1
      ORDER BY COALESCE(exchange_ts, received_at, created_at) DESC, id DESC
      LIMIT $2
    `, [platform, limit]);
    const history = result.rows
      .map(historyRowFromDbEvent)
      .filter((row): row is TradingHistoryRow => row != null)
      .slice(0, 100);
    const openOrders = dedupeOpenOrders(result.rows.map(openOrderFromDbEvent).filter((order): order is TradingOpenOrder => order != null));
    const positions = buildPositions(history);
    const portfolio = portfolioFromReadiness(platform, options.readiness, positions, history, now);
    const fallback: TradingPlatformActivity = {
      platform,
      connectionStatus: "live",
      lastUpdatedAt: portfolio.lastUpdatedAt ?? history[0]?.timeMs ?? now,
      portfolio,
      positions: positions.slice(0, 50),
      openOrders: openOrders.slice(0, 50),
      history,
      sparkline: buildSparkline(history, portfolio.cashValue, now),
    };
    const activity = this.config
      ? await accountBackedPlatformActivity(platform, fallback, {
          config: this.config,
          readiness: options.readiness,
          history,
          now,
          fetchFn: this.fetchFn,
          getPolymarketClient: () => this.getPolymarketClient(),
        })
      : fallback;
    const carried = this.applyLastKnownAccountValue(activity, now);
    const finalActivity = this.withAccountValueHistory(carried, now);
    if (this.config) this.activityCache[platform] = { at: now, value: finalActivity };
    return finalActivity;
  }

  /**
   * "Latest available" carry-forward. When a venue's live account fetch is unavailable (portfolioValue
   * null), serve the last-known good value marked stale instead of dropping the venue to null — so the
   * combined total stays Kalshi + Polymarket and the equity curve does not collapse to one account. A
   * venue that has NEVER reported stays null (genuinely missing), which the UI surfaces explicitly.
   */
  private applyLastKnownAccountValue(activity: TradingPlatformActivity, now: number): TradingPlatformActivity {
    if (isFiniteNumber(activity.portfolio.portfolioValue)) {
      this.lastKnownAccountValue[activity.platform] = {
        portfolioValue: activity.portfolio.portfolioValue,
        cashValue: activity.portfolio.cashValue,
        positions: activity.positions,
        at: now,
      };
      return activity;
    }
    const last = this.lastKnownAccountValue[activity.platform];
    if (!last || now - last.at > CARRY_FORWARD_MAX_AGE_MS) return activity;
    return {
      ...activity,
      connectionStatus: "reconnecting",
      positions: activity.positions.length > 0 ? activity.positions : last.positions,
      portfolio: {
        ...activity.portfolio,
        portfolioValue: last.portfolioValue,
        cashValue: last.cashValue,
        dayChangeDollars: null,
        dayChangePercent: null,
        stale: true,
        valueAsOfMs: last.at,
      },
    };
  }

  async getSnapshot(options: TradingActivityOptions = {}): Promise<TradingActivitySnapshot> {
    const [kalshi, polymarket] = await Promise.all([
      this.getPlatformActivity("kalshi", options),
      this.getPlatformActivity("polymarket", options),
    ]);
    return { kalshi, polymarket };
  }

  private getPolymarketClient(): Promise<PolymarketClobLike> {
    if (!this.config) throw new Error("Polymarket account client requires worker config");
    if (!this.polymarketClientPromise) {
      this.polymarketClientPromise = defaultPolymarketClientFactory(this.config).then((bundle) => "client" in bundle ? bundle.client : bundle);
    }
    return this.polymarketClientPromise;
  }

  private withAccountValueHistory(activity: TradingPlatformActivity, now: number): TradingPlatformActivity {
    const existing = this.accountValueHistory[activity.platform];
    const seedPoints = this.config && shouldSeedAccountHistory(activity) ? activity.sparkline : [];
    const merged = [...existing, ...seedPoints];
    if (isFiniteNumber(activity.portfolio.portfolioValue)) {
      merged.push({ timestamp: now, value: roundCurrency(activity.portfolio.portfolioValue) });
    }

    const sparkline = sanitizeAccountValuePoints(merged, now);
    this.accountValueHistory[activity.platform] = sparkline;

    return {
      ...activity,
      portfolio: portfolioWithAccountValueChange(activity.portfolio, sparkline),
      sparkline: sparkline.length > 0 ? sparkline : activity.sparkline,
    };
  }
}

function dedupeOpenOrders(orders: TradingOpenOrder[]): TradingOpenOrder[] {
  const byId = new Map<string, TradingOpenOrder>();
  for (const order of orders) {
    const current = byId.get(order.id);
    if (!current || (order.updatedAt ?? 0) > (current.updatedAt ?? 0)) byId.set(order.id, order);
  }
  return [...byId.values()].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

export function tradingActivityEventFromVenueEvent(event: VenueOrderEventInput, now = Date.now()): TradingActivityEvent {
  const platform = normalizePlatform(event.venue);
  const shares = event.fillCount ?? 0;
  const price = event.fillPrice ?? null;
  const activity = normalizeSide(event.side);
  const hasHistory = hasFill(event.eventType ?? event.status, shares);
  const timeMs = event.exchangeTimestampMs ?? event.receivedAtMs ?? now;
  const row: TradingHistoryRow | null = hasHistory && shares > 0
    ? {
        id: event.venueOrderId ?? event.clientOrderId ?? `${platform}-${timeMs}`,
        activity,
        marketName: event.marketId ?? event.assetId ?? event.venueOrderId ?? event.clientOrderId ?? "Live market",
        outcome: outcomeFromEvent(event.side, event.assetId),
        shares,
    value: price == null ? null : activity === "Buy" ? -roundCurrency(shares * price) : roundCurrency(shares * price),
        timeMs,
        venueOrderId: event.venueOrderId ?? null,
        clientOrderId: event.clientOrderId ?? null,
        status: event.status,
      }
    : null;
  return {
    platform,
    receivedAt: now,
    row,
    portfolioDelta: row?.value ?? null,
    cashDelta: row?.value ?? null,
    status: event.status ?? null,
    venueOrderId: event.venueOrderId ?? null,
    clientOrderId: event.clientOrderId ?? null,
  };
}
