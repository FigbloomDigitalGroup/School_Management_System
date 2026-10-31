/**
 * Figbloom design tokens.
 *
 * Platform brand is fixed: forest green + orange, taken from the Figbloom mark.
 * Each school picks ONE accent, which colours the header band, primary buttons
 * and the active nav marker. Status colours are system-owned and never themed —
 * red must mean the same thing in every school.
 */

export const brand = {
  forest: "#17402A",
  forestDeep: "#123420",
  leaf: "#1B4D2E",
  orange: "#F26A1B",
  orangeSoft: "#FDF1E8",
  orangeLine: "#F6DCC7",
  orangeInk: "#8A3D08",
} as const;

export const status = {
  okBg: "#E3EFE7", okInk: "#1B4D2E", okDot: "#2E7D4F",
  warnBg: "#FDEBDF", warnInk: "#B8460A", warnDot: "#F26A1B",
  infoBg: "#E9F0F6", infoInk: "#1F4E79",
  mutedBg: "#EEF1EE", mutedInk: "#5F6B62",
  /** Failed or refused. `badText` is for a message on a card; `badInk` for a label on `badBg`. */
  badBg: "#FBE9E6", badLine: "#F1C7BF", badInk: "#9B2C1C", badText: "#B4472B",
  /** Worth a second look without being wrong: a medical alert, an approval still pending, a middling score. */
  cautionBg: "#FDF3E1", cautionLine: "#F0DDB8", cautionInk: "#8A5A0B", cautionDot: "#F9A05C",
  /** A vehicle on the road, and one that is not. */
  liveDot: "#2EA45A", liveInk: "#1E7A43", idleDot: "#A3ABA5",
} as const;

/** Console surfaces (super admin, school admin, teacher desktop). */
export const surface = {
  page: "#F6F8F6",
  card: "#FFFFFF",
  sunken: "#F1F5F2",
  line: "#E2E6E2",
  lineSoft: "#EEF1EE",
  ink: "#16201A",
  inkMuted: "#5F6B62",
  inkFaint: "#7B877F",
} as const;

/**
 * Warmer surfaces for the parent and student apps — read on a phone, at night.
 * Only the phone apps use these. `inkFaint` is the quietest text and must still
 * clear 4.5:1 on every surface here (tokens.test.ts holds it to that).
 */
export const appSurface = {
  page: "#FBF9F9",
  shell: "#F3EFEE",
  card: "#FFFFFF",
  line: "#EAE6E5",
  lineSoft: "#F4F0EF",
  ink: "#221A1B",
  inkMuted: "#6B605F",
  inkFaint: "#736967",
  /** A form field's edge. It needs 3:1 against the page (WCAG 1.4.11); `line` is a divider and is far too faint. */
  field: "#8F8583",
  /** A switch's track while it is off. */
  track: "#DAD5D4",
} as const;

/** The light sets' keys with plain-string values, so each dark set below is checked against them key for key. */
export type AppSurfacePalette = { [K in keyof typeof appSurface]: string };
export type BrandPalette = { [K in keyof typeof brand]: string };
export type StatusPalette = { [K in keyof typeof status]: string };

/**
 * The phone apps in dark. A warm near-black, as the light set is a warm near-white, so a school's accent
 * sits on it the way it sits on the light page. A raised surface is the lighter one in dark (`card` over
 * `page`) and a recessed one the darker (`shell`). Text clears 4.5:1 on every surface, held by tokens.test.ts.
 */
export const appSurfaceDark: AppSurfacePalette = {
  page: "#141011",
  shell: "#0F0C0D",
  card: "#211A1B",
  line: "#3A3132",
  lineSoft: "#2B2425",
  ink: "#F4EFEF",
  inkMuted: "#BDB3B2",
  inkFaint: "#A59B9A",
  field: "#7C7372",
  track: "#4D4445",
};

/** The brand in dark: the orange stays the orange (it is the logo); its soft tints become dark washes. */
export const brandDark: BrandPalette = {
  forest: "#17402A", forestDeep: "#123420", leaf: "#1B4D2E",
  orange: "#F26A1B",
  orangeSoft: "#2C1B11", orangeLine: "#4D2F1C", orangeInk: "#FFB07A",
};

