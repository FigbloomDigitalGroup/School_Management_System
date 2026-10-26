import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { formatMoney } from "./fees";
import type { ReportCardData } from "./reportCards";

/**
 * Report cards and class results sheets as real PDF files, drawn with
 * pdf-lib so the same code runs in the browser and (later) the mobile apps.
 * Input is the stored snapshot (reportCards.ts), never live marks, so the
 * file a parent downloads is the card the school issued.
 *
 * Fonts are the PDF standard Helvetica pair: no font files to ship, but they
 * only cover Latin-1, so every string goes through pdfText() first.
 */

export interface PdfLogo { bytes: Uint8Array; type: "png" | "jpg" }

export interface PrintableCard {
  data: ReportCardData;
  teacherComment: string | null;
  principalComment: string | null;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 40;
const INK = rgb(0.11, 0.13, 0.12);
const MUTED = rgb(0.42, 0.45, 0.43);
const LINE = rgb(0.85, 0.86, 0.85);
const SHADE = rgb(0.95, 0.96, 0.95);

// Characters the standard fonts can draw beyond Latin-1 (WinAnsi's extras).
const WIN_ANSI_EXTRA = new Set([..."‘’“”–—•…€™"]);

/** Makes text safe for the standard PDF fonts: accents kept where Latin-1 has them, the rest simplified. */
export function pdfText(s: string | null | undefined): string {
  if (!s) return "";
  let out = "";
  for (const ch of s.replace(/\s+/g, " ")) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) { out += ch; continue; }
    const plain = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += /^[\x20-\x7e]+$/.test(plain) ? plain : "?";
  }
  return out;
}

function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return rgb(0.11, 0.3, 0.18);
  const n = parseInt(m[1]!, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const dash = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? "-" : String(v));

