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

/** Warmer surfaces for the parent and student apps — read on a phone, at night. */
export const appSurface = {
  page: "#FBF9F9",
  shell: "#F3EFEE",
  card: "#FFFFFF",
  line: "#EAE6E5",
  lineSoft: "#F4F0EF",
  ink: "#221A1B",
  inkMuted: "#6B605F",
  inkFaint: "#8B807E",
} as const;

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
