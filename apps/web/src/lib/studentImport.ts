import { localDay, setHealthConsent, splitCsvLine, splitList, supabase } from "@figbloom/shared";

/**
 * Bulk/CSV student import. One admission per term intake, forty-plus rows at
 * once, so this validates every row up front and shows exactly what's wrong
 * before anything is written — a partial import that silently skipped three
 * rows is worse than one that never ran.
 */

export const IMPORT_COLUMNS = ["admission_no", "full_name", "gender", "class", "boarding", "date_of_birth"] as const;
/**
 * Optional extra columns: where the learner lives (text; a pin is placed later, or given as home_lat/home_lng) and health.
 * Allergies and conditions need the family's signed consent form: who signed it and the date on it.
 */
export const OPTIONAL_IMPORT_COLUMNS = [
  "home_address", "home_landmark", "home_lat", "home_lng", "allergies", "medical_conditions", "health_consent_signed_by", "health_consent_date",
] as const;

export interface ImportRow {
  line: number;
  admission_no: string;
  full_name: string;
  gender: "male" | "female" | null;
  className: string;
  boarding: boolean;
  date_of_birth: string | null;
  home_address: string | null;
  home_landmark: string | null;
  /** Both or neither. A row with an address but no pin needs pinning before the bus can be planned. */
  home_lat: number | null;
  home_lng: number | null;
  allergies: string[];
  medical_conditions: string[];
  /** The signed health consent form, when the row has allergies or conditions. */
  health_consent: { signedBy: string; formDate: string } | null;
  errors: string[];
}


const YES = new Set(["yes", "y", "true", "1", "boarder", "boarding"]);

function parseBoarding(raw: string): boolean {
  return YES.has(raw.trim().toLowerCase());
}

const MALE = new Set(["male", "m", "boy", "b"]);
const FEMALE = new Set(["female", "f", "girl", "g"]);

/** null = blank (caller decides whether that's an error); "invalid" = something was typed but it's neither. */
function parseGender(raw: string): "male" | "female" | null | "invalid" {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (MALE.has(v)) return "male";
  if (FEMALE.has(v)) return "female";
  return "invalid";
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
    gender: col("gender"),
    class: col("class"),
    boarding: col("boarding"),
    date_of_birth: col("date_of_birth"),
    home_address: col("home_address"),
    home_landmark: col("home_landmark"),
    home_lat: col("home_lat"),
    home_lng: col("home_lng"),
    allergies: col("allergies"),
    medical_conditions: col("medical_conditions"),
    health_consent_signed_by: col("health_consent_signed_by"),
    health_consent_date: col("health_consent_date"),
  };
  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");

  const seenInFile = new Set<string>();
  const rows: ImportRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const admission_no = idx.admission_no >= 0 ? (cells[idx.admission_no] ?? "") : "";
    const full_name = idx.full_name >= 0 ? (cells[idx.full_name] ?? "") : "";
    const genderRaw = idx.gender >= 0 ? (cells[idx.gender] ?? "") : "";
    const className = idx.class >= 0 ? (cells[idx.class] ?? "") : "";
    const boardingRaw = idx.boarding >= 0 ? (cells[idx.boarding] ?? "") : "";
    const dobRaw = idx.date_of_birth >= 0 ? (cells[idx.date_of_birth] ?? "") : "";

    const errors: string[] = [];
    if (!admission_no) errors.push("Missing admission number.");
    else if (ctx.existingAdmissionNos.has(admission_no)) errors.push(`Admission ${admission_no} is already on the roster.`);
    else if (seenInFile.has(admission_no)) errors.push(`Admission ${admission_no} appears twice in this file.`);
    if (!full_name) errors.push("Missing name.");
    const gender = parseGender(genderRaw);
    if (gender === null) errors.push("Missing gender (male/female).");
    else if (gender === "invalid") errors.push(`"${genderRaw}" isn't male or female.`);
    const classId = ctx.classIdByName.get(className.trim().toLowerCase());
    if (!className) errors.push("Missing class.");
    else if (!classId) errors.push(`"${className}" is not one of this school's classes.`);
    const date_of_birth = parseDate(dobRaw);
    if (date_of_birth === "invalid") errors.push("Date of birth must be YYYY-MM-DD.");

    const home_address = cell(cells, idx.home_address).slice(0, 300) || null;
    const home_landmark = cell(cells, idx.home_landmark).slice(0, 200) || null;
    const latRaw = cell(cells, idx.home_lat);
    const lngRaw = cell(cells, idx.home_lng);
    let home_lat: number | null = null;
    let home_lng: number | null = null;
    if (latRaw || lngRaw) {
      const lat = Number(latRaw);
      const lng = Number(lngRaw);
      if (!latRaw || !lngRaw || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        errors.push("home_lat and home_lng must both be numbers (e.g. -1.2186, 36.9258), or both blank.");
      } else {
        home_lat = lat;
        home_lng = lng;
      }
    }

    const allergies = splitList(cell(cells, idx.allergies));
    const medical_conditions = splitList(cell(cells, idx.medical_conditions));
    const signedBy = cell(cells, idx.health_consent_signed_by).slice(0, 120);
    const consentDate = parseDate(cell(cells, idx.health_consent_date));
    let health_consent: ImportRow["health_consent"] = null;
    if (allergies.length || medical_conditions.length) {
      if (!signedBy || !consentDate) errors.push("Allergies and conditions need the family's consent form: health_consent_signed_by and health_consent_date.");
      else if (consentDate === "invalid") errors.push("health_consent_date must be YYYY-MM-DD.");
      else if (consentDate > localDay(new Date())) errors.push("health_consent_date can't be in the future.");
      else health_consent = { signedBy, formDate: consentDate };
    }

    if (admission_no) seenInFile.add(admission_no);

    rows.push({
      line: i + 1,
      admission_no,
      full_name,
      gender: gender === "invalid" ? null : gender,
      className,
      boarding: parseBoarding(boardingRaw),
      date_of_birth: date_of_birth === "invalid" ? null : date_of_birth,
      home_address,
      home_landmark,
      home_lat,
      home_lng,
      allergies,
      medical_conditions,
      health_consent,
      errors,
    });
  }

  return rows;
}

