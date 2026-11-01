import { describe, expect, it } from "vitest";
import { columnName, sheetCell, sheetXml, tablesXlsx, xlsxParts, xmlText } from "./xlsx";
import { crc32, storedZip, utf8 } from "./zip";

const INFO = { title: "Fees & balances", schoolName: "Kijani Ridge", disclaimer: "Drafted with Bloom (AI). Check before use.", created: new Date(2026, 9, 28, 10, 15, 30) };

/** The entries of a zip, read back from its central directory. */
function unzip(bytes: Uint8Array): Map<string, { data: Uint8Array; crc: number; method: number }> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const out = new Map<string, { data: Uint8Array; crc: number; method: number }>();
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    out.set(name, { data: bytes.subarray(start, start + size), crc, method });
    at += 46 + nameLen;
  }
  return out;
}

describe("zip", () => {
  it("encodes UTF-8 like TextEncoder", () => {
    for (const s of ["KES 1,250", "Wanjikũ – “₦” €", "👏🏽 🇰🇪", "Дмитрий"]) expect(utf8(s)).toEqual(new TextEncoder().encode(s));
  });

  it("computes the standard CRC-32", () => {
    expect(crc32(utf8("hello"))).toBe(0x3610a686);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("stores each file so a reader gets it back byte for byte", () => {
    const files = [{ name: "a.txt", data: utf8("Habari") }, { name: "dir/b.xml", data: utf8("<x>ñ</x>") }];
    const entries = unzip(storedZip(files, INFO.created));
    expect([...entries.keys()]).toEqual(["a.txt", "dir/b.xml"]);
    for (const f of files) {
      const e = entries.get(f.name)!;
      expect(e.method).toBe(0);
      expect(e.data).toEqual(f.data);
      expect(e.crc).toBe(crc32(f.data));
    }
  });

  it("refuses a name that isn't ASCII", () => {
    expect(() => storedZip([{ name: "ñ.txt", data: new Uint8Array() }], INFO.created)).toThrow();
  });
});

describe("xlsx", () => {
  it("names columns A to Z, then AA", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("keeps numbers as numbers, with their grouping, and guards text that could run as a formula", () => {
    expect(sheetCell("1,250", false, false)).toEqual({ kind: "number", value: 1250, style: 3 });
    expect(sheetCell("KES 18,750.50", false, false)).toEqual({ kind: "number", value: 18750.5, style: 4 });
    expect(sheetCell("65.5", false, false)).toEqual({ kind: "number", value: 65.5, style: 0 });
    expect(sheetCell("-1,250", false, false)).toMatchObject({ kind: "number", value: -1250 });
    expect(sheetCell("0712345678", false, false)).toEqual({ kind: "text", value: "0712345678", style: 0 });
    expect(sheetCell("=SUM(A1:A3)", false, false)).toEqual({ kind: "text", value: "'=SUM(A1:A3)", style: 0 });
    expect(sheetCell("@cmd", false, true)).toEqual({ kind: "text", value: "'@cmd", style: 2 });
    // the header row is always bold text, even a number
    expect(sheetCell("2026", true, false)).toEqual({ kind: "text", value: "2026", style: 1 });
  });

  it("escapes XML and leaves out characters XML can't hold", () => {
    expect(xmlText(`a < b & "c" > d`)).toBe("a &lt; b &amp; &quot;c&quot; &gt; d");
    expect(xmlText(`bell${String.fromCharCode(7)} ok\ttab\nline ${String.fromCharCode(0xd800)}x ${String.fromCharCode(0xfffe)}`)).toBe("bell ok\ttab\nline x ");
    expect(xmlText("Wanjikũ ₦ 👏🏽")).toBe("Wanjikũ ₦ 👏🏽");
  });

  it("writes a frozen, bold header and typed cells", () => {
    const xml = sheetXml({ head: ["Item", "Amount (KES)"], rows: [["Tuition", "12,500"], ["Trip", ""]] });
    expect(xml).toContain(`<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`);
    expect(xml).toContain(`<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Item</t></is></c>`);
    expect(xml).toContain(`<c r="B2" s="3"><v>12500</v></c>`);
    expect(xml).toContain(`<row r="3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">Trip</t></is></c></row>`);
    expect(xml).toContain(`<col min="1" max="1" width="9" customWidth="1"/>`);
  });

  it("makes a workbook with a sheet per table, unique sheet names and the file's properties", () => {
    const tables = [
      { name: "Fees: Term 3", head: ["A"], rows: [["1"]] },
      { name: "Fees: Term 3", head: ["B"], rows: [["2"]] },
    ];
    const parts = xlsxParts(tables, INFO);
    expect(Object.keys(parts).sort()).toEqual([
      "[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml",
      "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
    ]);
    expect(parts["xl/workbook.xml"]).toContain(`<sheet name="Fees Term 3" sheetId="1" r:id="rId1"/><sheet name="Fees Term 3 (2)" sheetId="2" r:id="rId2"/>`);
    expect(parts["xl/_rels/workbook.xml.rels"]).toContain(`Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"`);
    expect(parts["docProps/core.xml"]).toContain("<dc:title>Fees &amp; balances</dc:title>");
    expect(parts["docProps/core.xml"]).toContain("<dc:description>Drafted with Bloom (AI). Check before use.</dc:description>");
    expect(() => xlsxParts([], INFO)).toThrow();
  });

  it("zips the parts into one .xlsx", () => {
    const entries = unzip(tablesXlsx([{ name: "T", head: ["Jina"], rows: [["Wanjikũ"]] }], INFO));
    expect(entries.has("[Content_Types].xml")).toBe(true);
    expect(new TextDecoder().decode(entries.get("xl/worksheets/sheet1.xml")!.data)).toContain("Wanjikũ");
  });
});
