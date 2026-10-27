import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  BLOOM_EXPORT_DISCLAIMER, bloomExportFileName, buildBloomExport, exportTimestamp, exportTitle, pdfSafeText, replyTables, runsText,
  sheetName, spreadsheetNumber, type ExportBlock, type ExportTurn,
} from "./bloomExport";
import { csvFormulaSafe, toSpreadsheetCsv } from "./csv";

const NOW = new Date(2026, 9, 27, 14, 5);
const one = (content: string, sources: ExportTurn["sources"] = []) =>
  buildBloomExport({ title: "T", schoolName: "Kijani High School", turns: [{ role: "assistant", content, sources }], labelTurns: false, now: NOW });
const blocks = (content: string, sources?: ExportTurn["sources"]) => one(content, sources).sections[0]!.blocks;

describe("buildBloomExport", () => {
  it("carries the title, school, date and the AI note", () => {
    const d = one("Hello");
    expect(d).toMatchObject({ title: "T", schoolName: "Kijani High School", date: "27 October 2026", disclaimer: BLOOM_EXPORT_DISCLAIMER });
    expect(d.sections[0]).toMatchObject({ label: null, time: null });
  });

  it("keeps headings, paragraphs and inline styles as runs", () => {
    const [h, p] = blocks("## Fees **due**\n\nPay *by* `Friday` at [the office](https://kijani.ac.ke/fees).");
    expect(h).toMatchObject({ kind: "heading", level: 2, runs: [{ text: "Fees " }, { text: "due", bold: true }] });
    expect(p?.kind === "paragraph" && p.runs).toEqual([
      { text: "Pay " }, { text: "by", italic: true }, { text: " " }, { text: "Friday", code: true }, { text: " at " },
      { text: "the office", href: "https://kijani.ac.ke/fees" }, { text: "." },
    ]);
  });

  it("flattens nested lists with levels, numbers and a list each", () => {
    const b = blocks("3. Starter\n4. Main\n   - group work\n   - feedback\n     1. one\n5. Plenary\n\nThen:\n\n1. again");
    const items = b.filter((x): x is Extract<ExportBlock, { kind: "listItem" }> => x.kind === "listItem");
    expect(items.map((x) => [runsText(x.runs), x.indent, x.ordered, x.number])).toEqual([
      ["Starter", 0, true, 3], ["Main", 0, true, 4], ["group work", 1, false, 1], ["feedback", 1, false, 2],
      ["one", 2, true, 1], ["Plenary", 0, true, 5], ["again", 0, true, 1],
    ]);
    // the outer list, the bullets, the inner numbers and the second list are four separate lists
    expect(new Set(items.map((x) => x.listId)).size).toBe(4);
    expect(items[0]!.listId).toBe(items[5]!.listId);
    expect(items[6]!.listId).not.toBe(items[0]!.listId);
  });

  it("indents what follows an item's first line", () => {
    const b = blocks("- Plan\n\n  More detail\n\n  ```\ncode\n  ```");
    expect(b.map((x) => [x.kind, x.indent])).toEqual([["listItem", 0], ["paragraph", 1], ["code", 1]]);
  });

  it("keeps tables with alignment, header and inline styles", () => {
    const [t] = blocks("| Item | Cost |\n|:--|--:|\n| **Uniform** | KES 1,250 |\n| Books |");
    if (t?.kind !== "table") throw new Error("not a table");
    expect(t.align).toEqual(["left", "right"]);
    expect(t.head.map(runsText)).toEqual(["Item", "Cost"]);
    expect(t.rows[0]![0]).toEqual([{ text: "Uniform", bold: true }]);
    expect(t.rows[1]!.map(runsText)).toEqual(["Books", ""]);
  });

  it("keeps code exactly and marks quotes", () => {
    const b = blocks("```python\nfor i in range(3):\n    print(i)\n```\n\n> Elimu ni ufunguo\n\n---");
    expect(b[0]).toEqual({ kind: "code", indent: 0, lang: "python", text: "for i in range(3):\n    print(i)" });
    expect(b[1]).toMatchObject({ kind: "paragraph", quote: true });
    expect(b[2]).toMatchObject({ kind: "rule" });
  });

  it("turns citations into superscript numbers linked to a sources list", () => {
    const d = one("Term starts in January.[^1] Fees rose[^2].", [
      { title: "MoE calendar", url: "https://education.go.ke/calendar" },
      { title: "News", url: "https://nation.africa/fees" },
    ]);
    const p = d.sections[0]!.blocks[0]!;
    expect(p.kind === "paragraph" && p.runs.filter((r) => r.sup)).toEqual([
      { text: "1", sup: true, href: "https://education.go.ke/calendar" },
      { text: "2", sup: true, href: "https://nation.africa/fees" },
    ]);
    expect(d.sources).toEqual([
      { n: 1, title: "MoE calendar", url: "https://education.go.ke/calendar" },
      { n: 2, title: "News", url: "https://nation.africa/fees" },
    ]);
  });

  it("drops a citation with no usable source, and numbers the rest across the chat", () => {
    const turns: ExportTurn[] = [
      { role: "user", content: "When does term start?\nAnd fees?", created_at: "2026-10-27T11:00:00Z" },
      { role: "assistant", content: "A[^1] B[^2] C[^3]", sources: [{ title: "", url: "" }, { title: "Cal", url: "https://a.ke/cal" }, { title: "Fees", url: "https://a.ke/fees" }] },
      { role: "assistant", content: "Again[^1] new[^2]", sources: [{ title: "Fees", url: "https://a.ke/fees" }, { title: "KNEC", url: "https://knec.ac.ke" }] },
    ];
    const d = buildBloomExport({ title: "T", schoolName: "S", turns, labelTurns: true, now: NOW });
    const sups = (i: number) => { const p = d.sections[i]!.blocks[0]!; return p.kind === "paragraph" ? p.runs.filter((r) => r.sup).map((r) => r.text) : []; };
    expect(sups(1)).toEqual(["1", "2"]);
    expect(sups(2)).toEqual(["2", "3"]);
    expect(d.sources.map((s) => s.url)).toEqual(["https://a.ke/cal", "https://a.ke/fees", "https://knec.ac.ke"]);
    expect(d.sections.map((s) => s.label)).toEqual(["You", "Bloom", "Bloom"]);
    expect(d.sections[0]!.time).toBe(exportTimestamp("2026-10-27T11:00:00Z"));
    expect(d.sections[1]!.time).toBeNull();
  });

  it("keeps a question as typed, not read as Markdown", () => {
    const d = buildBloomExport({ title: "T", schoolName: "S", turns: [{ role: "user", content: "# not a heading\n*stars*\n\nsecond" }], labelTurns: true, now: NOW });
    expect(d.sections[0]!.blocks).toEqual([
      { kind: "paragraph", indent: 0, runs: [{ text: "# not a heading\n*stars*" }] },
      { kind: "paragraph", indent: 0, runs: [{ text: "second" }] },
    ]);
  });

  it("keeps Unicode text untouched in the model", () => {
    const text = "Wanafunzi wa Kidato cha 2 – ada ni KES 1,250 kwa “Muhula” wa José Ñandú, Zoë 😊";
    const p = blocks(text)[0]!;
    expect(p.kind === "paragraph" && runsText(p.runs)).toBe(text);
  });
});

