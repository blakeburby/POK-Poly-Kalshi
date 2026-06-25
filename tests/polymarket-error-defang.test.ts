import test from "node:test";
import assert from "node:assert/strict";
import { defangPolymarketAxiosError } from "../src/execution/polymarket-error-defang";

// Build an axios-like error whose response.config transitively holds the request socket cycle
// (TLSSocket -> parser -> socket), exactly the shape the clob-client SDK's errorHandling() chokes on.
function circularClobError() {
  const socket: Record<string, unknown> = {};
  const parser: Record<string, unknown> = { socket };
  socket.parser = parser; // socket -> parser -> socket cycle
  const circularConfig: Record<string, unknown> = {
    url: "/order",
    method: "post",
    httpsAgent: { sockets: { "clob.polymarket.com:443": [socket] } },
  };
  return {
    isAxiosError: true,
    config: { baseURL: "https://clob.polymarket.com", url: "/order" },
    request: socket,
    response: {
      status: 400,
      statusText: "Bad Request",
      data: { error: "no orders found to match with FAK order" },
      config: circularConfig,
    },
  } as unknown;
}

// What the SDK's errorHandling() stringifies before it can return the clean { error, status }.
function sdkStringifyPayload(err: any): string {
  return JSON.stringify({
    status: err.response?.status,
    statusText: err.response?.statusText,
    data: err.response?.data,
    config: err.response?.config,
  });
}

test("defangPolymarketAxiosError makes a circular CLOB error serializable and preserves the real reason", () => {
  const err: any = circularClobError();
  // Precondition: the SDK's stringify throws on the circular config (this is the masking bug).
  assert.throws(() => sdkStringifyPayload(err), /circular/i);

  defangPolymarketAxiosError(err);

  // Postcondition: stringify now succeeds and the genuine 400 rejection detail survives.
  const serialized = sdkStringifyPayload(err);
  assert.match(serialized, /no orders found to match/);
  assert.match(serialized, /400/);
  assert.equal(err.response.config.httpsAgent, undefined); // circular ref stripped
  assert.equal(err.request, undefined);
});

test("defangPolymarketAxiosError leaves non-Polymarket axios errors untouched", () => {
  const cfg = { url: "/foo", method: "get", httpsAgent: { sockets: {} } };
  const err: any = {
    isAxiosError: true,
    config: { url: "https://example.com/foo" },
    response: { status: 500, config: cfg },
  };
  defangPolymarketAxiosError(err);
  assert.equal(err.response.config, cfg); // unchanged — not a CLOB URL
});

test("defangPolymarketAxiosError is a no-op on non-axios values and never throws", () => {
  assert.doesNotThrow(() => defangPolymarketAxiosError(undefined));
  assert.doesNotThrow(() => defangPolymarketAxiosError(new Error("plain")));
  assert.doesNotThrow(() => defangPolymarketAxiosError({ isAxiosError: false }));
});
