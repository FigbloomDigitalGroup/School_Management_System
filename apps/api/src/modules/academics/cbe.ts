import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { getClassById, getTermById } from "./structure.js";
import { pgCode } from "./pgError.js";
import { ONE_ROW, pageQuery, type Page, type PageInput } from "./pagination.js";

function isoStamp(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function trim(value: string, field: string, max: number): string {
  const t = value.trim();
  if (t.length < 1 || t.length > max) throw validationError(`${field} must be 1–${max} characters`);
  return t;
}

export interface PublicProvenance {
  id: string;
  tenantId: string;
  source_kind: "school_configured" | "import_pending";
  source_label: string;
  source_uri: string | null;
  notes: string | null;
  /** School writes never claim an official national catalogue. */
  official_catalogue: false;
  created_at: string;
}

export async function createProvenance(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    source_kind: string;
    source_label: string;
    source_uri?: string | null;
    notes?: string | null;
    ip?: string | null;
  },
): Promise<PublicProvenance> {
  if (input.source_kind !== "school_configured" && input.source_kind !== "import_pending") {
    throw validationError(
      "Only school_configured or import_pending provenance can be recorded. Official catalogue import is a separate path and is not seeded.",
    );
  }
  const source_label = trim(input.source_label, "source_label", 160);
  const source_uri =
    input.source_uri === undefined || input.source_uri === null || input.source_uri.trim() === ""
      ? null
      : trim(input.source_uri, "source_uri", 500);
  const notes =
    input.notes === undefined || input.notes === null || input.notes.trim() === ""
      ? null
      : input.notes.trim();
  if (notes && notes.length > 2000) throw validationError("notes must be at most 2000 characters");
  const res = await tx.query<{
    id: string;
    tenant_id: string;
    source_kind: "school_configured" | "import_pending";
    source_label: string;
    source_uri: string | null;
    notes: string | null;
    created_at: Date | string;
  }>(
    `INSERT INTO curriculum_provenance (tenant_id, source_kind, source_label, source_uri, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, tenant_id, source_kind, source_label, source_uri, notes, created_at`,
    [input.tenantId, input.source_kind, source_label, source_uri, notes],
  );
  const row = res.rows[0]!;
  // Review A9-13: curriculum provenance is the D-5 trail, so its creation is audited (ids and kind only).
  await recordSecurityEvent(tx, {
    eventType: "academics.cbe.provenance.created",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { provenanceId: row.id, sourceKind: row.source_kind },
    ip: input.ip,
  });
  return {
    id: row.id,
    tenantId: row.tenant_id,
    source_kind: row.source_kind,
    source_label: row.source_label,
    source_uri: row.source_uri,
    notes: row.notes,
    official_catalogue: false,
    created_at: isoStamp(row.created_at),
  };
}

export async function listProvenance(tx: Tx, input: { tenantId: string; page: PageInput; id?: string }): Promise<Page<PublicProvenance>> {
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, source_kind, source_label, source_uri, notes, created_at
       FROM curriculum_provenance WHERE tenant_id = $1`,
    [input.tenantId],
    { name: "curriculum_provenance", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{
    id: string;
    tenant_id: string;
    source_kind: "school_configured" | "import_pending";
    source_label: string;
    source_uri: string | null;
    notes: string | null;
    created_at: Date | string;
  }>).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    source_kind: row.source_kind,
    source_label: row.source_label,
    source_uri: row.source_uri,
    notes: row.notes,
    official_catalogue: false as const,
    created_at: isoStamp(row.created_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getProvenanceById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listProvenance(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

export type LearningAreaLevel =
  | "pre_primary"
  | "primary"
  | "junior_secondary"
  | "senior_school"
  | "secondary";
export type LearningAreaPathway = "stem" | "social_sciences" | "arts_sports";

export interface PublicLearningArea {
  id: string;
  tenantId: string;
  provenance_id: string;
  code: string;
  name: string;
  education_level: LearningAreaLevel | null;
  min_grade: number | null;
  max_grade: number | null;
  pathway: LearningAreaPathway | null;
  is_core: boolean;
  official_catalogue: false;
  created_at: string;
}

type LearningAreaRow = {
  id: string;
  tenant_id: string;
  provenance_id: string;
  code: string;
  name: string;
  education_level: LearningAreaLevel | null;
  min_grade: number | null;
  max_grade: number | null;
  pathway: LearningAreaPathway | null;
  is_core: boolean;
  created_at: Date | string;
};

const LEARNING_AREA_COLS = `id, tenant_id, provenance_id, code, name, education_level, min_grade, max_grade, pathway, is_core, created_at`;

function mapLearningArea(row: LearningAreaRow): PublicLearningArea {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provenance_id: row.provenance_id,
    code: row.code,
    name: row.name,
    education_level: row.education_level,
    min_grade: row.min_grade,
    max_grade: row.max_grade,
    pathway: row.pathway,
    is_core: row.is_core,
    official_catalogue: false,
    created_at: isoStamp(row.created_at),
  };
}

export async function createLearningArea(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    provenance_id: string;
    code: string;
    name: string;
    education_level?: LearningAreaLevel | null;
    min_grade?: number | null;
    max_grade?: number | null;
    pathway?: LearningAreaPathway | null;
    is_core?: boolean;
    ip?: string | null;
  },
): Promise<PublicLearningArea> {
  const prov = await tx.query<{ source_kind: string }>(
    `SELECT source_kind FROM curriculum_provenance WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.provenance_id],
  );
  if (prov.rowCount === 0) {
    throw validationError("provenance_id must be school provenance in this school, not an official catalogue");
  }
  if (prov.rows[0]!.source_kind === "platform_reference") {
    throw validationError("Official catalogue provenance cannot be attached by this API");
  }
  const code = trim(input.code, "code", 32);
  const name = trim(input.name, "name", 120);
  const education_level = input.education_level ?? null;
  const pathway = input.pathway ?? null;
  if (pathway != null && education_level !== "senior_school") {
    throw validationError("pathway is only valid for senior_school learning areas");
  }
  const min_grade = input.min_grade ?? null;
  const max_grade = input.max_grade ?? null;
  if ((min_grade == null) !== (max_grade == null)) {
    throw validationError("min_grade and max_grade must both be set or both omitted");
  }
  if (min_grade != null && max_grade != null) {
    if (!Number.isInteger(min_grade) || !Number.isInteger(max_grade) || min_grade < 1 || max_grade > 12 || min_grade > max_grade) {
      throw validationError("min_grade and max_grade must be integers 1–12 with min_grade <= max_grade");
    }
  }
  try {
    const res = await tx.query<LearningAreaRow>(
      `INSERT INTO learning_areas
         (tenant_id, provenance_id, code, name, education_level, min_grade, max_grade, pathway, is_core, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${LEARNING_AREA_COLS}`,
      [
        input.tenantId,
        input.provenance_id,
        code,
        name,
        education_level,
        min_grade,
        max_grade,
        pathway,
        input.is_core ?? false,
        input.actorUserId,
      ],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "academics.cbe.learning_area.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { learningAreaId: row.id, provenanceId: row.provenance_id, sourceKind: prov.rows[0]!.source_kind },
      ip: input.ip,
    });
    return mapLearningArea(row);
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("A learning area with this code already exists");
    if (pgCode(err) === "23503") throw validationError("provenance_id must belong to this school");
    if (pgCode(err) === "23514") throw validationError("learning area level, pathway or grade band is invalid");
    throw err;
  }
}

