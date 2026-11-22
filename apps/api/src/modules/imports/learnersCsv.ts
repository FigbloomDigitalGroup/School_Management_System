import { createHash } from "node:crypto";
import type { Tx } from "../../db/sql.js";
import { AppError, conflict, forbidden, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { createLearner, validateLearnerFields } from "../directory/learners.js";
import { schoolToday } from "../tenancy/schoolClock.js";

export const MAX_CSV_CHARS = 1_000_000;
export const MAX_IMPORT_ROWS = 1_000;
export const MAX_CSV_FIELD_CHARS = 1_000;
export const MAX_PREVIEW_ERRORS = 100;
export const MAX_SAMPLE_VALID = 20;

export interface LearnerCsvRow {
  line: number;
  admission_no: string;
  full_name: string;
  gender: "male" | "female";
  date_of_birth: string | null;
  boarding: boolean;
}

export interface LearnerCsvError {
  line: number;
  message: string;
}

export interface LearnerImportPreview {
  import_id: string;
  row_count: number;
  valid_count: number;
  error_count: number;
  errors_truncated: boolean;
  errors: LearnerCsvError[];
  sample_valid: LearnerCsvRow[];
}

export interface LearnerImportApplyResult {
  created_count: number;
  import_id: string;
  replayed?: boolean;
}

const REQUIRED_HEADERS = ["admission_no", "full_name", "gender"] as const;
const ALLOWED_HEADERS = new Set<string>([
  "admission_no",
  "full_name",
  "gender",
  "date_of_birth",
  "boarding",
]);

interface ParsedCsvRecord {
  line: number;
  fields: string[];
}

/**
 * S16-5 & S16-4: RFC 4180 state-machine CSV parser.
 * - Strips leading UTF-8 BOM (\uFEFF).
 * - Rejects NUL bytes (\0) and fields exceeding MAX_CSV_FIELD_CHARS.
 * - Supports quoted fields with embedded commas, LF/CRLF newlines, and escaped quotes ("").
 * - Rejects unclosed quotes, stray quotes inside unquoted fields, and non-whitespace trailing text after a closing quote.
 * - Preserves exact 1-based physical line numbers across blank lines and multi-line quoted cells.
 */
export function parseRfc4180Csv(rawCsv: string): ParsedCsvRecord[] {
  if (rawCsv.includes("\0")) {
    throw validationError("CSV cannot contain NUL bytes");
  }
  const csv = rawCsv.replace(/^\uFEFF/, "");
  const records: ParsedCsvRecord[] = [];

  let lineNo = 1;
  let recordStartLine = 1;
  let currentRecord: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let fieldQuoted = false;
  let afterClosingQuote = false;
  let fieldStarted = false;

  const pushField = () => {
    currentRecord.push(currentField);
    currentField = "";
    inQuotes = false;
    fieldQuoted = false;
    afterClosingQuote = false;
    fieldStarted = false;
  };

  const pushRecordIfNonBlank = () => {
    const isBlankLine =
      currentRecord.length === 1 &&
      !fieldQuoted &&
      currentRecord[0]!.trim().length === 0;
    if (!isBlankLine) {
      records.push({ line: recordStartLine, fields: currentRecord });
    }
    currentRecord = [];
  };

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          currentField += '"';
          i++;
          if (currentField.length > MAX_CSV_FIELD_CHARS) {
            throw validationError(`CSV field on line ${recordStartLine} exceeds maximum length of ${MAX_CSV_FIELD_CHARS} characters`);
          }
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else if (ch === "\r") {
        if (csv[i + 1] === "\n") {
          currentField += "\n";
          i++;
        } else {
          currentField += "\r";
        }
        lineNo++;
        if (currentField.length > MAX_CSV_FIELD_CHARS) {
          throw validationError(`CSV field on line ${recordStartLine} exceeds maximum length of ${MAX_CSV_FIELD_CHARS} characters`);
        }
      } else if (ch === "\n") {
        currentField += "\n";
        lineNo++;
        if (currentField.length > MAX_CSV_FIELD_CHARS) {
          throw validationError(`CSV field on line ${recordStartLine} exceeds maximum length of ${MAX_CSV_FIELD_CHARS} characters`);
        }
      } else {
        currentField += ch;
        if (currentField.length > MAX_CSV_FIELD_CHARS) {
          throw validationError(`CSV field on line ${recordStartLine} exceeds maximum length of ${MAX_CSV_FIELD_CHARS} characters`);
        }
      }
      continue;
    }

    // Outside quotes
    if (afterClosingQuote) {
      if (ch === " " || ch === "\t") {
        continue;
      }
      if (ch === ",") {
        pushField();
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && csv[i + 1] === "\n") i++;
        pushField();
        pushRecordIfNonBlank();
        lineNo++;
        recordStartLine = lineNo;
        continue;
      }
      throw validationError(`Malformed CSV on line ${lineNo}: unexpected character after closing quote`);
    }

    if (ch === '"') {
      if (!fieldStarted && currentField.trim().length === 0) {
        // Allow optional leading spaces before opening quote, discarding them
        currentField = "";
        inQuotes = true;
        fieldQuoted = true;
        fieldStarted = true;
        continue;
      }
      throw validationError(`Malformed CSV on line ${lineNo}: unexpected quote inside unquoted field`);
    }

    if (ch === ",") {
      pushField();
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && csv[i + 1] === "\n") i++;
      pushField();
      pushRecordIfNonBlank();
      lineNo++;
      recordStartLine = lineNo;
      continue;
    }

    if (ch !== " " && ch !== "\t") {
      fieldStarted = true;
    }
    currentField += ch;
    if (currentField.length > MAX_CSV_FIELD_CHARS) {
      throw validationError(`CSV field on line ${recordStartLine} exceeds maximum length of ${MAX_CSV_FIELD_CHARS} characters`);
    }
  }

  if (inQuotes) {
    throw validationError(`Malformed CSV on line ${recordStartLine}: unclosed quoted field`);
  }

  if (currentRecord.length > 0 || currentField.length > 0 || fieldQuoted) {
    pushField();
    pushRecordIfNonBlank();
  }

  return records;
}

