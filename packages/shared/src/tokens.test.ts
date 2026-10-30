import { describe, expect, it } from "vitest";
import { appSurface, brand, schoolAccents, status } from "./tokens";

/** WCAG 2.x contrast ratio between two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const AA_TEXT = 4.5;

describe("phone app text colours", () => {
  const surfaces = ["page", "shell", "card", "lineSoft"] as const;

  for (const surface of surfaces) {
    it(`ink, inkMuted and inkFaint read on ${surface}`, () => {
      expect(contrast(appSurface.ink, appSurface[surface])).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(appSurface.inkMuted, appSurface[surface])).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(appSurface.inkFaint, appSurface[surface])).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }

  it("keeps inkFaint quieter than inkMuted, so the hierarchy survives the contrast fix", () => {
    expect(contrast(appSurface.inkFaint, appSurface.card)).toBeLessThan(contrast(appSurface.inkMuted, appSurface.card));
  });

  it("status inks read on their own backgrounds", () => {
    expect(contrast(status.okInk, status.okBg)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(status.warnInk, status.warnBg)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(status.infoInk, status.infoBg)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(status.mutedInk, status.mutedBg)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(brand.orangeInk, brand.orangeSoft)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("white reads on every school accent (headers and filled buttons)", () => {
    for (const a of schoolAccents) {
      expect(contrast("#FFFFFF", a.hex), a.name).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast("#FFFFFF", a.deep), `${a.name} deep`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  // Known gap, deliberately not asserted: white on brand.orange is about 3.06:1, under 4.5:1 for
  // 15px button labels. The orange is the Figbloom brand, so changing it is a design decision, not
  // a code fix. The phone apps' Button takes its fill from one constant for when that is decided.
});
