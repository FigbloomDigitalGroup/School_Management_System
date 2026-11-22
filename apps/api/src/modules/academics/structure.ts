import type { Tx } from "../../db/sql.js";
import { pageQuery, type Page, type PageInput } from "./pagination.js";
import { AppError, conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";

function isoDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  // node-pg parses a DATE as local midnight. UTC parts shift the calendar day west of UTC.
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isoStamp(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function trimRequired(value: string, field: string, max: number): string {
  const t = value.trim();
  if (t.length < 1 || t.length > max) {
    throw validationError(`${field} must be 1–${max} characters`);
  }
  return t;
}

// ── Academic years ──────────────────────────────────────────────────────────

export interface PublicAcademicYear {
  id: string;
  tenantId: string;
  label: string;
  starts_on: string;
  ends_on: string;
  is_current: boolean;
  created_at: string;
  updated_at: string;
}

export async function createAcademicYear(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    label: string;
    starts_on: string;
    ends_on: string;
    is_current?: boolean;
    ip?: string | null;
  },
): Promise<PublicAcademicYear> {
  const label = trimRequired(input.label, "label", 32);
  if (input.ends_on < input.starts_on) {
    throw validationError("ends_on must be on or after starts_on");
  }
  const isCurrent = input.is_current === true;
  if (isCurrent) {
    await tx.query(
      `UPDATE academic_years SET is_current = false, updated_at = now()
       WHERE tenant_id = $1 AND is_current = true`,
      [input.tenantId],
    );
  }
  try {
    const res = await tx.query<{
      id: string;
      tenant_id: string;
      label: string;
      starts_on: Date | string;
      ends_on: Date | string;
      is_current: boolean;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `INSERT INTO academic_years
         (tenant_id, label, starts_on, ends_on, is_current, created_by)
       VALUES ($1, $2, $3::date, $4::date, $5, $6)
       RETURNING id, tenant_id, label, starts_on, ends_on, is_current, created_at, updated_at`,
      [input.tenantId, label, input.starts_on, input.ends_on, isCurrent, input.actorUserId],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "academics.year.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { academicYearId: row.id, label: row.label },
      ip: input.ip,
    });
    return {
      id: row.id,
      tenantId: row.tenant_id,
      label: row.label,
      starts_on: isoDate(row.starts_on),
      ends_on: isoDate(row.ends_on),
      is_current: row.is_current,
      created_at: isoStamp(row.created_at),
      updated_at: isoStamp(row.updated_at),
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") throw conflict("An academic year with this label already exists");
    throw err;
  }
}

export async function listAcademicYears(
  tx: Tx,
  input: { tenantId: string; page: PageInput },
): Promise<Page<PublicAcademicYear>> {
  const res = await pageQuery<{
    id: string;
    tenant_id: string;
    label: string;
    starts_on: Date | string;
    ends_on: Date | string;
    is_current: boolean;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    tx,
    `SELECT id, tenant_id, label, starts_on, ends_on, is_current, created_at, updated_at
     FROM academic_years WHERE tenant_id = $1`,
    [input.tenantId],
    { name: "academic_years", expr: "q.starts_on", type: "date", dir: "desc" },
    input.page,
  );
  return { page: res.page, items: res.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    starts_on: isoDate(row.starts_on),
    ends_on: isoDate(row.ends_on),
    is_current: row.is_current,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  })) };
}

