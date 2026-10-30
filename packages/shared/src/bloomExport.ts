import { chatTitleFrom, type AiChatSource } from "./aiChat";
import { parseMarkdown, type Align, type Block, type Inline } from "./markdown";

/**
 * Bloom replies and whole chats as a small document model, for the web app's
 * PDF and Word downloads (apps/web/src/lib/bloomExport*.ts) to draw. Built
 * from parseMarkdown's tree, so the files match what the chat shows. Pure and
 * DOM-free like the rest of this package; the drawing and the download stay in
 * the app.
 *
 * Each answer numbers its own sources from 1 ([^n], aiChat.ts). A file has one
 * numbered list at the end, so markers are renumbered across the chat; a page
 * cited by two answers keeps one number. A marker with no usable source (a
 * gap parseChatSources left) is dropped rather than pointing nowhere.
 */

/** A stretch of text with one style. A citation is a superscript run whose text is its number. */
export interface ExportRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  sup?: boolean;
  href?: string;
}

/**
 * One block of the file, flattened: lists become items with a level, and
 * anything inside a list item carries its `indent` (how many list levels it
 * sits in). `quote` marks blocks inside a block quote.
 */
export type ExportBlock = { indent: number; quote?: boolean } & (
  | { kind: "heading"; level: 1 | 2 | 3 | 4; runs: ExportRun[] }
  | { kind: "paragraph"; runs: ExportRun[] }
  /** `indent` is the list level; `listId` tells two numbered lists apart so each starts its own count. */
  | { kind: "listItem"; ordered: boolean; number: number; listId: number; runs: ExportRun[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; align: Align[]; head: ExportRun[][]; rows: ExportRun[][][] }
  | { kind: "rule" }
);

export interface ExportSection {
  /** "You" or "Bloom" in a whole-chat export; null for a single reply. */
  label: string | null;
  /** When it was said, already formatted; null when it wasn't saved. */
  time: string | null;
  blocks: ExportBlock[];
}

export interface ExportSourceEntry { n: number; title: string; url: string }

export interface ExportDocument {
  title: string;
  schoolName: string;
  /** The day of the export, formatted for the page. */
  date: string;
  disclaimer: string;
  sections: ExportSection[];
  sources: ExportSourceEntry[];
}

/** A turn as the chat holds it: an answer's text is Markdown, a question is plain text. */
export interface ExportTurn {
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  sources?: AiChatSource[];
}

export const BLOOM_EXPORT_DISCLAIMER = "Drafted with Bloom (AI). Check before use.";

const longDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/** "27 Oct 2026, 14:05" for a saved turn; null when it has no (valid) time. */
export function exportTimestamp(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** The title on the page: the chat's name, else the first question's first words. */
export function exportTitle(chatTitle: string | null | undefined, turns: ExportTurn[]): string {
  const t = chatTitle?.trim();
  if (t && t !== "New chat") return t;
  const question = turns.find((x) => x.role === "user")?.content ?? turns[0]?.content ?? "";
  const words = chatTitleFrom(question);
  return words === "New chat" ? "Bloom chat" : words;
}

/**
 * The document for one answer (`labelTurns: false`) or a whole chat, where
 * each turn is headed "You" or "Bloom" with its time.
 */
export function buildBloomExport(input: {
  title: string; schoolName: string; turns: ExportTurn[]; labelTurns: boolean; now: Date;
}): ExportDocument {
  const sources: ExportSourceEntry[] = [];
  const byUrl = new Map<string, number>();
  let listIds = 0;

  const sections = input.turns.map((turn): ExportSection => {
    // this answer's [^n] -> the file's number
    const local = (turn.sources ?? []).map((s) => {
      if (!s.url) return null;
      let n = byUrl.get(s.url);
      if (n === undefined) {
        n = sources.length + 1;
        byUrl.set(s.url, n);
        sources.push({ n, title: s.title || s.url, url: s.url });
      }
      return { n, url: s.url };
    });
    const ctx: Ctx = { cite: (n) => local[n - 1] ?? null, nextListId: () => ++listIds };
    const blocks = turn.role === "assistant" ? convertBlocks(parseMarkdown(turn.content), ctx, 0, false) : plainBlocks(turn.content);
    return {
      label: input.labelTurns ? (turn.role === "user" ? "You" : "Bloom") : null,
      time: input.labelTurns ? exportTimestamp(turn.created_at) : null,
      blocks,
    };
  });

  return {
    title: input.title,
    schoolName: input.schoolName,
    date: longDate(input.now),
    disclaimer: BLOOM_EXPORT_DISCLAIMER,
    sections,
    sources,
  };
}

interface Ctx { cite: CiteLookup; nextListId: () => number }

/** The file's number and address for an answer's [^n], or null when it has no such source. */
export type CiteLookup = (n: number) => { n: number; url: string } | null;

/** A question as typed: paragraphs at blank lines, its line breaks kept, nothing read as formatting. */
function plainBlocks(text: string): ExportBlock[] {
  return text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.replace(/^\n+|\s+$/g, "")).filter(Boolean)
    .map((p) => ({ kind: "paragraph", indent: 0, runs: [{ text: p }] }));
}

function convertBlocks(blocks: Block[], ctx: Ctx, indent: number, quote: boolean): ExportBlock[] {
  const out: ExportBlock[] = [];
  const q = quote ? { quote: true } : {};
  for (const b of blocks) {
    switch (b.kind) {
      case "heading": out.push({ kind: "heading", level: b.level, indent, ...q, runs: convertInline(b.children, ctx) }); break;
      case "paragraph": out.push({ kind: "paragraph", indent, ...q, runs: convertInline(b.children, ctx) }); break;
      case "code": out.push({ kind: "code", indent, ...q, lang: b.lang, text: b.text }); break;
      case "rule": out.push({ kind: "rule", indent, ...q }); break;
      case "quote": out.push(...convertBlocks(b.children, ctx, indent, true)); break;
      case "table":
        out.push({
          kind: "table", indent, ...q, align: b.align,
          head: b.head.map((c) => convertInline(c, ctx)),
          rows: b.rows.map((r) => r.map((c) => convertInline(c, ctx))),
        });
        break;
      case "list": {
        const listId = ctx.nextListId();
        b.items.forEach((item, i) => {
          // the item's first paragraph sits by its marker; anything after it is indented under it
          const [first, ...rest] = item;
          const lead = first?.kind === "paragraph" ? first : null;
          out.push({ kind: "listItem", indent, ...q, ordered: b.ordered, number: b.start + i, listId, runs: lead ? convertInline(lead.children, ctx) : [] });
          out.push(...convertBlocks(lead ? rest : item, ctx, indent + 1, quote));
        });
        break;
      }
    }
  }
  return out;
}

type Style = Omit<ExportRun, "text">;

/** Inline Markdown as flat runs; adjacent runs with the same style are joined. */
export function convertInline(nodes: Inline[], ctx: { cite: CiteLookup }, style: Style = {}): ExportRun[] {
  const out: ExportRun[] = [];
  const push = (run: ExportRun) => {
    const last = out[out.length - 1];
    if (last && !run.sup && !last.sup && sameStyle(last, run)) last.text += run.text;
    else out.push(run);
  };
  for (const n of nodes) {
    switch (n.kind) {
      case "text": push({ ...style, text: n.text }); break;
      case "break": push({ ...style, text: "\n" }); break;
      case "code": push({ ...style, code: true, text: n.text }); break;
      case "strong": convertInline(n.children, ctx, { ...style, bold: true }).forEach(push); break;
      case "em": convertInline(n.children, ctx, { ...style, italic: true }).forEach(push); break;
      case "link": convertInline(n.children, ctx, { ...style, href: n.href }).forEach(push); break;
      case "cite": {
        const src = ctx.cite(n.n);
        if (!src) break;
        // the number sits against its word ("day¹"), not after a space
        const last = out[out.length - 1];
        if (last && !last.sup && /\s$/.test(last.text)) {
          last.text = last.text.trimEnd();
          if (!last.text) out.pop();
        }
        out.push({ text: String(src.n), sup: true, href: src.url });
        break;
      }
    }
  }
  return out;
}

function sameStyle(a: Style, b: Style): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code && a.href === b.href;
}

