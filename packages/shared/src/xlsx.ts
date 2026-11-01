import { csvFormulaSafe } from "./csv";
import { sheetName, spreadsheetNumber, type ReplyTable } from "./bloomExport";
import { storedZip, utf8 } from "./zip";

/**
 * Tables as an Excel workbook (.xlsx), written by hand: a handful of small
 * SpreadsheetML parts in an uncompressed zip. Replaces exceljs for Bloom's
 * table export, which only ever needed this much: one sheet per table, a bold
 * shaded header row frozen at the top, numbers stored as numbers, everything
 * else as text guarded against running as a formula, column widths to fit,
 * and the title, school and AI note in the file's properties. Excel, Google
 * Sheets (Drive converts it on upload) and LibreOffice all open it.
 *
 * Pure and DOM-free, like the rest of this package.
 */

export interface WorkbookInfo { title: string; schoolName: string; disclaimer: string; created: Date }

/** Cell styles, by index into styles.xml's cellXfs. */
const STYLE = { text: 0, header: 1, wrap: 2, thousands: 3, thousandsCents: 4 } as const;

/** Whether XML 1.0 can hold a character: not a control character (bar tab and line breaks), a lone surrogate or a non-character. */
const xmlChar = (k: number) =>
  k === 0x9 || k === 0xa || k === 0xd || (k >= 0x20 && k < 0xd800)
  || (k >= 0xe000 && k <= 0xfffd && !(k >= 0xfdd0 && k <= 0xfdef)) || (k >= 0x10000 && (k & 0xfffe) !== 0xfffe);

/** Text escaped for XML, with any character XML can't hold left out. */
export function xmlText(s: string): string {
  return [...s].filter((c) => xmlChar(c.codePointAt(0)!)).join("")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "A", "B", ... "Z", "AA", ... for a 0-based column. */
export function columnName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

type Cell = { kind: "number"; value: number; style: number } | { kind: "text"; value: string; style: number };

/** A table cell as the sheet stores it: a clear number as a number (keeping "1,250"-style grouping), anything else as guarded text. */
export function sheetCell(text: string, header: boolean, wrap: boolean): Cell {
  if (header) return { kind: "text", value: csvFormulaSafe(text), style: STYLE.header };
  const n = spreadsheetNumber(text);
  if (n !== null) {
    const grouped = /\d,\d{3}/.test(text);
    const cents = /\.\d{2}$/.test(text.trim());
    return { kind: "number", value: n, style: grouped ? (cents ? STYLE.thousandsCents : STYLE.thousands) : STYLE.text };
  }
  return { kind: "text", value: csvFormulaSafe(text), style: wrap ? STYLE.wrap : STYLE.text };
}

function cellXml(cell: Cell, ref: string): string {
  const s = cell.style ? ` s="${cell.style}"` : "";
  if (cell.kind === "number") return `<c r="${ref}"${s}><v>${cell.value}</v></c>`;
  if (!cell.value) return cell.style ? `<c r="${ref}"${s}/>` : "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(cell.value)}</t></is></c>`;
}

/** One sheet's XML. Columns are as wide as their longest cell (8 to 60 characters); longer text wraps. */
export function sheetXml(table: Pick<ReplyTable, "head" | "rows">): string {
  const width = Math.max(table.head.length, ...table.rows.map((r) => r.length));
  const longest = Array.from({ length: width }, (_, i) => Math.max(table.head[i]?.length ?? 0, ...table.rows.map((r) => r[i]?.length ?? 0)));
  const cols = longest.map((l, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, l + 2))}" customWidth="1"/>`).join("");
  const rows = [table.head, ...table.rows].map((row, r) => {
    const cells = row.map((text, c) => cellXml(sheetCell(text, r === 0, longest[c]! > 60), `${columnName(c)}${r + 1}`)).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>${width ? `<cols>${cols}</cols>` : ""}<sheetData>${rows}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>`
  + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FFEEF1EF"/><bgColor indexed="64"/></patternFill></fill></fills>`
  + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="5">`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>`
  + `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top"/></xf>`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`
  + `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>`
  + `<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>`
  + `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

/** Every part of the workbook, by its path in the zip. */
export function xlsxParts(tables: ReplyTable[], info: WorkbookInfo): Record<string, string> {
  if (!tables.length) throw new Error("There's no table to put in the workbook.");
  const taken = new Set<string>();
  const names = tables.map((t) => sheetName(t.name, taken));
  const sheetIds = tables.map((_, i) => i + 1);
  const parts: Record<string, string> = {
    "[Content_Types].xml": `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + sheetIds.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
      + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
      + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    "_rels/.rels": `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
      + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    "docProps/core.xml": `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
      + `<dc:title>${xmlText(info.title)}</dc:title><dc:creator>${xmlText(info.schoolName || "Figbloom School Systems")}</dc:creator>`
      + `<dc:description>${xmlText(info.disclaimer)}</dc:description>`
      + `<dcterms:created xsi:type="dcterms:W3CDTF">${info.created.toISOString().replace(/\.\d{3}Z$/, "Z")}</dcterms:created></cp:coreProperties>`,
    "xl/workbook.xml": `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<bookViews><workbookView/></bookViews><sheets>`
      + names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
      + `</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + sheetIds.map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join("")
      + `<Relationship Id="rId${tables.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": STYLES,
  };
  tables.forEach((t, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(t); });
  return parts;
}

/** The workbook's bytes. */
export function tablesXlsx(tables: ReplyTable[], info: WorkbookInfo): Uint8Array {
  return storedZip(Object.entries(xlsxParts(tables, info)).map(([name, xml]) => ({ name, data: utf8(xml) })), info.created);
}