export async function getAcademicYearById(
  tx: Tx,
  input: { tenantId: string; academicYearId: string },
): Promise<PublicAcademicYear> {
  const res = await tx.query<{
    id: string;
    tenant_id: string;
    label: string;
    starts_on: Date | string;
    ends_on: Date | string;
    is_current: boolean;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    `SELECT id, tenant_id, label, starts_on, ends_on, is_current, created_at, updated_at
     FROM academic_years WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.academicYearId],
  );
  const row = res.rows[0];
  if (!row) throw notFound("Academic year not found");
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    starts_on: isoDate(row.starts_on),
    ends_on: isoDate(row.ends_on),
    is_current: row.is_current,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

export async function setCurrentAcademicYear(
  tx: Tx,
  input: { tenantId: string; academicYearId: string; actorUserId: string; ip?: string | null },
): Promise<PublicAcademicYear> {
  const existing = await getAcademicYearById(tx, input);
  // A9-11: two concurrent set-current calls would both clear and then both set, and the second would
  // hit the one-current partial unique index (500). Lock the school's years first so they run in turn.
  await tx.query(`SELECT id FROM academic_years WHERE tenant_id = $1 ORDER BY id FOR UPDATE`, [input.tenantId]);
  await tx.query(
    `UPDATE academic_years SET is_current = false, updated_at = now()
     WHERE tenant_id = $1 AND is_current = true`,
    [input.tenantId],
  );
  const res = await tx.query<{
    id: string;
    tenant_id: string;
    label: string;
    starts_on: Date | string;
    ends_on: Date | string;
    is_current: boolean;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    `UPDATE academic_years SET is_current = true, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, tenant_id, label, starts_on, ends_on, is_current, created_at, updated_at`,
    [input.tenantId, input.academicYearId],
  );
  const row = res.rows[0];
  if (!row) throw notFound("Academic year not found");
  await recordSecurityEvent(tx, {
    eventType: "academics.year.current_set",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { academicYearId: row.id, previousCurrentId: existing.is_current ? existing.id : null },
    ip: input.ip,
  });
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    starts_on: isoDate(row.starts_on),
    ends_on: isoDate(row.ends_on),
    is_current: row.is_current,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

// ── Terms ───────────────────────────────────────────────────────────────────

export interface PublicTerm {
  id: string;
  tenantId: string;
  academic_year_id: string;
  index: number;
  label: string;
  starts_on: string;
  ends_on: string;
  is_current: boolean;
  created_at: string;
  updated_at: string;
}

export async function createTerm(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    academic_year_id: string;
    index: number;
    label: string;
    starts_on: string;
    ends_on: string;
    is_current?: boolean;
    ip?: string | null;
  },
): Promise<PublicTerm> {
  if (input.index < 1 || input.index > 4) {
    throw validationError("index must be between 1 and 4");
  }
  const label = trimRequired(input.label, "label", 64);
  if (input.ends_on < input.starts_on) {
    throw validationError("ends_on must be on or after starts_on");
  }
  await getAcademicYearById(tx, {
    tenantId: input.tenantId,
    academicYearId: input.academic_year_id,
  });
  if (input.is_current === true) {
    await tx.query(
      `UPDATE academic_terms SET is_current = false, updated_at = now()
       WHERE tenant_id = $1 AND is_current = true`,
      [input.tenantId],
    );
  }
  try {
    const res = await tx.query<{
      id: string;
      tenant_id: string;
      academic_year_id: string;
      index: number;
      label: string;
      starts_on: Date | string;
      ends_on: Date | string;
      is_current: boolean;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `INSERT INTO academic_terms
         (tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8)
       RETURNING id, tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current,
                 created_at, updated_at`,
      [
        input.tenantId,
        input.academic_year_id,
        input.index,
        label,
        input.starts_on,
        input.ends_on,
        input.is_current === true,
        input.actorUserId,
      ],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "academics.term.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { termId: row.id, academicYearId: row.academic_year_id, index: row.index },
      ip: input.ip,
    });
    return mapTerm(row);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") throw conflict("A term with this index already exists for the year");
    if (code === "23503") throw validationError("academic_year_id must belong to this school");
    throw err;
  }
}

function mapTerm(row: {
  id: string;
  tenant_id: string;
  academic_year_id: string;
  index: number;
  label: string;
  starts_on: Date | string;
  ends_on: Date | string;
  is_current: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}): PublicTerm {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    academic_year_id: row.academic_year_id,
    index: row.index,
    label: row.label,
    starts_on: isoDate(row.starts_on),
    ends_on: isoDate(row.ends_on),
    is_current: row.is_current,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

export async function listTerms(
  tx: Tx,
  input: { tenantId: string; academicYearId?: string; page: PageInput },
): Promise<Page<PublicTerm>> {
  const cols = `SELECT id, tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current,
                created_at, updated_at FROM academic_terms`;
  const res = input.academicYearId
    ? await pageQuery<Parameters<typeof mapTerm>[0]>(
        tx,
        `${cols} WHERE tenant_id = $1 AND academic_year_id = $2`,
        [input.tenantId, input.academicYearId],
        { name: "terms_in_year", expr: "q.index", type: "integer", dir: "asc" },
        input.page,
      )
    : await pageQuery<Parameters<typeof mapTerm>[0]>(
        tx,
        `${cols} WHERE tenant_id = $1`,
        [input.tenantId],
        { name: "terms", expr: "q.starts_on", type: "date", dir: "desc" },
        input.page,
      );
  return { items: res.rows.map(mapTerm), page: res.page };
}

export async function getTermById(
  tx: Tx,
  input: { tenantId: string; termId: string },
): Promise<PublicTerm> {
  const res = await tx.query(
    `SELECT id, tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current,
            created_at, updated_at
     FROM academic_terms WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.termId],
  );
  const row = res.rows[0] as Parameters<typeof mapTerm>[0] | undefined;
  if (!row) throw notFound("Term not found");
  return mapTerm(row);
}

export async function setCurrentTerm(
  tx: Tx,
  input: { tenantId: string; termId: string; actorUserId: string; ip?: string | null },
): Promise<PublicTerm> {
  await getTermById(tx, input);
  // A9-11: serialize concurrent set-current calls (see setCurrentAcademicYear).
  await tx.query(`SELECT id FROM academic_terms WHERE tenant_id = $1 ORDER BY id FOR UPDATE`, [input.tenantId]);
  await tx.query(
    `UPDATE academic_terms SET is_current = false, updated_at = now()
     WHERE tenant_id = $1 AND is_current = true`,
    [input.tenantId],
  );
  const res = await tx.query(
    `UPDATE academic_terms SET is_current = true, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current,
               created_at, updated_at`,
    [input.tenantId, input.termId],
  );
  const row = res.rows[0] as Parameters<typeof mapTerm>[0] | undefined;
  if (!row) throw notFound("Term not found");
  await recordSecurityEvent(tx, {
    eventType: "academics.term.current_set",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { termId: row.id },
    ip: input.ip,
  });
  return mapTerm(row);
}

// ── Subjects ────────────────────────────────────────────────────────────────

export interface PublicSubject {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function createSubject(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    code: string;
    name: string;
    ip?: string | null;
  },
): Promise<PublicSubject> {
  const code = trimRequired(input.code, "code", 32);
  const name = trimRequired(input.name, "name", 120);
  try {
    const res = await tx.query<{
      id: string;
      tenant_id: string;
      code: string;
      name: string;
      active: boolean;
      archived_at: Date | string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `INSERT INTO subjects (tenant_id, code, name, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, code, name, active, archived_at, created_at, updated_at`,
      [input.tenantId, code, name, input.actorUserId],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "academics.subject.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { subjectId: row.id, code: row.code },
      ip: input.ip,
    });
    return {
      id: row.id,
      tenantId: row.tenant_id,
      code: row.code,
      name: row.name,
      active: row.active,
      archived_at: row.archived_at ? isoStamp(row.archived_at) : null,
      created_at: isoStamp(row.created_at),
      updated_at: isoStamp(row.updated_at),
    };
  } catch (err) {
    const c = (err as { code?: string }).code;
    if (c === "23505") throw conflict("A subject with this code already exists");
    throw err;
  }
}

