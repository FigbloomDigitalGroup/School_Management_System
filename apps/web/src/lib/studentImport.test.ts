import { describe, expect, it } from "vitest";
import { csvTemplate, parseStudentCsv, type ParseContext } from "./studentImport";

/**
 * QA 11 (FIG-1244): the learner CSV import, as the People screen runs it before anything is written. parseStudentCsv() is the
 * whole validation step, so every rule is checked here with hand-written files. What the database then does with the rows that
 * pass is in tests/integration/learners.test.ts, and the screen is in e2e/learners.spec.ts.
 *
 * The import's rule, as the code and the screen have it: every row is checked and shown, rows with a problem are skipped, and the
 * rest are saved in one go ("N of M rows ready", "N need fixing"). It is per-row errors, not all-or-nothing.
 *
 * Known defects are written as the behaviour we want and use it.fails: they pass while the defect exists and fail the day it is
 * fixed. Then change it.fails to it.
 */

const CLASSES = new Map([["form 1 east", "c-1e"], ["form 2 west", "c-2w"], ["form 2 east", "c-2e"]]);
const ctx = (existing: string[] = []): ParseContext => ({ classIdByName: CLASSES, existingAdmissionNos: new Set(existing) });
const HEADER = "admission_no,full_name,gender,class,boarding,date_of_birth";
const parse = (lines: string[], c: ParseContext = ctx(), eol = "\n") => parseStudentCsv(lines.join(eol), c);
const GOOD = "4501,Wanjiku Kamau,female,Form 2 East,yes,2010-03-14";

describe("a clean row", () => {
  it("is read field by field, with no errors", () => {
    const [r] = parse([HEADER, GOOD]);
    expect(r).toMatchObject({
      line: 2, admission_no: "4501", full_name: "Wanjiku Kamau", gender: "female", className: "Form 2 East", boarding: true,
      date_of_birth: "2010-03-14", home_address: null, home_lat: null, home_lng: null, allergies: [], medical_conditions: [], errors: [],
    });
  });
  it("the template the screen offers for download imports without a single error, once its class exists", () => {
    const rows = parseStudentCsv(csvTemplate(), ctx());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.errors)).toEqual([[], []]);
    expect(rows[1]).toMatchObject({ home_address: "Plot 12, Kahawa Sukari", home_landmark: "Opposite Naivas", allergies: ["Peanuts", "Eggs"], medical_conditions: ["Asthma"] });
  });
  it("gives nothing for empty text, whitespace, or a header with no rows", () => {
    expect(parseStudentCsv("", ctx())).toEqual([]);
    expect(parseStudentCsv("\n\r\n  ", ctx())).toEqual([]);
    expect(parse([HEADER])).toEqual([]);
  });
});

describe("what a spreadsheet writes", () => {
  it("a byte-order mark and CRLF line endings (Excel 'CSV UTF-8') change nothing", () => {
    const rows = parseStudentCsv("﻿" + [HEADER, GOOD, "4502,Otieno Odhiambo,male,Form 1 East,no,"].join("\r\n") + "\r\n", ctx());
    expect(rows.map((r) => [r.admission_no, r.errors.length])).toEqual([["4501", 0], ["4502", 0]]);
  });
  it("a lone CR (old Mac Excel) is a line ending too", () => {
    expect(parse([HEADER, GOOD], ctx(), "\r")).toHaveLength(1);
  });
  it("a name with a comma, in quotes, stays one cell", () => {
    const [r] = parse([HEADER, '4501,"Kamau, Wanjiku",female,Form 2 East,no,']);
    expect(r!.full_name).toBe("Kamau, Wanjiku");
    expect(r!.errors).toEqual([]);
  });
  it("doubled quotes inside quotes come out as one quote", () => {
    const [r] = parse([HEADER, '4501,"Odhiambo ""Otis"" Otieno",male,Form 2 East,no,']);
    expect(r!.full_name).toBe('Odhiambo "Otis" Otieno');
  });
  it("blank lines are skipped", () => {
    expect(parse([HEADER, "", GOOD, "   ", "4502,B,male,Form 1 East,no,"]).map((r) => r.admission_no)).toEqual(["4501", "4502"]);
  });
  it("columns can come in any order, in any case, with extra columns the import does not know", () => {
    const rows = parse(["Nickname,CLASS,Full_Name,Admission_No,gender,boarding", "Wanji,Form 2 East,Wanjiku Kamau,4501,female,no"]);
    expect(rows[0]).toMatchObject({ admission_no: "4501", full_name: "Wanjiku Kamau", className: "Form 2 East", boarding: false, errors: [] });
  });
  it("cells are trimmed, including the admission number and the class name's case and spaces", () => {
    const [r] = parse([HEADER, "  4501 , Wanjiku Kamau ,female,  form 2 east  ,no,"]);
    expect(r).toMatchObject({ admission_no: "4501", full_name: "Wanjiku Kamau", errors: [] });
  });
  it.fails("QA11-LINES FIG-1423: an error is reported against the line of the FILE, so the office can find it (a blank line above does not shift the numbers)", () => {
    const [r] = parse([HEADER, "", "", GOOD]);
    expect(r!.line, "the row is on line 4 of the file").toBe(4);
  });
  it.fails("QA11-NEWLINE FIG-1425: a quoted address with a line break in it stays in one row (Excel writes it that way when someone presses Enter in a cell)", () => {
    const rows = parse([HEADER + ",home_address", '4501,Wanjiku Kamau,female,Form 2 East,no,,"Plot 12', 'Kahawa Sukari"', "4502,B,male,Form 1 East,no,,"]);
    expect(rows.map((r) => [r.admission_no, r.errors.length])).toEqual([["4501", 0], ["4502", 0]]);
    expect(rows[0]!.home_address).toBe("Plot 12\nKahawa Sukari");
  });
});

