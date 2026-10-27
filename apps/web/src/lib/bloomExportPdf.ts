/**
 * A Bloom export (packages/shared bloomExport.ts) drawn as a PDF with pdf-lib.
 * Loaded on demand through bloomExport.ts, so pdf-lib stays out of the chat
 * page's bundle.
 *
 * The fonts are the PDF standard Helvetica and Courier families, like the
 * report cards: no font file to ship, but they only cover Latin-1 and WinAnsi,
 * so every string goes through pdfSafeText() first (accents and curly quotes
 * kept, other scripts simplified). The Word export keeps every character.
 */
import { PDFDocument, PDFString, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { pdfSafeText, type ExportBlock, type ExportDocument, type ExportRun } from "../../../../packages/shared/src/bloomExport";

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;
/** Lowest a line of content may reach; the footer sits below it. */
const BOTTOM = MARGIN + 10;
const WIDTH = A4[0] - MARGIN * 2;
const BODY = 10.5;
const LEADING = 1.45;
/** Per list level. */
const INDENT = 18;
const CELL_PAD = 4;

const INK = rgb(0.11, 0.13, 0.12);
const MUTED = rgb(0.42, 0.45, 0.43);
const LINE = rgb(0.78, 0.8, 0.79);
const SHADE = rgb(0.94, 0.95, 0.94);
const CODE_BG = rgb(0.95, 0.96, 0.95);
const LINK = rgb(0.06, 0.4, 0.27);
const FOREST = rgb(0.09, 0.25, 0.16);

interface Fonts { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont; mono: PDFFont; monoBold: PDFFont }

interface Piece { text: string; font: PDFFont; size: number; color: RGB; href?: string; sup?: boolean; x: number; w: number }
interface Line { pieces: Piece[]; width: number; size: number }

/** Base style for laying out a run of text. */
interface TextStyle { size: number; bold?: boolean; italic?: boolean; color?: RGB }

/** Pages with a cursor that moves down, starting a new page when it runs out. */
class Writer {
  page!: PDFPage;
  y = 0;
  constructor(readonly doc: PDFDocument, readonly fonts: Fonts) { this.addPage(); }

  addPage() {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  get top() { return this.y === A4[1] - MARGIN; }

  /** Makes room for h points, or moves to a new page. */
  need(h: number) {
    if (this.y - h < BOTTOM && !this.top) this.addPage();
  }

  link(x: number, y: number, w: number, h: number, url: string) {
    const ctx = this.doc.context;
    const annot = ctx.register(ctx.obj({
      Type: "Annot", Subtype: "Link", Rect: [x, y, x + w, y + h], Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(pdfUri(url)) },
    }));
    this.page.node.addAnnot(annot);
  }

  rule(x: number, w: number, color = LINE) {
    this.page.drawLine({ start: { x, y: this.y }, end: { x: x + w, y: this.y }, thickness: 0.6, color });
  }
}

/** A URI as a PDF string can hold it: ASCII, with brackets and backslashes escaped the URL way. */
function pdfUri(url: string): string {
  return url.replace(/[^\x21-\x7e]|[()\\]/gu, (c) => [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""));
}

function fontFor(fonts: Fonts, run: ExportRun, base: TextStyle): PDFFont {
  const bold = !!(run.bold || base.bold);
  if (run.code) return bold ? fonts.monoBold : fonts.mono;
  const italic = !!(run.italic || base.italic);
  return bold ? (italic ? fonts.boldItalic : fonts.bold) : italic ? fonts.italic : fonts.regular;
}

/**
 * Runs wrapped to a width: words move to the next line whole, and a word
 * longer than a line (a long address, say) is broken where it must be.
 */
function layout(runs: ExportRun[], fonts: Fonts, width: number, base: TextStyle): Line[] {
  const lines: Line[] = [];
  let line: Line = { pieces: [], width: 0, size: base.size };
  const endLine = () => {
    // no trailing spaces, so centred and right-aligned text sits true
    while (line.pieces.length && !line.pieces[line.pieces.length - 1]!.text.trim()) line.pieces.pop();
    const last = line.pieces[line.pieces.length - 1];
    line.width = last ? last.x + last.w : 0;
    lines.push(line);
    line = { pieces: [], width: 0, size: base.size };
  };
  const add = (text: string, font: PDFFont, size: number, run: ExportRun, color: RGB) => {
    const last = line.pieces[line.pieces.length - 1];
    const x = last ? last.x + last.w : 0;
    const w = font.widthOfTextAtSize(text, size);
    if (last && last.font === font && last.size === size && last.href === run.href && last.sup === run.sup && last.color === color) {
      last.text += text;
      last.w = font.widthOfTextAtSize(last.text, size);
    } else {
      line.pieces.push({ text, font, size, color, href: run.href, sup: run.sup, x, w });
    }
  };
  const cursor = () => { const l = line.pieces[line.pieces.length - 1]; return l ? l.x + l.w : 0; };

  for (const run of runs) {
    const font = fontFor(fonts, run, base);
    const size = run.sup ? base.size * 0.65 : run.code ? base.size * 0.92 : base.size;
    const color = run.href ? LINK : base.color ?? INK;
    for (const token of pdfSafeText(run.text).match(/\n| +|[^ \n]+/g) ?? []) {
      if (token === "\n") { endLine(); continue; }
      if (!token.trim()) { if (line.pieces.length) add(" ", font, size, run, color); continue; }
      let word = token;
      let w = font.widthOfTextAtSize(word, size);
      // a citation stays on its word's line
      if (cursor() + w > width && line.pieces.length && !run.sup) endLine();
      while (w > width - cursor() && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > width - cursor()) cut--;
        if (font.widthOfTextAtSize(word.slice(0, cut), size) > width - cursor() && line.pieces.length) { endLine(); continue; }
        add(word.slice(0, cut), font, size, run, color);
        endLine();
        word = word.slice(cut);
        w = font.widthOfTextAtSize(word, size);
      }
      add(word, font, size, run, color);
    }
  }
  if (line.pieces.length || !lines.length) endLine();
  return lines;
}