export function parseLearnerCsv(csv: string, today?: string): { rows: LearnerCsvRow[]; errors: LearnerCsvError[]; totalDataRows: number } {
  const records = parseRfc4180Csv(csv);
  if (records.length < 2) {
    throw validationError("CSV must include a header row and at least one data row");
  }

  const dataRecordCount = records.length - 1;
  if (dataRecordCount > MAX_IMPORT_ROWS) {
    throw validationError(`CSV exceeds maximum row limit of ${MAX_IMPORT_ROWS} rows (found ${dataRecordCount})`);
  }

  const headerRecord = records[0]!;
  const header = headerRecord.fields.map((h) => h.trim().toLowerCase());
  const seenHeaders = new Set<string>();
  for (const col of header) {
    if (!col) {
      throw validationError("CSV header contains an empty column name");
    }
    if (seenHeaders.has(col)) {
      throw validationError(`CSV header contains duplicate column: ${col}`);
    }
    if (!ALLOWED_HEADERS.has(col)) {
      if (col === "class") {
        throw validationError(
          "Unsupported CSV header column: class (class enrollment requires an academic year context and is not supported in learner CSV import)",
        );
      }
      throw validationError(`Unsupported CSV header column: ${col}`);
    }
    seenHeaders.add(col);
  }

  for (const required of REQUIRED_HEADERS) {
    if (!seenHeaders.has(required)) {
      throw validationError(`CSV header missing required column: ${required}`);
    }
  }

  const idx = {
    admission_no: header.indexOf("admission_no"),
    full_name: header.indexOf("full_name"),
    gender: header.indexOf("gender"),
    date_of_birth: header.indexOf("date_of_birth"),
    boarding: header.indexOf("boarding"),
  };

  const rows: LearnerCsvRow[] = [];
  const errors: LearnerCsvError[] = [];
  const seenAdmissions = new Set<string>();

  for (let i = 1; i < records.length; i++) {
    const rec = records[i]!;
    const lineNo = rec.line;
    const cols = rec.fields;

    const messages: string[] = [];
    if (cols.length !== header.length) {
      messages.push(`expected ${header.length} columns but found ${cols.length}`);
    }

    const rawAdmissionNo = cols[idx.admission_no] ?? "";
    const rawFullName = cols[idx.full_name] ?? "";
    const rawGender = cols[idx.gender] ?? "";
    const rawDob = idx.date_of_birth >= 0 ? (cols[idx.date_of_birth] ?? "") : "";
    const rawBoarding = idx.boarding >= 0 ? (cols[idx.boarding] ?? "") : "";

    const checked = validateLearnerFields({
      admission_no: rawAdmissionNo,
      full_name: rawFullName,
      gender: rawGender,
      date_of_birth: rawDob,
      boarding: rawBoarding,
      ...(today ? { today } : {}),
    });
    if (!checked.valid) {
      messages.push(...checked.messages);
    }

    const normAdm = rawAdmissionNo.trim().toLowerCase();
    if (normAdm) {
      if (seenAdmissions.has(normAdm)) {
        messages.push("duplicate admission_no in CSV");
      }
      seenAdmissions.add(normAdm);
    }

    if (messages.length > 0 || !checked.value) {
      errors.push({ line: lineNo, message: messages.join("; ") });
      continue;
    }

    rows.push({
      line: lineNo,
      admission_no: checked.value.admission_no,
      full_name: checked.value.full_name,
      gender: checked.value.gender,
      date_of_birth: checked.value.date_of_birth,
      boarding: checked.value.boarding,
    });
  }

  return { rows, errors, totalDataRows: dataRecordCount };
}

