/**
 * Checks a decision webhook from the Figbloom platform (figbloomHR-platform
 * README, "Decision webhook"): x-figbloom-signature is "sha256=" and the hex
 * HMAC-SHA256 of "<x-figbloom-timestamp>.<raw body>" with the shared secret,
 * and the timestamp (Unix seconds) is within 5 minutes of now, so a captured
 * request can't be replayed later. The same rule as the platform's
 * verifySignature; compared in constant time. Verify the raw body, before
 * parsing it.
 */

import { secretsMatch } from "./daraja.ts";

export const MAX_SKEW_SECONDS = 300;

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyFigbloomWebhook(
  secret: string, rawBody: string, signature: string | null | undefined, timestamp: string | null | undefined, nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || !signature || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = `sha256=${await hmacHex(secret, `${timestamp}.${rawBody}`)}`;
  return secretsMatch(signature, expected);
}

/** For tests and tooling: the headers the platform would send for this body. */
export async function signFigbloomWebhook(secret: string, rawBody: string, nowMs = Date.now()): Promise<{ signature: string; timestamp: string }> {
  const timestamp = String(Math.floor(nowMs / 1000));
  return { timestamp, signature: `sha256=${await hmacHex(secret, `${timestamp}.${rawBody}`)}` };
}