export async function listSubjects(
  tx: Tx,
  input: { tenantId: string; active?: boolean | null; page: PageInput },
): Promise<Page<PublicSubject>> {
  const all = input.active === null || input.active === undefined;
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, code, name, active, archived_at, created_at, updated_at
       FROM subjects WHERE tenant_id = $1${all ? "" : " AND active = $2"}`,
    all ? [input.tenantId] : [input.tenantId, input.active],
    { name: "subjects", expr: "lower(q.name)", type: "text", dir: "asc" },
    input.page,
  );
  return { page: res.page, items: (res.rows as unknown as Array<{
    id: string;
    tenant_id: string;
    code: string;
    name: string;
    active: boolean;
    archived_at: Date | string | null;
    created_at: Date | string;
    updated_at: Date | string;
  }>).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    active: row.active,
    archived_at: row.archived_at ? isoStamp(row.archived_at) : null,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  })) };
}

export async function getSubjectById(
  tx: Tx,
  input: { tenantId: string; subjectId: string },
): Promise<PublicSubject> {
  const res = await tx.query(
    `SELECT id, tenant_id, code, name, active, archived_at, created_at, updated_at
     FROM subjects WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.subjectId],
  );
  const row = res.rows[0] as
    | {
        id: string;
        tenant_id: string;
        code: string;
        name: string;
        active: boolean;
        archived_at: Date | string | null;
        created_at: Date | string;
        updated_at: Date | string;
      }
    | undefined;
  if (!row) throw notFound("Subject not found");
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    active: row.active,
    archived_at: row.archived_at ? isoStamp(row.archived_at) : null,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

// ── Classes ─────────────────────────────────────────────────────────────────

export type EducationLevel =
  | "pre_primary"
  | "primary"
  | "junior_secondary"
  | "senior_school"
  | "secondary";
export type Pathway = "stem" | "social_sciences" | "arts_sports";

const LEVEL_YEAR: Record<EducationLevel, { min: number; max: number }> = {
  pre_primary: { min: 1, max: 2 },
  primary: { min: 1, max: 6 },
  junior_secondary: { min: 7, max: 9 },
  senior_school: { min: 10, max: 12 },
  secondary: { min: 1, max: 4 },
};

export function assertEducationLevelYear(
  education_level: EducationLevel | null | undefined,
  form_level: number | null | undefined,
  pathway: Pathway | null | undefined,
): void {
  if (pathway != null && education_level !== "senior_school") {
    throw validationError("pathway is only valid for senior_school");
  }
  if (education_level == null || form_level == null) return;
  const band = LEVEL_YEAR[education_level];
  if (form_level < band.min || form_level > band.max) {
    throw validationError(`form_level must be between ${band.min} and ${band.max} for ${education_level}`);
  }
}

