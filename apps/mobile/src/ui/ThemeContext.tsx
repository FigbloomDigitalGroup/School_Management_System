import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Appearance, StyleSheet, useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { readableAccent } from "@figbloom/shared";
import { themes, type Scheme, type Theme } from "../theme";
import { isThemePref, pickScheme, type ThemePref } from "./scheme";

export type { ThemePref } from "./scheme";

const PREF_KEY = "figbloom.themePref.v1";

/** How long Android may keep reporting an override we have just dropped before we trust its report again. */
const STALE_REPORT_MS = 5000;

/**
 * What the phone itself was set to when this app started. Read now, at import, before anything here has asked
 * Android to override it (that request only lasts as long as the process does).
 */
const phoneAtStart: Scheme = Appearance.getColorScheme() === "dark" ? "dark" : "light";

export interface ThemeValue extends Theme {
  pref: ThemePref;
  setPref: (pref: ThemePref) => void;
  /**
   * A school's accent, made readable as text, an icon or a thin outline on this scheme's surfaces. The
   * accents are dark enough to carry a white label, so on a dark page they need lifting; use this for the
   * accent as ink, and the accent itself where it is a fill. In light it hands the colour back unchanged.
   */
  accentInk: (accent: string) => string;
}

const INK: Record<Scheme, (accent: string) => string> = {
  light: (accent) => accent,
  // The lightest dark surface is the hardest to read on, so clearing it clears them all.
  dark: (accent) => readableAccent(accent, themes.dark.t.appSurface.lineSoft),
};

// Outside a provider (a test, a screen rendered alone) the apps are as they always were: light.
const ThemeContext = createContext<ThemeValue>({ ...themes.light, pref: "system", setPref: () => {}, accentInk: INK.light });

/**
 * Decides light or dark once, for the whole app: the person's pick if they made one, else the phone's
 * setting. It also tells Android, so the things the app does not draw (dialogs, the keyboard, system
 * widgets) follow the same choice, and keeps the pick across launches. Nothing is drawn until the pick has
 * been read, which is a few milliseconds, so a person who chose dark never sees a flash of light.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const phone = useColorScheme();
  const [pref, setPrefState] = useState<ThemePref | null>(null);
  const prefRef = useRef<ThemePref | null>(null);
  prefRef.current = pref;
  // The phone's own setting, as last seen while we were not overriding it.
  const lastKnownPhone = useRef<Scheme>(phoneAtStart);
  // True from the moment an override is dropped until Android reports the phone's real setting again.
  const [reportStale, setReportStale] = useState(false);
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(PREF_KEY)
      .then((saved) => { if (alive) setPrefState(isThemePref(saved) ? saved : "system"); })
      .catch(() => { if (alive) setPrefState("system"); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (pref !== null) Appearance.setColorScheme(pref === "system" ? null : pref);
  }, [pref]);

  const phoneReport: Scheme = phone === "dark" ? "dark" : "light";

  // While the report is the phone's own, remember it.
  useEffect(() => {
    if (pref === "system" && !reportStale) lastKnownPhone.current = phoneReport;
  }, [pref, phoneReport, reportStale]);

  // Android reported something new: that is the real setting now.
  useEffect(() => {
    setReportStale(false);
  }, [phoneReport]);

  useEffect(() => () => { if (staleTimer.current) clearTimeout(staleTimer.current); }, []);

  const setPref = useCallback((next: ThemePref) => {
    const previous = prefRef.current;
    if (next === "system" && previous !== null && previous !== "system") {
      // The override we are dropping is still what Android reports for a moment.
      setReportStale(true);
      if (staleTimer.current) clearTimeout(staleTimer.current);
      staleTimer.current = setTimeout(() => setReportStale(false), STALE_REPORT_MS);
    }
    setPrefState(next);
    AsyncStorage.setItem(PREF_KEY, next).catch(() => {});
  }, []);

  const chosen = pref ?? "system";
  const scheme = pickScheme(chosen, phoneReport, lastKnownPhone.current, reportStale);
  const value = useMemo<ThemeValue>(() => ({ ...themes[scheme], pref: chosen, setPref, accentInk: INK[scheme] }), [scheme, chosen, setPref]);

  if (pref === null) return null;
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The colours, shared styles and scheme to draw with. Every component that colours itself reads this. */
export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

/**
 * Styles that depend on the colours, for a component that keeps them in a stylesheet. Written like
 * `StyleSheet.create`, but as a function of the theme; it returns a hook that hands back the sheet for the
 * current scheme. Each scheme's sheet is built once, the first time it is wanted, and shared by every
 * instance and every render after.
 *
 *     const useStyles = themedStyles(({ t }) => ({ box: { backgroundColor: t.appSurface.card } }));
 *     // in the component:  const styles = useStyles();
 */
export function themedStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(make: (theme: Theme) => T): () => T {
  const sheets: Partial<Record<Scheme, T>> = {};
  return function useStyles() {
    const { scheme } = useTheme();
    return (sheets[scheme] ??= StyleSheet.create(make(themes[scheme])));
  };
}
