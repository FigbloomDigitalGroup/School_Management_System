/**
 * A Bloom export (packages/shared bloomExport.ts) as a Word document, built
 * with the docx package: real Word headings, numbered and bulleted lists,
 * bordered tables with a repeating header row, and live hyperlinks. Loaded on
 * demand through bloomExport.ts, so docx stays out of the chat page's bundle.
 * Word fonts cover every script, so text goes in exactly as written.
 */
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, HeadingLevel, LevelFormat, Packer, PageNumber, Paragraph,
  ShadingType, Table, TableCell, TableRow, TextRun, WidthType, type ILevelsOptions, type ParagraphChild,
} from "docx";
import type { Align } from "../../../../packages/shared/src/markdown";
import type { ExportBlock, ExportDocument, ExportRun } from "../../../../packages/shared/src/bloomExport";

const MUTED = "6B736E";
const FOREST = "17402A";
const LINE = "C7CCC9";
const SHADE = "EEF1EF";
const MONO = "Consolas";
/** Twips per list level. */
const LEVEL = 360;
const BULLETS = "bloom-bullets";

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4] as const;
const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT } as const;

/** Runs as Word text, line breaks kept and links live. */
function runs(list: ExportRun[], base: { color?: string; size?: number; bold?: boolean } = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const r of list) {
    const parts = r.text.split("\n");
    const text = parts.map((t, i) => new TextRun({
      text: t, break: i > 0 ? 1 : undefined,
      bold: r.bold || base.bold || undefined, italics: r.italic || undefined, superScript: r.sup || undefined,
      font: r.code ? MONO : undefined, size: base.size, color: r.href ? undefined : base.color,
      style: r.href ? "Hyperlink" : undefined,
    }));
    if (r.href) out.push(new ExternalHyperlink({ link: r.href, children: text }));
    else out.push(...text);
  }
  return out;
}

const border = (color = LINE, size = 4) => ({ style: BorderStyle.SINGLE, size, color, space: 0 });
const quoteBorder = { left: { style: BorderStyle.SINGLE, size: 12, color: LINE, space: 8 } };

function table(block: Extract<ExportBlock, { kind: "table" }>, indent: number): Table {
  const cell = (content: ExportRun[], align: Align, header: boolean) => new TableCell({
    children: [new Paragraph({ alignment: ALIGN[align ?? "left"], children: runs(content, { bold: header, size: 20 }) })],
    shading: header ? { type: ShadingType.CLEAR, fill: SHADE, color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    indent: indent ? { size: indent, type: WidthType.DXA } : undefined,
    borders: { top: border(), bottom: border(), left: border(), right: border(), insideHorizontal: border(), insideVertical: border() },
    rows: [
      // repeats at the top of each page the table runs onto
      new TableRow({ tableHeader: true, children: block.head.map((h, i) => cell(h, block.align[i] ?? null, true)) }),
      ...block.rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, block.align[i] ?? null, false)) })),
    ],
  });
}

function blockToWord(b: ExportBlock): (Paragraph | Table)[] {
  const left = b.indent * LEVEL * 2;
  const quote = b.quote ? { border: quoteBorder, indent: { left: left + 360 } } : left ? { indent: { left } } : {};
  const color = b.quote ? MUTED : undefined;
  switch (b.kind) {
    case "heading":
      return [new Paragraph({ heading: HEADINGS[b.level], ...quote, children: runs(b.runs) })];
    case "paragraph":
      return [new Paragraph({ ...quote, spacing: { after: 120 }, children: runs(b.runs, { color }) })];
    case "listItem":
      return [new Paragraph({
        numbering: { reference: b.ordered ? `bloom-ol-${b.listId}` : BULLETS, level: Math.min(b.indent, 8) },
        ...(b.quote ? { border: quoteBorder } : {}),
        spacing: { after: 60 },
        children: runs(b.runs, { color }),
      })];
    case "code":
      return [new Paragraph({
        ...(left || b.quote ? { indent: { left: left + (b.quote ? 360 : 0) } } : {}),
        shading: { type: ShadingType.CLEAR, fill: "F3F5F4", color: "auto" },
        border: { top: border(), bottom: border(), left: border(), right: border() },
        spacing: { after: 120 },
        children: b.text.split("\n").map((line, i) => new TextRun({ text: line, font: MONO, size: 18, break: i > 0 ? 1 : undefined })),
      })];
    case "table":
      return [table(b, left), new Paragraph({ spacing: { after: 60 }, children: [] })];
    case "rule":
      return [new Paragraph({ border: { bottom: border(LINE, 6) }, spacing: { after: 120 }, children: [] })];
  }
}

/** Levels for a list's numbering: indented by level, a numbered list starting at its first number. */
function levels(ordered: boolean, start: number): ILevelsOptions[] {
  const bullets = ["•", "◦", "▪"];
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
    text: ordered ? `%${level + 1}.` : bullets[level % 3]!,
    start: ordered ? start : 1,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: LEVEL * 2 * (level + 1), hanging: LEVEL } } },
  }));
}

/** The file, ready to download. */
export async function renderBloomDocx(d: ExportDocument): Promise<Blob> {
  // one numbering per numbered list, so each counts from its own first number
  const ordered = new Map<number, number>();
  for (const s of d.sections) for (const b of s.blocks) if (b.kind === "listItem" && b.ordered && !ordered.has(b.listId)) ordered.set(b.listId, b.number);
  const SOURCES = "bloom-sources";

  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: d.title })] }),
    new Paragraph({ children: [new TextRun({ text: [d.schoolName, d.date].filter(Boolean).join("  ·  "), color: MUTED, size: 20 })] }),
    new Paragraph({
      border: { bottom: border(LINE, 6) }, spacing: { after: 240 },
      children: [new TextRun({ text: d.disclaimer, italics: true, color: MUTED, size: 16 })],
    }),
  ];

  for (const s of d.sections) {
    if (s.label) {
      children.push(new Paragraph({
        keepNext: true, spacing: { before: 240, after: 80 },
        children: [new TextRun({ text: [s.label, s.time].filter(Boolean).join("  ·  "), bold: true, size: 18, color: s.label === "Bloom" ? FOREST : MUTED })],
      }));
    }
    for (const b of s.blocks) children.push(...blockToWord(b));
  }

  if (d.sources.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Sources" })] }));
    for (const src of d.sources) {
      children.push(new Paragraph({
        numbering: { reference: SOURCES, level: 0 }, spacing: { after: 80 },
        children: [
          new ExternalHyperlink({ link: src.url, children: [new TextRun({ text: src.title, style: "Hyperlink" })] }),
          new TextRun({ text: "", break: 1 }),
          new ExternalHyperlink({ link: src.url, children: [new TextRun({ text: src.url, style: "Hyperlink", size: 16 })] }),
        ],
      }));
    }
  }

  const doc = new Document({
    title: d.title,
    creator: d.schoolName || "Figbloom School Systems",
    description: d.disclaimer,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: {
      config: [
        { reference: BULLETS, levels: levels(false, 1) },
        { reference: SOURCES, levels: levels(true, 1) },
        ...[...ordered].map(([id, start]) => ({ reference: `bloom-ol-${id}`, levels: levels(true, start) })),
      ],
    },
    sections: [{
      footers: {
        default: new Footer({
          children: [new Paragraph({
            children: [
              new TextRun({ text: `${d.disclaimer}    `, italics: true, color: MUTED, size: 14 }),
              new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], color: MUTED, size: 14 }),
            ],
          })],
        }),
      },
      children,
    }],
  });
  return Packer.toBlob(doc);
}
