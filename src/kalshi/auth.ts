import { constants, createPrivateKey, sign } from "node:crypto";

const websocketPath = "/trade-api/ws/v2";

function decodeBase64Pem(value: string): string | null {
  try {
    const decoded = Buffer.from(value.trim(), "base64").toString("utf8").trim();
    return decoded.startsWith("-----BEGIN") ? decoded : null;
  } catch {
    return null;
  }
}

export function resolveKalshiPrivateKeyPem(env: NodeJS.ProcessEnv = process.env): string {
  const rawPrivateKey = env.KALSHI_PRIVATE_KEY?.trim();
  if (rawPrivateKey) {
    if (rawPrivateKey.startsWith("-----BEGIN")) return rawPrivateKey;
    const decoded = decodeBase64Pem(rawPrivateKey);
    if (decoded) return decoded;
    return rawPrivateKey;
  }
  if (env.KALSHI_PRIVATE_KEY_B64?.trim()) {
    const decoded = decodeBase64Pem(env.KALSHI_PRIVATE_KEY_B64);
    if (decoded) return decoded;
  }
  throw new Error("KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_B64 is required");
}

function getKeyId(): string {
  const keyId = process.env.KALSHI_API_KEY_ID?.trim();
  if (!keyId) throw new Error("KALSHI_API_KEY_ID is required");
  return keyId;
}

export function signKalshiRequest(method: string, pathWithQuery: string, timestamp = Date.now().toString()): string {
  const key = createPrivateKey(resolveKalshiPrivateKeyPem());
  const payload = Buffer.from(`${timestamp}${method.toUpperCase()}${kalshiSignaturePath(pathWithQuery)}`);
  return sign("sha256", payload, {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
}

export function kalshiSignaturePath(pathWithQuery: string): string {
  return pathWithQuery.split("?")[0] ?? pathWithQuery;
}

export function getKalshiHeaders(
  method: string,
  pathWithQuery: string,
  timestamp = Date.now().toString(),
): Record<string, string> {
  return {
    "KALSHI-ACCESS-KEY": getKeyId(),
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signKalshiRequest(method, pathWithQuery, timestamp),
  };
}

export function getKalshiWebsocketHeaders(): Record<string, string> {
  return getKalshiHeaders("GET", websocketPath);
}
