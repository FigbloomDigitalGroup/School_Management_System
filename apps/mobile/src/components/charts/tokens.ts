/**
 * The web charts' colours (apps/web/src/components/analytics/charts.css),
 * light theme: four line colours that stay apart for colour-blind readers, and
 * one blue ramp for ordered bands (best grade darkest).
 */
const VIZ_LIGHT = {
  surface: "#ffffff",
  ink: "#16201a",
  ink2: "#4a5a50",
  muted: "#6b7a70",
  grid: "#e7ece8",
  axis: "#c9d2cc",
  up: "#006300",
  down: "#b8460a",
} as const;

/** The same roles on the dark card: the grid and axis sit just above the card, the inks are the app's light inks. */
const VIZ_DARK: { [K in keyof typeof VIZ_LIGHT]: string } = {
  surface: "#211a1b",
  ink: "#f4efef",
  ink2: "#c9c0bf",
  muted: "#a59b9a",
  grid: "#3a3132",
  axis: "#5a5051",
  up: "#6fd99a",
  down: "#ffaa72",
};

export const VIZ = { light: VIZ_LIGHT as { [K in keyof typeof VIZ_LIGHT]: string }, dark: VIZ_DARK };

export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"] as const;
export const MAX_SERIES = SERIES_COLORS.length;
export const BAND_COLORS = {
  light: ["#104281", "#1c5cab", "#2a78d6", "#5598e7", "#86b6ef"],
  // Best grade is the most intense: darkest on a light card, brightest on a dark one.
  dark: ["#c4ddfa", "#8fbff2", "#5598e7", "#3a86de", "#2f78ce"],
};

/** A mark to one decimal, or a dash when there is none. */
export const fmt = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(digits);

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(max - 1, 1))}…` : text;
}
