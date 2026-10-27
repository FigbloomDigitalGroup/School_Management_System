/**
 * The web charts' colours (apps/web/src/components/analytics/charts.css),
 * light theme: four line colours that stay apart for colour-blind readers, and
 * one blue ramp for ordered bands (best grade darkest).
 */
export const VIZ = {
  surface: "#ffffff",
  ink: "#16201a",
  ink2: "#4a5a50",
  muted: "#6b7a70",
  grid: "#e7ece8",
  axis: "#c9d2cc",
  up: "#006300",
  down: "#b8460a",
} as const;

export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"] as const;
export const MAX_SERIES = SERIES_COLORS.length;
export const BAND_COLORS = ["#104281", "#1c5cab", "#2a78d6", "#5598e7", "#86b6ef"] as const;

/** A mark to one decimal, or a dash when there is none. */
export const fmt = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(digits);

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(max - 1, 1))}…` : text;
}
