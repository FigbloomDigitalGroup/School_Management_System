import { deflateRawSync, inflateRawSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Minimal spec-compliant ZIP writer & reader (PKZIP 2.0, Deflate, CRC32)
// Zero third-party dependencies.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function createZipArchive(entries: Array<{ name: string; content: string | Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const rawBuf = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content;
    const compressed = deflateRawSync(rawBuf, { level: 6 });
    const crc = crc32(rawBuf);

    // Local file header (30 bytes + name)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(8, 8); // compression: deflate
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(0x21, 12); // mod date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(rawBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra len

    localParts.push(lh, nameBuf, compressed);

    // Central directory header (46 bytes + name)
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(8, 10); // deflate
    ch.writeUInt16LE(0, 12); // mod time
    ch.writeUInt16LE(0x21, 14); // mod date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(rawBuf.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra len
    ch.writeUInt16LE(0, 32); // comment len
    ch.writeUInt16LE(0, 34); // disk start
    ch.writeUInt16LE(0, 36); // internal attr
    ch.writeUInt32LE(0, 38); // external attr
    ch.writeUInt32LE(offset, 42);

    centralParts.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

/** Reader helper for verifying generated XLSX/DOCX archives in automated tests. */
export function parseZipEntries(zipBuf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let pos = 0;
  while (pos + 30 <= zipBuf.length && zipBuf.readUInt32LE(pos) === 0x04034b50) {
    const compression = zipBuf.readUInt16LE(pos + 8);
    const compSize = zipBuf.readUInt32LE(pos + 18);
    const nameLen = zipBuf.readUInt16LE(pos + 26);
    const extraLen = zipBuf.readUInt16LE(pos + 28);
    const name = zipBuf.subarray(pos + 30, pos + 30 + nameLen).toString("utf8");
    const dataStart = pos + 30 + nameLen + extraLen;
    const compData = zipBuf.subarray(dataStart, dataStart + compSize);
    const raw = compression === 8 ? inflateRawSync(compData) : Buffer.from(compData);
    out.set(name, raw);
    pos = dataStart + compSize;
  }
  return out;
}

// ---------------------------------------------------------------------------
// XML escaping & formula-injection neutralization
// ---------------------------------------------------------------------------

/** Removes characters that are illegal in XML 1.0 (controls, U+FFFE/U+FFFF, unpaired surrogates). */
export function stripIllegalXmlChars(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]/g, "")
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
  );
}

function xmlEscape(s: string): string {
  return stripIllegalXmlChars(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Neutralizes spreadsheet formula injection (=, +, -, @, tab, CR) by prefixing with a single quote. */
export function sanitizeSpreadsheetText(input: string): string {
  // strip illegal characters FIRST so a leading control character cannot hide a formula prefix
  const raw = stripIllegalXmlChars(input);
  return /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
}

function excelColLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------------------
// OOXML SpreadsheetML (.xlsx) generator
// ---------------------------------------------------------------------------

export type XlsxCellValue = string | number | boolean | Date | null | undefined;

export interface XlsxOptions {
  sheetName: string;
  title: string;
  headers: string[];
  rows: XlsxCellValue[][];
  creator?: string;
}

function renderXlsxCell(ref: string, value: XlsxCellValue, styleIdx = 0): string {
  if (value === null || value === undefined) return `<c r="${ref}" s="${styleIdx}"/>`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}" s="${styleIdx}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${ref}" t="b" s="${styleIdx}"><v>${value ? 1 : 0}</v></c>`;
  }
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  const safe = sanitizeSpreadsheetText(text);
  return `<c r="${ref}" t="inlineStr" s="${styleIdx}"><is><t xml:space="preserve">${xmlEscape(safe)}</t></is></c>`;
}