describe("required fields and values", () => {
  it("a missing admission number, name, gender or class is reported in words, one message each", () => {
    const [r] = parse([HEADER, ",,,,no,"]);
    expect(r!.errors).toEqual(["Missing admission number.", "Missing name.", "Missing gender (male/female).", "Missing class."]);
  });
  it("a row shorter than the header counts the missing cells as blank", () => {
    const [r] = parse([HEADER, "4501,Wanjiku Kamau"]);
    expect(r!.errors).toEqual(["Missing gender (male/female).", "Missing class."]);
  });
  it("a file with no admission_no column fails every row with the same message (the header itself is not mentioned)", () => {
    const rows = parse(["full_name,gender,class", "A,male,Form 1 East", "B,female,Form 1 East"]);
    expect(rows.map((r) => r.errors)).toEqual([["Missing admission number."], ["Missing admission number."]]);
  });
  it("a header written 'Admission No' (spaces, not underscores) is not found, so every row fails the same way", () => {
    const rows = parse(["Admission No,Full Name,Gender,Class", "4501,A,male,Form 1 East"]);
    expect(rows[0]!.errors).toContain("Missing admission number.");
    expect(rows[0]!.errors).toContain("Missing name.");
  });
  it("gender: m, f, b, g, boy, girl and any case are accepted; anything else is named in the message; blank is missing", () => {
    const g = (v: string) => parse([HEADER, `1,A,${v},Form 1 East,no,`])[0]!;
    expect([g("M").gender, g("Female").gender, g("boy").gender, g("GIRL").gender]).toEqual(["male", "female", "male", "female"]);
    expect([g("b").gender, g("G").gender]).toEqual(["male", "female"]);
    expect(g("x").errors).toEqual(['"x" isn\'t male or female.']);
    expect(g("").errors).toEqual(["Missing gender (male/female)."]);
  });
  it("class: matched without case or spaces; an unknown class is named, a blank one is missing", () => {
    const c = (v: string) => parse([HEADER, `1,A,male,${v},no,`])[0]!;
    expect(c("FORM 1 EAST").errors).toEqual([]);
    expect(c("Form 9 North").errors).toEqual(['"Form 9 North" is not one of this school\'s classes.']);
    expect(c("").errors).toEqual(["Missing class."]);
  });
  it("boarding: yes, y, true, 1, boarder and boarding mean boarder; no, blank and day mean day scholar", () => {
    const b = (v: string) => parse([HEADER, `1,A,male,Form 1 East,${v},`])[0]!.boarding;
    expect(["yes", "Y", "TRUE", "1", "Boarder", "boarding"].map(b)).toEqual([true, true, true, true, true, true]);
    expect(["no", "", "day", "false", "0"].map(b)).toEqual([false, false, false, false, false]);
  });
  it.fails("QA11-BOARDING FIG-1423: a boarding value that is neither yes nor no ('yess', 'maybe') is flagged, not quietly read as a day scholar", () => {
    expect(parse([HEADER, "1,A,male,Form 1 East,yess,"])[0]!.errors.length).toBeGreaterThan(0);
  });
});

