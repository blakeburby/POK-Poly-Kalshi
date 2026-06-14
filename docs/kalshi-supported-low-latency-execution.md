# Kalshi Supported Low-Latency Execution

## Decision

Use supported Kalshi order-entry surfaces only.

Preferred low-latency mode, once Kalshi enables FIX for the account/API key, is staged behind `KALSHI_HEDGE_ORDER_MODE=fix_ioc`:

- Persistent TLS FIX order-entry session to `mm.fix.elections.kalshi.com:8228`
- `TargetCompID=KalshiNR`
- `OrdType=Limit`
- `TimeInForce=IOC`
- strict capped `Price` on the YES book
- `MaxExecutionCost` capped to `LIVE_ORDER_SIZE * context.maxBuyPrice`
- `CancelOrderOnPause=Y`
- `SelfTradePreventionType=taker_at_cross`
- `UseDollars=Y` fixed-point price format by default
- no automatic retry after ambiguous state

Production-viable fallback mode remains supported public V2 event orders as aggressive marketable IOC orders:

- `POST /trade-api/v2/portfolio/events/orders`
- `side=bid` for YES, `side=ask` for NO-equivalent YES-book execution
- `count=LIVE_ORDER_SIZE`
- `price=context.maxBuyPrice` converted to the YES book price
- `time_in_force=immediate_or_cancel`
- `self_trade_prevention_type=taker_at_cross`
- `cancel_order_on_pause=true`

Both routes are capped marketable limits, not uncapped market orders. They cross available liquidity immediately up to a strict price/cost cap, cancel the unfilled remainder, and keep all fills visible through normal accounting and reconciliation. When FIX access is unavailable, `LIVE_ORDER_PLACEMENT_MODE=parallel_quick` plus `KALSHI_HEDGE_ORDER_MODE=public_v2` is the fastest supported deployable route because it dispatches Kalshi public V2 IOC and Polymarket exact-share FAK concurrently.

## Official Surface Review

- Kalshi Help Center defines Quick Orders as market orders that buy a specified number of contracts immediately at the best available prices and may sweep multiple price levels.
- Public V2 order creation documents a limit-style event-market order with `ticker`, `side`, `count`, `price`, and required `time_in_force`; documented values are `fill_or_kill`, `good_till_canceled`, and `immediate_or_cancel`.
- Public V2 order responses include immediate `fill_count`, `remaining_count`, matching-engine `ts_ms`, optional `average_fill_price`, and optional `average_fee_paid`.
- The legacy `/portfolio/orders` endpoint documents `buy_max_cost`, but says that field automatically gives Fill-or-Kill behavior. That is useful for all-or-nothing cost caps, not for market-like IOC sweeping.
- FIX New Order Single supports only `OrdType=Limit`, but supports `TimeInForce=IOC/FOK` and `MaxExecutionCost`. This is the lowest-latency supported route implemented here because it avoids per-order REST/TLS/signing overhead once the session is warm.
- FIX authentication uses the same RSA key pair as REST; the API Key ID is the FIX `SenderCompID`.
- FIX non-retransmission order entry uses `KalshiNR` and requires `ResetSeqNumFlag=Y` on logon. Only one FIX connection is allowed per API key.
- FIX subpenny/dollar price format is enabled by logon tag `21005=Y`, letting order prices use fixed-point dollars instead of whole-cent integers.
- Kalshi WebSockets provide authenticated orderbook deltas and fill notifications. They are still the right source for quote freshness and post-submit fill verification, not an order submission mechanism.
- Hostinger production FIX staging on June 14, 2026 returned a Kalshi FIX logout reason: `API usage level is not allowed for FIX`. Treat FIX as externally blocked until Kalshi enables that access level.

Sources:

- https://help.kalshi.com/en/articles/13823810-quick-orders
- https://docs.kalshi.com/api-reference/orders/create-order-v2
- https://docs.kalshi.com/api-reference/orders/create-order
- https://docs.kalshi.com/fix/order-entry
- https://docs.kalshi.com/fix/connectivity
- https://docs.kalshi.com/fix/authentication
- https://docs.kalshi.com/fix/subpenny-pricing
- https://docs.kalshi.com/getting_started/quick_start_websockets
- https://docs.kalshi.com/websockets/orderbook-updates

## Why Not Private UI Quick Order Replay

The Hostinger-origin HAR investigation showed the browser could call private UI endpoints, but the same captured CSRF/WAF/user-agent/header set returned `401 token_authentication_failure` from Node on the VPS. That strongly suggests the private UI route is bound to browser/WAF runtime context rather than reusable API-style credentials.

Production should not rely on private UI endpoints or browser automation for autonomous hedging. It is unsupported, hard to audit, brittle under WAF/session changes, and cannot provide the same clean idempotency/recovery model as signed public API or FIX.

## Execution Semantics

`immediate_or_cancel`:

