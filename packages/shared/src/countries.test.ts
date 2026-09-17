import { describe, expect, it } from "vitest";
import { COUNTRIES, countryProfile } from "./countries";

describe("COUNTRIES", () => {
  it("has every UN member state, each with a complete profile", () => {
    const codes = Object.keys(COUNTRIES);
    expect(codes.length).toBe(194);
    expect(new Set(codes).size).toBe(codes.length); // no duplicate ISO codes
    for (const [code, p] of Object.entries(COUNTRIES)) {
      expect(p.label, code).toBeTruthy();
      expect(p.currencyCode, code).toMatch(/^[A-Z]{3}$/);
      expect(p.currencySymbol, code).toBeTruthy();
      expect(p.dialCode, code).toMatch(/^\d+$/);
      expect(p.localPrefixes.length, code).toBeGreaterThan(0);
      expect(p.phonePlaceholder, code).toBeTruthy();
    }
  });
});

describe("countryProfile", () => {
  it("Kenya: returns the registered profile", () => {
    const ke = countryProfile("KE");
    expect(ke.label).toBe("Kenya");
    expect(ke.currencyCode).toBe("KES");
    expect(ke.currencySymbol).toBe("KSh");
    expect(ke.currencyDecimals).toBe(0);
    expect(ke.dialCode).toBe("254");
    expect(ke.localPrefixes).toEqual(["0"]);
  });

  it("falls back to Kenya for an unregistered country rather than throwing", () => {
    expect(countryProfile("XX")).toBe(countryProfile("KE"));
  });
});
