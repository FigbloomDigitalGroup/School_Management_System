/**
 * One flat glyph set. Deliberately typographic rather than illustrated — the
 * console is dense and pictorial icons add noise at 14px.
 */
const GLYPH: Record<string, string> = {
  table: "\u25A4", pulse: "\u25C8", gauge: "\u25F7", flag: "\u2691", cycle: "\u25CD",
  receipt: "\u25A6", mask: "\u25D0", gear: "\u2699", home: "\u25C8", people: "\u25CE",
  grid: "\u2593", megaphone: "\u25C9", chart: "\u25A6", check: "\u2713", clock: "\u25F7",
  chat: "\u25CB", pencil: "\u270E", bell: "\u25C9", back: "\u2039", forward: "\u203A",
  warn: "!", tick: "\u2713", search: "\u2315", close: "\u2715", signout: "\u23FB",
  text: "A",
};

export function Icon({ name, size = 14 }: { name: string; size?: number }) {
  return (
    <span aria-hidden style={{ fontSize: size, lineHeight: 1, width: size + 4, textAlign: "center", display: "inline-block" }}>
      {GLYPH[name] ?? "\u25A1"}
    </span>
  );
}
