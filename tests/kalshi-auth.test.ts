import test from "node:test";
import assert from "node:assert/strict";
import { resolveKalshiPrivateKeyPem } from "../src/kalshi/auth";

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