const lineHeight = (size: number) => size * LEADING;

/** Draws one laid-out line with its top at w.y, at x (plus an offset for alignment). */
function drawLine(w: Writer, line: Line, x: number) {
  const lh = lineHeight(line.size);
  const baseline = w.y - lh * 0.76;
  for (const p of line.pieces) {
    const y = p.sup ? baseline + line.size * 0.38 : baseline;
    w.page.drawText(p.text, { x: x + p.x, y, size: p.size, font: p.font, color: p.color });
    if (p.href) {
      if (!p.sup) w.page.drawLine({ start: { x: x + p.x, y: y - 1.2 }, end: { x: x + p.x + p.w, y: y - 1.2 }, thickness: 0.4, color: LINK });
      w.link(x + p.x, y - 2, p.w, p.size + 2, p.href);
    }
  }
}

/** Lines down the page from x, a new page when they run out; a quote bar beside each when asked. */
function drawLines(w: Writer, lines: Line[], x: number, opts: { quoteX?: number } = {}) {
  for (const line of lines) {
    const lh = lineHeight(line.size);
    w.need(lh);
    if (opts.quoteX !== undefined) w.page.drawRectangle({ x: opts.quoteX, y: w.y - lh, width: 2.2, height: lh, color: LINE });
    drawLine(w, line, x);
    w.y -= lh;
  }
}

const HEADING_SIZE = [0, 15, 13, 11.5, 10.5];

function drawBlock(w: Writer, block: ExportBlock) {
  const left = MARGIN + block.indent * INDENT + (block.quote ? 12 : 0);
  const width = MARGIN + WIDTH - left;
  const quoteX = block.quote ? left - 9 : undefined;
  const color = block.quote ? MUTED : INK;

  switch (block.kind) {
    case "heading": {
      const size = HEADING_SIZE[block.level]!;
      w.y -= size * 0.5;
      const lines = layout(block.runs, w.fonts, width, { size, bold: true, color });
      // a heading stays with the line after it
      w.need(lineHeight(size) * lines.length + lineHeight(BODY));
      drawLines(w, lines, left, { quoteX });
      w.y -= 2;
      break;
    }
    case "paragraph":
      drawLines(w, layout(block.runs, w.fonts, width, { size: BODY, color }), left, { quoteX });
      w.y -= BODY * 0.55;
      break;
    case "listItem": {
      const textX = left + INDENT;
      const lines = layout(block.runs, w.fonts, width - INDENT, { size: BODY, color });
      const lh = lineHeight(BODY);
      w.need(lh);
      const marker = block.ordered ? `${block.number}.` : (["•", "–", "·"][block.indent % 3]!);
      const font = w.fonts.regular;
      const mw = font.widthOfTextAtSize(marker, BODY);
      w.page.drawText(marker, { x: textX - 5 - mw, y: w.y - lh * 0.76, size: BODY, font, color: block.ordered ? color : MUTED });
      drawLines(w, lines, textX, { quoteX });
      w.y -= BODY * 0.25;
      break;
    }
    case "code":
      drawCode(w, block.text, left, width);
      w.y -= BODY * 0.55;
      break;
    case "table":
      drawTable(w, block, left, width);
      w.y -= BODY * 0.7;
      break;
    case "rule":
      w.need(12);
      w.y -= 5;
      w.rule(left, width);
      w.y -= 8;
      break;
  }
}

