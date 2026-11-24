// RFC 6238 time-based one-time password (HMAC-SHA1, 30 s step, 6 digits), which is what apps/api checks
// (apps/api/src/modules/auth/mfa.ts). Needed only when the API enforces two-step sign-in for the account the
// script signs in as.
import { createHmac } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(text) {
  const clean = text.replace(/\s+/g, "").replace(/=+$/, "").toUpperCase();
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("The two-step secret is not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

/** `stepOffset` 1 gives the code for the next 30 s window (the API accepts one step either side). */
export function totp(secret, nowMs = Date.now(), stepOffset = 0) {
  const counter = Math.floor(nowMs / 30000) + stepOffset;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}