/** A run's text without any style, e.g. for measuring a table column. */
export function runsText(runs: ExportRun[]): string {
  return runs.map((r) => r.text).join("");
}

// ------------------------------------------------------------------ tables as spreadsheets

/** A table from a reply, as plain cell text, for CSV and Excel. */
export interface ReplyTable {
  /** The heading above it, or "Table n". */
  name: string;
  head: string[];
  rows: string[][];
}

/** A cell's text: formatting dropped, citation markers left out, line breaks as spaces. */
function cellText(nodes: Inline[]): string {
  return nodes.map((n) => n.kind === "text" || n.kind === "code" ? n.text : n.kind === "break" ? " " : n.kind === "cite" ? "" : cellText(n.children))
    .join("").replace(/\s+/g, " ").trim();
}

/** Every table in a reply, in order, including any inside a list or quote. */
export function replyTables(markdown: string): ReplyTable[] {
  const out: ReplyTable[] = [];
  let heading = "";
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.kind === "heading") heading = cellText(b.children);
      else if (b.kind === "quote") walk(b.children);
      else if (b.kind === "list") b.items.forEach(walk);
      else if (b.kind === "table") {
        out.push({ name: heading || `Table ${out.length + 1}`, head: b.head.map(cellText), rows: b.rows.map((r) => r.map(cellText)) });
        heading = "";
      }
    }
  };
  walk(parseMarkdown(markdown));
  return out;
}

const MONEY_PREFIX = /^(?:KES|KSh|Ksh|Kshs|USD|US\$|\$|€|£)\.?\s?/i;

/**
 * The number a cell clearly holds ("1,250", "KES 1,250", "-3.5", "Ksh. 2,000.50"),
 * or null when it's text. Leading zeros (a phone number, an admission number)
 * and very long digit runs stay text, so nothing is lost; so do percentages,
 * ranges ("80 - 100") and anything with words.
 */