/** Monospace on a shaded panel; long lines wrap, and a long block carries on over pages. */
function drawCode(w: Writer, text: string, x: number, width: number) {
  const size = 8.5;
  const lh = size * 1.4;
  const pad = 6;
  const font = w.fonts.mono;
  const perLine = Math.max(8, Math.floor((width - pad * 2) / font.widthOfTextAtSize("M", size)));
  const lines: string[] = [];
  for (const raw of pdfSafeText(text).split("\n")) {
    let l = raw.replace(/\s+$/, "");
    if (!l) { lines.push(""); continue; }
    while (l.length > perLine) { lines.push(l.slice(0, perLine)); l = l.slice(perLine); }
    lines.push(l);
  }
  let i = 0;
  while (i < lines.length) {
    // keep at least two lines together (or the whole of a short block) when starting low on a page
    if (w.y - BOTTOM < pad * 2 + lh * Math.min(2, lines.length - i)) w.addPage();
    const fit = Math.max(1, Math.floor((w.y - BOTTOM - pad * 2) / lh));
    const chunk = lines.slice(i, i + fit);
    const h = chunk.length * lh + pad * 2;
    w.page.drawRectangle({ x, y: w.y - h, width, height: h, color: CODE_BG, borderColor: LINE, borderWidth: 0.5 });
    chunk.forEach((l, k) => {
      if (l) w.page.drawText(l, { x: x + pad, y: w.y - pad - lh * k - size * 1.02, size, font, color: INK });
    });
    w.y -= h;
    i += chunk.length;
    if (i < lines.length) w.addPage();
  }
}

/** Column widths that fit the space: each gets its longest word, and the rest is shared by how much more it wants. */
function columnWidths(w: Writer, block: Extract<ExportBlock, { kind: "table" }>, width: number, size: number): number[] {
  const n = block.head.length;
  const measure = (runs: ExportRun[], bold: boolean) => {
    let full = 0;
    let word = 0;
    for (const r of runs) {
      const font = fontFor(w.fonts, r, { size, bold });
      const s = r.sup ? size * 0.65 : size;
      const text = pdfSafeText(r.text);
      full += font.widthOfTextAtSize(text.replace(/\n/g, " "), s);
      for (const part of text.split(/[ \n]+/)) word = Math.max(word, font.widthOfTextAtSize(part, s));
    }
    return { full, word };
  };
  const want = new Array<number>(n).fill(0);
  const least = new Array<number>(n).fill(0);
  [block.head, ...block.rows].forEach((row, r) => row.forEach((cell, c) => {
    const m = measure(cell, r === 0);
    want[c] = Math.max(want[c]!, Math.min(m.full, width) + CELL_PAD * 2);
    least[c] = Math.max(least[c]!, Math.min(m.word, width / n) + CELL_PAD * 2);
  }));
  const wantSum = want.reduce((a, b) => a + b, 0);
  // everything fits on one line each: share out the spare room to fill the width, as the chat's tables do
  if (wantSum <= width) return want.map((x) => (x / wantSum) * width);
  const leastSum = least.reduce((a, b) => a + b, 0);
  if (leastSum >= width) return least.map((x) => (x / leastSum) * width);
  const extra = want.map((x, i) => x - least[i]!);
  const extraSum = extra.reduce((a, b) => a + b, 0) || 1;
  return least.map((x, i) => x + (extra[i]! / extraSum) * (width - leastSum));
}

/**
 * A bordered table with a shaded header row. A row that won't fit moves to
 * the next page, the header repeated above it; a row taller than a page is
 * split between pages.
 */