/** Wraps text to a width, breaking words that are longer than a line. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of pdfText(text).split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Cuts text to fit a width, with an ellipsis. */
function fit(text: string, font: PDFFont, size: number, width: number): string {
  let t = pdfText(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
  return `${t}…`;
}

interface Fonts { regular: PDFFont; bold: PDFFont }

/** A page with a cursor that moves down, starting a new page when it runs out. */
class Sheet {
  page!: PDFPage;
  y = 0;
  constructor(
    private doc: PDFDocument, readonly fonts: Fonts, private size: [number, number],
    private onNewPage: (s: Sheet, continued: boolean) => void,
  ) { this.addPage(false); }

  get width() { return this.size[0]; }
  get inner() { return this.size[0] - MARGIN * 2; }

  addPage(continued: boolean) {
    this.page = this.doc.addPage(this.size);
    this.y = this.size[1] - MARGIN;
    this.onNewPage(this, continued);
  }

  /** Makes room for h points, or moves to a new page. */
  need(h: number) {
    if (this.y - h < MARGIN + 24) this.addPage(true);
  }

  text(t: string, x: number, size: number, opts: { bold?: boolean; color?: RGB; y?: number; align?: "left" | "right" | "center"; width?: number } = {}) {
    const font = opts.bold ? this.fonts.bold : this.fonts.regular;
    const s = opts.width ? fit(t, font, size, opts.width) : pdfText(t);
    const w = font.widthOfTextAtSize(s, size);
    const left = opts.align === "right" ? x - w : opts.align === "center" ? x - w / 2 : x;
    this.page.drawText(s, { x: left, y: opts.y ?? this.y, size, font, color: opts.color ?? INK });
  }

  rule(y = this.y, color = LINE) {
    this.page.drawLine({ start: { x: MARGIN, y }, end: { x: this.width - MARGIN, y }, thickness: 0.6, color });
  }

  box(x: number, y: number, w: number, h: number, color: RGB) {
    this.page.drawRectangle({ x, y, width: w, height: h, color });
  }
}

// ------------------------------------------------------------------ report card

interface Col { label: string; width: number; align: "left" | "right" | "center"; value: (s: ReportCardData["subjects"][number]) => string }

function subjectColumns(d: ReportCardData, inner: number): Col[] {
  const fixed: Col[] = [
    ...d.exams.map((e, i) => ({ label: e.name, width: 46, align: "center" as const, value: (s: ReportCardData["subjects"][number]) => dash(s.scores[i]) })),
    { label: "Average", width: 46, align: "center", value: (s) => dash(s.average) },
    { label: "Grade", width: 38, align: "center", value: (s) => dash(s.grade) },
    ...(d.scheme === "kcse" ? [{ label: "Points", width: 38, align: "center" as const, value: (s: ReportCardData["subjects"][number]) => dash(s.points) }] : []),
    { label: "Class mean", width: 50, align: "center", value: (s) => dash(s.classMean) },
  ];
  const used = fixed.reduce((a, c) => a + c.width, 0);
  return [{ label: "Subject", width: Math.max(110, inner - used), align: "left", value: (s) => s.name }, ...fixed];
}

function drawCard(doc: PDFDocument, fonts: Fonts, card: PrintableCard, logo: PDFImage | null) {
  const d = card.data;
  const accent = hexToRgb(d.school.accent);
  const firstPage = doc.getPageCount();

  const sheet = new Sheet(doc, fonts, A4, (s, continued) => {
    s.box(0, A4[1] - 6, A4[0], 6, accent);
    if (continued) {
      s.text(`${d.learner.name} - ${d.term.name} report card (continued)`, MARGIN, 9, { color: MUTED });
      s.y -= 20;
    }
  });

  // header
  const top = sheet.y;
  let nameX = MARGIN;
  if (logo) {
    const h = 46;
    const w = Math.min(70, (logo.width / logo.height) * h);
    sheet.page.drawImage(logo, { x: MARGIN, y: top - h + 8, width: w, height: h });
    nameX += w + 12;
  }
  sheet.text(d.school.name, nameX, 16, { bold: true, y: top - 8, width: sheet.width - MARGIN - nameX - 150 });
  if (d.school.county) sheet.text(d.school.county, nameX, 9, { color: MUTED, y: top - 24 });
  sheet.text("REPORT CARD", sheet.width - MARGIN, 12, { bold: true, align: "right", y: top - 8, color: accent });
  sheet.text(d.term.name, sheet.width - MARGIN, 9, { align: "right", y: top - 24, color: MUTED });
  sheet.y = top - 52;
  sheet.rule();

  // learner
  sheet.y -= 18;
  const cols = [
    ["Name", d.learner.name], ["Admission no.", d.learner.admissionNo],
    ["Class", d.learner.className], ["Term", `${shortDate(d.term.startsOn)} - ${shortDate(d.term.endsOn)}`],
  ];
  const colW = sheet.inner / 4;
  cols.forEach(([label, value], i) => {
    sheet.text(label!, MARGIN + i * colW, 8, { color: MUTED });
    sheet.text(value!, MARGIN + i * colW, 10, { bold: true, y: sheet.y - 13, width: colW - 8 });
  });
  sheet.y -= 34;

  // subjects
  const table = subjectColumns(d, sheet.inner);
  if (d.subjects.length) {
    const header = () => {
      sheet.need(26);
      const h = 22;
      sheet.box(MARGIN, sheet.y - h + 4, sheet.inner, h, SHADE);
      let x = MARGIN;
      for (const c of table) {
        const lines = wrap(c.label, fonts.bold, 7, c.width - 4).slice(0, 2);
        lines.forEach((l, i) => {
          const ly = sheet.y - (lines.length === 1 ? 9 : 5 + i * 8);
          if (c.align === "left") sheet.text(l, x + 4, 7, { bold: true, y: ly, color: MUTED });
          else sheet.text(l, x + c.width / 2, 7, { bold: true, y: ly, align: "center", color: MUTED });
        });
        x += c.width;
      }
      sheet.y -= h;
    };
    header();
    d.subjects.forEach((s, r) => {
      if (sheet.y - 16 < MARGIN + 24) { sheet.addPage(true); header(); }
      if (r % 2 === 1) sheet.box(MARGIN, sheet.y - 12, sheet.inner, 16, rgb(0.985, 0.985, 0.985));
      let x = MARGIN;
      for (const c of table) {
        const v = c.value(s);
        if (c.align === "left") sheet.text(v, x + 4, 9, { y: sheet.y - 8, width: c.width - 8 });
        else sheet.text(v, x + c.width / 2, 9, { y: sheet.y - 8, align: "center", bold: c.label === "Grade" });
        x += c.width;
      }
      sheet.y -= 16;
    });
    sheet.rule(sheet.y + 2);

    // summary
    sheet.need(30);
    sheet.y -= 18;
    const sm = d.summary;
    const parts = [
      `Subjects: ${sm.subjectsSat}`,
      `Total: ${dash(sm.total)}`,
      `Mean: ${sm.mean === null ? "-" : `${sm.mean}%`}`,
      `Mean grade: ${dash(sm.grade)}`,
      ...(d.scheme === "kcse" ? [`Points: ${dash(sm.points)}`] : []),
      ...(sm.position !== null ? [`Position: ${sm.position} of ${sm.ranked}`] : []),
    ];
    sheet.text(parts.join("     "), MARGIN, 10, { bold: true });
    sheet.y -= 10;
  } else if (!d.cbe.length) {
    sheet.text("No exam results were published for this term.", MARGIN, 10, { color: MUTED, y: sheet.y - 8 });
    sheet.y -= 24;
  }

  // CBC
  if (d.cbe.length) {
    sheet.need(40);
    sheet.y -= 16;
    sheet.text("Competency-based assessment", MARGIN, 10, { bold: true });
    sheet.y -= 8;
    const w = [sheet.inner * 0.32, sheet.inner * 0.4, sheet.inner * 0.28];
    sheet.box(MARGIN, sheet.y - 14, sheet.inner, 18, SHADE);
    ["Learning area", "Assessment", "Level"].forEach((l, i) =>
      sheet.text(l, MARGIN + 4 + w.slice(0, i).reduce((a, b) => a + b, 0), 7, { bold: true, color: MUTED, y: sheet.y - 8 }));
    sheet.y -= 18;
    for (const a of d.cbe) {
      sheet.need(16);
      const vals = [a.area, a.assessment, a.level ? `${a.level}${a.label ? ` - ${a.label}` : ""}` : "-"];
      vals.forEach((v, i) =>
        sheet.text(v, MARGIN + 4 + w.slice(0, i).reduce((x, y) => x + y, 0), 9, { y: sheet.y - 8, width: w[i]! - 8, bold: i === 2 }));
      sheet.y -= 16;
    }
    sheet.rule(sheet.y + 2);
  }

  // attendance, fees, next term
  const facts: string[] = [];
  if (d.attendance && d.attendance.days > 0) {
    facts.push(`Attendance: ${d.attendance.present} of ${d.attendance.days} days (${Math.round((d.attendance.present / d.attendance.days) * 100)}%)`);
  }
  if (d.fees) {
    const balance = d.fees.billedCents - d.fees.paidCents;
    facts.push(`Fees: billed ${formatMoney(d.fees.billedCents, d.school.country)}, paid ${formatMoney(d.fees.paidCents, d.school.country)}, ${balance > 0 ? `balance ${formatMoney(balance, d.school.country)}` : "fully paid"}`);
  }
  if (d.nextTermBegins) facts.push(`Next term begins: ${shortDate(d.nextTermBegins)}`);
  if (facts.length) {
    sheet.need(facts.length * 14 + 14);
    sheet.y -= 18;
    for (const f of facts) { sheet.text(f, MARGIN, 9); sheet.y -= 14; }
  }

  // comments
  const comment = (title: string, text: string | null) => {
    const lines = wrap(text?.trim() || "", fonts.regular, 9.5, sheet.inner - 16);
    const h = 30 + Math.max(1, lines.length) * 12 + 22;
    sheet.need(h + 10);
    sheet.y -= 14;
    sheet.page.drawRectangle({ x: MARGIN, y: sheet.y - h + 10, width: sheet.inner, height: h, borderColor: LINE, borderWidth: 0.8 });
    sheet.text(title, MARGIN + 8, 8, { bold: true, color: MUTED, y: sheet.y - 4 });
    let ly = sheet.y - 20;
    if (lines.length && lines[0]) for (const l of lines) { sheet.text(l, MARGIN + 8, 9.5, { y: ly }); ly -= 12; }
    else ly -= 12;
    sheet.text("Signature: ____________________", MARGIN + 8, 8, { color: MUTED, y: ly - 8 });
    sheet.text("Date: ______________", sheet.width - MARGIN - 8, 8, { color: MUTED, y: ly - 8, align: "right" });
    sheet.y -= h;
  };
  comment(`Class teacher's comment${d.classTeacher ? ` (${d.classTeacher})` : ""}`, card.teacherComment);
  comment("Principal's comment", card.principalComment);

  // footer on every page of this card
  for (const p of doc.getPages().slice(firstPage)) {
    p.drawText(pdfText(`Issued by ${d.school.name} - prepared ${shortDate(d.preparedOn)}`), {
      x: MARGIN, y: MARGIN - 14, size: 7, font: fonts.regular, color: MUTED,
    });
  }
}

async function newDoc(title: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfText(title));
  doc.setProducer("Figbloom");
  doc.setCreator("Figbloom School Management");
  const fonts: Fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  return { doc, fonts };
}

