/**
 * Per-device display preferences (text size, bolder text, higher contrast,
 * reduced motion). Kept in localStorage rather than on the profile: it's a
 * property of the screen and the eyes in front of it, it has to apply on
 * the sign-in page before anyone is known, and a shared staff-room PC
 * shouldn't force one teacher's 150% text on the next.
 *
 * Text size is CSS `zoom` on #root, not a root font-size: every size in the
 * console is authored in px (text-[13px], the tokens in tailwind.config), so
 * rem scaling would change nothing. zoom scales `100vh` as well, which is
 * why h-screen/min-h-screen are redefined against --ui-zoom in index.css.
 */

export const TEXT_SCALES = [
  { value: 1, label: "Default" },
  { value: 1.15, label: "Large" },
  { value: 1.3, label: "Larger" },
  { value: 1.5, label: "Largest" },
] as const;

export interface A11yPrefs {
  textScale: number;
  bold: boolean;
  contrast: boolean;
  reduceMotion: boolean;
}

export const DEFAULT_A11Y: A11yPrefs = { textScale: 1, bold: false, contrast: false, reduceMotion: false };

const KEY = "figbloom.a11y";

export function loadA11y(): A11yPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_A11Y;
    const p = JSON.parse(raw) as Partial<A11yPrefs>;
    return {
      textScale: TEXT_SCALES.some((s) => s.value === p.textScale) ? p.textScale! : 1,
      bold: p.bold === true,
      contrast: p.contrast === true,
      reduceMotion: p.reduceMotion === true,
    };
  } catch {
    return DEFAULT_A11Y;
  }
}

export function saveA11y(prefs: A11yPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private window / blocked storage: the change still applies for this visit.
  }
  applyA11y(prefs);
}

export function applyA11y(prefs: A11yPrefs) {
  const html = document.documentElement;
  html.style.setProperty("--ui-zoom", String(prefs.textScale));
  const root = document.getElementById("root");
  if (root) root.style.zoom = prefs.textScale === 1 ? "" : String(prefs.textScale);
  html.toggleAttribute("data-a11y-bold", prefs.bold);
  html.toggleAttribute("data-a11y-contrast", prefs.contrast);
  html.toggleAttribute("data-a11y-reduce-motion", prefs.reduceMotion);
}

/** Current zoom, for code that measures the window in CSS px (e.g. deciding whether the sidebar fits). */
export const uiZoom = () => loadA11y().textScale;
