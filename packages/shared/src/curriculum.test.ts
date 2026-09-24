import { describe, expect, it } from "vitest";
import { STRAND_CSV_TEMPLATE, parseStrandCsv } from "./curriculum";

const areas = [
  { id: "isc", code: "JS-ISC", name: "Integrated Science", min_grade: 7, max_grade: 9 },
  { id: "eng", code: "UP-ENG", name: "English", min_grade: 4, max_grade: 6 },
];

describe("parseStrandCsv", () => {
  it("gathers sub-strands under their strand, in file order", () => {
    const { strands, errors } = parseStrandCsv(STRAND_CSV_TEMPLATE, areas);
    expect(errors).toEqual([]);
    expect(strands).toEqual([
      { areaCode: "JS-ISC", learningAreaId: "isc", grade: 7, name: "Scientific Investigation", code: "1.0", subStrands: ["Introduction to Integrated Science", "Laboratory Safety"] },
      { areaCode: "JS-ISC", learningAreaId: "isc", grade: 7, name: "Mixtures Elements and Compounds", code: "2.0", subStrands: ["Mixtures"] },
    ]);
  });

  it("accepts a strand with no sub-strands, and quoted names with commas", () => {
    const csv = 'area_code,grade,strand\nup-eng,5,"Listening, Speaking"';
    const { strands, errors } = parseStrandCsv(csv, areas);
    expect(errors).toEqual([]);
    expect(strands[0]).toMatchObject({ learningAreaId: "eng", grade: 5, name: "Listening, Speaking", subStrands: [] });
  });

  it("reports bad lines by spreadsheet line number and keeps the good ones", () => {
    const csv = [
      "area_code,grade,strand,sub_strand",
      "JS-ISC,7,Force and Energy,Electrical Energy",
      "XX-NOPE,7,Something,",
      "JS-ISC,6,Too Young,",
      "JS-ISC,8,,Orphan",
    ].join("\n");
    const { strands, errors } = parseStrandCsv(csv, areas);
    expect(strands).toHaveLength(1);
    expect(errors).toEqual([
      'Line 3: no learning area with code "XX-NOPE".',
      'Line 4: Integrated Science runs grade 7 to 9, not "6".',
      "Line 5: the strand name is blank.",
    ]);
  });

  it("doesn't duplicate a sub-strand listed twice", () => {
    const csv = "area_code,grade,strand,sub_strand\nJS-ISC,9,Living Things,Cells\nJS-ISC,9,Living Things,cells";
    expect(parseStrandCsv(csv, areas).strands[0]!.subStrands).toEqual(["Cells"]);
  });

  it("explains a missing header instead of guessing", () => {
    expect(parseStrandCsv("JS-ISC,7,Something", areas).errors[0]).toMatch(/Missing columns: area_code, grade, strand/);
  });
});