describe("dates of birth", () => {
  const dob = (v: string) => parse([HEADER, `1,A,male,Form 1 East,no,${v}`])[0]!;
  it("YYYY-MM-DD is accepted; blank is allowed (the date is optional)", () => {
    expect(dob("2010-03-14").errors).toEqual([]);
    expect(dob("").errors).toEqual([]);
    expect(dob("").date_of_birth).toBeNull();
  });
  it("another format is refused, and the message says which one is wanted", () => {
    for (const v of ["14/03/2010", "14-03-2010", "2010/03/14", "March 14 2010", "2010-3-14", "2010-03-14x", "2010-03-141"]) expect(dob(v).errors, v).toEqual(["Date of birth must be YYYY-MM-DD."]);
    expect(dob("14/03/2010").date_of_birth).toBeNull();
  });
  it.fails("QA11-DATE FIG-1412: a date that does not exist (2010-02-31, 2010-13-45) is refused (the database cannot save it, and one such row stops the whole import)", () => {
    for (const v of ["2010-02-31", "2010-13-45", "2011-02-29"]) expect(dob(v).errors.length, v).toBeGreaterThan(0);
  });
  it.fails("QA11-DOB FIG-1421: a date of birth in the future is refused", () => {
    expect(dob("2090-01-01").errors.length).toBeGreaterThan(0);
  });
});

describe("duplicates", () => {
  it("the same admission number twice in one file: the second is flagged and says so, the first is fine", () => {
    const rows = parse([HEADER, "4501,A,male,Form 1 East,no,", "4502,B,male,Form 1 East,no,", "4501,C,female,Form 1 East,no,"]);
    expect(rows.map((r) => r.errors)).toEqual([[], [], ["Admission 4501 appears twice in this file."]]);
  });
  it("an admission number already on the roster is flagged, so importing the same file again creates nobody", () => {
    const rows = parse([HEADER, "4501,A,male,Form 1 East,no,", "4502,B,male,Form 1 East,no,"], ctx(["4501", "4502"]));
    expect(rows.map((r) => r.errors)).toEqual([["Admission 4501 is already on the roster."], ["Admission 4502 is already on the roster."]]);
  });
  it("a number that is on the roster only once the context lists it: the context is the check", () => {
    expect(parse([HEADER, "4501,A,male,Form 1 East,no,"], ctx(["9999"]))[0]!.errors).toEqual([]);
  });
});

describe("homes and health (the optional columns)", () => {
  const home = (extra: string, header = ",home_lat,home_lng") => parse([HEADER + header, `1,A,male,Form 1 East,no,${extra}`])[0]!;
  it("a pin needs both numbers, or neither", () => {
    expect(home(",-1.2186,36.9258").errors).toEqual([]);
    expect(home(",-1.2186,").errors).toEqual(["home_lat and home_lng must both be numbers (e.g. -1.2186, 36.9258), or both blank."]);
    expect(home(",abc,36.9").errors.length).toBe(1);
  });
  it("a pin outside the globe is refused (latitude 90 and longitude 180 are the limits)", () => {
    expect(home(",90,180").errors).toEqual([]);
    expect(home(",91,36").errors.length).toBe(1);
    expect(home(",-1,181").errors.length).toBe(1);
  });
  it("allergies and conditions are split on commas, semicolons or line breaks", () => {
    const [r] = parse([HEADER + ",allergies,medical_conditions", '1,A,male,Form 1 East,no,,"Peanuts; Eggs, Dust",Asthma']);
    expect(r!.allergies).toEqual(["Peanuts", "Eggs", "Dust"]);
    expect(r!.medical_conditions).toEqual(["Asthma"]);
  });
  it("(pinned) an address longer than 300 characters is cut at 300 without a word, to fit the database column", () => {
    const [r] = parse([HEADER + ",home_address", `1,A,male,Form 1 East,no,,${"x".repeat(400)}`]);
    expect(r!.home_address).toHaveLength(300);
    expect(r!.errors).toEqual([]);
  });
  it("(pinned) a landmark longer than 200 characters is cut at 200 without a word, to fit the database column", () => {
    const [r] = parse([HEADER + ",home_landmark", `1,A,male,Form 1 East,no,,${"x".repeat(300)}`]);
    expect(r!.home_landmark).toHaveLength(200);
    expect(r!.errors).toEqual([]);
  });
});

describe("several thousand rows", () => {
  it("5,000 rows are read in well under two seconds, and the one repeated number is flagged on the right line", () => {
    const body = Array.from({ length: 5000 }, (_, i) => `${i + 1},Learner ${i + 1},${i % 2 ? "male" : "female"},Form 1 East,no,2010-01-01`);
    body.splice(4000, 0, "17,Repeated Seventeen,male,Form 1 East,no,2010-01-01");
    const t0 = Date.now();
    const rows = parse([HEADER, ...body]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(rows).toHaveLength(5001);
    const bad = rows.filter((r) => r.errors.length);
    expect(bad.map((r) => [r.line, r.admission_no, r.errors])).toEqual([[4002, "17", ["Admission 17 appears twice in this file."]]]);
  });
});