export async function previewLearnerCsvImport(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; csv: string; ip?: string | null },
): Promise<LearnerImportPreview> {
  const { rows, errors } = parseLearnerCsv(input.csv, await schoolToday(tx, input.tenantId));

  // S16-1: Check ALL learners in the tenant (both active and archived) matching learners_tenant_admission_uidx.
  const existing = await tx.query<{ admission_no: string; active: boolean }>(
    `SELECT admission_no, active FROM learners WHERE tenant_id = $1`,
    [input.tenantId],
  );
  const existingMap = new Map<string, boolean>();
  for (const r of existing.rows) {
    existingMap.set(r.admission_no.trim().toLowerCase(), r.active);
  }

  const filtered: LearnerCsvRow[] = [];
  for (const row of rows) {
    const key = row.admission_no.trim().toLowerCase();
    if (existingMap.has(key)) {
      const isActive = existingMap.get(key);
      errors.push({
        line: row.line,
        message: isActive
          ? "admission_no already exists in this school"
          : "admission_no belongs to an archived learner in this school (restore instead of re-importing)",
      });
    } else {
      filtered.push(row);
    }
  }

  errors.sort((a, b) => a.line - b.line);
  const errorLines = new Set(errors.map((e) => e.line));
  const error_count = errorLines.size;
  const valid_count = filtered.length;
  const row_count = valid_count + error_count;
  const errors_truncated = errors.length > MAX_PREVIEW_ERRORS;

  const payload_sha256 = createHash("sha256").update(input.csv, "utf8").digest("hex");
  const preview_json = {
    rows: filtered,
    errors: errors.slice(0, MAX_PREVIEW_ERRORS),
    errors_truncated,
  };
  const res = await tx.query<{ id: string }>(
    `INSERT INTO import_batches (
       tenant_id, kind, status, source_name, row_count, valid_count, error_count,
       payload_sha256, preview_json, created_by
     ) VALUES ($1,'learners_csv','previewed','csv',$2,$3,$4,$5,$6::jsonb,$7)
     RETURNING id`,
    [
      input.tenantId,
      row_count,
      valid_count,
      error_count,
      payload_sha256,
      JSON.stringify(preview_json),
      input.actorUserId,
    ],
  );
  const importId = res.rows[0]!.id;
  await recordSecurityEvent(tx, {
    eventType: "import.learners.previewed",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip ?? null,
    detail: {
      importId,
      payloadSha256: payload_sha256,
      rowCount: row_count,
      validCount: valid_count,
      errorCount: error_count,
      valid: valid_count,
      errors: error_count,
    },
  });
  return {
    import_id: importId,
    row_count,
    valid_count,
    error_count,
    errors_truncated,
    errors: errors.slice(0, MAX_PREVIEW_ERRORS),
    sample_valid: filtered.slice(0, MAX_SAMPLE_VALID),
  };
}