describe("exportTitle and file names", () => {
  it("uses the chat's name, else the first question's first words", () => {
    expect(exportTitle("Half term circular", [])).toBe("Half term circular");
    expect(exportTitle(null, [{ role: "user", content: "Draft a circular to parents about half term" }])).toBe("Draft a circular to parents about half term");
    expect(exportTitle("New chat", [{ role: "assistant", content: "" }])).toBe("Bloom chat");
  });

  it("names files Bloom - title - date, without characters file systems refuse", () => {
    expect(bloomExportFileName("Half term circular", NOW, "pdf")).toBe("Bloom - Half term circular - 2026-10-27.pdf");
    expect(bloomExportFileName('Fees: Term 1/2 "draft" <v2>?', NOW, "docx")).toBe("Bloom - Fees Term 1 2 draft v2 - 2026-10-27.docx");
    expect(bloomExportFileName("Ratiba ya mitihani ya Kidato cha Nne – José…", NOW, "xlsx")).toBe("Bloom - Ratiba ya mitihani ya Kidato cha Nne – José - 2026-10-27.xlsx");
    expect(bloomExportFileName("  ...  ", NOW, "csv")).toBe("Bloom - chat - 2026-10-27.csv");
    const long = bloomExportFileName("word ".repeat(40), NOW, "pdf");
    expect(long.length).toBeLessThan(110);
    expect(long).toMatch(/^Bloom - word( word)+ - 2026-10-27\.pdf$/);
  });
});

