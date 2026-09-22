import { StyleSheet } from "react-native";
import { appSurface, brand, radius, schoolAccents, space, status } from "@figbloom/shared";

/**
 * The web tokens, expressed for React Native. Same values, so a screenshot of
 * the app and a screenshot of the web view are the same colour.
 */
export const t = { appSurface, brand, status, space, radius };

export const accentFor = (hex: string) =>
  schoolAccents.find((a) => a.hex.toLowerCase() === hex.toLowerCase()) ?? schoolAccents[0]!;

/** 44dp minimum on anything tappable — enforced, not aspirational. */
export const HIT = { minHeight: 44, minWidth: 44 };

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: appSurface.page },
  header: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16 },
  headerTitle: { fontSize: 21, fontWeight: "600", color: "#fff", letterSpacing: -0.3 },
  headerSub: { fontSize: 12.5, color: "rgba(255,255,255,0.75)", marginTop: 3 },

  card: {
    backgroundColor: appSurface.card,
    borderWidth: 1,
    borderColor: appSurface.line,
    borderRadius: 18,
    padding: 16,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },

  h2: { fontSize: 15, fontWeight: "600", color: appSurface.ink },
  body: { fontSize: 14.5, lineHeight: 24, color: appSurface.ink },
  small: { fontSize: 12.5, lineHeight: 19, color: appSurface.inkMuted },
  faint: { fontSize: 11.5, color: appSurface.inkFaint },
  mono: { fontFamily: "monospace", fontSize: 12 },
  eyebrow: {
    fontFamily: "monospace", fontSize: 9.5, letterSpacing: 1.2,
    color: appSurface.inkFaint,
  },

  primary: {
    ...HIT,
    borderRadius: 13,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryLabel: { fontSize: 15, fontWeight: "600", color: "#fff" },

  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  pillLabel: { fontSize: 11.5, fontWeight: "700" },

  banner: {
    flexDirection: "row", gap: 12, alignItems: "flex-start",
    backgroundColor: brand.orangeSoft,
    borderWidth: 1, borderColor: brand.orangeLine,
    borderRadius: 16, padding: 14,
  },
  bannerText: { fontSize: 12.5, lineHeight: 19, color: brand.orangeInk },
});
