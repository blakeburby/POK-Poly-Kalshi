# Kalshi UI Quick Order Hedge Mode

This mode routes the Kalshi hedge leg through the private Kalshi website Quick Order shape captured from the UI:

- `POST /v1/users/{user_id}/orders`
- `order_type: "market"`
- `time_in_force: "immediate_or_cancel"`

It is disabled by default. The supported public V2 order route remains the default via `KALSHI_HEDGE_ORDER_MODE=public_v2`.

## Enablement Gates

Set all of the following before the worker can report Kalshi UI Quick Order readiness as green:

```bash
KALSHI_HEDGE_ORDER_MODE=ui_quick_order
KALSHI_UI_SESSION_PATH=/etc/pok-poly-kalshi/kalshi-ui-session.json
KALSHI_UI_QUICK_ORDER_CAP_VALIDATED=true
```

`KALSHI_UI_QUICK_ORDER_CAP_VALIDATED=true` must only be set after a tiny controlled validation proves Kalshi enforces the submitted cap fields (`price_dollars` and/or `max_cost_cents`) in the private UI endpoint. Without that evidence, true market orders are treated as unsafe because they could exceed the hedge cap.

## Session File

The session file must be readable only by the service user, for example:

```bash
install -m 600 -o root -g root /dev/null /etc/pok-poly-kalshi/kalshi-ui-session.json
```

Schema:

```json
{
  "userId": "kalshi-user-id-from-ui-path",
  "cookie": "full Kalshi browser Cookie header",
  "csrfToken": "x-csrf-token value",
  "userAgent": "optional browser user-agent",
  "headers": {
    "Accept-Language": "en-US,en;q=0.9"
  }
}
```

Optional static market-id fallback:

```json
{
  "marketIdByTicker": {
    "KXBTC15M-26JUN140300-00": "private-ui-market-id"
  },
  "allowStaticMarketIdMap": true
}
```

Static mappings should be avoided for rolling 15-minute markets unless a separate operator process keeps them fresh. The worker first tries to verify `market_ticker -> market_id` through the UI event-position endpoint and refuses to submit when it cannot prove a mapping.

## Safety Behavior

- The UI Quick Order client is used only as a Kalshi `VenueOrderClient`; Polymarket-first sequencing, readiness, collateral, stream, reconciliation, lock, exposure, and quote-quality gates stay unchanged.
- The worker submits UI Quick Order only after acceptable Polymarket first-leg fill evidence in `polymarket_first_exact`.
- The submitted body uses the existing hedge `context.size` and `context.maxBuyPrice`; it does not increase size or loosen hedge caps.
- The worker performs one post-order lookup when possible so fees, final status, and fill counts come from the best available UI order record.
- If the realized UI fill price exceeds the hedge cap, the Kalshi result is marked `unknown` with a safety-breach error so the existing lock/quarantine path treats it as unsafe.

## Verification

Before enabling live entries on Hostinger:

```bash
npm run build:worker
node --import tsx --test --test-isolation=none tests/health.test.ts tests/live-execution.test.ts
HOSTINGER_SSH_TARGET=root@187.77.145.117 npm run hostinger:pause-ui-capture
```

Then verify protected readiness and `/health?readiness=1` with `ARB_ENABLED=false`. Only restore entries after the UI Quick Order readiness gate, normal venue readiness, streams, reconciliation, locks, exposure, collateral, and geoblock checks are all green.
