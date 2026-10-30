/** Pure, with no React Native in it, so it can be unit-tested on its own. */
import type { Scheme } from "../theme";

/** What the person picked in Account: follow the phone, or stay light or dark whatever the phone does. */
export type ThemePref = "system" | "light" | "dark";

export const isThemePref = (value: unknown): value is ThemePref => value === "system" || value === "light" || value === "dark";

/**
 * Light or dark, for a pick. A pick of light or dark is the answer. "Same as phone" is the phone's own setting,
 * which Android reports through `phoneReport`; but just after the person drops an override they had chosen,
 * Android keeps reporting that override for a few seconds. While that is so (`reportStale`) the answer is what
 * the phone was last known to be set to, so the switch back is instant instead of lagging.
 */
export function pickScheme(pref: ThemePref, phoneReport: Scheme, lastKnownPhone: Scheme, reportStale: boolean): Scheme {
  if (pref !== "system") return pref;
  return reportStale ? lastKnownPhone : phoneReport;
}
