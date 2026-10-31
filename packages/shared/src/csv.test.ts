import { describe, expect, it } from "vitest";
import { csvCell, csvLines, splitCsvLine, toCsv } from "./csv";

/**
 * QA 11 (FIG-1244): the CSV helpers every import and export in the app is built on. Written by hand from the CSV rules
 * (RFC 4180: a field in quotes may hold commas, doubled quotes and line breaks) and from what a spreadsheet writes, not from the
 * code under test.
 *
 * Known defects are written as the behaviour we want and use it.fails: they pass while the defect exists and fail the day it is
 * fixed. Then change it.fails to it.
 */

describe("splitCsvLine", () => {
  it("splits on commas and trims the cells", () => {
    expect(splitCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
    expect(splitCsvLine(" a , b ,c ")).toEqual(["a", "b", "c"]);
  });
  it("keeps a comma inside quotes: a name written 'Kamau, Wanjiku'", () => {
    expect(splitCsvLine('4501,"Kamau, Wanjiku",female')).toEqual(["4501", "Kamau, Wanjiku", "female"]);
  });
  it("reads a doubled quote inside quotes as one quote", () => {
    expect(splitCsvLine('"He said ""hi"""')).toEqual(['He said "hi"']);
    expect(splitCsvLine('1,"Odhiambo ""Otis"" Otieno",2')).toEqual(["1", 'Odhiambo "Otis" Otieno', "2"]);
  });
  it("keeps empty cells, including a trailing one", () => {
    expect(splitCsvLine("a,,c,")).toEqual(["a", "", "c", ""]);
    expect(splitCsvLine("")).toEqual([""]);
  });
  it("drops a byte-order mark at the start (Excel's 'CSV UTF-8' puts one there)", () => {
    expect(splitCsvLine("﻿admission_no,full_name")).toEqual(["admission_no", "full_name"]);
  });
  it("(pinned) trims spaces inside quotes too, so a quoted ' a ' comes back as 'a'", () => {
    expect(splitCsvLine('" a "')).toEqual(["a"]);
  });
});

describe("csvLines", () => {
  it("splits on CRLF, LF and a lone CR", () => {
    expect(csvLines("a\r\nb\nc\rd")).toEqual(["a", "b", "c", "d"]);
  });
  it("drops blank and whitespace-only lines, and gives nothing for empty text", () => {
    expect(csvLines("a\n\n  \r\n\tb\n")).toEqual(["a", "\tb"]);
    expect(csvLines("")).toEqual([]);
    expect(csvLines("\n\r\n   ")).toEqual([]);
  });
});

describe("csvCell and toCsv", () => {
  it("writes a plain value as it is, and nothing for null or undefined", () => {
    expect(csvCell("Wanjiku")).toBe("Wanjiku");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  it("quotes a value with a comma, a quote or a line break, and doubles its quotes", () => {
    expect(csvCell("Kamau, Wanjiku")).toBe('"Kamau, Wanjiku"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("two\r\nlines")).toBe('"two\r\nlines"');
    expect(csvCell("old\rmac")).toBe('"old\rmac"');
  });
  it("writes a header and rows joined by line breaks, with no trailing break", () => {
    expect(toCsv(["a", "b"], [["1", "x,y"], [2, null]])).toBe('a,b\n1,"x,y"\n2,');
  });
  it("what toCsv writes, splitCsvLine reads back, for commas and quotes", () => {
    const rows = [["4501", "Kamau, Wanjiku", 'said "hi"'], ["4502", "Otieno", ""]];
    const text = toCsv(["admission_no", "full_name", "note"], rows);
    const back = csvLines(text).map(splitCsvLine);
    expect(back).toEqual([["admission_no", "full_name", "note"], ["4501", "Kamau, Wanjiku", 'said "hi"'], ["4502", "Otieno", ""]]);
  });
});

describe("known defects", () => {
  it.fails("QA11-NEWLINE FIG-1425: a cell with a line break inside quotes reads back as one cell (what toCsv writes, the readers cannot read)", () => {
    const text = toCsv(["admission_no", "home_address"], [["4501", "Plot 12\nKahawa Sukari"]]);
    const back = csvLines(text).map(splitCsvLine);
    expect(back, "the address was cut in two at its line break").toEqual([["admission_no", "home_address"], ["4501", "Plot 12\nKahawa Sukari"]]);
  });

  // A spreadsheet runs a cell that starts with = + - or @ as a formula. Text that someone typed (a name, an item, a note) must be
  // made safe when it is written to a file, usually by a leading apostrophe. A number is not text: -5 must stay -5.
  const FORMULAS = ['=HYPERLINK("http://x.example","click")', "+1+1", "-2+3", "@SUM(A1:A9)"];
  it.fails("QA11-FORMULA FIG-1426: text that starts with = + - or @ is made safe when written to a CSV cell", () => {
    for (const f of FORMULAS) {
      const cell = csvCell(f);
      const inner = cell.startsWith('"') ? cell.slice(1) : cell;
      expect(/^[=+\-@]/.test(inner), `${f} is written as ${cell}`).toBe(false);
    }
  });
  it.fails("QA11-FORMULA FIG-1426: toCsv makes the same text safe in a row", () => {
    const text = toCsv(["name"], [[FORMULAS[0]!]]);
    expect(text.split("\n")[1]!.replace(/^"/, "")).not.toMatch(/^[=+\-@]/);
  });
  it("a number is not text: a negative number is written as it is", () => {
    expect(csvCell(-5)).toBe("-5");
  });
});
