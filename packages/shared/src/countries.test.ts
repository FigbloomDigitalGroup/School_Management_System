import { describe, expect, it } from "vitest";
import { countryProfile } from "./countries";

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
