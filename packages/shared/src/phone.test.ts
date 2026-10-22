import { describe, expect, it } from "vitest";
import { normalisePhoneForCountry } from "./phone";

describe("normalisePhoneForCountry", () => {
  it("Kenya: converts a local 07xx number to +254", () => {
    expect(normalisePhoneForCountry("0712 345 678", "KE")).toBe("+254712345678");
  });
  it("Kenya: leaves an already-international number's digits alone", () => {
    expect(normalisePhoneForCountry("+254712345678", "KE")).toBe("+254712345678");
  });
  it("Kenya: prefixes a bare subscriber number", () => {
    expect(normalisePhoneForCountry("712345678", "KE")).toBe("+254712345678");
  });
  it("falls back to Kenya's dial code for an unregistered country", () => {
    expect(normalisePhoneForCountry("0712345678", "XX")).toBe("+254712345678");
  });
});
