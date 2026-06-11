# Kalshi UI Quick Order Capture Runbook

This runbook is for one bounded research capture of Kalshi's website/app Quick Order flow. It must not be used to build production private-endpoint replay.

## Guardrails

- Use only your own Kalshi account and a manually controlled browser session.
- Do not automate login, bypass MFA, replay private requests, or persist session secrets.
- Pause the production worker before any live UI submit.
- Use the smallest practical live Quick Order only after a final manual confirmation.
- Export the HAR, sanitize it immediately, and analyze only sanitized output.
- Never commit raw HAR files, cookies, tokens, CSRF values, session headers, account IDs, or order IDs.

## Pause Production Entries

```bash
HOSTINGER_SSH_TARGET=root@187.77.145.117 npm run hostinger:pause-ui-capture
```

The pause guard backs up the VPS env file, sets `ARB_ENABLED=false`, restarts `pok-worker`, verifies public health, checks the protected dashboard snapshot, and checks the production database for active locks, unresolved quarantined exposure, and recent worker-managed open-order candidates.

Do not continue to the browser capture if this command fails.

## Browser Capture Procedure

1. Open a fresh browser profile.
2. Log into Kalshi manually.
3. Open DevTools Network capture.
4. Enable Preserve log and disable cache.
5. Filter visually to Kalshi traffic only when possible.
6. Navigate to a liquid low-risk market and open Quick Order.
7. Enter the smallest practical dollar or contract amount.
8. Record the visible ticker, side, displayed average price, displayed estimated cost, and timestamp.
9. Submit exactly one tiny Quick Order only after final manual confirmation.
10. Stop capture immediately and export the HAR locally.

## Sanitize And Analyze

```bash
npm run kalshi:ui-har:sanitize -- /path/to/kalshi-quick-order.har
```

The sanitizer keeps only Kalshi-domain requests, redacts sensitive headers and identifiers, and writes sanitized JSON plus a Markdown report under `tmp/kalshi-ui-capture/`.

Use the decision hints in the generated report:

- `documentedV2OrderRequestSeen=true`: treat Quick Order as public V2 conversion and implement the supported V2 equivalent.
- `legacyOrderRequestSeen=true`: test only in demo/tiny-live and prefer V2 unless Kalshi confirms legacy behavior.
- `undocumentedOrderLikeRequestSeen=true`: document the shape and ask Kalshi for official support before any production integration.
- `sessionCookieRequestSeen=true` without API-key signatures: do not integrate into the worker.

## Reconcile And Resume

After the tiny UI order, reconcile it through Kalshi's supported public order/fill history before resuming automated entries.

Then restore entries only through the protected Hostinger resume flow:

```bash
HOSTINGER_SSH_TARGET=root@187.77.145.117 npm run hostinger:resume
```

If readiness fails, leave `ARB_ENABLED=false` and inspect the printed readiness summary.
