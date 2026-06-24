import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeHarObject } from "../scripts/sanitize-kalshi-ui-har";

test("Kalshi UI HAR sanitizer keeps Kalshi order evidence and redacts secrets", () => {
  const output = sanitizeHarObject(
    {
      log: {
        entries: [
          {
            request: {
              method: "GET",
              url: "https://example.com/analytics",
              headers: [{ name: "cookie", value: "ignore-me" }],
            },
            response: { status: 200 },
          },
          {
            startedDateTime: "2026-06-10T12:00:00.000Z",
            time: 42,
            request: {
              method: "POST",
              url: "https://api.elections.kalshi.com/trade-api/v2/portfolio/events/orders",
              headers: [
                { name: "KALSHI-ACCESS-KEY", value: "secret-key" },
                { name: "KALSHI-ACCESS-SIGNATURE", value: "secret-signature" },
              ],
              postData: {
                mimeType: "application/json",
                text: JSON.stringify({
                  ticker: "KXBTC-TEST",
                  side: "bid",
                  count: "1.00",
                  price: "0.6100",
                  client_order_id: "client-secret-id",
                  time_in_force: "fill_or_kill",
                }),
              },
            },
            response: {
              status: 201,
              content: {
                mimeType: "application/json",
                text: JSON.stringify({
                  order: {
                    order_id: "order-secret-id",
                    status: "filled",
                    fill_count: "1.00",
                  },
                }),
              },
            },
          },
          {
            request: {
              method: "POST",
              url: "https://kalshi.com/internal/quick-order",
              headers: [
                { name: "cookie", value: "session=secret-session" },
                { name: "x-csrf-token", value: "secret-csrf" },
              ],
              postData: {
                mimeType: "application/json",
                text: JSON.stringify({
                  quick_order: true,
                  target_cost_dollars: "1.00",
                  account_id: "acct-secret",
                }),
              },
            },
            response: {
              status: 200,
              content: {
                mimeType: "application/json",
                text: JSON.stringify({ ok: true, order_id: "private-order-secret" }),
              },
            },
          },
        ],
      },
    },
    "fixture.har",
  );

  const serialized = JSON.stringify(output);
  assert.equal(output.kalshiEntryCount, 2);
  assert.equal(output.summary.ignoredNonKalshiEntries, 1);
  assert.equal(output.decisionHints.documentedV2OrderRequestSeen, true);
  assert.equal(output.decisionHints.quickOrderFieldSeen, true);
  assert.equal(output.decisionHints.dollarSpendFieldSeen, true);
  assert.equal(output.decisionHints.apiKeySignedRequestSeen, true);
  assert.equal(output.decisionHints.sessionCookieRequestSeen, true);
  assert.equal(serialized.includes("secret-key"), false);
  assert.equal(serialized.includes("secret-signature"), false);
  assert.equal(serialized.includes("client-secret-id"), false);
  assert.equal(serialized.includes("order-secret-id"), false);
  assert.equal(serialized.includes("secret-session"), false);
  assert.equal(serialized.includes("secret-csrf"), false);
  assert.equal(serialized.includes("acct-secret"), false);
});