export function spreadsheetNumber(text: string): number | null {
  const t = text.trim().replace(MONEY_PREFIX, "").replace(/^−/, "-");
  const m = /^(-?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/.exec(t);
  if (!m) return null;
  const digits = m[2]!.replace(/,/g, "");
  if ((digits.length > 1 && digits.startsWith("0") && !m[3]) || digits.length > 15) return null;
  const n = Number(`${m[1]}${digits}${m[3] ?? ""}`);
  return Number.isFinite(n) ? n : null;
}

/** A sheet name Excel accepts: no []:*?/\, at most 31 characters, unique in the workbook. */
export function sheetName(name: string, taken: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]+/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "").slice(0, 31).trim() || "Table";
  let out = base;
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${base.slice(0, 31 - ` (${i})`.length)} (${i})`;
  taken.add(out.toLowerCase());
  return out;
}

// ------------------------------------------------------------------ file names

const two = (n: number) => String(n).padStart(2, "0");

/** "Bloom - Half term circular - 2026-10-27.pdf": characters no file system allows are taken out. */
export function bloomExportFileName(title: string, now: Date, ext: "pdf" | "docx" | "xlsx" | "csv"): string {
  let name = [...title].map((c) => (c.charCodeAt(0) < 0x20 || c === "\u007f" ? " " : c)).join("")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/…/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (name.length > 80) {
    const cut = name.slice(0, 80);
    const space = cut.lastIndexOf(" ");
    name = (space > 40 ? cut.slice(0, space) : cut).trim();
  }
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return `Bloom - ${name || "chat"} - ${date}.${ext}`;
}

/// ------------------------------------------------------------------ PDF text

// What the standard PDF fonts (WinAnsi) can draw beyond Latin-1.
const WIN_ANSI_EXTRA = new Set([..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"].map((c) => c.codePointAt(0)!));

/** Whether a font can draw a character, by its code point. */
export type GlyphCheck = (codePoint: number) => boolean;

/** What the standard Helvetica and Courier can draw: Latin-1 and WinAnsi's extras. */
export const winAnsiGlyphs: GlyphCheck = (k) => (k >= 0x20 && k <= 0x7e) || (k >= 0xa1 && k <= 0xff && k !== 0xad) || WIN_ANSI_EXTRA.has(k);

// Common characters a font may lack, put as their nearest plain spelling.
const PLAIN: Record<string, string> = {
  "‐": "-", "‑": "-", "‒": "-", "―": "—", "−": "-",
  "′": "'", "″": '"', "‛": "'", "‟": "”",
  "←": "<-", "→": "->", "↔": "<->", "⇒": "=>", "⇐": "<=",
  "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "∞": "infinity",
  "✓": "[x]", "✔": "[x]", "✅": "[x]", "☑": "[x]", "✗": "x", "✘": "x", "❌": "x", "☐": "[ ]",
  "●": "•", "◦": "•", "▪": "•", "∙": "•", "‣": "•",
  "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "ı": "i", "Ŋ": "Ng", "ŋ": "ng", "ħ": "h",
};

/** Characters that draw nothing: controls, zero-width joiners and spaces, variation selectors, soft hyphen, BOM, tag characters. */
const invisible = (k: number) =>
  k < 0x20 || (k >= 0x7f && k <= 0x9f) || k === 0xad || (k >= 0x200b && k <= 0x200f) || (k >= 0x2060 && k <= 0x206f)
  || (k >= 0xfe00 && k <= 0xfe0f) || k === 0xfeff || (k >= 0xe0000 && k <= 0xe007f);

/**
 * Text a PDF font can draw. `has` says which characters the font has: the
 * export embeds Noto Sans (apps/web bloomExportPdf.ts), which covers Latin
 * with its accents, Greek, Cyrillic, curly quotes, dashes and signs such as
 * € £ ₦; left out, it's the standard fonts' WinAnsi. Whatever the font lacks
 * falls back: a few symbols become their plain spelling (→ "->", ≥ ">="), an
 * accented letter loses the accent when the bare letter can be drawn
 * (ş -> s), emoji, stray accent marks and invisible characters are left out,
 * and anything else (a script the font doesn't cover) becomes "?". Every kind
 * of space becomes a plain one, spaces are kept for code, and a tab becomes four.
 */
export function pdfSafeText(s: string, has: GlyphCheck = winAnsiGlyphs): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    if (ch === "\t") { out += "    "; continue; }
    if (ch === "\n") { out += ch; continue; }
    if (/\p{Z}/u.test(ch)) { out += " "; continue; }
    if (invisible(code)) continue;
    if (has(code)) { out += ch; continue; }
    const plain = PLAIN[ch];
    if (plain !== undefined && [...plain].every((c) => has(c.codePointAt(0)!))) { out += plain; continue; }
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{M}/u.test(ch) || (code >= 0x1f3fb && code <= 0x1f3ff)) continue;
    const bare = ch.normalize("NFKD").replace(/\p{M}/gu, "");
    out += bare && [...bare].every((c) => has(c.codePointAt(0)!)) ? bare : "?";
  }
  return out;
}
