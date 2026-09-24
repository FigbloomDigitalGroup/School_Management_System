import { csvLines, splitCsvLine } from "./csv";
import type { Pathway } from "./levels";
import { supabase } from "./supabase";
import type { ClassLevel } from "./types";

/**
 * The KICD catalogue (supabase/migrations/20260924040000_kicd_catalogue.sql):
 * learning areas per band, and strands / sub-strands per learning area per
 * grade. Official rows have tenant_id null and are maintained by Figbloom
 * staff; a school can add its own strands (tenant_id set) where the official
 * list doesn't cover a grade yet.
 */

export interface LearningArea {
  id: string;
  code: string;
  name: string;
  level: ClassLevel;
  min_grade: number;
  max_grade: number;
  is_core: boolean;
  pathway: Pathway | null;
  track: string | null;
  sort_order: number;
  source: string | null;
  verified_at: string | null;
}

export interface Strand {
  id: string;
  tenant_id: string | null;
  learning_area_id: string;
  grade: number;
  parent_id: string | null;
  code: string | null;
  name: string;
  sort_order: number;
  source: string | null;
  verified_at: string | null;
}

export const TRACK_LABEL: Record<string, string> = {
  pure_sciences: "Pure Sciences",
  applied_sciences: "Applied Sciences",
  technical_engineering: "Technical & Engineering",
  languages_literature: "Languages & Literature",
  humanities_business: "Humanities & Business",
  arts: "Arts",
  sports: "Sports",
};

