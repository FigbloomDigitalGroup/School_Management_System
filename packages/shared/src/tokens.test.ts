import { describe, expect, it } from "vitest";
import { appSurface, appSurfaceDark, brand, brandDark, contrastRatio, readableAccent, schoolAccents, status, statusDark } from "./tokens";

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

  it("the new status inks read on their own washes", () => {
    expect(contrast(status.badInk, status.badBg)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(status.cautionInk, status.cautionBg)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(status.badText, appSurface.card)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(status.liveInk, appSurface.card)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe("phone app text colours in dark", () => {
  const surfaces = ["page", "shell", "card", "lineSoft"] as const;

  for (const surface of surfaces) {
    it(`ink, inkMuted and inkFaint read on ${surface}`, () => {
      expect(contrast(appSurfaceDark.ink, appSurfaceDark[surface])).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(appSurfaceDark.inkMuted, appSurfaceDark[surface])).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(appSurfaceDark.inkFaint, appSurfaceDark[surface])).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }

  it("keeps the hierarchy: ink over inkMuted over inkFaint", () => {
    const on = (c: string) => contrast(c, appSurfaceDark.card);
    expect(on(appSurfaceDark.ink)).toBeGreaterThan(on(appSurfaceDark.inkMuted));
    expect(on(appSurfaceDark.inkMuted)).toBeGreaterThan(on(appSurfaceDark.inkFaint));
  });

  it("every status ink reads on its own wash, and on a dark card", () => {
    const pairs: [keyof typeof statusDark, keyof typeof statusDark][] = [
      ["okInk", "okBg"], ["warnInk", "warnBg"], ["infoInk", "infoBg"], ["mutedInk", "mutedBg"],
      ["badInk", "badBg"], ["cautionInk", "cautionBg"],
    ];
    for (const [ink, bg] of pairs) expect(contrast(statusDark[ink], statusDark[bg]), `${ink} on ${bg}`).toBeGreaterThanOrEqual(AA_TEXT);
    for (const ink of ["okInk", "warnInk", "infoInk", "badText", "cautionInk", "liveInk"] as const) {
      expect(contrast(statusDark[ink], appSurfaceDark.card), `${ink} on card`).toBeGreaterThanOrEqual(AA_TEXT);
    }
    expect(contrast(brandDark.orangeInk, brandDark.orangeSoft)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("a form field's edge is 3:1 against the page and the card, in both schemes", () => {
    for (const set of [appSurface, appSurfaceDark]) {
      expect(contrast(set.field, set.page)).toBeGreaterThanOrEqual(3);
      expect(contrast(set.field, set.card)).toBeGreaterThanOrEqual(3);
    }
  });

  it("raised surfaces are lighter than the page, recessed ones darker", () => {
    const l = (hex: string) => contrast(hex, "#000000");
    expect(l(appSurfaceDark.card)).toBeGreaterThan(l(appSurfaceDark.page));
    expect(l(appSurfaceDark.shell)).toBeLessThan(l(appSurfaceDark.page));
  });

  it("defines every colour the light sets do, and no others", () => {
    expect(Object.keys(appSurfaceDark).sort()).toEqual(Object.keys(appSurface).sort());
    expect(Object.keys(statusDark).sort()).toEqual(Object.keys(status).sort());
    expect(Object.keys(brandDark).sort()).toEqual(Object.keys(brand).sort());
  });

  it("keeps the brand orange the same orange", () => {
    expect(brandDark.orange).toBe(brand.orange);
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for a colour on itself", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#7A1F2B", "#7A1F2B")).toBeCloseTo(1, 5);
  });

  it("agrees with an independent implementation", () => {
    for (const [a, b] of [["#F26A1B", "#FFFFFF"], ["#736967", "#FBF9F9"], ["#8FD6A8", "#14261B"]] as const) {
      expect(contrastRatio(a, b)).toBeCloseTo(contrast(a, b), 6);
    }
  });

  it("reads anything it cannot parse as no contrast at all", () => {
    expect(contrastRatio("rgba(0,0,0,0.5)", "#FFFFFF")).toBe(1);
    expect(contrastRatio("#FFF", "#000000")).toBe(1);
  });
});

describe("readableAccent", () => {
  const hues = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return h / 6;
  };

  it("leaves every school accent alone on the light card (they are all AA on white already)", () => {
    for (const a of schoolAccents) {
      expect(readableAccent(a.hex, appSurface.card), a.name).toBe(a.hex);
      expect(readableAccent(a.deep, appSurface.card), `${a.name} deep`).toBe(a.deep);
    }
  });

  it("lifts every school accent to 4.5:1 on the dark card and the dark chip surface", () => {
    for (const a of schoolAccents) {
      for (const colour of [a.hex, a.deep]) {
        for (const surface of [appSurfaceDark.card, appSurfaceDark.lineSoft, appSurfaceDark.page]) {
          expect(contrast(readableAccent(colour, surface), surface), `${a.name} ${colour} on ${surface}`).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    }
  });

  it("keeps each accent recognisably itself: same hue family, lighter, not white", () => {
    for (const a of schoolAccents) {
      const lifted = readableAccent(a.hex, appSurfaceDark.lineSoft);
      expect(lifted).not.toBe("#FFFFFF");
      expect(contrast(lifted, "#000000")).toBeGreaterThan(contrast(a.hex, "#000000"));
      expect(Math.abs(hues(lifted) - hues(a.hex)), a.name).toBeLessThan(0.03);
    }
  });

  it("is idempotent: lifting a lifted accent changes nothing", () => {
    for (const a of schoolAccents) {
      const once = readableAccent(a.hex, appSurfaceDark.card);
      expect(readableAccent(once, appSurfaceDark.card)).toBe(once);
    }
  });

  it("passes through a colour it cannot read, rather than inventing one", () => {
    expect(readableAccent("rgba(0,0,0,0.5)", appSurfaceDark.card)).toBe("rgba(0,0,0,0.5)");
    expect(readableAccent("#FFF", appSurfaceDark.card)).toBe("#FFF");
  });

  it("asks for more when told to", () => {
    const normal = readableAccent("#7A1F2B", appSurfaceDark.card, 4.5);
    const more = readableAccent("#7A1F2B", appSurfaceDark.card, 7);
    expect(contrast(more, appSurfaceDark.card)).toBeGreaterThanOrEqual(7);
    expect(contrast(more, "#000000")).toBeGreaterThan(contrast(normal, "#000000"));
  });
});