export async function listLearningAreas(tx: Tx, input: { tenantId: string; page: PageInput; id?: string }): Promise<Page<PublicLearningArea>> {
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT ${LEARNING_AREA_COLS}
       FROM learning_areas WHERE tenant_id = $1`,
    [input.tenantId],
    { name: "learning_areas", expr: "lower(q.name)", type: "text", dir: "asc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as LearningAreaRow[]).map(mapLearningArea);
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getLearningAreaById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listLearningAreas(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

async function requireLearningArea(tx: Tx, tenantId: string, id: string): Promise<void> {
  const res = await tx.query(`SELECT id FROM learning_areas WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (res.rowCount === 0) throw notFound("Learning area not found");
}

export async function createStrand(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; learning_area_id: string; code: string; name: string; ip?: string | null },
) {
  await requireLearningArea(tx, input.tenantId, input.learning_area_id);
  const code = trim(input.code, "code", 32);
  const name = trim(input.name, "name", 160);
  try {
    const res = await tx.query<{ id: string; tenant_id: string; learning_area_id: string; code: string; name: string; created_at: Date | string }>(
      `INSERT INTO strands (tenant_id, learning_area_id, code, name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, learning_area_id, code, name, created_at`,
      [input.tenantId, input.learning_area_id, code, name],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "academics.cbe.strand.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { strandId: row.id, learningAreaId: row.learning_area_id },
      ip: input.ip,
    });
    // Same shape as the strand list (no raw tenant_id column in the response).
    return {
      id: row.id,
      tenantId: row.tenant_id,
      learning_area_id: row.learning_area_id,
      code: row.code,
      name: row.name,
      created_at: isoStamp(row.created_at),
    };
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("A strand with this code already exists in the learning area");
    throw err;
  }
}