export function csvTemplate(): string {
  return [
    [...IMPORT_COLUMNS, "home_address", "home_landmark", "allergies", "medical_conditions", "health_consent_signed_by", "health_consent_date"].join(","),
    "4501,Wanjiku Kamau,female,Form 2 East,yes,2010-03-14,,,,,,",
    '4502,Otieno Odhiambo,male,Form 2 East,no,,"Plot 12, Kahawa Sukari",Opposite Naivas,"Peanuts; Eggs",Asthma,Grace Odhiambo,2026-01-06',
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
  const { data: created, error } = await supabase().from("students").insert(
    valid.map((r) => ({
      tenant_id: tenantId,
      admission_no: r.admission_no,
      full_name: r.full_name,
      gender: r.gender,
      class_id: classIdByName.get(r.className.trim().toLowerCase())!,
      boarding: r.boarding,
      date_of_birth: r.date_of_birth,
      active: true,
      home_address: r.home_address,
      home_landmark: r.home_landmark,
      home_lat: r.home_lat,
      home_lng: r.home_lng,
    })),
  ).select("id, admission_no").returns<{ id: string; admission_no: string }[]>();
  if (error) throw error;

  // Allergies and conditions go to student_health (one row per learner who has any),
  // after recording each family's signed consent form: without it the database refuses them.
  const idByAdmission = new Map((created ?? []).map((c) => [c.admission_no, c.id]));
  const health = valid
    .filter((r) => r.health_consent && (r.allergies.length || r.medical_conditions.length))
    .map((r) => ({
      consent: r.health_consent!,
      row: { tenant_id: tenantId, student_id: idByAdmission.get(r.admission_no), allergies: r.allergies, medical_conditions: r.medical_conditions },
    }))
    .filter((h): h is typeof h & { row: { student_id: string } } => !!h.row.student_id);
  if (health.length) {
    try {
      for (let i = 0; i < health.length; i += 8) {
        await Promise.all(health.slice(i, i + 8).map((h) => setHealthConsent(h.row.student_id, true, h.consent)));
      }
    } catch (err) {
      throw new Error(`The learners were imported, but their health consent forms didn't save: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { error: healthErr } = await supabase().from("student_health").upsert(health.map((h) => h.row), { onConflict: "student_id" });
    if (healthErr) throw new Error(`The learners were imported, but their allergies and conditions didn't save: ${healthErr.message}`);
  }
  return valid.length;
}