async function embedLogo(doc: PDFDocument, logo: PdfLogo | null | undefined): Promise<PDFImage | null> {
  if (!logo) return null;
  try {
    return logo.type === "png" ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
  } catch {
    return null; // a logo that won't decode shouldn't stop the report card
  }
}

/** One PDF with every card in it, each starting on a new page — one learner, or a whole class to print. */
export async function renderReportCardsPdf(cards: PrintableCard[], opts: { logo?: PdfLogo | null; title?: string } = {}): Promise<Uint8Array> {
  const first = cards[0]?.data;
  const { doc, fonts } = await newDoc(opts.title ?? (first ? `${first.term.name} report cards - ${first.learner.className}` : "Report cards"));
  const logo = await embedLogo(doc, opts.logo);
  for (const card of cards) drawCard(doc, fonts, card, logo);
  if (!cards.length) doc.addPage(A4);
  return doc.save();
}

// ------------------------------------------------------------------ class results sheet

/** Learners in merit order: by position when there is one, else by mean; no mean last; then by name. */
export function meritOrder(cards: ReportCardData[]): ReportCardData[] {
  return [...cards].sort((a, b) => {
    const am = a.summary.mean, bm = b.summary.mean;
    if (am === null || bm === null) return am === bm ? a.learner.name.localeCompare(b.learner.name) : am === null ? 1 : -1;
    return bm - am || a.learner.name.localeCompare(b.learner.name);
  });
}