export async function listStrands(tx: Tx, input: { tenantId: string; learningAreaId?: string; page: PageInput; id?: string }) {
  const params: unknown[] = [input.tenantId];
  const extra = input.learningAreaId ? " AND learning_area_id = $2" : "";
  if (input.learningAreaId) params.push(input.learningAreaId);
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, learning_area_id, code, name, created_at
       FROM strands WHERE tenant_id = $1${extra}`,
    params,
    { name: "strands", expr: "lower(q.name)", type: "text", dir: "asc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{ id: string; tenant_id: string; learning_area_id: string; code: string; name: string; created_at: Date | string }>).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    learning_area_id: row.learning_area_id,
    code: row.code,
    name: row.name,
    created_at: isoStamp(row.created_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getStrandById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listStrands(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

export async function createSubStrand(
  tx: Tx,
  input: { tenantId: string; strand_id: string; code: string; name: string },
) {
  const strand = await tx.query(`SELECT id FROM strands WHERE tenant_id = $1 AND id = $2`, [input.tenantId, input.strand_id]);
  if (strand.rowCount === 0) throw notFound("Strand not found");
  const code = trim(input.code, "code", 32);
  const name = trim(input.name, "name", 160);
  try {
    const res = await tx.query<{ id: string; tenant_id: string; strand_id: string; code: string; name: string; created_at: Date | string }>(
      `INSERT INTO sub_strands (tenant_id, strand_id, code, name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, strand_id, code, name, created_at`,
      [input.tenantId, input.strand_id, code, name],
    );
    const row = res.rows[0]!;
    return { id: row.id, tenantId: row.tenant_id, strand_id: row.strand_id, code: row.code, name: row.name, created_at: isoStamp(row.created_at) };
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("A sub-strand with this code already exists");
    throw err;
  }
}

export async function listSubStrands(tx: Tx, input: { tenantId: string; strandId?: string; page: PageInput; id?: string }) {
  const params: unknown[] = [input.tenantId];
  const extra = input.strandId ? " AND strand_id = $2" : "";
  if (input.strandId) params.push(input.strandId);
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, strand_id, code, name, created_at FROM sub_strands WHERE tenant_id = $1${extra}`,
    params,
    { name: "sub_strands", expr: "lower(q.name)", type: "text", dir: "asc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{ id: string; tenant_id: string; strand_id: string; code: string; name: string; created_at: Date | string }>).map((row) => ({
    id: row.id, tenantId: row.tenant_id, strand_id: row.strand_id, code: row.code, name: row.name, created_at: isoStamp(row.created_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getSubStrandById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listSubStrands(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

export async function createLearningOutcome(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; sub_strand_id: string; code: string; statement: string; ip?: string | null },
) {
  const parent = await tx.query(`SELECT id FROM sub_strands WHERE tenant_id = $1 AND id = $2`, [input.tenantId, input.sub_strand_id]);
  if (parent.rowCount === 0) throw notFound("Sub-strand not found");
  const code = trim(input.code, "code", 32);
  const statement = trim(input.statement, "statement", 500);
  try {
    const res = await tx.query<{ id: string; tenant_id: string; sub_strand_id: string; code: string; statement: string; created_at: Date | string }>(
      `INSERT INTO learning_outcomes (tenant_id, sub_strand_id, code, statement)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, sub_strand_id, code, statement, created_at`,
      [input.tenantId, input.sub_strand_id, code, statement],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "academics.cbe.outcome.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { learningOutcomeId: row.id, subStrandId: row.sub_strand_id },
      ip: input.ip,
    });
    return { id: row.id, tenantId: row.tenant_id, sub_strand_id: row.sub_strand_id, code: row.code, statement: row.statement, created_at: isoStamp(row.created_at) };
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("A learning outcome with this code already exists");
    throw err;
  }
}

export async function listLearningOutcomes(tx: Tx, input: { tenantId: string; subStrandId?: string; page: PageInput; id?: string }) {
  const params: unknown[] = [input.tenantId];
  const extra = input.subStrandId ? " AND sub_strand_id = $2" : "";
  if (input.subStrandId) params.push(input.subStrandId);
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, sub_strand_id, code, statement, created_at
       FROM learning_outcomes WHERE tenant_id = $1${extra}`,
    params,
    { name: "learning_outcomes", expr: "lower(q.code)", type: "text", dir: "asc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{ id: string; tenant_id: string; sub_strand_id: string; code: string; statement: string; created_at: Date | string }>).map((row) => ({
    id: row.id, tenantId: row.tenant_id, sub_strand_id: row.sub_strand_id, code: row.code, statement: row.statement, created_at: isoStamp(row.created_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getLearningOutcomeById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listLearningOutcomes(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

export interface RubricDescriptor {
  level_code: string;
  label: string;
  /** Present for numerical rubrics; may be 0 for level_only instruments. */
  points: number;
}

export type RubricScoringMode = "numerical" | "level_only";

export function parseDescriptors(value: unknown, scoringMode: RubricScoringMode = "numerical"): RubricDescriptor[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw validationError("descriptors must be a non-empty array of {level_code, label, points}");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw validationError("each descriptor needs level_code, label and points");
    const raw = item as { level_code?: unknown; label?: unknown; points?: unknown };
    if (typeof raw.level_code !== "string" || typeof raw.label !== "string") {
      throw validationError("each descriptor needs level_code and label");
    }
    const level_code = trim(raw.level_code, "level_code", 16);
    const label = trim(raw.label, "label", 80);
    let points = 0;
    if (scoringMode === "numerical") {
      if (typeof raw.points !== "number" || !Number.isFinite(raw.points) || raw.points < 0 || raw.points > 1000) {
        throw validationError("points must be between 0 and 1000 for numerical rubrics");
      }
      points = raw.points;
    } else if (raw.points !== undefined && raw.points !== null) {
      if (typeof raw.points !== "number" || !Number.isFinite(raw.points) || raw.points < 0 || raw.points > 1000) {
        throw validationError("points must be between 0 and 1000 when provided");
      }
      points = raw.points;
    }
    if (seen.has(level_code)) throw validationError("descriptor level_code values must be unique");
    seen.add(level_code);
    return { level_code, label, points };
  });
}

export interface RubricCriterion {
  code: string;
  title: string;
  max_points?: number | null;
}

export interface CriterionScore {
  criterion_code: string;
  level_code: string;
  points?: number | null;
  comment?: string | null;
}

function parseCriteria(raw: unknown): RubricCriterion[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length === 0) throw validationError("criteria must be a non-empty array when provided");
  const seen = new Set<string>();
  return raw.map((item) => {
    if (!item || typeof item !== "object") throw validationError("each criterion must be an object");
    const c = item as Record<string, unknown>;
    if (typeof c.code !== "string" || typeof c.title !== "string") {
      throw validationError("each criterion needs code and title");
    }
    const code = trim(c.code, "criterion.code", 40);
    const title = trim(c.title, "criterion.title", 160);
    if (seen.has(code)) throw validationError("criterion code values must be unique");
    seen.add(code);
    let max_points: number | null = null;
    if (c.max_points !== undefined && c.max_points !== null) {
      if (typeof c.max_points !== "number" || !Number.isFinite(c.max_points) || c.max_points <= 0 || c.max_points > 1000) {
        throw validationError("criterion max_points must be > 0 and <= 1000");
      }
      max_points = c.max_points;
    }
    return { code, title, ...(max_points === null ? {} : { max_points }) };
  });
}

export async function createRubricConfig(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    name: string;
    version?: number;
    descriptors: unknown;
    scoring_mode?: RubricScoringMode;
    criteria?: unknown;
    ip?: string | null;
  },
) {
  const name = trim(input.name, "name", 80);
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw validationError("version must be an integer >= 1");
  const scoring_mode: RubricScoringMode = input.scoring_mode ?? "numerical";
  if (scoring_mode !== "numerical" && scoring_mode !== "level_only") {
    throw validationError("scoring_mode must be numerical or level_only");
  }
  const descriptors = parseDescriptors(input.descriptors, scoring_mode);
  const criteria = parseCriteria(input.criteria);
  try {
    const res = await tx.query<{
      id: string;
      tenant_id: string;
      name: string;
      version: number;
      scoring_mode: RubricScoringMode;
      descriptors: RubricDescriptor[];
      criteria: RubricCriterion[] | null;
      created_at: Date | string;
    }>(
      `INSERT INTO rubric_descriptor_configs (tenant_id, name, version, scoring_mode, descriptors, criteria, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING id, tenant_id, name, version, scoring_mode, descriptors, criteria, created_at`,
      [
        input.tenantId,
        name,
        version,
        scoring_mode,
        JSON.stringify(descriptors),
        criteria ? JSON.stringify(criteria) : null,
        input.actorUserId,
      ],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "academics.cbe.rubric_config.upserted",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { rubricConfigId: row.id, version: row.version, scoringMode: row.scoring_mode },
      ip: input.ip,
    });
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      version: row.version,
      scoring_mode: row.scoring_mode,
      descriptors: row.descriptors,
      criteria: row.criteria,
      created_at: isoStamp(row.created_at),
    };
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("A rubric config with this name and version already exists");
    throw err;
  }
}

export async function listRubricConfigs(tx: Tx, input: { tenantId: string; page: PageInput; id?: string }) {
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, name, version, scoring_mode, descriptors, criteria, created_at
       FROM rubric_descriptor_configs WHERE tenant_id = $1`,
    [input.tenantId],
    { name: "rubric_configs", expr: "lower(q.name)", type: "text", dir: "asc" },
    input.page,
    input.id,
  );
  const items = (
    res.rows as unknown as Array<{
      id: string;
      tenant_id: string;
      name: string;
      version: number;
      scoring_mode: RubricScoringMode;
      descriptors: RubricDescriptor[];
      criteria: RubricCriterion[] | null;
      created_at: Date | string;
    }>
  ).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    version: row.version,
    scoring_mode: row.scoring_mode,
    descriptors: row.descriptors,
    criteria: row.criteria,
    created_at: isoStamp(row.created_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getRubricConfigById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listRubricConfigs(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

export const CBE_INSTRUMENT_TYPES = [
  "test",
  "observation",
  "checklist",
  "quiz",
  "rubric",
  "journal",
  "portfolio",
  "learner_profile",
  "anecdotal",
  "rating_scale",
  "project",
] as const;
export type CbeInstrumentType = (typeof CBE_INSTRUMENT_TYPES)[number];
export type CbeAssessmentStatus = "draft" | "published" | "closed";

const CBE_ASSESSMENT_COLS = `id, tenant_id, class_id, learning_area_id, term_id, rubric_config_id, title,
  status, instrument_type, assessment_date, instructions, strand_id, sub_strand_id, learning_outcome_id,
  curriculum_version_label, published_at, closed_at, row_version, created_at`;

type CbeAssessmentRow = {
  id: string;
  tenant_id: string;
  class_id: string;
  learning_area_id: string;
  term_id: string;
  rubric_config_id: string | null;
  title: string;
  status: CbeAssessmentStatus;
  instrument_type: CbeInstrumentType;
  assessment_date: Date | string | null;
  instructions: string | null;
  strand_id: string | null;
  sub_strand_id: string | null;
  learning_outcome_id: string | null;
  curriculum_version_label: string | null;
  published_at: Date | string | null;
  closed_at: Date | string | null;
  row_version: number;
  created_at: Date | string;
};

export interface PublicCbeAssessment {
  id: string;
  tenantId: string;
  class_id: string;
  learning_area_id: string;
  term_id: string;
  rubric_config_id: string | null;
  title: string;
  status: CbeAssessmentStatus;
  instrument_type: CbeInstrumentType;
  assessment_date: string | null;
  instructions: string | null;
  strand_id: string | null;
  sub_strand_id: string | null;
  learning_outcome_id: string | null;
  curriculum_version_label: string | null;
  published_at: string | null;
  closed_at: string | null;
  row_version: number;
  created_at: string;
}

function mapCbeAssessment(row: CbeAssessmentRow): PublicCbeAssessment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    class_id: row.class_id,
    learning_area_id: row.learning_area_id,
    term_id: row.term_id,
    rubric_config_id: row.rubric_config_id,
    title: row.title,
    status: row.status,
    instrument_type: row.instrument_type,
    assessment_date: row.assessment_date
      ? typeof row.assessment_date === "string"
        ? row.assessment_date.slice(0, 10)
        : `${row.assessment_date.getFullYear()}-${String(row.assessment_date.getMonth() + 1).padStart(2, "0")}-${String(row.assessment_date.getDate()).padStart(2, "0")}`
      : null,
    instructions: row.instructions,
    strand_id: row.strand_id,
    sub_strand_id: row.sub_strand_id,
    learning_outcome_id: row.learning_outcome_id,
    curriculum_version_label: row.curriculum_version_label,
    published_at: row.published_at ? isoStamp(row.published_at) : null,
    closed_at: row.closed_at ? isoStamp(row.closed_at) : null,
    row_version: row.row_version,
    created_at: isoStamp(row.created_at),
  };
}

export async function createCbeAssessment(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    class_id: string;
    learning_area_id: string;
    term_id: string;
    title: string;
    rubric_config_id?: string | null;
    instrument_type?: CbeInstrumentType;
    assessment_date?: string | null;
    instructions?: string | null;
    strand_id?: string | null;
    sub_strand_id?: string | null;
    learning_outcome_id?: string | null;
    curriculum_version_label?: string | null;
    ip?: string | null;
  },
): Promise<PublicCbeAssessment> {
  await getClassById(tx, { tenantId: input.tenantId, classId: input.class_id });
  await requireLearningArea(tx, input.tenantId, input.learning_area_id);
  await getTermById(tx, { tenantId: input.tenantId, termId: input.term_id });
  if (input.rubric_config_id) {
    const rubric = await tx.query(`SELECT 1 FROM rubric_descriptor_configs WHERE tenant_id = $1 AND id = $2`, [
      input.tenantId,
      input.rubric_config_id,
    ]);
    if (rubric.rowCount === 0) throw validationError("rubric_config_id must belong to this school");
  }
  const instrument_type = input.instrument_type ?? "rubric";
  if (!(CBE_INSTRUMENT_TYPES as readonly string[]).includes(instrument_type)) {
    throw validationError("instrument_type is not supported");
  }
  const title = trim(input.title, "title", 160);
  const instructions =
    input.instructions === undefined || input.instructions === null || input.instructions.trim() === ""
      ? null
      : input.instructions.trim();
  if (instructions && instructions.length > 4000) throw validationError("instructions must be at most 4000 characters");
  const curriculum_version_label =
    input.curriculum_version_label === undefined ||
    input.curriculum_version_label === null ||
    input.curriculum_version_label.trim() === ""
      ? null
      : trim(input.curriculum_version_label, "curriculum_version_label", 80);
  if (input.strand_id || input.learning_outcome_id || input.sub_strand_id) {
    const scope = await tx.query<{ ok: boolean }>(
      `SELECT (
          ($3::uuid IS NULL OR EXISTS (
            SELECT 1 FROM strands s WHERE s.tenant_id = $1 AND s.id = $3 AND s.learning_area_id = $2))
          AND ($4::uuid IS NULL OR EXISTS (
            SELECT 1 FROM sub_strands ss
              JOIN strands s ON s.tenant_id = ss.tenant_id AND s.id = ss.strand_id
             WHERE ss.tenant_id = $1 AND ss.id = $4 AND s.learning_area_id = $2
               AND ($3::uuid IS NULL OR s.id = $3)))
          AND ($5::uuid IS NULL OR EXISTS (
            SELECT 1 FROM learning_outcomes o
              JOIN sub_strands ss ON ss.tenant_id = o.tenant_id AND ss.id = o.sub_strand_id
              JOIN strands s ON s.tenant_id = ss.tenant_id AND s.id = ss.strand_id
             WHERE o.tenant_id = $1 AND o.id = $5 AND s.learning_area_id = $2
               AND ($3::uuid IS NULL OR s.id = $3)
               AND ($4::uuid IS NULL OR ss.id = $4)))
        ) AS ok`,
      [
        input.tenantId,
        input.learning_area_id,
        input.strand_id ?? null,
        input.sub_strand_id ?? null,
        input.learning_outcome_id ?? null,
      ],
    );
    if (!scope.rows[0]?.ok) {
      throw validationError("strand_id, sub_strand_id and learning_outcome_id must belong to the learning area");
    }
  }
  const res = await tx.query<CbeAssessmentRow>(
    `INSERT INTO cbe_assessments
       (tenant_id, class_id, learning_area_id, term_id, rubric_config_id, title, created_by,
        instrument_type, assessment_date, instructions, strand_id, sub_strand_id, learning_outcome_id,
        curriculum_version_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12, $13, $14)
     RETURNING ${CBE_ASSESSMENT_COLS}`,
    [
      input.tenantId,
      input.class_id,
      input.learning_area_id,
      input.term_id,
      input.rubric_config_id ?? null,
      title,
      input.actorUserId,
      instrument_type,
      input.assessment_date ?? null,
      instructions,
      input.strand_id ?? null,
      input.sub_strand_id ?? null,
      input.learning_outcome_id ?? null,
      curriculum_version_label,
    ],
  );
  return mapCbeAssessment(res.rows[0]!);
}

export async function listCbeAssessments(
  tx: Tx,
  input: {
    tenantId: string;
    classId?: string;
    scopeClassIds?: readonly string[] | null;
    page: PageInput;
    id?: string;
  },
) {
  const params: unknown[] = [input.tenantId];
  const parts = ["tenant_id = $1"];
  if (input.classId) {
    params.push(input.classId);
    parts.push(`class_id = $${params.length}`);
  }
  if (input.scopeClassIds) {
    params.push(input.scopeClassIds);
    parts.push(`class_id = ANY($${params.length}::uuid[])`);
  }
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT ${CBE_ASSESSMENT_COLS} FROM cbe_assessments WHERE ${parts.join(" AND ")}`,
    params,
    { name: "cbe_assessments", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
    input.id,
  );
  return { items: (res.rows as unknown as CbeAssessmentRow[]).map(mapCbeAssessment), page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getCbeAssessmentById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listCbeAssessments(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

/** OD-2 / A9-9: assessment or null when missing / outside teacher class scope. */
export async function findCbeAssessmentInScope(
  tx: Tx,
  input: { tenantId: string; id: string; scopeClassIds: readonly string[] | null },
): Promise<PublicCbeAssessment | null> {
  const res = await tx.query<CbeAssessmentRow>(
    `SELECT ${CBE_ASSESSMENT_COLS} FROM cbe_assessments
      WHERE tenant_id = $1 AND id = $2 AND ($3::uuid[] IS NULL OR class_id = ANY($3::uuid[]))`,
    [input.tenantId, input.id, input.scopeClassIds],
  );
  return res.rows[0] ? mapCbeAssessment(res.rows[0]) : null;
}

export async function publishCbeAssessment(
  tx: Tx,
  input: { tenantId: string; id: string; actorUserId: string; ip?: string | null },
): Promise<PublicCbeAssessment> {
  const res = await tx.query<CbeAssessmentRow>(
    `UPDATE cbe_assessments
        SET status = 'published', published_at = now(), row_version = row_version + 1
      WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
      RETURNING ${CBE_ASSESSMENT_COLS}`,
    [input.tenantId, input.id],
  );
  const row = res.rows[0];
  if (!row) {
    const existing = await getCbeAssessmentById(tx, { tenantId: input.tenantId, id: input.id });
    if (!existing) throw notFound("CBE assessment not found");
    throw conflict("Only a draft CBE assessment can be published");
  }
  await recordSecurityEvent(tx, {
    eventType: "academics.cbe.assessment.published",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { cbeAssessmentId: row.id, rowVersion: row.row_version },
    ip: input.ip,
  });
  return mapCbeAssessment(row);
}

export async function closeCbeAssessment(
  tx: Tx,
  input: { tenantId: string; id: string; actorUserId: string; ip?: string | null },
): Promise<PublicCbeAssessment> {
  const res = await tx.query<CbeAssessmentRow>(
    `UPDATE cbe_assessments
        SET status = 'closed', closed_at = now(), row_version = row_version + 1
      WHERE tenant_id = $1 AND id = $2 AND status = 'published'
      RETURNING ${CBE_ASSESSMENT_COLS}`,
    [input.tenantId, input.id],
  );
  const row = res.rows[0];
  if (!row) {
    const existing = await getCbeAssessmentById(tx, { tenantId: input.tenantId, id: input.id });
    if (!existing) throw notFound("CBE assessment not found");
    throw conflict("Only a published CBE assessment can be closed");
  }
  await recordSecurityEvent(tx, {
    eventType: "academics.cbe.assessment.closed",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { cbeAssessmentId: row.id, rowVersion: row.row_version },
    ip: input.ip,
  });
  return mapCbeAssessment(row);
}

export async function recordCbeResult(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    cbeAssessmentId: string;
    learner_id: string;
    strand_id?: string | null;
    learning_outcome_id?: string | null;
    level_code: string;
    points?: number | null;
    observation?: string | null;
    teacher_feedback?: string | null;
    evidence_asset_id?: string | null;
    completion_status?: "recorded" | "reviewed" | "finalized";
    criterion_scores?: CriterionScore[] | null;
    /** OD-3: required (and must equal the current version) to change an existing result. */
    row_version?: number | null;
    /** OD-3: required to change an existing result (5–500 characters). */
    reason?: string | null;
    ip?: string | null;
  },
): Promise<{ result: PublicCbeResult; outcome: "created" | "revised" | "unchanged"; ref: { type: string; id: string } }> {
  if (!input.strand_id && !input.learning_outcome_id) {
    throw validationError("strand_id or learning_outcome_id is required");
  }
  const assessment = await tx.query<{
    rubric_config_id: string | null;
    class_id: string;
    learning_area_id: string;
    status: CbeAssessmentStatus;
  }>(
    `SELECT rubric_config_id, class_id, learning_area_id, status FROM cbe_assessments WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.cbeAssessmentId],
  );
  if (assessment.rowCount === 0) throw notFound("CBE assessment not found");
  if (assessment.rows[0]!.status === "closed") {
    throw conflict("Closed CBE assessments do not accept result changes");
  }
  // Review A9-3: the strand / outcome must sit under the assessment's learning area (and an outcome
  // under the named strand), and the learner must be a member of the assessment's class.
  const scope = await tx.query<{ strand_ok: boolean; outcome_ok: boolean; member: boolean }>(
    `SELECT ($3::uuid IS NULL OR EXISTS (
              SELECT 1 FROM strands s WHERE s.tenant_id = $1 AND s.id = $3 AND s.learning_area_id = $2)) AS strand_ok,
            ($4::uuid IS NULL OR EXISTS (
              SELECT 1 FROM learning_outcomes o
                JOIN sub_strands ss ON ss.tenant_id = o.tenant_id AND ss.id = o.sub_strand_id
                JOIN strands s ON s.tenant_id = ss.tenant_id AND s.id = ss.strand_id
               WHERE o.tenant_id = $1 AND o.id = $4 AND s.learning_area_id = $2
                 AND ($3::uuid IS NULL OR s.id = $3))) AS outcome_ok,
            EXISTS (SELECT 1 FROM class_memberships cm
                     WHERE cm.tenant_id = $1 AND cm.learner_id = $5 AND cm.class_id = $6) AS member`,
    [
      input.tenantId,
      assessment.rows[0]!.learning_area_id,
      input.strand_id ?? null,
      input.learning_outcome_id ?? null,
      input.learner_id,
      assessment.rows[0]!.class_id,
    ],
  );
  if (!scope.rows[0]?.strand_ok) throw validationError("strand_id must belong to the assessment's learning area");
  if (!scope.rows[0]?.outcome_ok) {
    throw validationError("learning_outcome_id must belong to the assessment's learning area (and strand_id, if given)");
  }
  if (!scope.rows[0]?.member) throw validationError("learner_id is not a member of the assessment's class");
  const level_code = trim(input.level_code, "level_code", 16);
  let points = input.points ?? null;
  const criterionScores = input.criterion_scores ?? null;
  if (assessment.rows[0]!.rubric_config_id) {
    const rubric = await tx.query<{
      descriptors: RubricDescriptor[];
      scoring_mode: RubricScoringMode;
      criteria: RubricCriterion[] | null;
    }>(
      `SELECT descriptors, scoring_mode, criteria FROM rubric_descriptor_configs WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, assessment.rows[0]!.rubric_config_id],
    );
    const match = rubric.rows[0]?.descriptors.find((d) => d.level_code === level_code);
    if (!match) throw validationError("level_code is not in the rubric config");
    if (criterionScores && rubric.rows[0]?.criteria) {
      const allowedCriteria = new Map(rubric.rows[0].criteria.map((c) => [c.code, c]));
      const allowedLevels = new Set(rubric.rows[0].descriptors.map((d) => d.level_code));
      for (const cs of criterionScores) {
        const cDef = allowedCriteria.get(cs.criterion_code);
        if (!cDef) throw validationError(`Unknown criterion_code '${cs.criterion_code}' for this rubric`);
        if (!allowedLevels.has(cs.level_code)) throw validationError(`Unknown level_code '${cs.level_code}' in criterion_scores`);
        if (cs.points !== undefined && cs.points !== null && cDef.max_points !== undefined && cDef.max_points !== null && cs.points > cDef.max_points) {
          throw validationError(`Criterion '${cs.criterion_code}' points exceed max_points (${cDef.max_points})`);
        }
      }
    }
    if (rubric.rows[0]!.scoring_mode === "level_only") {
      if (points === null || points === undefined) points = match.points;
      else if (points !== match.points) throw validationError("points must match the rubric descriptor");
    } else {
      if (points === null || points === undefined) throw validationError("points is required for numerical rubrics");
      if (match.points !== points) throw validationError("points must match the rubric descriptor");
    }
  } else {
    if (points === null || points === undefined) throw validationError("points is required when no rubric is attached");
    if (!(points >= 0) || points > 1000) throw validationError("points must be between 0 and 1000");
  }
  const observation =
    input.observation === undefined || input.observation === null || input.observation.trim() === ""
      ? null
      : input.observation.trim();
  if (observation && observation.length > 4000) throw validationError("observation must be at most 4000 characters");
  const teacher_feedback =
    input.teacher_feedback === undefined || input.teacher_feedback === null || input.teacher_feedback.trim() === ""
      ? null
      : input.teacher_feedback.trim();
  if (teacher_feedback && teacher_feedback.length > 4000) {
    throw validationError("teacher_feedback must be at most 4000 characters");
  }
  const completion_status = input.completion_status ?? "recorded";
  if (!["recorded", "reviewed", "finalized"].includes(completion_status)) {
    throw validationError("completion_status must be recorded, reviewed or finalized");
  }
  if (input.evidence_asset_id) {
    const evidence = await tx.query(`SELECT 1 FROM evidence_assets WHERE tenant_id = $1 AND id = $2`, [
      input.tenantId,
      input.evidence_asset_id,
    ]);
    if (evidence.rowCount === 0) throw validationError("evidence_asset_id must belong to this school");
  }
  const learner = await tx.query(`SELECT id FROM learners WHERE tenant_id = $1 AND id = $2 AND active = true`, [
    input.tenantId,
    input.learner_id,
  ]);
  if (learner.rowCount === 0) throw validationError("learner_id must be an active learner in this school");
  const strandId = input.strand_id ?? null;
  const outcomeId = input.learning_outcome_id ?? null;
  const evidenceId = input.evidence_asset_id ?? null;
  // OD-3: one current result per (assessment, learner, strand, outcome); unique index in migration 035.
  const current = await tx.query<CbeResultRow>(
    `SELECT ${CBE_RESULT_COLS} FROM cbe_results
      WHERE tenant_id = $1 AND cbe_assessment_id = $2 AND learner_id = $3
        AND strand_id IS NOT DISTINCT FROM $4::uuid AND learning_outcome_id IS NOT DISTINCT FROM $5::uuid
      FOR UPDATE`,
    [input.tenantId, input.cbeAssessmentId, input.learner_id, strandId, outcomeId],
  );
  const existing = current.rows[0];
  try {
    if (!existing) {
      if (input.row_version !== undefined && input.row_version !== null && input.row_version !== 0) {
        throw conflict("The result was changed by someone else");
      }
      const res = await tx.query<CbeResultRow>(
        `INSERT INTO cbe_results
           (tenant_id, cbe_assessment_id, learner_id, strand_id, learning_outcome_id, level_code, points, marked_by,
            observation, teacher_feedback, evidence_asset_id, completion_status, criterion_scores)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
         RETURNING ${CBE_RESULT_COLS}`,
        [
          input.tenantId,
          input.cbeAssessmentId,
          input.learner_id,
          strandId,
          outcomeId,
          level_code,
          points,
          input.actorUserId,
          observation,
          teacher_feedback,
          evidenceId,
          completion_status,
          criterionScores ? JSON.stringify(criterionScores) : null,
        ],
      );
      const row = res.rows[0]!;
      await recordSecurityEvent(tx, {
        eventType: "academics.cbe.result.recorded",
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        detail: { resultId: row.id, cbeAssessmentId: row.cbe_assessment_id, learnerId: row.learner_id },
        ip: input.ip,
      });
      return { result: mapCbeResult(row), outcome: "created", ref: { type: "cbe_result", id: row.id } };
    }
    const same = await tx.query<{ same: boolean }>(`SELECT ($1::numeric = $2::numeric) AS same`, [existing.points, points]);
    if (
      existing.level_code === level_code &&
      same.rows[0]?.same &&
      (existing.observation ?? null) === observation &&
      (existing.teacher_feedback ?? null) === teacher_feedback &&
      (existing.evidence_asset_id ?? null) === evidenceId &&
      existing.completion_status === completion_status &&
      JSON.stringify(existing.criterion_scores ?? null) === JSON.stringify(criterionScores)
    ) {
      // A retry of the same result is safe: nothing changes and nothing is audited as a change.
      return { result: mapCbeResult(existing), outcome: "unchanged", ref: await cbeResultRef(tx, input.tenantId, existing) };
    }
    if (input.row_version === undefined || input.row_version === null || input.row_version !== existing.row_version) {
      throw conflict("A result already exists. Send its row_version and a reason to change it.");
    }
    const reason = (input.reason ?? "").trim();
    if (reason.length < 5 || reason.length > 500) throw validationError("reason must be 5–500 characters to change a result");
    const revision = await tx.query<{ id: string }>(
      `INSERT INTO cbe_result_revisions
         (tenant_id, result_id, previous_level_code, previous_points, new_level_code, new_points,
          resulting_row_version, reason, revised_by,
          previous_observation, new_observation, previous_teacher_feedback, new_teacher_feedback,
          previous_evidence_asset_id, new_evidence_asset_id, previous_completion_status, new_completion_status,
          previous_criterion_scores, new_criterion_scores)
       VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb)
       RETURNING id`,
      [
        input.tenantId,
        existing.id,
        existing.level_code,
        existing.points,
        level_code,
        points,
        existing.row_version + 1,
        reason,
        input.actorUserId,
        existing.observation,
        observation,
        existing.teacher_feedback,
        teacher_feedback,
        existing.evidence_asset_id,
        evidenceId,
        existing.completion_status,
        completion_status,
        existing.criterion_scores ? JSON.stringify(existing.criterion_scores) : null,
        criterionScores ? JSON.stringify(criterionScores) : null,
      ],
    );
    const updated = await tx.query<CbeResultRow>(
      `UPDATE cbe_results
          SET level_code = $3, points = $4, marked_at = now(), marked_by = $5, row_version = row_version + 1,
              observation = $6, teacher_feedback = $7, evidence_asset_id = $8, completion_status = $9,
              criterion_scores = $10::jsonb
        WHERE id = $1 AND row_version = $2
        RETURNING ${CBE_RESULT_COLS}`,
      [
        existing.id,
        existing.row_version,
        level_code,
        points,
        input.actorUserId,
        observation,
        teacher_feedback,
        evidenceId,
        completion_status,
        criterionScores ? JSON.stringify(criterionScores) : null,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw conflict("The result was changed by someone else");
    // Audit: ids and versions only; values and the free-text reason live in cbe_result_revisions.
    await recordSecurityEvent(tx, {
      eventType: "academics.cbe.result.revised",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { resultId: row.id, revisionId: revision.rows[0]!.id, fromRowVersion: existing.row_version, toRowVersion: row.row_version },
      ip: input.ip,
    });
    return { result: mapCbeResult(row), outcome: "revised", ref: { type: "cbe_result_revision", id: revision.rows[0]!.id } };
  } catch (err) {
    const code = pgCode(err);
    if (code === "23505" || code === "FB409") throw conflict("The result was changed by someone else");
    if (code === "23503") throw validationError("Strand, outcome or learner must belong to this school");
    throw err;
  }
}

export interface PublicCbeResult {
  id: string;
  tenantId: string;
  cbe_assessment_id: string;
  learner_id: string;
  strand_id: string | null;
  learning_outcome_id: string | null;
  level_code: string;
  points: string;
  observation: string | null;
  teacher_feedback: string | null;
  evidence_asset_id: string | null;
  completion_status: "recorded" | "reviewed" | "finalized";
  criterion_scores: CriterionScore[] | null;
  marked_at: string;
  marked_by: string | null;
  row_version: number;
}

type CbeResultRow = {
  id: string;
  tenant_id: string;
  cbe_assessment_id: string;
  learner_id: string;
  strand_id: string | null;
  learning_outcome_id: string | null;
  level_code: string;
  points: string;
  observation: string | null;
  teacher_feedback: string | null;
  evidence_asset_id: string | null;
  completion_status: "recorded" | "reviewed" | "finalized";
  criterion_scores: CriterionScore[] | null;
  marked_at: Date | string;
  marked_by: string | null;
  row_version: number;
};

const CBE_RESULT_COLS = `id, tenant_id, cbe_assessment_id, learner_id, strand_id, learning_outcome_id,
  level_code, points::text AS points, observation, teacher_feedback, evidence_asset_id, completion_status,
  criterion_scores, marked_at, marked_by, row_version`;

function mapCbeResult(row: CbeResultRow): PublicCbeResult {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    cbe_assessment_id: row.cbe_assessment_id,
    learner_id: row.learner_id,
    strand_id: row.strand_id,
    learning_outcome_id: row.learning_outcome_id,
    level_code: row.level_code,
    points: row.points,
    observation: row.observation,
    teacher_feedback: row.teacher_feedback,
    evidence_asset_id: row.evidence_asset_id,
    completion_status: row.completion_status,
    criterion_scores: row.criterion_scores,
    marked_at: isoStamp(row.marked_at),
    marked_by: row.marked_by,
    row_version: row.row_version,
  };
}

/** Reference to the result exactly as it stands now: version 1 by result id, later versions by revision id. */
async function cbeResultRef(tx: Tx, tenantId: string, row: CbeResultRow): Promise<{ type: string; id: string }> {
  if (row.row_version === 1) return { type: "cbe_result", id: row.id };
  const rev = await tx.query<{ id: string }>(
    `SELECT id FROM cbe_result_revisions WHERE tenant_id = $1 AND result_id = $2 AND resulting_row_version = $3`,
    [tenantId, row.id, row.row_version],
  );
  return { type: "cbe_result_revision", id: rev.rows[0]!.id };
}

/**
 * OD-3 idempotent replay: rebuild the result exactly as the original request returned it, even if it
 * was revised later. `cbe_result` = version 1; `cbe_result_revision` = the version that revision made.
 */
export async function getCbeResultVersion(
  tx: Tx,
  input: { tenantId: string; refType: string; refId: string },
): Promise<PublicCbeResult | null> {
  let resultId: string;
  let version: number;
  if (input.refType === "cbe_result_revision") {
    const rev = await tx.query<{ result_id: string; resulting_row_version: number }>(
      `SELECT result_id, resulting_row_version FROM cbe_result_revisions WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.refId],
    );
    if (!rev.rows[0]) return null;
    resultId = rev.rows[0].result_id;
    version = rev.rows[0].resulting_row_version;
  } else {
    resultId = input.refId;
    version = 1;
  }
  const cur = await tx.query<CbeResultRow>(`SELECT ${CBE_RESULT_COLS} FROM cbe_results WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    resultId,
  ]);
  const row = cur.rows[0];
  if (!row) return null;
  if (row.row_version === version) return mapCbeResult(row);
  // The state at `version` is the "new" side of the revision that produced it, or (for version 1)
  // the "previous" side of the revision that produced version 2.
  const made = await tx.query<{
    new_level_code: string;
    new_points: string;
    revised_at: Date | string;
    revised_by: string;
    new_observation: string | null;
    new_teacher_feedback: string | null;
    new_evidence_asset_id: string | null;
    new_completion_status: string | null;
  }>(
    `SELECT new_level_code, new_points::text AS new_points, revised_at, revised_by,
            new_observation, new_teacher_feedback, new_evidence_asset_id, new_completion_status
       FROM cbe_result_revisions WHERE tenant_id = $1 AND result_id = $2 AND resulting_row_version = $3`,
    [input.tenantId, resultId, version],
  );
  if (made.rows[0]) {
    const m = made.rows[0];
    return {
      ...mapCbeResult(row),
      level_code: m.new_level_code,
      points: m.new_points,
      observation: m.new_observation,
      teacher_feedback: m.new_teacher_feedback,
      evidence_asset_id: m.new_evidence_asset_id,
      completion_status: (m.new_completion_status ?? row.completion_status) as PublicCbeResult["completion_status"],
      marked_at: isoStamp(m.revised_at),
      marked_by: m.revised_by,
      row_version: version,
    };
  }
  const next = await tx.query<{
    previous_level_code: string;
    previous_points: string;
    previous_marked_at: Date | string;
    previous_marked_by: string | null;
    previous_observation: string | null;
    previous_teacher_feedback: string | null;
    previous_evidence_asset_id: string | null;
    previous_completion_status: string | null;
  }>(
    `SELECT previous_level_code, previous_points::text AS previous_points, previous_marked_at, previous_marked_by,
            previous_observation, previous_teacher_feedback, previous_evidence_asset_id, previous_completion_status
       FROM cbe_result_revisions WHERE tenant_id = $1 AND result_id = $2 AND resulting_row_version = $3`,
    [input.tenantId, resultId, version + 1],
  );
  const n = next.rows[0];
  if (!n) return null;
  return {
    ...mapCbeResult(row),
    level_code: n.previous_level_code,
    points: n.previous_points,
    observation: n.previous_observation,
    teacher_feedback: n.previous_teacher_feedback,
    evidence_asset_id: n.previous_evidence_asset_id,
    completion_status: (n.previous_completion_status ?? row.completion_status) as PublicCbeResult["completion_status"],
    marked_at: isoStamp(n.previous_marked_at),
    marked_by: n.previous_marked_by,
    row_version: version,
  };
}

export async function listCbeResults(tx: Tx, input: { tenantId: string; cbeAssessmentId: string; page: PageInput; id?: string }) {
  const found = await tx.query(`SELECT id FROM cbe_assessments WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.cbeAssessmentId,
  ]);
  if (found.rowCount === 0) throw notFound("CBE assessment not found");
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT ${CBE_RESULT_COLS} FROM cbe_results WHERE tenant_id = $1 AND cbe_assessment_id = $2`,
    [input.tenantId, input.cbeAssessmentId],
    // Keyed by learner, not marked_at: a revision re-stamps marked_at and must not move rows between pages.
    { name: "cbe_results", expr: "q.learner_id::text", type: "text", dir: "asc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as CbeResultRow[]).map(mapCbeResult);
  return { items, page: res.page };
}

export async function registerEvidence(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    provenance_id: string;
    title: string;
    description?: string | null;
    learner_id?: string | null;
    ip?: string | null;
  },
) {
  const prov = await tx.query(`SELECT id FROM curriculum_provenance WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.provenance_id,
  ]);
  if (prov.rowCount === 0) throw validationError("provenance_id must belong to this school");
  const title = trim(input.title, "title", 160);
  const description =
    input.description === undefined || input.description === null || input.description.trim() === ""
      ? null
      : input.description;
  if (description && description.length > 4000) throw validationError("description must be at most 4000 characters");
  if (input.learner_id) {
    // A9-11: an unknown learner is a client error, not a 500 from the foreign key.
    const learner = await tx.query(`SELECT 1 FROM learners WHERE tenant_id = $1 AND id = $2`, [input.tenantId, input.learner_id]);
    if (learner.rowCount === 0) throw validationError("learner_id must belong to this school");
  }
  const res = await tx.query<{
    id: string; tenant_id: string; provenance_id: string; learner_id: string | null;
    title: string; description: string | null; storage_status: "metadata_only"; created_at: Date | string;
  }>(
    `INSERT INTO evidence_assets
       (tenant_id, provenance_id, learner_id, title, description, storage_key, created_by)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     RETURNING id, tenant_id, provenance_id, learner_id, title, description, storage_status, created_at`,
    [input.tenantId, input.provenance_id, input.learner_id ?? null, title, description, input.actorUserId],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "academics.cbe.evidence.registered",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { evidenceId: row.id, provenanceId: row.provenance_id },
    ip: input.ip,
  });
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provenance_id: row.provenance_id,
    learner_id: row.learner_id,
    title: row.title,
    description: row.description,
    storage_status: "metadata_only" as const,
    created_at: isoStamp(row.created_at),
  };
}

