import test from "node:test";
import assert from "node:assert/strict";
import { kalshiSignaturePath, resolveKalshiPrivateKeyPem } from "../src/kalshi/auth";

const pem = [
  "-----BEGIN PRIVATE KEY-----",
  "abc123",
  "-----END PRIVATE KEY-----",
].join("\n");

test("Kalshi private key resolver accepts raw PEM in KALSHI_PRIVATE_KEY", () => {
  assert.equal(resolveKalshiPrivateKeyPem({ KALSHI_PRIVATE_KEY: pem }), pem);
});

test("Kalshi private key resolver accepts base64 PEM in KALSHI_PRIVATE_KEY", () => {
  const encoded = Buffer.from(pem, "utf8").toString("base64");
  assert.equal(resolveKalshiPrivateKeyPem({ KALSHI_PRIVATE_KEY: encoded }), pem);
});

test("Kalshi private key resolver accepts base64 PEM in KALSHI_PRIVATE_KEY_B64", () => {
  const encoded = Buffer.from(pem, "utf8").toString("base64");
  assert.equal(resolveKalshiPrivateKeyPem({ KALSHI_PRIVATE_KEY_B64: encoded }), pem);
});

test("Kalshi REST signatures exclude query parameters", () => {
  assert.equal(
    kalshiSignaturePath("/trade-api/v2/portfolio/orders?ticker=KXBTC15M&status=resting"),
    "/trade-api/v2/portfolio/orders",
  );
  assert.equal(kalshiSignaturePath("/trade-api/v2/portfolio/orders/abc123"), "/trade-api/v2/portfolio/orders/abc123");
});
