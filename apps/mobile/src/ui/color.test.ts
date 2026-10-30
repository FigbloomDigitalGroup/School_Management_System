import { describe, expect, it } from "vitest";
import { luminance, parseOpaqueColor, rippleFor, RIPPLE_ON_DARK, RIPPLE_ON_LIGHT } from "./color";

describe("parseOpaqueColor", () => {
  it("reads 3- and 6-digit hex in either case", () => {
    expect(parseOpaqueColor("#fff")).toEqual([255, 255, 255]);
    expect(parseOpaqueColor("#F26A1B")).toEqual([242, 106, 27]);
    expect(parseOpaqueColor("#123")).toEqual([17, 34, 51]);
  });

  it("reads rgb()", () => {
    expect(parseOpaqueColor("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
  });

  it("refuses what it cannot read, rather than guessing", () => {
    expect(parseOpaqueColor("rgba(255,255,255,0.18)")).toBeNull();
    expect(parseOpaqueColor("transparent")).toBeNull();
    expect(parseOpaqueColor("hsl(0, 0%, 50%)")).toBeNull();
    expect(parseOpaqueColor("#12345")).toBeNull();
  });
});

describe("luminance", () => {
  it("runs from black to white", () => {
    expect(luminance([0, 0, 0])).toBe(0);
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 5);
  });
});

describe("rippleFor", () => {
  it("gives a light wash on every school accent, which are all dark fills", () => {
    for (const hex of ["#7A1F2B", "#123C63", "#1B4D2E", "#5C2E1F", "#3B3B6D", "#0F5257", "#4E1520"]) {
      expect(rippleFor(hex), hex).toBe(RIPPLE_ON_DARK);
    }
  });

  it("gives a light wash on the brand orange, which carries a white label", () => {
    expect(rippleFor("#F26A1B")).toBe(RIPPLE_ON_DARK);
  });

  it("gives a dark wash on cards and pale fills", () => {
    for (const hex of ["#FFFFFF", "#F4F0EF", "#FBF9F9", "#FDF1E8"]) {
      expect(rippleFor(hex), hex).toBe(RIPPLE_ON_LIGHT);
    }
  });

  it("falls back to the dark wash when there is no readable background", () => {
    expect(rippleFor(undefined)).toBe(RIPPLE_ON_LIGHT);
    expect(rippleFor("transparent")).toBe(RIPPLE_ON_LIGHT);
    expect(rippleFor("rgba(255,255,255,0.18)")).toBe(RIPPLE_ON_LIGHT);
    expect(rippleFor(42)).toBe(RIPPLE_ON_LIGHT);
  });
});
