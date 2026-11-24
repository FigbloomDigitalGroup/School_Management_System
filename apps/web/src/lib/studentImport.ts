import { apiImportLearners, bulkInsertStudentsWithHealth, localDay, onApi, peopleCapabilities, splitCsvLine, splitList, type ImportLearnerRow } from "@figbloom/shared";

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
  /**
   * Leave the home and health columns alone: they are neither read nor checked (a backend that keeps neither, so a missing consent
   * form is not a problem worth stopping a row for).
   */
  skipExtras?: boolean;
}

/** The optional columns (home, health) a file has in its header: on a backend that does not keep them, they are listed as not imported. */
export function ignoredImportColumns(text: string): string[] {
  const first = text.split(/\r\n|\n|\r/).find((l) => l.trim().length > 0);
  if (!first) return [];
  const header = new Set(splitCsvLine(first).map((h) => h.toLowerCase()));
  return OPTIONAL_IMPORT_COLUMNS.filter((c) => header.has(c));
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

    const extras = !ctx.skipExtras;
    const home_address = extras ? cell(cells, idx.home_address).slice(0, 300) || null : null;
    const home_landmark = extras ? cell(cells, idx.home_landmark).slice(0, 200) || null : null;
    const latRaw = extras ? cell(cells, idx.home_lat) : "";
    const lngRaw = extras ? cell(cells, idx.home_lng) : "";
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

    const allergies = extras ? splitList(cell(cells, idx.allergies)) : [];
    const medical_conditions = extras ? splitList(cell(cells, idx.medical_conditions)) : [];
    const signedBy = extras ? cell(cells, idx.health_consent_signed_by).slice(0, 120) : "";
    const consentDate = extras ? parseDate(cell(cells, idx.health_consent_date)) : null;
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
  // Only the columns the backend keeps: on the new API, no home or health columns.
  if (!peopleCapabilities().learnerHome) {
    return [
      IMPORT_COLUMNS.join(","),
      "4501,Wanjiku Kamau,female,Form 2 East,yes,2010-03-14",
      "4502,Otieno Odhiambo,male,Form 2 East,no,",
    ].join("\n");
  }
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

/**
 * Inserts every valid row in one call — a school admin can already write students in their own tenant (the students policies in supabase/migrations).
 * On the new API the API checks the file again and makes the learners, and each is then placed in their class (api/peopleApi.ts apiImportLearners);
 * `notify` says so when some could not be placed.
 */
export async function importStudents(
  tenantId: string,
  classIdByName: Map<string, string>,
  rows: ImportRow[],
  notify?: (message: string) => void,
): Promise<number> {
  const valid = rows.filter((r) => r.errors.length === 0);
  if (valid.length === 0) return 0;
  if (onApi()) {
    const learners: ImportLearnerRow[] = valid.map((r) => ({
      line: r.line, admissionNo: r.admission_no, fullName: r.full_name, gender: r.gender!, dateOfBirth: r.date_of_birth, boarding: r.boarding,
      classId: classIdByName.get(r.className.trim().toLowerCase()) ?? null,
    }));
    const outcome = await apiImportLearners(tenantId, learners);
    if (outcome.unplaced.length > 0) {
      const some = outcome.unplaced.slice(0, 3).map((u) => `${u.admissionNo} (${u.reason})`).join(", ");
      notify?.(`${outcome.created} learner${outcome.created === 1 ? " was" : "s were"} imported, but ${outcome.unplaced.length} could not be placed in a class: ${some}${outcome.unplaced.length > 3 ? ", and more" : ""}. Place them from Manage.`);
    }
    return outcome.created;
  }
  return bulkInsertStudentsWithHealth(
    tenantId,
    valid.map((r) => ({
      admission_no: r.admission_no,
      full_name: r.full_name,
      gender: r.gender,
      class_id: classIdByName.get(r.className.trim().toLowerCase())!,
      boarding: r.boarding,
      date_of_birth: r.date_of_birth,
      home_address: r.home_address,
      home_landmark: r.home_landmark,
      home_lat: r.home_lat,
      home_lng: r.home_lng,
      allergies: r.allergies,
      medical_conditions: r.medical_conditions,
      health_consent: r.health_consent,
    })),
  );
}