export async function fetchLearningAreas(): Promise<LearningArea[]> {
  const { data, error } = await supabase().from("learning_areas").select("*").order("sort_order").returns<LearningArea[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Official strand counts per learning area and grade: "strands/sub-strands". */
export async function fetchOfficialStrandCoverage(): Promise<Map<string, { strands: number; subStrands: number }>> {
  const { data, error } = await supabase().from("strands").select("learning_area_id, grade, parent_id").is("tenant_id", null)
    .returns<{ learning_area_id: string; grade: number; parent_id: string | null }[]>();
  if (error) throw new Error(error.message);
  const out = new Map<string, { strands: number; subStrands: number }>();
  for (const s of data ?? []) {
    const k = coverageKey(s.learning_area_id, s.grade);
    const cur = out.get(k) ?? { strands: 0, subStrands: 0 };
    if (s.parent_id) cur.subStrands += 1; else cur.strands += 1;
    out.set(k, cur);
  }
  return out;
}

export const coverageKey = (learningAreaId: string, grade: number) => `${learningAreaId}:${grade}`;

export async function updateLearningArea(id: string, patch: Partial<Pick<LearningArea, "name" | "code" | "is_core" | "source">>): Promise<void> {
  const { error } = await supabase().from("learning_areas").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Stamps (or clears) verified_at — "someone checked this against the official KICD design". */
export async function setLearningAreaVerified(id: string, verified: boolean): Promise<void> {
  const { error } = await supabase().from("learning_areas").update({ verified_at: verified ? new Date().toISOString() : null }).eq("id", id);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------- CSV import

export interface ParsedStrand {
  areaCode: string;
  learningAreaId: string;
  grade: number;
  name: string;
  code: string | null;
  subStrands: string[];
}

export interface StrandCsvResult {
  strands: ParsedStrand[];
  /** One message per bad line, with its line number as the spreadsheet shows it. */
  errors: string[];
}

export const STRAND_CSV_TEMPLATE = [
  "area_code,grade,strand,sub_strand,strand_code",
  "JS-ISC,7,Scientific Investigation,Introduction to Integrated Science,1.0",
  "JS-ISC,7,Scientific Investigation,Laboratory Safety,1.0",
  "JS-ISC,7,Mixtures Elements and Compounds,Mixtures,2.0",
].join("\n");

/**
 * One row per sub-strand (or per strand, with sub_strand left blank), in the
 * order the curriculum design lists them — that order becomes sort_order.
 * Rows naming the same area, grade and strand are gathered under one strand.
 */
export function parseStrandCsv(text: string, areas: Pick<LearningArea, "id" | "code" | "name" | "min_grade" | "max_grade">[]): StrandCsvResult {
  const lines = csvLines(text);
  const errors: string[] = [];
  if (lines.length === 0) return { strands: [], errors: ["The file is empty."] };

  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idx = { area: col("area_code"), grade: col("grade"), strand: col("strand"), sub: col("sub_strand"), code: col("strand_code") };
  const missing = (["area_code", "grade", "strand"] as const).filter((h) => col(h) < 0);
  if (missing.length) return { strands: [], errors: [`Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. The first row must be the header.`] };

  const areaByCode = new Map(areas.map((a) => [a.code.toUpperCase(), a]));
  const byKey = new Map<string, ParsedStrand>();

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const lineNo = i + 1;
    const areaCode = (cells[idx.area] ?? "").toUpperCase();
    const area = areaByCode.get(areaCode);
    const grade = Number(cells[idx.grade] ?? "");
    const name = cells[idx.strand] ?? "";
    const sub = idx.sub >= 0 ? (cells[idx.sub] ?? "") : "";
    const code = idx.code >= 0 ? (cells[idx.code] || null) : null;

    if (!area) { errors.push(`Line ${lineNo}: no learning area with code "${cells[idx.area] ?? ""}".`); continue; }
    if (!Number.isInteger(grade) || grade < area.min_grade || grade > area.max_grade) {
      errors.push(`Line ${lineNo}: ${area.name} runs grade ${area.min_grade} to ${area.max_grade}, not "${cells[idx.grade] ?? ""}".`);
      continue;
    }
    if (!name) { errors.push(`Line ${lineNo}: the strand name is blank.`); continue; }

    const key = `${area.id}:${grade}:${name.toLowerCase()}`;
    const strand = byKey.get(key) ?? { areaCode: area.code, learningAreaId: area.id, grade, name, code, subStrands: [] };
    if (!strand.code && code) strand.code = code;
    if (sub && !strand.subStrands.some((s) => s.toLowerCase() === sub.toLowerCase())) strand.subStrands.push(sub);
    byKey.set(key, strand);
  }
  return { strands: [...byKey.values()], errors };
}

/**
 * Adds parsed strands to the official catalogue. Existing strands (same area,
 * grade and name) are reused and only their missing sub-strands added, so
 * re-importing a corrected file never duplicates anything.
 */
export async function importOfficialStrands(parsed: ParsedStrand[], source: string): Promise<{ strandsAdded: number; subStrandsAdded: number }> {
  if (!parsed.length) return { strandsAdded: 0, subStrandsAdded: 0 };
  const sb = supabase();
  const areaIds = [...new Set(parsed.map((p) => p.learningAreaId))];
  const { data: existing, error: e1 } = await sb.from("strands").select("id, learning_area_id, grade, parent_id, name")
    .is("tenant_id", null).in("learning_area_id", areaIds)
    .returns<Pick<Strand, "id" | "learning_area_id" | "grade" | "parent_id" | "name">[]>();
  if (e1) throw new Error(e1.message);

  const strandKey = (areaId: string, grade: number, name: string) => `${areaId}:${grade}:${name.toLowerCase()}`;
  const strandIds = new Map<string, string>();
  for (const s of existing ?? []) if (!s.parent_id) strandIds.set(strandKey(s.learning_area_id, s.grade, s.name), s.id);
  const subsByParent = new Map<string, Set<string>>();
  for (const s of existing ?? []) {
    if (!s.parent_id) continue;
    const set = subsByParent.get(s.parent_id) ?? new Set<string>();
    set.add(s.name.toLowerCase());
    subsByParent.set(s.parent_id, set);
  }

  const newStrands = parsed
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !strandIds.has(strandKey(p.learningAreaId, p.grade, p.name)));
  let strandsAdded = 0;
  if (newStrands.length) {
    const { data: inserted, error: e2 } = await sb.from("strands").insert(newStrands.map(({ p, i }) => ({
      tenant_id: null, learning_area_id: p.learningAreaId, grade: p.grade, parent_id: null,
      code: p.code, name: p.name, sort_order: (i + 1) * 10, source,
    }))).select("id, learning_area_id, grade, name").returns<Pick<Strand, "id" | "learning_area_id" | "grade" | "name">[]>();
    if (e2) throw new Error(e2.message);
    for (const s of inserted ?? []) strandIds.set(strandKey(s.learning_area_id, s.grade, s.name), s.id);
    strandsAdded = inserted?.length ?? 0;
  }

  const subRows = parsed.flatMap((p) => {
    const parentId = strandIds.get(strandKey(p.learningAreaId, p.grade, p.name))!;
    const have = subsByParent.get(parentId) ?? new Set<string>();
    return p.subStrands
      .map((name, j) => ({ name, j }))
      .filter(({ name }) => !have.has(name.toLowerCase()))
      .map(({ name, j }) => ({
        tenant_id: null, learning_area_id: p.learningAreaId, grade: p.grade, parent_id: parentId,
        code: null, name, sort_order: (j + 1) * 10, source,
      }));
  });
  if (subRows.length) {
    const { error: e3 } = await sb.from("strands").insert(subRows);
    if (e3) throw new Error(e3.message);
  }
  return { strandsAdded, subStrandsAdded: subRows.length };
}