describe("pdfSafeText", () => {
  it("keeps what the standard fonts can draw", () => {
    expect(pdfSafeText("José Ñandú – “KES 1,250” — Zoë’s café • €5")).toBe("José Ñandú – “KES 1,250” — Zoë’s café • €5");
    expect(pdfSafeText("Habari ya asubuhi, mwalimu! Karibu shuleni.")).toBe("Habari ya asubuhi, mwalimu! Karibu shuleni.");
  });

  it("simplifies the rest, keeping spaces for code", () => {
    expect(pdfSafeText("Şükrü Łukasz Ōtieno ŋombe")).toBe("Sükrü Lukasz Otieno ngombe");
    expect(pdfSafeText("x → y, a ≥ b, ✓ done")).toBe("x -> y, a >= b, [x] done");
    expect(pdfSafeText("Great work 👏🏽 🇰🇪!\u200b")).toBe("Great work  !");
    expect(pdfSafeText("\tif x:\n        y")).toBe("    if x:\n        y");
    expect(pdfSafeText("مرحبا 你好")).toBe("????? ??");
  });

  it("makes any text encodable by the PDF's Helvetica and Courier", async () => {
    const doc = await PDFDocument.create();
    const fonts = [await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.Courier)];
    const sample = "Ada: KES 1,250 – “Muhula wa Kwanza” · José, Zoë, Ñandú, Łukasz, Şükrü · x → y ≤ z ≠ w ✓ ❌ 😊👍🏾 🇰🇪 \u00a0\u2009\u200b\ufeff − ‐ ′ ″ 你好 مرحبا Ελληνικά Кириллица";
    for (const f of fonts) {
      // the reason for the function: the raw text can't be encoded
      expect(() => f.encodeText(sample)).toThrow();
      expect(() => f.encodeText(pdfSafeText(sample))).not.toThrow();
      expect(() => f.widthOfTextAtSize(pdfSafeText(sample), 10)).not.toThrow();
    }
  });
});

describe("tables as spreadsheets", () => {
  const reply = [
    "## Fee structure", "", "| Item | Cost |", "|---|--:|", "| **Tuition**[^1] | KES 12,500 |", "| Lunch | 3,000 |", "",
    "- Notes:", "", "  | A | B |", "  |---|---|", "  | x | y |",
  ].join("\n");

  it("finds every table with a name and plain cell text", () => {
    expect(replyTables(reply)).toEqual([
      { name: "Fee structure", head: ["Item", "Cost"], rows: [["Tuition", "KES 12,500"], ["Lunch", "3,000"]] },
      { name: "Table 2", head: ["A", "B"], rows: [["x", "y"]] },
    ]);
    expect(replyTables("No tables here.")).toEqual([]);
  });

  it("reads numbers only where the cell clearly holds one", () => {
    expect(spreadsheetNumber("1,250")).toBe(1250);
    expect(spreadsheetNumber("KES 1,250")).toBe(1250);
    expect(spreadsheetNumber("Ksh. 2,000.50")).toBe(2000.5);
    expect(spreadsheetNumber("-3.5")).toBe(-3.5);
    expect(spreadsheetNumber("−40")).toBe(-40);
    expect(spreadsheetNumber("42")).toBe(42);
    for (const text of ["0712345678", "80 - 100", "45%", "12,50", "1,2345", "Term 1", "", "=1+1", "1234567890123456"]) expect(spreadsheetNumber(text)).toBeNull();
  });

  it("makes sheet names Excel accepts, each once", () => {
    const taken = new Set<string>();
    expect(sheetName("Fees: Term 1/2 [draft]", taken)).toBe("Fees Term 1 2 draft");
    expect(sheetName("Fees: Term 1/2 [draft]", taken)).toBe("Fees Term 1 2 draft (2)");
    expect(sheetName("A very long table heading that goes on and on", taken)).toBe("A very long table heading that");
    expect(sheetName("''", taken)).toBe("Table");
  });
});

describe("spreadsheet CSV", () => {
  it("guards cells that a spreadsheet would run as a formula", () => {
    expect(csvFormulaSafe("=HYPERLINK(\"http://x\")")).toBe("'=HYPERLINK(\"http://x\")");
    expect(csvFormulaSafe("+254 712 345678")).toBe("'+254 712 345678");
    expect(csvFormulaSafe("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvFormulaSafe("-2+3")).toBe("'-2+3");
    expect(csvFormulaSafe("\tx")).toBe("'\tx");
    expect(csvFormulaSafe("\rx")).toBe("'\rx");
    expect(csvFormulaSafe("-1,250")).toBe("-1,250");
    expect(csvFormulaSafe("Mwanafunzi")).toBe("Mwanafunzi");
  });

  it("writes RFC 4180 with CRLF and a UTF-8 byte order mark", () => {
    const csv = toSpreadsheetCsv(["Jina", "Ada"], [["José, Ñandú", 'say "hi"'], ["=cmd", "line\nbreak"]]);
    expect(csv).toBe('\uFEFFJina,Ada\r\n"José, Ñandú","say ""hi"""\r\n\'=cmd,"line\nbreak"\r\n');
  });
});