/** Status colours keep their meaning in dark (red is still red); the washes go dark and the inks go light. */
export const statusDark: StatusPalette = {
  okBg: "#14261B", okInk: "#8FD6A8", okDot: "#4DB97C",
  warnBg: "#2D1C11", warnInk: "#FFAA72", warnDot: "#F26A1B",
  infoBg: "#13212E", infoInk: "#8FBDE8",
  mutedBg: "#272122", mutedInk: "#BDB3B2",
  badBg: "#301613", badLine: "#5A2B25", badInk: "#FF9C8A", badText: "#FF9C8A",
  cautionBg: "#2B2110", cautionLine: "#4D3C1A", cautionInk: "#EDBB5E", cautionDot: "#F9A05C",
  liveDot: "#3DBF70", liveInk: "#6FD99A", idleDot: "#7D8480",
};

const channels = (hex: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};

const luminanceOf = ([r, g, b]: [number, number, number]): number => {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** WCAG 2.x contrast ratio, 1 to 21, between two opaque #RRGGBB colours. Anything else reads as 1. */
export function contrastRatio(a: string, b: string): number {
  const ca = channels(a);
  const cb = channels(b);
  if (!ca || !cb) return 1;
  const [hi, lo] = [luminanceOf(ca), luminanceOf(cb)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToHex([h, s, l]: [number, number, number]): string {
  const hue = (p: number, q: number, t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const [r, g, b] = s === 0 ? [l, l, l] : [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
  return "#" + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

const readableCache = new Map<string, string>();

/**
 * A school's accent made readable as text, an icon or a thin outline on `surface`. The accents are dark
 * enough to carry white labels, which is exactly what stops them being read on a dark page. This keeps the
 * hue and lifts the lightness only as far as it takes to reach `min`:1. A colour that already reads comes
 * back unchanged, so on a light surface it is the identity, and applying it twice changes nothing more.
 */
export function readableAccent(accent: string, surface: string, min = 4.5): string {
  const key = `${accent}|${surface}|${min}`;
  const hit = readableCache.get(key);
  if (hit) return hit;

  const rgb = channels(accent);
  let out = accent;
  if (rgb && contrastRatio(accent, surface) < min) {
    const [h, s, l0] = rgbToHsl(rgb);
    out = "#FFFFFF";
    for (let l = l0; l <= 0.92; l += 0.01) {
      // A lighter tone of the same hue gets a little less saturated as it rises, so it reads as a tint, not a neon.
      const candidate = hslToHex([h, Math.min(s, 0.72 - Math.max(0, l - 0.5) * 0.5), l]);
      if (contrastRatio(candidate, surface) >= min) { out = candidate; break; }
    }
  }
  readableCache.set(key, out);
  return out;
}

/** The accents a school may choose. Every one is AA on white. */
export const schoolAccents = [
  { hex: "#7A1F2B", name: "Maroon", deep: "#4E1520" },
  { hex: "#123C63", name: "Navy", deep: "#0C2740" },
  { hex: "#1B4D2E", name: "Forest", deep: "#123420" },
  { hex: "#5C2E1F", name: "Rust", deep: "#3B1D13" },
  { hex: "#3B3B6D", name: "Indigo", deep: "#262647" },
  { hex: "#0F5257", name: "Teal", deep: "#0A3538" },
] as const;

export type SchoolAccent = (typeof schoolAccents)[number];

export const accentFor = (hex: string): SchoolAccent =>
  schoolAccents.find((a) => a.hex.toLowerCase() === hex.toLowerCase()) ?? schoolAccents[0];

/** 4px base. Tailwind's default scale matches; these are for React Native. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 22, xxl: 30 } as const;

export const radius = { sm: 7, md: 9, lg: 12, xl: 16, pill: 999 } as const;

export const type = {
  sans: "Figtree, system-ui, -apple-system, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
  /** Never below 13px on console, 14px in the parent app. */
  size: { micro: 10, mono: 11, small: 12.5, body: 13.5, lead: 15, h3: 17, h2: 22, h1: 26 },
} as const;

/** Minimum touch target, enforced in the mobile apps. */
export const HIT_SLOP = 44;
