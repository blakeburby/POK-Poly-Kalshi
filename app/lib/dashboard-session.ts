import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const cookieName = "pok_dashboard_session";
const maxAgeSeconds = 12 * 60 * 60;

function secret(): string {
  return process.env.DASHBOARD_SESSION_SECRET?.trim() || process.env.DASHBOARD_PASSWORD?.trim() || "";
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyDashboardPassword(input: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD?.trim() ?? "";
  return Boolean(expected) && safeEqual(input, expected);
}

export async function setDashboardSession(now = Date.now()): Promise<void> {
  const issuedAt = String(now);
  const jar = await cookies();
  jar.set(cookieName, `${issuedAt}.${sign(issuedAt)}`, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: maxAgeSeconds,
    path: "/",
  });
}

export function isValidDashboardSession(value: string | undefined, now = Date.now()): boolean {
  if (!value || !secret()) return false;
  const [issuedAt, signature] = value.split(".", 2);
  const timestamp = Number(issuedAt);
  if (!issuedAt || !signature || !Number.isFinite(timestamp)) return false;
  if (now - timestamp < 0 || now - timestamp > maxAgeSeconds * 1000) return false;
  return safeEqual(signature, sign(issuedAt));
}

export async function hasDashboardSession(): Promise<boolean> {
  const jar = await cookies();
  return isValidDashboardSession(jar.get(cookieName)?.value);
}