/** The class on one table (landscape): every learner, every subject's average, mean, grade and position. */
export async function renderResultsSheetPdf(cards: ReportCardData[], opts: { logo?: PdfLogo | null } = {}): Promise<Uint8Array> {
  const first = cards[0];
  const { doc, fonts } = await newDoc(first ? `${first.term.name} results - ${first.learner.className}` : "Class results");
  const logo = await embedLogo(doc, opts.logo);
  const size: [number, number] = [A4[1], A4[0]];
  if (!first) { doc.addPage(size); return doc.save(); }

  const subjects = [...new Map(cards.flatMap((c) => c.subjects.map((s) => [s.name, s.code || s.name.slice(0, 4).toUpperCase()] as const))).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]));
  const showPos = cards.some((c) => c.summary.position !== null);
  const kcse = first.scheme === "kcse";
  const accent = hexToRgb(first.school.accent);

  const lead = [
    ...(showPos ? [{ label: "Pos", width: 28 }] : []),
    { label: "Adm no.", width: 54 },
    { label: "Name", width: 130 },
  ];
  const tail = [{ label: "Mean", width: 36 }, { label: "Grade", width: 34 }, ...(kcse ? [{ label: "Points", width: 36 }] : [])];
  const inner = size[0] - MARGIN * 2;
  const leftW = [...lead, ...tail].reduce((a, c) => a + c.width, 0);
  const subjW = subjects.length ? Math.max(24, (inner - leftW) / subjects.length) : 0;
  const fontSize = subjW < 32 ? 7 : 8;

  const sheet = new Sheet(doc, fonts, size, (s, continued) => {
    s.box(0, size[1] - 6, size[0], 6, accent);
    const top = s.y;
    let x = MARGIN;
    if (logo && !continued) {
      const h = 34, w = Math.min(54, (logo.width / logo.height) * h);
      s.page.drawImage(logo, { x, y: top - h + 6, width: w, height: h });
      x += w + 10;
    }
    s.text(first.school.name, x, continued ? 10 : 14, { bold: true, y: top - 6 });
    s.text(`${first.learner.className} - ${first.term.name} results${continued ? " (continued)" : ""}`, x, 9, { color: MUTED, y: top - 20 });
    if (first.exams.length) s.text(`Exams: ${first.exams.map((e) => e.name).join(", ")}`, size[0] - MARGIN, 8, { color: MUTED, y: top - 20, align: "right", width: 360 });
    s.y = top - 40;
  });

  const header = () => {
    sheet.box(MARGIN, sheet.y - 12, inner, 18, SHADE);
    let x = MARGIN;
    for (const c of lead) { sheet.text(c.label, x + 3, 7, { bold: true, color: MUTED, y: sheet.y - 6 }); x += c.width; }
    for (const [, code] of subjects) { sheet.text(code, x + subjW / 2, 7, { bold: true, color: MUTED, y: sheet.y - 6, align: "center", width: subjW - 2 }); x += subjW; }
    for (const c of tail) { sheet.text(c.label, x + c.width / 2, 7, { bold: true, color: MUTED, y: sheet.y - 6, align: "center" }); x += c.width; }
    sheet.y -= 18;
  };
  header();

  const rowH = 14;
  meritOrder(cards).forEach((c, r) => {
    if (sheet.y - rowH < MARGIN + 30) { sheet.addPage(true); header(); }
    if (r % 2 === 1) sheet.box(MARGIN, sheet.y - 10, inner, rowH, rgb(0.985, 0.985, 0.985));
    const byName = new Map(c.subjects.map((s) => [s.name, s.average]));
    let x = MARGIN;
    const ty = sheet.y - 6;
    if (showPos) { sheet.text(dash(c.summary.position), x + 3, fontSize, { y: ty }); x += 28; }
    sheet.text(c.learner.admissionNo, x + 3, fontSize, { y: ty, width: 50 }); x += 54;
    sheet.text(c.learner.name, x + 3, fontSize, { y: ty, width: 126 }); x += 130;
    for (const [name] of subjects) { sheet.text(dash(byName.get(name)), x + subjW / 2, fontSize, { y: ty, align: "center" }); x += subjW; }
    sheet.text(c.summary.mean === null ? "-" : `${c.summary.mean}`, x + 18, fontSize, { y: ty, align: "center", bold: true }); x += 36;
    sheet.text(dash(c.summary.grade), x + 17, fontSize, { y: ty, align: "center", bold: true }); x += 34;
    if (kcse) sheet.text(dash(c.summary.points), x + 18, fontSize, { y: ty, align: "center" });
    sheet.y -= rowH;
  });

  // class mean per subject
  sheet.need(rowH + 4);
  sheet.rule(sheet.y + 3);
  let x = MARGIN + lead.reduce((a, c) => a + c.width, 0);
  sheet.text("Class mean", x - 6, fontSize, { bold: true, y: sheet.y - 6, align: "right" });
  for (const [name] of subjects) {
    const mean = cards.flatMap((c) => c.subjects).find((s) => s.name === name)?.classMean ?? null;
    sheet.text(dash(mean), x + subjW / 2, fontSize, { bold: true, y: sheet.y - 6, align: "center" });
    x += subjW;
  }
  const means = cards.map((c) => c.summary.mean).filter((m): m is number => m !== null);
  if (means.length) sheet.text(`${Math.round(means.reduce((a, b) => a + b, 0) / means.length)}`, x + 18, fontSize, { bold: true, y: sheet.y - 6, align: "center" });
  sheet.y -= rowH + 10;
  sheet.need(14);
  sheet.text(`${cards.length} learners - prepared ${shortDate(first.preparedOn)}`, MARGIN, 7, { color: MUTED });

  return doc.save();
}
