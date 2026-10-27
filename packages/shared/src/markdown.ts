/**
 * Just enough Markdown for Bloom chat replies: headings, paragraphs, lists
 * (nested), fenced code, tables, quotes, rules, and inline bold, italics,
 * code and links. Parsed into a small tree that each app renders as its own
 * elements -- never as HTML, so nothing a model writes can become markup or
 * script. Our own rather than a library: the replies only need this much, and
 * every dependency is one more thing in the build (.agents/SECURITY.md).
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "break" };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: Block[][] }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "quote"; children: Block[] }
  | { kind: "rule" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || BULLET.test(line) || NUMBERED.test(line) || QUOTE.test(line);
}

function cells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  // split on pipes that aren't escaped (no lookbehind: older mobile JS engines lack it)
  return t.replace(/\\\|/g, "\u0000").split("|").map((c) => c.trim().split("\u0000").join("|"));
}

export function parseMarkdown(source: string): Block[] {
  return parseLines(source.replace(/\r\n?/g, "\n").split("\n"));
}

function parseLines(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!);
      i++; // the closing fence, or past the end of an unclosed one
      out.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: "heading", level: Math.min(heading[1]!.length, 4) as 1 | 2 | 3 | 4, children: parseInline(heading[2]!) });
      i++;
      continue;
    }

    if (RULE.test(line)) { out.push({ kind: "rule" }); i++; continue; }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      out.push({ kind: "quote", children: parseLines(body) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]!).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        const row = cells(lines[i++]!);
        rows.push(head.map((_, c) => parseInline(row[c] ?? "")));
      }
      out.push({ kind: "table", align: head.map((_, c) => align[c] ?? null), head: head.map((h) => parseInline(h)), rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const indent = (bullet ?? numbered)![1]!.length;
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = pattern.exec(l);
        if (m && m[1]!.length === indent) { items.push([m[3]!]); i++; continue; }
        // a blank line ends the list unless the next line carries on inside it
        if (!l.trim()) {
          const next = lines[i + 1];
          if (next !== undefined && (next.search(/\S/) > indent || (pattern.exec(next)?.[1]?.length === indent))) { items[items.length - 1]!.push(""); i++; continue; }
          break;
        }
        const lead = l.search(/\S/);
        if (lead > indent) { items[items.length - 1]!.push(l.slice(Math.min(lead, indent + 4))); i++; continue; }
        // a lazy continuation of the item's paragraph
        if (!startsBlock(l)) { items[items.length - 1]!.push(l.trim()); i++; continue; }
        break;
      }
      out.push({ kind: "list", ordered, start: ordered ? Number(numbered![2]) : 1, items: items.map((it) => parseLines(it)) });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !(para.length && startsBlock(lines[i]!))) para.push(lines[i++]!);
    out.push({ kind: "paragraph", children: parseInline(para.map((l) => l.trim()).join("\n")) });
  }
  return out;
}

/** Only links a person can safely follow; anything else stays as its text. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ kind: "text", text: buf }); buf = ""; } };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const rest = text.slice(i);

    if (c === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(text[i + 1]!)) { buf += text[i + 1]; i += 2; continue; }

    if (c === "\n") { flush(); out.push({ kind: "break" }); i++; continue; }

    if (c === "`") {
      const run = /^`+/.exec(rest)![0];
      const close = text.indexOf(run, i + run.length);
      if (close > 0) { flush(); out.push({ kind: "code", text: text.slice(i + run.length, close).trim() }); i = close + run.length; continue; }
    }

    if ((rest.startsWith("**") || rest.startsWith("__")) && rest.length > 4) {
      const close = text.indexOf(rest.slice(0, 2), i + 2);
      if (close > i + 2) { flush(); out.push({ kind: "strong", children: parseInline(text.slice(i + 2, close)) }); i = close + 2; continue; }
    }

    // single * or _ for italics; _ only at word edges, so snake_case stays as it is
    if ((c === "*" || (c === "_" && !/\w/.test(text[i - 1] ?? ""))) && text[i + 1] && !/\s/.test(text[i + 1]!)) {
      let close = text.indexOf(c, i + 1);
      while (close > 0 && (text[close + 1] === c || (c === "_" && /\w/.test(text[close + 1] ?? "")))) close = text.indexOf(c, close + 2);
      if (close > i + 1 && !/\s/.test(text[close - 1]!)) { flush(); out.push({ kind: "em", children: parseInline(text.slice(i + 1, close)) }); i = close + 1; continue; }
    }

    if (c === "[") {
      // one level of brackets inside the address, as Wikipedia links have
      const m = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (m) {
        const href = safeHref(m[2]!);
        flush();
        if (href) out.push({ kind: "link", href, children: parseInline(m[1]!) });
        else out.push(...parseInline(m[1]!));
        i += m[0].length;
        continue;
      }
    }

    if (c === "h" && /^https?:\/\//.test(rest)) {
      const m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest);
      if (m) { flush(); out.push({ kind: "link", href: m[0], children: [{ kind: "text", text: m[0] }] }); i += m[0].length; continue; }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

/** The text of a reply without its formatting, e.g. for a screen reader summary or a plain copy. */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => n.kind === "text" || n.kind === "code" ? n.text : n.kind === "break" ? "\n" : inlineText(n.children)).join("");
}
