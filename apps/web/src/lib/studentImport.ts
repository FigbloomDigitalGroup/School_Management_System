import { supabase } from "@figbloom/shared";

/**
 * Bulk/CSV student import. One admission per term intake, forty-plus rows at
 * once, so this validates every row up front and shows exactly what's wrong
 * before anything is written — a partial import that silently skipped three
 * rows is worse than one that never ran.
 */

export const IMPORT_COLUMNS = ["admission_no", "full_name", "class", "boarding", "date_of_birth"] as const;

export interface ImportRow {
  line: number;
  admission_no: string;
  full_name: string;
  className: string;
  boarding: boolean;
  date_of_birth: string | null;
  errors: string[];
}

/** Handles quoted fields (a name with a comma in it) without pulling in a CSV library for one form. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const YES = new Set(["yes", "y", "true", "1", "boarder", "boarding"]);

function parseBoarding(raw: string): boolean {
  return YES.has(raw.trim().toLowerCase());
}

function parseDate(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "invalid";
}

export interface ParseContext {
  /** Class name (any case) -> id, from the classes already loaded for this school. */
  classIdByName: Map<string, string>;
  /** Admission numbers already on the active roster — a re-import of the same file must not duplicate them. */
  existingAdmissionNos: Set<string>;
}

/** Parses and validates every row; nothing here talks to the network. */
export function parseStudentCsv(text: string, ctx: ParseContext): ImportRow[] {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    admission_no: col("admission_no"),
    full_name: col("full_name"),
    class: col("class"),
    boarding: col("boarding"),
    date_of_birth: col("date_of_birth"),
  };

  const seenInFile = new Set<string>();
  const rows: ImportRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const admission_no = idx.admission_no >= 0 ? (cells[idx.admission_no] ?? "") : "";
    const full_name = idx.full_name >= 0 ? (cells[idx.full_name] ?? "") : "";
    const className = idx.class >= 0 ? (cells[idx.class] ?? "") : "";
    const boardingRaw = idx.boarding >= 0 ? (cells[idx.boarding] ?? "") : "";
    const dobRaw = idx.date_of_birth >= 0 ? (cells[idx.date_of_birth] ?? "") : "";

    const errors: string[] = [];
    if (!admission_no) errors.push("Missing admission number.");
    else if (ctx.existingAdmissionNos.has(admission_no)) errors.push(`Admission ${admission_no} is already on the roster.`);
    else if (seenInFile.has(admission_no)) errors.push(`Admission ${admission_no} appears twice in this file.`);
    if (!full_name) errors.push("Missing name.");
    const classId = ctx.classIdByName.get(className.trim().toLowerCase());
    if (!className) errors.push("Missing class.");
    else if (!classId) errors.push(`"${className}" is not one of this school's classes.`);
    const date_of_birth = parseDate(dobRaw);
    if (date_of_birth === "invalid") errors.push("Date of birth must be YYYY-MM-DD.");

    if (admission_no) seenInFile.add(admission_no);

    rows.push({
      line: i + 1,
      admission_no,
      full_name,
      className,
      boarding: parseBoarding(boardingRaw),
      date_of_birth: date_of_birth === "invalid" ? null : date_of_birth,
      errors,
    });
  }

  return rows;
}

export function csvTemplate(): string {
  return [
    IMPORT_COLUMNS.join(","),
    "4501,Wanjiku Kamau,Form 2 East,yes,2010-03-14",
    "4502,Otieno Odhiambo,Form 2 East,no,",
  ].join("\n");
}

export function downloadCsvTemplate(): void {
  const blob = new Blob([csvTemplate()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "student-import-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Inserts every valid row in one call — a school admin can already write students in their own tenant (see rls.sql). */
export async function importStudents(
  tenantId: string,
  classIdByName: Map<string, string>,
  rows: ImportRow[],
): Promise<number> {
  const valid = rows.filter((r) => r.errors.length === 0);
  if (valid.length === 0) return 0;
  const { error } = await supabase().from("students").insert(
    valid.map((r) => ({
      tenant_id: tenantId,
      admission_no: r.admission_no,
      full_name: r.full_name,
      class_id: classIdByName.get(r.className.trim().toLowerCase())!,
      boarding: r.boarding,
      date_of_birth: r.date_of_birth,
      active: true,
    })),
  );
  if (error) throw error;
  return valid.length;
}
