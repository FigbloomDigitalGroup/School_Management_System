import { StyleSheet } from "react-native";
import {
  appSurface, appSurfaceDark, brand, brandDark, radius, schoolAccents, space, status, statusDark,
  type AppSurfacePalette, type BrandPalette, type StatusPalette,
} from "@figbloom/shared";

export type Scheme = "light" | "dark";

/**
 * The web tokens, expressed for React Native, in one scheme. Light has the same values as the web, so a
 * screenshot of the app and a screenshot of the web view are the same colour. The spacing and radius
 * scales are the same in both schemes. Read it with `useTheme()` (ui/ThemeContext), never from a module
 * constant: a colour captured at import time stays the scheme it was captured in.
 */
export interface Palette {
  appSurface: AppSurfacePalette;
  brand: BrandPalette;
  status: StatusPalette;
  space: typeof space;
  radius: typeof radius;
}

/** Spacing and radii do not change with the scheme, so these are safe to read anywhere, including at module level. */
export { radius, space };

export const accentFor = (hex: string) =>
  schoolAccents.find((a) => a.hex.toLowerCase() === hex.toLowerCase()) ?? schoolAccents[0]!;

/** 44dp minimum on anything tappable — enforced, not aspirational. */
export const HIT = { minHeight: 44, minWidth: 44 };

/**
 * The type scale. The apps print nothing smaller than `micro`; running text is
 * `body`. New screens pick from here instead of inventing a size.
 */
export const fontSize = { micro: 11, caption: 12, small: 13, body: 14.5, lead: 15, title: 17, header: 21, display: 30 } as const;

/** Milliseconds. Press feedback is quick enough to feel attached to the finger. */
export const motion = { press: 90, pulse: 700 } as const;

/** How far a held control shrinks. Small enough to read as a press, not a wobble. */
export const PRESS_SCALE = 0.98;

/** Text inside a fixed-size control (button, tab label) stops growing here, so large system text can't burst it. */
export const CONTROL_FONT_SCALE = 1.3;

/** The styles every screen shares, for one palette. */
function makeStyles(t: Palette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.appSurface.page },
    header: {
      paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16,
      shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 6,
      elevation: 3,
    },
    headerTitle: { fontSize: fontSize.header, fontWeight: "600", color: "#fff", letterSpacing: -0.3 },
    headerSub: { fontSize: fontSize.small, color: "rgba(255,255,255,0.75)", marginTop: 3 },

    card: {
      backgroundColor: t.appSurface.card,
      borderWidth: 1,
      borderColor: t.appSurface.line,
      borderRadius: t.radius.xl,
      padding: 16,
      // A flat card and a photo of a card look the same at a glance but not
      // in the hand — this is the difference between "placed" and "pasted".
      shadowColor: "#1A1614",
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.06,
      shadowRadius: 10,
      elevation: 2,
    },
    row: { flexDirection: "row", alignItems: "center", gap: 12 },

    h2: { fontSize: fontSize.lead, fontWeight: "600", color: t.appSurface.ink },
    body: { fontSize: fontSize.body, lineHeight: 24, color: t.appSurface.ink },
    small: { fontSize: fontSize.small, lineHeight: 20, color: t.appSurface.inkMuted },
    faint: { fontSize: fontSize.caption, color: t.appSurface.inkFaint },
    mono: { fontFamily: "monospace", fontSize: 12 },
    eyebrow: {
      fontFamily: "monospace", fontSize: fontSize.micro, letterSpacing: 1.1,
      color: t.appSurface.inkFaint,
    },
    // The same label on a coloured header band, where the dark-on-light eyebrow colour would vanish.
    headerEyebrow: {
      fontFamily: "monospace", fontSize: fontSize.micro, letterSpacing: 1.1,
      color: "rgba(255,255,255,0.75)",
    },

    primary: {
      ...HIT,
      borderRadius: t.radius.lg,
      paddingVertical: 15,
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#1A1614", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.16, shadowRadius: 8,
      elevation: 3,
    },
    primaryLabel: { fontSize: fontSize.lead, fontWeight: "600", color: "#fff" },

    pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
    pillLabel: { fontSize: 11.5, fontWeight: "700" },

    banner: {
      flexDirection: "row", gap: 12, alignItems: "flex-start",
      backgroundColor: t.brand.orangeSoft,
      borderWidth: 1, borderColor: t.brand.orangeLine,
      borderRadius: t.radius.xl, padding: 14,
    },
    bannerText: { fontSize: fontSize.small, lineHeight: 19, color: t.brand.orangeInk },
  });
}

export type Styles = ReturnType<typeof makeStyles>;

/** Everything a component reads to colour itself: the scheme, its tokens, the shared styles and the form-field edge. */
export interface Theme {
  scheme: Scheme;
  t: Palette;
  s: Styles;
  /** An input's edge. It needs 3:1 against the page (WCAG 1.4.11); `appSurface.line` is a divider and is far too faint. */
  fieldLine: string;
}

function build(scheme: Scheme): Theme {
  const t: Palette = scheme === "dark"
    ? { appSurface: appSurfaceDark, brand: brandDark, status: statusDark, space, radius }
    : { appSurface, brand, status, space, radius };
  return { scheme, t, s: makeStyles(t), fieldLine: t.appSurface.field };
}

/** Both schemes, built once. Switching scheme swaps which of these a component is handed; nothing is rebuilt. */
export const themes: Record<Scheme, Theme> = { light: build("light"), dark: build("dark") };

/**
 * For a table or style that is written once at module level but depends on the colours (status → pill
 * colours, say): builds it for both schemes up front, and a component picks with `table[scheme]`.
 */
export function perScheme<T>(make: (t: Palette) => T): Record<Scheme, T> {
  return { light: make(themes.light.t), dark: make(themes.dark.t) };
}
