import { isIP } from "node:net";

/**
 * Normalize a candidate client IP for rate limiting and PostgreSQL `inet`.
 *
 * Policy (R2-02):
 * - Strip optional surrounding brackets used in some forwarded forms.
 * - Reject zone identifiers (`fe80::1%eth0`) — they can look plausible to
 *   callers but are not valid `inet` values and must never cause HTTP 500.
 * - Reject anything `net.isIP` does not accept as IPv4/IPv6.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let ip = String(raw).trim();
  if (!ip) return null;

  if (ip.startsWith("[") && ip.includes("]")) {
    ip = ip.slice(1, ip.indexOf("]"));
  }

  // Explicit reject: zone IDs are unsupported for storage and audit use.
  if (ip.includes("%")) return null;

  // Canonicalise IPv4-mapped IPv6 (::ffff:a.b.c.d) to IPv4 so CIDR matching
  // and rate-limit buckets are consistent (R3-03).
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped && isIP(mapped[1]!) === 4) {
    return mapped[1]!;
  }
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    if (isIP(v4) === 4) return v4;
  }

  // IPv4 with trailing :port (not valid for isIP); leave pure IPv6 alone.
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) === 6) return ip;

  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (v4port && isIP(v4port[1]!) === 4) return v4port[1]!;

  return null;
}

/** Parse "a.b.c.d/n" or a bare IPv4/IPv6 address (implied full-length prefix). */
export function parseCidr(cidr: string): { version: 4 | 6; value: bigint; prefix: number } | null {
  const trimmed = cidr.trim();
  if (!trimmed) return null;
  const [addrPart, prefixPart] = trimmed.split("/");
  const addr = normalizeIp(addrPart);
  if (!addr) return null;
  const version = isIP(addr) as 4 | 6;
  if (version !== 4 && version !== 6) return null;
  const maxPrefix = version === 4 ? 32 : 128;
  const prefix = prefixPart === undefined ? maxPrefix : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return null;
  const value = ipToBigInt(addr, version);
  if (value === null) return null;
  return { version, value, prefix };
}

export function isIpInCidrs(ip: string, cidrs: readonly string[]): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  const version = isIP(normalized) as 4 | 6;
  const value = ipToBigInt(normalized, version);
  if (value === null) return false;

  for (const raw of cidrs) {
    const cidr = parseCidr(raw);
    if (!cidr || cidr.version !== version) continue;
    const shift = (cidr.version === 4 ? 32 : 128) - cidr.prefix;
    const mask = shift >= (cidr.version === 4 ? 32 : 128) ? 0n : ((1n << BigInt(cidr.version === 4 ? 32 : 128)) - 1n) ^ ((1n << BigInt(shift)) - 1n);
    // For prefix 0, everything matches.
    if (cidr.prefix === 0) return true;
    if ((value & mask) === (cidr.value & mask)) return true;
  }
  return false;
}

function ipToBigInt(ip: string, version: 4 | 6): bigint | null {
  if (version === 4) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return BigInt((parts[0]! << 24) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!);
  }
  // Expand IPv6 to eight hextets.
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 0) return null;
  const full = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...tail,
  ];
  if (full.length !== 8) return null;
  let value = 0n;
  for (const hextet of full) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(hextet)) return null;
    value = (value << 16n) + BigInt(parseInt(hextet, 16));
  }
  return value;
}