export async function listEvidence(tx: Tx, input: { tenantId: string; page: PageInput; id?: string }) {
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, provenance_id, learner_id, title, description, storage_status, created_at
       FROM evidence_assets WHERE tenant_id = $1`,
    [input.tenantId],
    { name: "evidence_assets", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{
    id: string; tenant_id: string; provenance_id: string; learner_id: string | null;
    title: string; description: string | null; storage_status: "metadata_only"; created_at: Date | string;
  }>).map((row) => ({
    id: row.id, tenantId: row.tenant_id, provenance_id: row.provenance_id, learner_id: row.learner_id,
    title: row.title, description: row.description, storage_status: "metadata_only" as const, created_at: isoStamp(row.created_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getEvidenceById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listEvidence(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

/**
 * Progress against learning outcomes / strands for a learner in a term.
 * Returns discrete result history — not a single numerical average.
 */
export async function getLearnerCbeProgress(
  tx: Tx,
  input: { tenantId: string; learnerId: string; termId: string; learningAreaId?: string },
): Promise<{
  learner_id: string;
  term_id: string;
  learning_area_id: string | null;
  outcomes: Array<{
    learning_outcome_id: string | null;
    strand_id: string | null;
    learning_area_id: string;
    results: Array<{
      cbe_assessment_id: string;
      assessment_title: string;
      instrument_type: CbeInstrumentType;
      level_code: string;
      points: string;
      observation: string | null;
      teacher_feedback: string | null;
      completion_status: string;
      marked_at: string;
      curriculum_version_label: string | null;
    }>;
    latest_level_code: string | null;
    strength: boolean;
    needs_support: boolean;
  }>;
}> {
  await getTermById(tx, { tenantId: input.tenantId, termId: input.termId });
  const learner = await tx.query(`SELECT id FROM learners WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.learnerId,
  ]);
  if (learner.rowCount === 0) throw notFound("Learner not found");
  const params: unknown[] = [input.tenantId, input.learnerId, input.termId];
  let areaFilter = "";
  if (input.learningAreaId) {
    params.push(input.learningAreaId);
    areaFilter = ` AND a.learning_area_id = $${params.length}`;
  }
  const res = await tx.query<{
    cbe_assessment_id: string;
    assessment_title: string;
    instrument_type: CbeInstrumentType;
    learning_area_id: string;
    strand_id: string | null;
    learning_outcome_id: string | null;
    level_code: string;
    points: string;
    observation: string | null;
    teacher_feedback: string | null;
    completion_status: string;
    marked_at: Date | string;
    curriculum_version_label: string | null;
  }>(
    `SELECT a.id AS cbe_assessment_id, a.title AS assessment_title, a.instrument_type, a.learning_area_id,
            r.strand_id, r.learning_outcome_id, r.level_code, r.points::text AS points,
            r.observation, r.teacher_feedback, r.completion_status, r.marked_at, a.curriculum_version_label
       FROM cbe_results r
       JOIN cbe_assessments a ON a.tenant_id = r.tenant_id AND a.id = r.cbe_assessment_id
      WHERE r.tenant_id = $1 AND r.learner_id = $2 AND a.term_id = $3${areaFilter}
      ORDER BY a.learning_area_id, r.learning_outcome_id NULLS LAST, r.strand_id NULLS LAST, r.marked_at`,
    params,
  );
  type Bucket = {
    learning_outcome_id: string | null;
    strand_id: string | null;
    learning_area_id: string;
    results: Array<{
      cbe_assessment_id: string;
      assessment_title: string;
      instrument_type: CbeInstrumentType;
      level_code: string;
      points: string;
      observation: string | null;
      teacher_feedback: string | null;
      completion_status: string;
      marked_at: string;
      curriculum_version_label: string | null;
    }>;
  };
  const map = new Map<string, Bucket>();
  for (const row of res.rows) {
    const key = `${row.learning_area_id}:${row.strand_id ?? ""}:${row.learning_outcome_id ?? ""}`;
    const bucket =
      map.get(key) ??
      ({
        learning_outcome_id: row.learning_outcome_id,
        strand_id: row.strand_id,
        learning_area_id: row.learning_area_id,
        results: [],
      } satisfies Bucket);
    bucket.results.push({
      cbe_assessment_id: row.cbe_assessment_id,
      assessment_title: row.assessment_title,
      instrument_type: row.instrument_type,
      level_code: row.level_code,
      points: row.points,
      observation: row.observation,
      teacher_feedback: row.teacher_feedback,
      completion_status: row.completion_status,
      marked_at: isoStamp(row.marked_at),
      curriculum_version_label: row.curriculum_version_label,
    });
    map.set(key, bucket);
  }
  const outcomes = [...map.values()].map((b) => {
    const latest = b.results[b.results.length - 1]!;
    const level = latest.level_code.toUpperCase();
    return {
      ...b,
      latest_level_code: latest.level_code,
      strength: level.startsWith("EE") || level === "ME",
      needs_support: level.startsWith("BE") || level.startsWith("AE"),
    };
  });
  return {
    learner_id: input.learnerId,
    term_id: input.termId,
    learning_area_id: input.learningAreaId ?? null,
    outcomes,
  };
}