function drawTable(w: Writer, block: Extract<ExportBlock, { kind: "table" }>, x: number, width: number) {
  const size = 9;
  const lh = lineHeight(size);
  const widths = columnWidths(w, block, width, size);
  const lefts = widths.map((_, i) => x + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const cellLines = (row: ExportRun[][], bold: boolean) => row.map((cell, c) => layout(cell, w.fonts, widths[c]! - CELL_PAD * 2, { size, bold }));
  const head = cellLines(block.head, true);
  const headH = Math.max(...head.map((l) => l.length)) * lh + CELL_PAD * 2;

  const drawRow = (cells: Line[][], height: number, shaded: boolean) => {
    cells.forEach((lines, c) => {
      const cx = lefts[c]!;
      const cw = widths[c]!;
      w.page.drawRectangle({ x: cx, y: w.y - height, width: cw, height, color: shaded ? SHADE : undefined, borderColor: LINE, borderWidth: 0.6 });
      const top = w.y;
      w.y -= CELL_PAD;
      for (const line of lines) {
        const room = cw - CELL_PAD * 2;
        const a = block.align[c];
        const off = a === "right" ? room - line.width : a === "center" ? (room - line.width) / 2 : 0;
        drawLine(w, line, cx + CELL_PAD + off);
        w.y -= lh;
      }
      w.y = top;
    });
    w.y -= height;
  };
  const header = () => drawRow(head, headH, true);

  w.need(headH + lh + CELL_PAD * 2);
  header();
  for (const row of block.rows) {
    let cells = cellLines(row, false);
    for (;;) {
      const tall = Math.max(1, ...cells.map((l) => l.length));
      const h = tall * lh + CELL_PAD * 2;
      const room = w.y - BOTTOM;
      if (h <= room) { drawRow(cells, h, false); break; }
      const pageRoom = A4[1] - MARGIN - BOTTOM - headH;
      const fits = Math.floor((room - CELL_PAD * 2) / lh);
      // move the whole row on if it fits a fresh page, or if only a sliver would stay here
      if (h <= pageRoom || fits < 2) { w.addPage(); header(); continue; }
      drawRow(cells.map((l) => l.slice(0, fits)), fits * lh + CELL_PAD * 2, false);
      cells = cells.map((l) => l.slice(fits));
      w.addPage();
      header();
    }
  }
}

/** The file's bytes. */
export async function renderBloomPdf(d: ExportDocument): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafeText(d.title));
  doc.setAuthor(pdfSafeText(d.schoolName));
  doc.setSubject(d.disclaimer);
  doc.setCreator("Figbloom School Systems - Bloom");
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
  };
  const w = new Writer(doc, fonts);

  // header
  w.page.drawRectangle({ x: 0, y: A4[1] - 6, width: A4[0], height: 6, color: FOREST });
  drawLines(w, layout([{ text: d.title, bold: true }], fonts, WIDTH, { size: 17, color: FOREST }), MARGIN);
  drawLines(w, layout([{ text: [d.schoolName, d.date].filter(Boolean).join("  ·  ") }], fonts, WIDTH, { size: 9.5, color: MUTED }), MARGIN);
  drawLines(w, layout([{ text: d.disclaimer, italic: true }], fonts, WIDTH, { size: 7.5, color: MUTED }), MARGIN);
  w.y -= 6;
  w.rule(MARGIN, WIDTH);
  w.y -= 12;

  d.sections.forEach((s, i) => {
    if (s.label) {
      if (i > 0) { w.y -= 6; w.need(lineHeight(BODY) * 3); }
      const label = [s.label, s.time].filter(Boolean).join("  ·  ");
      drawLines(w, layout([{ text: label, bold: true }], fonts, WIDTH, { size: 8.5, color: s.label === "Bloom" ? FOREST : MUTED }), MARGIN);
      w.y -= 3;
    }
    for (const b of s.blocks) drawBlock(w, b);
  });

  if (d.sources.length) {
    w.y -= 8;
    w.need(lineHeight(BODY) * 4);
    w.rule(MARGIN, WIDTH);
    w.y -= 8;
    drawBlock(w, { kind: "heading", level: 2, indent: 0, runs: [{ text: "Sources" }] });
    for (const s of d.sources) {
      const lines = layout([{ text: s.title, href: s.url }], fonts, WIDTH - INDENT, { size: 9.5 });
      const url = layout([{ text: s.url, href: s.url }], fonts, WIDTH - INDENT, { size: 8 });
      w.need(lineHeight(9.5) + lineHeight(8));
      const n = `${s.n}.`;
      w.page.drawText(n, { x: MARGIN + INDENT - 5 - fonts.regular.widthOfTextAtSize(n, 9.5), y: w.y - lineHeight(9.5) * 0.76, size: 9.5, font: fonts.regular, color: INK });
      drawLines(w, lines, MARGIN + INDENT);
      drawLines(w, url.map((l) => ({ ...l, pieces: l.pieces.map((p) => ({ ...p, color: MUTED })) })), MARGIN + INDENT);
      w.y -= 4;
    }
  }

  // footer on every page
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    page.drawText(d.disclaimer, { x: MARGIN, y: MARGIN - 18, size: 7, font: fonts.italic, color: MUTED });
    const label = `Page ${i + 1} of ${pages.length}`;
    page.drawText(label, { x: A4[0] - MARGIN - fonts.regular.widthOfTextAtSize(label, 7), y: MARGIN - 18, size: 7, font: fonts.regular, color: MUTED });
  });

  return doc.save();
}