- Best fill probability among supported REST V2 modes.
- Executes immediately against liquidity at or better than the capped limit price.
- Cancels unfilled remainder, preventing resting exposure.
- Can produce partial fills; those remain strict failures for completion-rate accounting and still trigger the existing quarantine/hardlock path when unsafe.
- In FIX mode, partially filled IOC orders request cancel reports with logon tag `21007=Y` so the worker can observe terminal state.

`fill_or_kill`:

- All-or-nothing exact-fill behavior.
- Avoids partial Kalshi hedge fills.
- More likely to reject when displayed depth moves or is not actually available at the matching engine.
- Remains configurable with `LIVE_KALSHI_HEDGE_TIME_IN_FORCE=fill_or_kill` for rollback.

`good_till_canceled`:

- Only retained for the existing `parallel_limit_rest` mode, where the worker intentionally rests briefly and then cancels/final-verifies.

## Latency Recommendations

Current REST path:

- Keep Kalshi pre-arm enabled for `polymarket_first_exact`; it prebuilds and signs the order before Polymarket fill evidence, then patches only price at hedge time.
- Keep user-stream readiness required; the worker already uses stream evidence to trigger Kalshi faster than waiting for slow REST confirmation where possible.
- Keep `LIVE_QUOTE_MAX_AGE_MS=750` and `LIVE_QUOTE_SYNC_MAX_SKEW_MS=250` or tighter only after measured evidence.
- Keep `LIVE_ORDER_TIMEOUT_MS<=2500` with `client_order_id` recovery. Do not blindly retry ambiguous submits.
- Keep `cancel_order_on_pause=true` and order group support enabled where configured.

FIX path:

- Use a persistent FIX order-entry session to avoid per-order HTTP/TLS/signing overhead.
- Submit `OrdType=Limit`, `TimeInForce=IOC`, capped `Price`, and `MaxExecutionCost`.
- Consume FIX execution reports for lower-latency definitive fill state.
- Keep REST/user-stream reconciliation as a backup until FIX telemetry is proven complete.
- Keep `LIVE_KALSHI_HEDGE_TIME_IN_FORCE=immediate_or_cancel`.
- Keep the FIX session warm through hot-path readiness. If logon fails, readiness fails and live resume is blocked.
- If an explicit `LIVE_KALSHI_ORDER_GROUP_ID` is configured, FIX IOC mode fails closed because Kalshi's FIX NewOrderSingle docs do not document attaching an order to an existing group.

## Before And After

Before:

```text
Polymarket exact FAK fill evidence
  -> Kalshi public V2 marketable limit FOK
  -> full fill or no fill
```

After:

```text
Polymarket exact FAK fill evidence
  -> Kalshi public V2 marketable limit IOC
  -> full fill succeeds
  -> partial/no fill remains visible and fail-closed through existing accounting
```

Supported low-latency staged target:

```text
Qualified signal event
  -> refreshed quote/collateral/readiness preflight
  -> parallel dispatch:
       Kalshi FIX marketable limit IOC + MaxExecutionCost
       Polymarket exact-share marketable FAK
  -> both exact fills succeed
  -> any reject/partial/timeout/ambiguous state remains a strict failure
```

Supported deployable fallback while FIX access is blocked:

```text
Qualified signal event
  -> refreshed quote/collateral/readiness preflight
  -> parallel dispatch:
       Kalshi public V2 marketable limit IOC
       Polymarket exact-share marketable FAK
  -> both exact fills succeed
  -> any reject/partial/timeout/ambiguous state remains a strict failure
```

## Operational Setting

```bash
LIVE_ORDER_PLACEMENT_MODE=polymarket_first_exact
KALSHI_HEDGE_ORDER_MODE=public_v2
LIVE_KALSHI_HEDGE_TIME_IN_FORCE=immediate_or_cancel
```

Staged FIX IOC:

```bash
LIVE_ORDER_PLACEMENT_MODE=parallel_quick
KALSHI_HEDGE_ORDER_MODE=fix_ioc
LIVE_KALSHI_HEDGE_TIME_IN_FORCE=immediate_or_cancel
KALSHI_FIX_HOST=mm.fix.elections.kalshi.com
KALSHI_FIX_PORT=8228
KALSHI_FIX_TARGET_COMP_ID=KalshiNR
KALSHI_FIX_USE_DOLLARS=true
```

Hostinger staging:

```bash
HOSTINGER_SSH_TARGET=root@187.77.145.117 npm run hostinger:stage-fix-ioc
```

Staged deployable public V2 parallel quick:

```bash
LIVE_ORDER_PLACEMENT_MODE=parallel_quick
KALSHI_HEDGE_ORDER_MODE=public_v2
LIVE_KALSHI_HEDGE_TIME_IN_FORCE=immediate_or_cancel
```

Hostinger staging:

```bash
HOSTINGER_SSH_TARGET=root@187.77.145.117 npm run hostinger:stage-public-v2-parallel-quick
```

Rollback:

```bash
ARB_ENABLED=false
LIVE_ORDER_PLACEMENT_MODE=polymarket_first_exact
KALSHI_HEDGE_ORDER_MODE=public_v2
LIVE_KALSHI_HEDGE_TIME_IN_FORCE=immediate_or_cancel
```