export function buildXlsx(opts: XlsxOptions): Buffer {
  const safeSheetName = opts.sheetName.replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Report";
  const nowIso = new Date().toISOString();
  const rowXml: string[] = [];

  // Header row (style 1 = bold)
  const headerCells = opts.headers.map((h, ci) => renderXlsxCell(`${excelColLetter(ci)}1`, h, 1)).join("");
  rowXml.push(`<row r="1">${headerCells}</row>`);

  // Data rows
  for (let ri = 0; ri < opts.rows.length; ri++) {
    const row = opts.rows[ri]!;
    const cells = row.map((v, ci) => renderXlsxCell(`${excelColLetter(ci)}${ri + 2}`, v, 0)).join("");
    rowXml.push(`<row r="${ri + 2}">${cells}</row>`);
  }

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowXml.join("")}</sheetData>` +
    `</worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlEscape(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`;

  const workbookRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
    `</styleSheet>`;

  const coreXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xmlEscape(opts.title)}</dc:title>` +
    `<dc:creator>${xmlEscape(opts.creator ?? "FigBloom School Management System")}</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created>` +
    `</cp:coreProperties>`;

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `</Types>`;

  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `</Relationships>`;

  return createZipArchive([
    { name: "[Content_Types].xml", content: contentTypesXml },
    { name: "_rels/.rels", content: rootRelsXml },
    { name: "docProps/core.xml", content: coreXml },
    { name: "xl/workbook.xml", content: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRelsXml },
    { name: "xl/styles.xml", content: stylesXml },
    { name: "xl/worksheets/sheet1.xml", content: sheetXml },
  ]);
}

// ---------------------------------------------------------------------------
// OOXML WordprocessingML (.docx) generator
// ---------------------------------------------------------------------------

export interface DocxSection {
  heading: string;
  paragraphs?: string[];
  table?: { headers: string[]; rows: string[][] };
}

export interface DocxOptions {
  title: string;
  subtitle?: string;
  metadata?: Array<[string, string]>;
  sections: DocxSection[];
  creator?: string;
}

function wParagraph(text: string, bold = false, sizeHalfPts = 22): string {
  return (
    `<w:p><w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${sizeHalfPts}"/></w:rPr>` +
    `<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`
  );
}

function wTable(headers: string[], rows: string[][]): string {
  const renderRow = (cells: string[], header: boolean) =>
    `<w:tr>${cells
      .map((cell) => `<w:tc>${wParagraph(cell, header, header ? 20 : 18)}</w:tc>`)
      .join("")}</w:tr>`;
  return (
    `<w:tbl><w:tblPr><w:tblBorders>` +
    `<w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
    `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
    `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="EEEEEE"/>` +
    `</w:tblBorders></w:tblPr>` +
    renderRow(headers, true) +
    rows.map((r) => renderRow(r, false)).join("") +
    `</w:tbl>`
  );
}

export function buildDocx(opts: DocxOptions): Buffer {
  const nowIso = new Date().toISOString();
  const parts: string[] = [wParagraph(opts.title, true, 32)];
  if (opts.subtitle) parts.push(wParagraph(opts.subtitle, false, 22));
  if (opts.metadata && opts.metadata.length > 0) {
    parts.push(wTable(["Field", "Value"], opts.metadata));
  }
  for (const sec of opts.sections) {
    parts.push(wParagraph(sec.heading, true, 26));
    for (const p of sec.paragraphs ?? []) {
      parts.push(wParagraph(p, false, 20));
    }
    if (sec.table) {
      parts.push(wTable(sec.table.headers, sec.table.rows));
    }
  }

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${parts.join("")}<w:sectPr/></w:body>` +
    `</w:document>`;

  const coreXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xmlEscape(opts.title)}</dc:title>` +
    `<dc:creator>${xmlEscape(opts.creator ?? "FigBloom School Management System")}</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created>` +
    `</cp:coreProperties>`;

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `</Types>`;

  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `</Relationships>`;

  return createZipArchive([
    { name: "[Content_Types].xml", content: contentTypesXml },
    { name: "_rels/.rels", content: rootRelsXml },
    { name: "docProps/core.xml", content: coreXml },
    { name: "word/document.xml", content: documentXml },
  ]);
}
