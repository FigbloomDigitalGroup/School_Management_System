import { describe, expect, it } from "vitest";
import { computeTotpCode, decodeBase32 } from "./totp";

describe("scripts/api-seed/totp", () => {
  // RFC 6238 Appendix B SHA1 test vector: ASCII "12345678901234567890" -> GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("decodes RFC 4648 base32 strings with optional spaces or padding", () => {
    expect(decodeBase32(RFC_SECRET).toString("utf8")).toBe("12345678901234567890");
    expect(decodeBase32("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ====").toString("utf8")).toBe("12345678901234567890");
  });

  it("matches RFC 6238 SHA-1 test vectors (6-digit truncation)", () => {
    // T = 59s -> 94287082 -> last 6 digits 287082
    expect(computeTotpCode(RFC_SECRET, 59 * 1000)).toBe("287082");
    // T = 1111111109s -> 07081804 -> last 6 digits 081804
    expect(computeTotpCode(RFC_SECRET, 1111111109 * 1000)).toBe("081804");
    // T = 1234567890s -> 89005924 -> last 6 digits 005924
    expect(computeTotpCode(RFC_SECRET, 1234567890 * 1000)).toBe("005924");
  });

  it("supports negative/positive step offsets cleanly", () => {
    const t = 1234567890 * 1000;
    expect(computeTotpCode(RFC_SECRET, t + 30_000, -1)).toBe("005924");
    expect(computeTotpCode(RFC_SECRET, t - 30_000, 1)).toBe("005924");
  });
});
