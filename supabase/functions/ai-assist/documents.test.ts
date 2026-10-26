import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import { docxText, MAX_PDF_PAGES, paperImportContent, pdfPageCount, sniff, toBase64 } from "./documents.ts";
import { BadInput, type PaperImportRequest } from "./tasks.ts";

const enc = (s: string) => new TextEncoder().encode(s);
export const fakePdf = (pages: number) =>
  enc(`%PDF-1.7\n1 0 obj << /Type /Pages /Kids [] /Count ${pages} >> endobj\n${Array.from({ length: pages }, (_, i) => `${i + 2} 0 obj << /Type /Page /Parent 1 0 R >> endobj`).join("\n")}\n%%EOF`);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const para = (inner: string, num?: { lvl: number; id: number }) =>
  `<w:p>${num ? `<w:pPr><w:numPr><w:ilvl w:val="${num.lvl}"/><w:numId w:val="${num.id}"/></w:numPr></w:pPr>` : ""}${inner}</w:p>`;
const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
export function fakeDocx(paragraphs: string[]): Uint8Array {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paragraphs.join("")}</w:body></w:document>`;
  return zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(xml) });
}

const REQ: PaperImportRequest = { paths: ["t/paper-imports/me/a.pdf"], subject: "Biology", classLabel: "Form 2 East", curriculum: "844", kind: "exam", notes: "" };

describe("reading the files", () => {
  it("knows a file by its bytes, not its name", () => {
    assertEquals(sniff(fakePdf(1)), "pdf");
    assertEquals(sniff(PNG), "png");
    assertEquals(sniff(JPEG), "jpeg");
    assertEquals(sniff(fakeDocx([])), "docx");
    assertEquals(sniff(enc("MZ this is an exe")), null);
  });

  it("counts a PDF's pages, falling back to the page tree's count", () => {
    assertEquals(pdfPageCount(fakePdf(3)), 3);
    assertEquals(pdfPageCount(enc("%PDF-1.7\n<< /Type /Pages /Count 12 >>")), 12);
    assertEquals(pdfPageCount(enc("%PDF-1.7\n<< /Type /ObjStm >>")), null);
  });

  it("takes the text out of a Word file, numbering lists and marking figures", () => {
    const text = docxText(fakeDocx([
      para(run("SECTION A (40 marks)")),
      para(run("Name the organelle &amp; its role."), { lvl: 0, id: 3 }),
      para(run("Study the diagram below.") + "<w:r><w:drawing>…</w:drawing></w:r>", { lvl: 0, id: 3 }),
      para(run("Label part A") + "<w:r><w:tab/></w:r>" + run("(2 marks)"), { lvl: 1, id: 3 }),
      para(run("State its function"), { lvl: 1, id: 3 }),
      para(run("Explain osmosis."), { lvl: 0, id: 3 }),
    ]));
    assertEquals(text.split("\n"), [
      "SECTION A (40 marks)",
      "1. Name the organelle & its role.",
      "2. Study the diagram below. [FIGURE]",
      "(a) Label part A\t(2 marks)",
      "(b) State its function",
      "3. Explain osmosis.",
    ]);
  });

  it("refuses a zip that isn't a Word document", () => {
    assertThrows(() => docxText(zipSync({ "hello.txt": strToU8("hi") })), BadInput);
  });

  it("encodes large files without overflowing", () => {
    const big = new Uint8Array(200_000).fill(65);
    assertEquals(atob(toBase64(big)).length, 200_000);
  });
});

describe("what the model is sent", () => {
  it("sends a PDF as a document, then the instruction", () => {
    const parts = paperImportContent(REQ, [fakePdf(4)]);
    assertEquals(parts.map((p) => p.type), ["pdf", "text"]);
    // deno-lint-ignore no-explicit-any
    assertStringIncludes((parts[1] as any).text, "Above is a PDF");
  });

  it("sends a Word file as its text, inside markers", () => {
    const parts = paperImportContent(REQ, [fakeDocx([para(run("1. Define a cell."))])]);
    assertEquals(parts.map((p) => p.type), ["text", "text"]);
    // deno-lint-ignore no-explicit-any
    assertStringIncludes((parts[0] as any).text, "<paper>\n1. Define a cell.\n</paper>");
  });

  it("sends page photos in order", () => {
    const parts = paperImportContent(REQ, [PNG, JPEG]);
    // deno-lint-ignore no-explicit-any
    assertEquals(parts.map((p: any) => p.mediaType ?? p.type), ["image/png", "image/jpeg", "text"]);
    // deno-lint-ignore no-explicit-any
    assertStringIncludes((parts[2] as any).text, "2 photos of the pages");
  });

  it("turns away a long PDF, a mix, and anything that isn't a paper format", () => {
    assertThrows(() => paperImportContent(REQ, [fakePdf(MAX_PDF_PAGES + 1)]), BadInput, `${MAX_PDF_PAGES + 1} pages`);
    assertThrows(() => paperImportContent(REQ, [fakePdf(1), PNG]), BadInput, "not a mix");
    assertThrows(() => paperImportContent(REQ, [enc("MZ")]), BadInput, "PDF, Word");
    assert(paperImportContent(REQ, [PNG]).length === 2);
  });
});
