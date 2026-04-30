import { constants, createPrivateKey, sign } from "node:crypto";

const websocketPath = "/trade-api/ws/v2";

function getPrivateKeyPem(): string {
  if (process.env.KALSHI_PRIVATE_KEY?.trim()) return process.env.KALSHI_PRIVATE_KEY.trim();
  if (process.env.KALSHI_PRIVATE_KEY_B64?.trim()) {
    return Buffer.from(process.env.KALSHI_PRIVATE_KEY_B64.trim(), "base64").toString("utf8");
  }
  throw new Error("KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_B64 is required");
}

function getKeyId(): string {
  const keyId = process.env.KALSHI_API_KEY_ID?.trim();
  if (!keyId) throw new Error("KALSHI_API_KEY_ID is required");
  return keyId;
}

export function signKalshiRequest(method: string, pathWithQuery: string, timestamp = Date.now().toString()): string {
  const key = createPrivateKey(getPrivateKeyPem());
  const payload = Buffer.from(`${timestamp}${method.toUpperCase()}${pathWithQuery}`);
  return sign("sha256", payload, {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
}

export function getKalshiHeaders(method: string, pathWithQuery: string, timestamp = Date.now().toString()): Record<string, string> {
  return {
    "KALSHI-ACCESS-KEY": getKeyId(),
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signKalshiRequest(method, pathWithQuery, timestamp),
  };
}

export function getKalshiWebsocketHeaders(): Record<string, string> {
  return getKalshiHeaders("GET", websocketPath);
}
