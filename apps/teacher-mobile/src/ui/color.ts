/** Pure colour helpers, kept free of React Native imports so they can be unit-tested on their own. */

export const RIPPLE_ON_LIGHT = "rgba(34, 26, 27, 0.12)";
export const RIPPLE_ON_DARK = "rgba(255, 255, 255, 0.28)";

/** Parses an opaque #RGB, #RRGGBB or rgb() colour into 0-255 channels. Anything else (names, hsl, translucent) is null. */
export function parseOpaqueColor(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.replace(/./g, (c) => c + c) : hex[1]!;
    const n = parseInt(h, 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** WCAG relative luminance: 0 is black, 1 is white. */
export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The ripple that shows on a control with this background: a light wash on a
 * dark fill, a dark one on a light fill. The line sits at 0.4, not at the
 * 0.18 where black and white labels tie, because mid-tones such as the brand
 * orange carry white labels and want the light wash. A background it can't
 * read (none, translucent, a named colour) gets the dark wash; a control that
 * sits on a dark surface without a fill of its own passes `ripple` itself.
 */
export function rippleFor(background: unknown): string {
  const rgb = typeof background === "string" ? parseOpaqueColor(background) : null;
  return rgb && luminance(rgb) < 0.4 ? RIPPLE_ON_DARK : RIPPLE_ON_LIGHT;
}