export interface PublicClass {
  id: string;
  tenantId: string;
  academic_year_id: string;
  name: string;
  form_level: number | null;
  education_level: EducationLevel | null;
  pathway: Pathway | null;
  stream: string | null;
  class_teacher_staff_id: string | null;
  active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapClass(row: {
  id: string;
  tenant_id: string;
  academic_year_id: string;
  name: string;
  form_level: number | null;
  education_level: EducationLevel | null;
  pathway: Pathway | null;
  stream: string | null;
  class_teacher_staff_id: string | null;
  active: boolean;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): PublicClass {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    academic_year_id: row.academic_year_id,
    name: row.name,
    form_level: row.form_level,
    education_level: row.education_level,
    pathway: row.pathway,
    stream: row.stream,
    class_teacher_staff_id: row.class_teacher_staff_id,
    active: row.active,
    archived_at: row.archived_at ? isoStamp(row.archived_at) : null,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

export async function createClass(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    academic_year_id: string;
    name: string;
    form_level?: number | null;
    education_level?: EducationLevel | null;
    pathway?: Pathway | null;
    stream?: string | null;
    class_teacher_staff_id?: string | null;
    ip?: string | null;
  },
): Promise<PublicClass> {
  const name = trimRequired(input.name, "name", 64);
  const stream =
    input.stream === undefined || input.stream === null || input.stream.trim() === ""
      ? null
      : trimRequired(input.stream, "stream", 32);
  if (input.form_level != null && (input.form_level < 1 || input.form_level > 12)) {
    throw validationError("form_level must be between 1 and 12");
  }
  assertEducationLevelYear(input.education_level ?? null, input.form_level ?? null, input.pathway ?? null);
  await getAcademicYearById(tx, {
    tenantId: input.tenantId,
    academicYearId: input.academic_year_id,
  });
  if (input.class_teacher_staff_id) {
    const staff = await tx.query(
      `SELECT id FROM staff_members
       WHERE tenant_id = $1 AND id = $2 AND active = true`,
      [input.tenantId, input.class_teacher_staff_id],
    );
    if (staff.rowCount === 0) {
      throw validationError("class_teacher_staff_id must be an active staff member in this school");
    }
  }
  try {
    const res = await tx.query(
      `INSERT INTO classes
         (tenant_id, academic_year_id, name, form_level, education_level, pathway, stream, class_teacher_staff_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, tenant_id, academic_year_id, name, form_level, education_level, pathway, stream, class_teacher_staff_id,
                 active, archived_at, created_at, updated_at`,
      [
        input.tenantId,
        input.academic_year_id,
        name,
        input.form_level ?? null,
        input.education_level ?? null,
        input.pathway ?? null,
        stream,
        input.class_teacher_staff_id ?? null,
        input.actorUserId,
      ],
    );
    const row = res.rows[0] as Parameters<typeof mapClass>[0];
    await recordSecurityEvent(tx, {
      eventType: "academics.class.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { classId: row.id, academicYearId: row.academic_year_id, name: row.name },
      ip: input.ip,
    });
    return mapClass(row);
  } catch (err) {
    const c = (err as { code?: string }).code;
    if (c === "23505") throw conflict("A class with this name already exists for the year");
    if (c === "23503") throw validationError("Referenced year or staff member is invalid for this school");
    throw err;
  }
}

export async function listClasses(
  tx: Tx,
  input: {
    tenantId: string;
    academicYearId?: string;
    active?: boolean | null;
    page: PageInput;
    /** OD-2: null = every class; otherwise only these class ids. */
    scopeClassIds?: string[] | null;
  },
): Promise<Page<PublicClass>> {
  if (input.scopeClassIds !== undefined && input.scopeClassIds !== null && input.scopeClassIds.length === 0) {
    return { items: [], page: { next_cursor: null, limit: input.page.limit } };
  }
  const clauses = ["tenant_id = $1"];
  const params: unknown[] = [input.tenantId];
  if (input.academicYearId) {
    params.push(input.academicYearId);
    clauses.push(`academic_year_id = $${params.length}`);
  }
  if (input.active === true || input.active === false) {
    params.push(input.active);
    clauses.push(`active = $${params.length}`);
  }
  if (input.scopeClassIds != null) {
    params.push(input.scopeClassIds);
    clauses.push(`id = ANY($${params.length}::uuid[])`);
  }
  const res = await pageQuery<Parameters<typeof mapClass>[0]>(
    tx,
    `SELECT id, tenant_id, academic_year_id, name, form_level, education_level, pathway, stream, class_teacher_staff_id,
            active, archived_at, created_at, updated_at
     FROM classes WHERE ${clauses.join(" AND ")}`,
    params,
    { name: "classes", expr: "lower(q.name)", type: "text", dir: "asc" },
    input.page,
  );
  return { items: res.rows.map(mapClass), page: res.page };
}

export async function getClassById(
  tx: Tx,
  input: { tenantId: string; classId: string },
): Promise<PublicClass> {
  const res = await tx.query(
    `SELECT id, tenant_id, academic_year_id, name, form_level, education_level, pathway, stream, class_teacher_staff_id,
            active, archived_at, created_at, updated_at
     FROM classes WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.classId],
  );
  const row = res.rows[0] as Parameters<typeof mapClass>[0] | undefined;
  if (!row) throw notFound("Class not found");
  return mapClass(row);
}

/** OD-2: class in scope, or null when missing / outside teacher class scope. */
export async function findClassInScope(
  tx: Tx,
  input: { tenantId: string; classId: string; scopeClassIds: string[] | null },
): Promise<PublicClass | null> {
  if (input.scopeClassIds !== null && !input.scopeClassIds.includes(input.classId)) return null;
  try {
    return await getClassById(tx, { tenantId: input.tenantId, classId: input.classId });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return null;
    throw err;
  }
}

// ── Class memberships ───────────────────────────────────────────────────────

export interface PublicClassMembership {
  id: string;
  tenantId: string;
  learner_id: string;
  class_id: string;
  academic_year_id: string;
  active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapMembership(row: {
  id: string;
  tenant_id: string;
  learner_id: string;
  class_id: string;
  academic_year_id: string;
  active: boolean;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): PublicClassMembership {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    learner_id: row.learner_id,
    class_id: row.class_id,
    academic_year_id: row.academic_year_id,
    active: row.active,
    archived_at: row.archived_at ? isoStamp(row.archived_at) : null,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

export async function assignLearnerToClass(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    learner_id: string;
    class_id: string;
    ip?: string | null;
  },
): Promise<PublicClassMembership> {
  const cls = await getClassById(tx, { tenantId: input.tenantId, classId: input.class_id });
  if (!cls.active) throw validationError("Cannot assign learners to an archived class");
  try {
    const res = await tx.query(
      `INSERT INTO class_memberships
         (tenant_id, learner_id, class_id, academic_year_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant_id, learner_id, class_id, academic_year_id, active, archived_at,
                 created_at, updated_at`,
      [input.tenantId, input.learner_id, input.class_id, cls.academic_year_id, input.actorUserId],
    );
    const row = res.rows[0] as Parameters<typeof mapMembership>[0];
    await recordSecurityEvent(tx, {
      eventType: "academics.membership.assigned",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: {
        membershipId: row.id,
        learnerId: row.learner_id,
        classId: row.class_id,
        academicYearId: row.academic_year_id,
      },
      ip: input.ip,
    });
    return mapMembership(row);
  } catch (err) {
    const c = (err as { code?: string }).code;
    if (c === "23505") {
      throw conflict("Learner already has an active class membership for this academic year");
    }
    if (c === "23514") {
      // Review A9-10: forward only the guard's own known messages, never a raw CHECK constraint text.
      const message = (err as Error).message ?? "";
      if (message === "class membership academic year must match the class year" || message === "cannot assign an inactive learner to a class") {
        throw validationError(message);
      }
      throw validationError("Class membership rejected");
    }
    if (c === "23503") {
      throw validationError("Learner or class must belong to this school");
    }
    throw err;
  }
}

export async function listClassMemberships(
  tx: Tx,
  input: {
    tenantId: string;
    classId?: string;
    learnerId?: string;
    active?: boolean | null;
    page: PageInput;
    scopeClassIds?: string[] | null;
  },
): Promise<Page<PublicClassMembership>> {
  if (input.scopeClassIds !== undefined && input.scopeClassIds !== null && input.scopeClassIds.length === 0) {
    return { items: [], page: { next_cursor: null, limit: input.page.limit } };
  }
  if (input.classId && input.scopeClassIds != null && !input.scopeClassIds.includes(input.classId)) {
    return { items: [], page: { next_cursor: null, limit: input.page.limit } };
  }
  const clauses = ["tenant_id = $1"];
  const params: unknown[] = [input.tenantId];
  if (input.classId) {
    params.push(input.classId);
    clauses.push(`class_id = $${params.length}`);
  } else if (input.scopeClassIds != null) {
    params.push(input.scopeClassIds);
    clauses.push(`class_id = ANY($${params.length}::uuid[])`);
  }
  if (input.learnerId) {
    params.push(input.learnerId);
    clauses.push(`learner_id = $${params.length}`);
  }
  if (input.active === true || input.active === false) {
    params.push(input.active);
    clauses.push(`active = $${params.length}`);
  }
  const res = await pageQuery<Parameters<typeof mapMembership>[0]>(
    tx,
    `SELECT id, tenant_id, learner_id, class_id, academic_year_id, active, archived_at,
            created_at, updated_at
     FROM class_memberships WHERE ${clauses.join(" AND ")}`,
    params,
    { name: "class_memberships", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: res.rows.map(mapMembership), page: res.page };
}

/** A9-6: replays read the created or archived membership by id. */
export async function getClassMembershipById(
  tx: Tx,
  input: { tenantId: string; membershipId: string },
): Promise<PublicClassMembership | null> {
  const res = await tx.query(
    `SELECT id, tenant_id, learner_id, class_id, academic_year_id, active, archived_at, created_at, updated_at
       FROM class_memberships WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.membershipId],
  );
  const row = res.rows[0] as Parameters<typeof mapMembership>[0] | undefined;
  return row ? mapMembership(row) : null;
}

export async function archiveClassMembership(
  tx: Tx,
  input: { tenantId: string; membershipId: string; actorUserId: string; ip?: string | null },
): Promise<PublicClassMembership> {
  const res = await tx.query(
    `UPDATE class_memberships
     SET active = false, archived_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND active = true
     RETURNING id, tenant_id, learner_id, class_id, academic_year_id, active, archived_at,
               created_at, updated_at`,
    [input.tenantId, input.membershipId],
  );
  const row = res.rows[0] as Parameters<typeof mapMembership>[0] | undefined;
  if (!row) throw notFound("Class membership not found or already archived");
  await recordSecurityEvent(tx, {
    eventType: "academics.membership.archived",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { membershipId: row.id, learnerId: row.learner_id, classId: row.class_id },
    ip: input.ip,
  });
  return mapMembership(row);
}

// ── Teaching assignments ────────────────────────────────────────────────────

export interface PublicTeachingAssignment {
  id: string;
  tenantId: string;
  staff_member_id: string;
  class_id: string;
  subject_id: string;
  active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapAssignment(row: {
  id: string;
  tenant_id: string;
  staff_member_id: string;
  class_id: string;
  subject_id: string;
  active: boolean;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): PublicTeachingAssignment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    staff_member_id: row.staff_member_id,
    class_id: row.class_id,
    subject_id: row.subject_id,
    active: row.active,
    archived_at: row.archived_at ? isoStamp(row.archived_at) : null,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

export async function createTeachingAssignment(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    staff_member_id: string;
    class_id: string;
    subject_id: string;
    ip?: string | null;
  },
): Promise<PublicTeachingAssignment> {
  await getClassById(tx, { tenantId: input.tenantId, classId: input.class_id });
  await getSubjectById(tx, { tenantId: input.tenantId, subjectId: input.subject_id });
  const staff = await tx.query(
    `SELECT id FROM staff_members WHERE tenant_id = $1 AND id = $2 AND active = true`,
    [input.tenantId, input.staff_member_id],
  );
  if (staff.rowCount === 0) {
    throw validationError("staff_member_id must be an active staff member in this school");
  }
  try {
    const res = await tx.query(
      `INSERT INTO teaching_assignments
         (tenant_id, staff_member_id, class_id, subject_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant_id, staff_member_id, class_id, subject_id, active, archived_at,
                 created_at, updated_at`,
      [
        input.tenantId,
        input.staff_member_id,
        input.class_id,
        input.subject_id,
        input.actorUserId,
      ],
    );
    const row = res.rows[0] as Parameters<typeof mapAssignment>[0];
    await recordSecurityEvent(tx, {
      eventType: "academics.teaching_assignment.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: {
        assignmentId: row.id,
        staffMemberId: row.staff_member_id,
        classId: row.class_id,
        subjectId: row.subject_id,
      },
      ip: input.ip,
    });
    return mapAssignment(row);
  } catch (err) {
    const c = (err as { code?: string }).code;
    if (c === "23505") {
      throw conflict("An active teaching assignment already exists for this class and subject");
    }
    if (c === "23503") throw validationError("Referenced staff, class or subject is invalid");
    throw err;
  }
}

export async function listTeachingAssignments(
  tx: Tx,
  input: {
    tenantId: string;
    classId?: string;
    staffMemberId?: string;
    active?: boolean | null;
    page: PageInput;
    scopeClassIds?: string[] | null;
  },
): Promise<Page<PublicTeachingAssignment>> {
  if (input.scopeClassIds !== undefined && input.scopeClassIds !== null && input.scopeClassIds.length === 0) {
    return { items: [], page: { next_cursor: null, limit: input.page.limit } };
  }
  if (input.classId && input.scopeClassIds != null && !input.scopeClassIds.includes(input.classId)) {
    return { items: [], page: { next_cursor: null, limit: input.page.limit } };
  }
  const clauses = ["tenant_id = $1"];
  const params: unknown[] = [input.tenantId];
  if (input.classId) {
    params.push(input.classId);
    clauses.push(`class_id = $${params.length}`);
  } else if (input.scopeClassIds != null) {
    params.push(input.scopeClassIds);
    clauses.push(`class_id = ANY($${params.length}::uuid[])`);
  }
  if (input.staffMemberId) {
    params.push(input.staffMemberId);
    clauses.push(`staff_member_id = $${params.length}`);
  }
  if (input.active === true || input.active === false) {
    params.push(input.active);
    clauses.push(`active = $${params.length}`);
  }
  const res = await pageQuery<Parameters<typeof mapAssignment>[0]>(
    tx,
    `SELECT id, tenant_id, staff_member_id, class_id, subject_id, active, archived_at,
            created_at, updated_at
     FROM teaching_assignments WHERE ${clauses.join(" AND ")}`,
    params,
    { name: "teaching_assignments", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: res.rows.map(mapAssignment), page: res.page };
}

export async function getTeachingAssignmentById(
  tx: Tx,
  input: { tenantId: string; assignmentId: string },
): Promise<PublicTeachingAssignment | null> {
  const res = await tx.query(
    `SELECT id, tenant_id, staff_member_id, class_id, subject_id, active, archived_at, created_at, updated_at
       FROM teaching_assignments WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.assignmentId],
  );
  const row = res.rows[0] as Parameters<typeof mapAssignment>[0] | undefined;
  return row ? mapAssignment(row) : null;
}

/**
 * OD-2 read scope: classes the user may read as a teacher. Same rule as userMayTeachClass: an active
 * staff row linked to the user that holds an active teaching assignment for the class, or is the
 * class teacher of an active class. Empty when the user teaches nothing.
 */
export async function teacherClassIds(tx: Tx, input: { tenantId: string; userId: string }): Promise<string[]> {
  const res = await tx.query<{ class_id: string }>(
    `SELECT ta.class_id
       FROM staff_members sm
       JOIN teaching_assignments ta ON ta.tenant_id = sm.tenant_id AND ta.staff_member_id = sm.id AND ta.active = true
      WHERE sm.tenant_id = $1 AND sm.user_id = $2 AND sm.active = true
     UNION
     SELECT c.id
       FROM staff_members sm
       JOIN classes c ON c.tenant_id = sm.tenant_id AND c.class_teacher_staff_id = sm.id AND c.active = true
      WHERE sm.tenant_id = $1 AND sm.user_id = $2 AND sm.active = true`,
    [input.tenantId, input.userId],
  );
  return res.rows.map((r) => r.class_id);
}

/** True when the user is linked to an active staff row that teaches the class (any subject) or is class teacher. */
export async function userMayTeachClass(
  tx: Tx,
  input: { tenantId: string; userId: string; classId: string },
): Promise<boolean> {
  const res = await tx.query(
    `SELECT 1
     FROM staff_members sm
     WHERE sm.tenant_id = $1 AND sm.user_id = $2 AND sm.active = true
       AND (
         EXISTS (
           SELECT 1 FROM teaching_assignments ta
           WHERE ta.tenant_id = sm.tenant_id
             AND ta.staff_member_id = sm.id
             AND ta.class_id = $3
             AND ta.active = true
         )
         OR EXISTS (
           SELECT 1 FROM classes c
           WHERE c.tenant_id = sm.tenant_id
             AND c.id = $3
             AND c.class_teacher_staff_id = sm.id
             AND c.active = true
         )
       )
     LIMIT 1`,
    [input.tenantId, input.userId, input.classId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function userMayAssessClassSubject(
  tx: Tx,
  input: { tenantId: string; userId: string; classId: string; subjectId: string },
): Promise<boolean> {
  const res = await tx.query(
    `SELECT 1
     FROM staff_members sm
     JOIN teaching_assignments ta
       ON ta.tenant_id = sm.tenant_id
      AND ta.staff_member_id = sm.id
     WHERE sm.tenant_id = $1 AND sm.user_id = $2 AND sm.active = true
       AND ta.class_id = $3 AND ta.subject_id = $4 AND ta.active = true
     LIMIT 1`,
    [input.tenantId, input.userId, input.classId, input.subjectId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Timetable ───────────────────────────────────────────────────────────────

export interface PublicTimetableSlot {
  id: string;
  tenantId: string;
  class_id: string;
  subject_id: string;
  teaching_assignment_id: string | null;
  day_of_week: number;
  starts_at: string;
  ends_at: string;
  room: string | null;
  active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapSlot(row: {
  id: string;
  tenant_id: string;
  class_id: string;
  subject_id: string;
  teaching_assignment_id: string | null;
  day_of_week: number;
  starts_at: string;
  ends_at: string;
  room: string | null;
  active: boolean;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): PublicTimetableSlot {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    class_id: row.class_id,
    subject_id: row.subject_id,
    teaching_assignment_id: row.teaching_assignment_id,
    day_of_week: row.day_of_week,
    starts_at: String(row.starts_at).slice(0, 8),
    ends_at: String(row.ends_at).slice(0, 8),
    room: row.room,
    active: row.active,
    archived_at: row.archived_at ? isoStamp(row.archived_at) : null,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

export async function createTimetableSlot(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    class_id: string;
    subject_id: string;
    teaching_assignment_id?: string | null;
    day_of_week: number;
    starts_at: string;
    ends_at: string;
    room?: string | null;
    ip?: string | null;
  },
): Promise<PublicTimetableSlot> {
  if (input.day_of_week < 1 || input.day_of_week > 7) {
    throw validationError("day_of_week must be 1 (Monday) through 7 (Sunday)");
  }
  if (input.ends_at <= input.starts_at) {
    throw validationError("ends_at must be after starts_at");
  }
  await getClassById(tx, { tenantId: input.tenantId, classId: input.class_id });
  await getSubjectById(tx, { tenantId: input.tenantId, subjectId: input.subject_id });
  if (input.teaching_assignment_id) {
    // Review A9-7: the linked assignment must be the active one for this class and subject.
    const ta = await tx.query(
      `SELECT 1 FROM teaching_assignments
        WHERE tenant_id = $1 AND id = $2 AND class_id = $3 AND subject_id = $4 AND active = true`,
      [input.tenantId, input.teaching_assignment_id, input.class_id, input.subject_id],
    );
    if (ta.rowCount === 0) {
      throw validationError("teaching_assignment_id must be an active assignment for this class and subject");
    }
  }
  // Serialize concurrent slot creations for the same (tenant, class, day) to prevent overlap races.
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtext('timetable:' || $1 || ':' || $2 || ':' || $3))`,
    [input.tenantId, input.class_id, String(input.day_of_week)],
  );
  // Same class + same day: active slots must not overlap in time (approved conflict rule).
  const overlap = await tx.query(
    `SELECT id FROM timetable_slots
      WHERE tenant_id = $1 AND class_id = $2 AND day_of_week = $3 AND active = true
        AND starts_at < $5::time AND ends_at > $4::time
      LIMIT 1`,
    [input.tenantId, input.class_id, input.day_of_week, input.starts_at, input.ends_at],
  );
  if ((overlap.rowCount ?? 0) > 0) {
    throw conflict("Timetable slot overlaps an existing active slot for this class and day");
  }
  const room =
    input.room === undefined || input.room === null || input.room.trim() === ""
      ? null
      : trimRequired(input.room, "room", 64);
  try {
    const res = await tx.query(
      `INSERT INTO timetable_slots
         (tenant_id, class_id, subject_id, teaching_assignment_id, day_of_week,
          starts_at, ends_at, room, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::time, $7::time, $8, $9)
       RETURNING id, tenant_id, class_id, subject_id, teaching_assignment_id, day_of_week,
                 starts_at::text AS starts_at, ends_at::text AS ends_at, room, active,
                 archived_at, created_at, updated_at`,
      [
        input.tenantId,
        input.class_id,
        input.subject_id,
        input.teaching_assignment_id ?? null,
        input.day_of_week,
        input.starts_at,
        input.ends_at,
        room,
        input.actorUserId,
      ],
    );
    const row = res.rows[0] as Parameters<typeof mapSlot>[0];
    await recordSecurityEvent(tx, {
      eventType: "academics.timetable.slot_created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { slotId: row.id, classId: row.class_id, dayOfWeek: row.day_of_week },
      ip: input.ip,
    });
    return mapSlot(row);
  } catch (err) {
    const c = (err as { code?: string }).code;
    if (c === "23503") throw validationError("Referenced class, subject or assignment is invalid");
    if (c === "23514") throw validationError("Invalid timetable slot");
    throw err;
  }
}

export async function listTimetableSlots(
  tx: Tx,
  input: {
    tenantId: string;
    classId: string;
    active?: boolean | null;
    page: PageInput;
    scopeClassIds?: string[] | null;
  },
): Promise<Page<PublicTimetableSlot>> {
  if (input.scopeClassIds !== undefined && input.scopeClassIds !== null) {
    if (input.scopeClassIds.length === 0 || !input.scopeClassIds.includes(input.classId)) {
      return { items: [], page: { next_cursor: null, limit: input.page.limit } };
    }
  }
  const clauses = ["tenant_id = $1", "class_id = $2"];
  const params: unknown[] = [input.tenantId, input.classId];
  if (input.active === true || input.active === false) {
    params.push(input.active);
    clauses.push(`active = $${params.length}`);
  }
  const res = await pageQuery<Parameters<typeof mapSlot>[0]>(
    tx,
    `SELECT id, tenant_id, class_id, subject_id, teaching_assignment_id, day_of_week,
            starts_at::text AS starts_at, ends_at::text AS ends_at, room, active,
            archived_at, created_at, updated_at
     FROM timetable_slots WHERE ${clauses.join(" AND ")}`,
    params,
    // Day 1-7 is one digit and starts_at is HH:MM:SS, so the text key sorts by day, then time.
    { name: "timetable_slots", expr: "(q.day_of_week::text || ' ' || q.starts_at)", type: "text", dir: "asc" },
    input.page,
  );
  return { items: res.rows.map(mapSlot), page: res.page };
}

export async function getTimetableSlotById(
  tx: Tx,
  input: { tenantId: string; slotId: string },
): Promise<PublicTimetableSlot | null> {
  const res = await tx.query(
    `SELECT id, tenant_id, class_id, subject_id, teaching_assignment_id, day_of_week,
            starts_at::text AS starts_at, ends_at::text AS ends_at, room, active,
            archived_at, created_at, updated_at
       FROM timetable_slots WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.slotId],
  );
  const row = res.rows[0] as Parameters<typeof mapSlot>[0] | undefined;
  return row ? mapSlot(row) : null;
}

export interface PublicTimetablePublication {
  id: string;
  tenantId: string;
  academic_year_id: string;
  term_id: string | null;
  class_id: string;
  version: number;
  status: "draft" | "published";
  slots_snapshot: PublicTimetableSlot[];
  created_by: string | null;
  published_by: string | null;
  created_at: string;
  published_at: string | null;
}

type PublicationRow = {
  id: string;
  tenant_id: string;
  academic_year_id: string;
  term_id: string | null;
  class_id: string;
  version: number;
  status: "draft" | "published";
  slots_snapshot: PublicTimetableSlot[];
  created_by: string | null;
  published_by: string | null;
  created_at: Date | string;
  published_at: Date | string | null;
};

function mapPublication(r: PublicationRow): PublicTimetablePublication {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    academic_year_id: r.academic_year_id,
    term_id: r.term_id,
    class_id: r.class_id,
    version: r.version,
    status: r.status,
    slots_snapshot: r.slots_snapshot,
    created_by: r.created_by,
    published_by: r.published_by,
    created_at: isoStamp(r.created_at),
    published_at: r.published_at ? isoStamp(r.published_at) : null,
  };
}

export async function createTimetablePublication(
  tx: Tx,
  input: { tenantId: string; class_id: string; term_id?: string | null; actorUserId: string; ip?: string | null },
): Promise<PublicTimetablePublication> {
  const klass = await getClassById(tx, { tenantId: input.tenantId, classId: input.class_id });
  if (input.term_id) {
    const term = await getTermById(tx, { tenantId: input.tenantId, termId: input.term_id });
    if (term.academic_year_id !== klass.academic_year_id) {
      throw validationError("term_id must belong to the class's academic year");
    }
  }
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtext('timetable-pub:' || $1 || ':' || $2))`,
    [input.tenantId, input.class_id],
  );
  const nextVer = await tx.query<{ v: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM timetable_publications WHERE tenant_id = $1 AND class_id = $2`,
    [input.tenantId, input.class_id],
  );
  const slots = await tx.query(
    `SELECT id, tenant_id, class_id, subject_id, teaching_assignment_id, day_of_week,
            starts_at::text AS starts_at, ends_at::text AS ends_at, room, active,
            archived_at, created_at, updated_at
       FROM timetable_slots
      WHERE tenant_id = $1 AND class_id = $2 AND active = true
      ORDER BY day_of_week ASC, starts_at ASC`,
    [input.tenantId, input.class_id],
  );
  const snapshot = slots.rows.map((r) => mapSlot(r as Parameters<typeof mapSlot>[0]));
  const res = await tx.query<PublicationRow>(
    `INSERT INTO timetable_publications
       (tenant_id, academic_year_id, term_id, class_id, version, status, slots_snapshot, created_by)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6::jsonb, $7)
     RETURNING id, tenant_id, academic_year_id, term_id, class_id, version, status, slots_snapshot,
               created_by, published_by, created_at, published_at`,
    [
      input.tenantId,
      klass.academic_year_id,
      input.term_id ?? null,
      input.class_id,
      nextVer.rows[0]!.v,
      JSON.stringify(snapshot),
      input.actorUserId,
    ],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "academics.timetable.publication_drafted",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { publicationId: row.id, classId: row.class_id, version: row.version },
    ip: input.ip,
  });
  return mapPublication(row);
}

export async function publishTimetablePublication(
  tx: Tx,
  input: { tenantId: string; publicationId: string; actorUserId: string; ip?: string | null },
): Promise<PublicTimetablePublication> {
  const res = await tx.query<PublicationRow>(
    `UPDATE timetable_publications
        SET status = 'published', published_by = $3, published_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
      RETURNING id, tenant_id, academic_year_id, term_id, class_id, version, status, slots_snapshot,
                created_by, published_by, created_at, published_at`,
    [input.tenantId, input.publicationId, input.actorUserId],
  );
  const row = res.rows[0];
  if (!row) {
    const exists = await tx.query(`SELECT 1 FROM timetable_publications WHERE tenant_id = $1 AND id = $2`, [
      input.tenantId,
      input.publicationId,
    ]);
    if (exists.rowCount === 0) throw notFound("Timetable publication not found");
    throw conflict("Timetable publication is already published");
  }
  await recordSecurityEvent(tx, {
    eventType: "academics.timetable.published",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { publicationId: row.id, classId: row.class_id, version: row.version },
    ip: input.ip,
  });
  return mapPublication(row);
}

export async function listTimetablePublications(
  tx: Tx,
  input: { tenantId: string; classId?: string; scopeClassIds?: string[] | null; page: PageInput },
): Promise<Page<PublicTimetablePublication>> {
  const clauses = ["tenant_id = $1"];
  const params: unknown[] = [input.tenantId];
  if (input.scopeClassIds !== undefined && input.scopeClassIds !== null) {
    if (input.scopeClassIds.length === 0) {
      return { items: [], page: { limit: input.page.limit, next_cursor: null } };
    }
    params.push(input.scopeClassIds);
    clauses.push(`class_id = ANY($${params.length}::uuid[])`);
  }
  if (input.classId) {
    params.push(input.classId);
    clauses.push(`class_id = $${params.length}`);
  }
  const out = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, academic_year_id, term_id, class_id, version, status, slots_snapshot,
            created_by, published_by, created_at, published_at
       FROM timetable_publications WHERE ${clauses.join(" AND ")}`,
    params,
    { name: "timetable_publications", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: (out.rows as unknown as PublicationRow[]).map(mapPublication), page: out.page };
}