export async function applyLearnerCsvImport(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; importId: string; ip?: string | null },
): Promise<LearnerImportApplyResult> {
  const batch = await tx.query<{
    id: string;
    status: string;
    created_by: string;
    created_count: number;
    row_count: number;
    valid_count: number;
    error_count: number;
    payload_sha256: string;
    expires_at: Date | null;
    preview_json: { rows?: LearnerCsvRow[]; errors?: LearnerCsvError[]; redacted?: boolean };
  }>(
    `SELECT id, status, created_by, created_count, row_count, valid_count, error_count, payload_sha256, preview_json, expires_at
       FROM import_batches
      WHERE tenant_id = $1 AND id = $2 AND kind = 'learners_csv'
      FOR UPDATE`,
    [input.tenantId, input.importId],
  );
  const row = batch.rows[0];
  if (!row) throw notFound("Import batch not found");

  // S16-11: Importer ownership check — only the user who created the preview may apply it.
  if (row.created_by !== input.actorUserId) {
    throw forbidden("Only the user who created this import preview may apply it");
  }

  // S16-3: Safe idempotent replay when already applied by the owner.
  if (row.status === "applied") {
    return {
      created_count: row.created_count,
      import_id: input.importId,
      replayed: true,
    };
  }

  if (row.status === "cancelled") {
    throw conflict("Import batch has been cancelled");
  }
  // N-8: a preview is retained only for its lifetime; an expired one (swept or about to be) can never be applied.
  if (row.status === "expired" || (row.expires_at !== null && row.expires_at.getTime() <= Date.now())) {
    throw conflict("Import preview has expired; preview the file again");
  }
  if (row.status !== "previewed") {
    throw conflict("Import batch is not in previewed state");
  }
  if (row.error_count > 0 || (row.preview_json.errors?.length ?? 0) > 0) {
    throw validationError("Import has validation errors; fix the CSV and preview again");
  }

  const previewRows = Array.isArray(row.preview_json.rows) ? row.preview_json.rows : [];
  if (previewRows.length === 0 || previewRows.length !== row.valid_count) {
    throw validationError("Import batch contains no valid rows to apply");
  }
  if (previewRows.length > MAX_IMPORT_ROWS) {
    throw validationError(`Import batch exceeds maximum row limit of ${MAX_IMPORT_ROWS} rows`);
  }

  // S16-3: Revalidate every stored preview row against the shared validation contract and current DB state.
  const existing = await tx.query<{ admission_no: string; active: boolean }>(
    `SELECT admission_no, active FROM learners WHERE tenant_id = $1`,
    [input.tenantId],
  );
  const existingSet = new Set(existing.rows.map((r) => r.admission_no.trim().toLowerCase()));
  const seenInBatch = new Set<string>();
  const validatedRows: Array<{ line: number } & ReturnType<typeof validateLearnerFields>["value"]> = [];

  const today = await schoolToday(tx, input.tenantId);
  for (const r of previewRows) {
    const lineNo = typeof r.line === "number" ? r.line : 0;
    const checked = validateLearnerFields({
      admission_no: r.admission_no,
      full_name: r.full_name,
      gender: r.gender,
      date_of_birth: r.date_of_birth,
      boarding: r.boarding,
      today,
    });
    if (!checked.valid || !checked.value) {
      throw validationError(`Row on line ${lineNo} failed validation on apply: ${checked.messages.join("; ")}`);
    }
    const key = checked.value.admission_no.toLowerCase();
    if (seenInBatch.has(key)) {
      throw validationError(`Row on line ${lineNo} has duplicate admission_no ${checked.value.admission_no} in batch`);
    }
    seenInBatch.add(key);
    if (existingSet.has(key)) {
      throw conflict(`Row on line ${lineNo} conflicts with existing admission_no ${checked.value.admission_no}`);
    }
    validatedRows.push({ line: lineNo, ...checked.value });
  }

  let created = 0;
  for (const item of validatedRows) {
    try {
      await createLearner(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        admission_no: item!.admission_no,
        full_name: item!.full_name,
        gender: item!.gender,
        date_of_birth: item!.date_of_birth,
        boarding: item!.boarding,
        ip: input.ip ?? null,
      });
      created++;
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 409) {
        throw conflict(`Row on line ${item.line} conflicts with existing admission_no ${item!.admission_no}`);
      }
      throw err;
    }
  }

  // S16-9: Redact raw learner PII from preview_json upon application while preserving sha256 and counts.
  const redactedPreview = {
    redacted: true,
    redacted_at: new Date().toISOString(),
    row_count: row.row_count,
    valid_count: row.valid_count,
    error_count: row.error_count,
    created_count: created,
  };

  await tx.query(
    `UPDATE import_batches
        SET status = 'applied',
            created_count = $3,
            applied_by = $4,
            applied_at = now(),
            preview_json = $5::jsonb
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.importId, created, input.actorUserId, JSON.stringify(redactedPreview)],
  );

  // S16-10: Enrich applied audit event with IP, payloadSha256, and counts.
  await recordSecurityEvent(tx, {
    eventType: "import.learners.applied",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip ?? null,
    detail: {
      importId: input.importId,
      payloadSha256: row.payload_sha256,
      rowCount: row.row_count,
      createdCount: created,
      created,
    },
  });
  return { created_count: created, import_id: input.importId, replayed: false };
}
