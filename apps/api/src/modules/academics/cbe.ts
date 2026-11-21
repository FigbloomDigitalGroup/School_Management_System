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

export interface PublicLearningArea {
  id: string;
  tenantId: string;
  provenance_id: string;
  code: string;
  name: string;
  official_catalogue: false;
  created_at: string;
}

export async function createLearningArea(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    provenance_id: string;
    code: string;
    name: string;
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
  try {
    const res = await tx.query<{
      id: string;
      tenant_id: string;
      provenance_id: string;
      code: string;
      name: string;
      created_at: Date | string;
    }>(
      `INSERT INTO learning_areas (tenant_id, provenance_id, code, name, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant_id, provenance_id, code, name, created_at`,
      [input.tenantId, input.provenance_id, code, name, input.actorUserId],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "academics.cbe.learning_area.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { learningAreaId: row.id, provenanceId: row.provenance_id, sourceKind: prov.rows[0]!.source_kind },
      ip: input.ip,
    });
    return {
      id: row.id,
      tenantId: row.tenant_id,
      provenance_id: row.provenance_id,
      code: row.code,
      name: row.name,
      official_catalogue: false,
      created_at: isoStamp(row.created_at),
    };
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("A learning area with this code already exists");
    if (pgCode(err) === "23503") throw validationError("provenance_id must belong to this school");
    throw err;
  }
}

export async function listLearningAreas(tx: Tx, input: { tenantId: string; page: PageInput; id?: string }): Promise<Page<PublicLearningArea>> {
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, provenance_id, code, name, created_at
       FROM learning_areas WHERE tenant_id = $1`,
    [input.tenantId],
    { name: "learning_areas", expr: "lower(q.name)", type: "text", dir: "asc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{
    id: string;
    tenant_id: string;
    provenance_id: string;
    code: string;
    name: string;
    created_at: Date | string;
  }>).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    provenance_id: row.provenance_id,
    code: row.code,
    name: row.name,
    official_catalogue: false as const,
    created_at: isoStamp(row.created_at),
  }));
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
  points: number;
}

export function parseDescriptors(value: unknown): RubricDescriptor[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw validationError("descriptors must be a non-empty array of {level_code, label, points}");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw validationError("each descriptor needs level_code, label and points");
    const raw = item as { level_code?: unknown; label?: unknown; points?: unknown };
    if (typeof raw.level_code !== "string" || typeof raw.label !== "string" || typeof raw.points !== "number") {
      throw validationError("each descriptor needs level_code, label and points");
    }
    const level_code = trim(raw.level_code, "level_code", 16);
    const label = trim(raw.label, "label", 80);
    if (!Number.isFinite(raw.points) || raw.points < 0 || raw.points > 1000) {
      throw validationError("points must be between 0 and 1000");
    }
    if (seen.has(level_code)) throw validationError("descriptor level_code values must be unique");
    seen.add(level_code);
    return { level_code, label, points: raw.points };
  });
}

export async function createRubricConfig(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; name: string; version?: number; descriptors: unknown; ip?: string | null },
) {
  const name = trim(input.name, "name", 80);
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw validationError("version must be an integer >= 1");
  const descriptors = parseDescriptors(input.descriptors);
  try {
    const res = await tx.query<{ id: string; tenant_id: string; name: string; version: number; descriptors: RubricDescriptor[]; created_at: Date | string }>(
      `INSERT INTO rubric_descriptor_configs (tenant_id, name, version, descriptors, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, tenant_id, name, version, descriptors, created_at`,
      [input.tenantId, name, version, JSON.stringify(descriptors), input.actorUserId],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "academics.cbe.rubric_config.upserted",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { rubricConfigId: row.id, version: row.version },
      ip: input.ip,
    });
    return { id: row.id, tenantId: row.tenant_id, name: row.name, version: row.version, descriptors: row.descriptors, created_at: isoStamp(row.created_at) };
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("A rubric config with this name and version already exists");
    throw err;
  }
}

export async function listRubricConfigs(tx: Tx, input: { tenantId: string; page: PageInput; id?: string }) {
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, name, version, descriptors, created_at
       FROM rubric_descriptor_configs WHERE tenant_id = $1`,
    [input.tenantId],
    { name: "rubric_configs", expr: "lower(q.name)", type: "text", dir: "asc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{ id: string; tenant_id: string; name: string; version: number; descriptors: RubricDescriptor[]; created_at: Date | string }>).map((row) => ({
    id: row.id, tenantId: row.tenant_id, name: row.name, version: row.version, descriptors: row.descriptors, created_at: isoStamp(row.created_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getRubricConfigById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listRubricConfigs(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
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
    ip?: string | null;
  },
) {
  await getClassById(tx, { tenantId: input.tenantId, classId: input.class_id });
  await requireLearningArea(tx, input.tenantId, input.learning_area_id);
  await getTermById(tx, { tenantId: input.tenantId, termId: input.term_id });
  if (input.rubric_config_id) {
    // A9-11: an unknown rubric config is a client error, not a 500 from the foreign key.
    const rubric = await tx.query(`SELECT 1 FROM rubric_descriptor_configs WHERE tenant_id = $1 AND id = $2`, [
      input.tenantId,
      input.rubric_config_id,
    ]);
    if (rubric.rowCount === 0) throw validationError("rubric_config_id must belong to this school");
  }
  const title = trim(input.title, "title", 160);
  const res = await tx.query<{
    id: string; tenant_id: string; class_id: string; learning_area_id: string; term_id: string;
    rubric_config_id: string | null; title: string; created_at: Date | string;
  }>(
    `INSERT INTO cbe_assessments
       (tenant_id, class_id, learning_area_id, term_id, rubric_config_id, title, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, tenant_id, class_id, learning_area_id, term_id, rubric_config_id, title, created_at`,
    [input.tenantId, input.class_id, input.learning_area_id, input.term_id, input.rubric_config_id ?? null, title, input.actorUserId],
  );
  const row = res.rows[0]!;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    class_id: row.class_id,
    learning_area_id: row.learning_area_id,
    term_id: row.term_id,
    rubric_config_id: row.rubric_config_id,
    title: row.title,
    created_at: isoStamp(row.created_at),
  };
}

export async function listCbeAssessments(tx: Tx, input: { tenantId: string; classId?: string; page: PageInput; id?: string }) {
  const params: unknown[] = [input.tenantId];
  const extra = input.classId ? " AND class_id = $2" : "";
  if (input.classId) params.push(input.classId);
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT id, tenant_id, class_id, learning_area_id, term_id, rubric_config_id, title, created_at
       FROM cbe_assessments WHERE tenant_id = $1${extra}`,
    params,
    { name: "cbe_assessments", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
    input.id,
  );
  const items = (res.rows as unknown as Array<{
    id: string; tenant_id: string; class_id: string; learning_area_id: string; term_id: string;
    rubric_config_id: string | null; title: string; created_at: Date | string;
  }>).map((row) => ({
    id: row.id, tenantId: row.tenant_id, class_id: row.class_id, learning_area_id: row.learning_area_id,
    term_id: row.term_id, rubric_config_id: row.rubric_config_id, title: row.title, created_at: isoStamp(row.created_at),
  }));
  return { items, page: res.page };
}

/** A9-6: by-id lookup through the same query and scope as the list. */
export async function getCbeAssessmentById(tx: Tx, input: { tenantId: string; id: string }) {
  return (await listCbeAssessments(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
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
    points: number;
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
  const assessment = await tx.query<{ rubric_config_id: string | null; class_id: string; learning_area_id: string }>(
    `SELECT rubric_config_id, class_id, learning_area_id FROM cbe_assessments WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.cbeAssessmentId],
  );
  if (assessment.rowCount === 0) throw notFound("CBE assessment not found");
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
  if (assessment.rows[0]!.rubric_config_id) {
    const rubric = await tx.query<{ descriptors: RubricDescriptor[] }>(
      `SELECT descriptors FROM rubric_descriptor_configs WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, assessment.rows[0]!.rubric_config_id],
    );
    const match = rubric.rows[0]?.descriptors.find((d) => d.level_code === level_code);
    if (!match) throw validationError("level_code is not in the rubric config");
    if (match.points !== input.points) throw validationError("points must match the rubric descriptor");
  } else if (!(input.points >= 0) || input.points > 1000) {
    throw validationError("points must be between 0 and 1000");
  }
  const learner = await tx.query(`SELECT id FROM learners WHERE tenant_id = $1 AND id = $2 AND active = true`, [
    input.tenantId,
    input.learner_id,
  ]);
  if (learner.rowCount === 0) throw validationError("learner_id must be an active learner in this school");
  const strandId = input.strand_id ?? null;
  const outcomeId = input.learning_outcome_id ?? null;
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
           (tenant_id, cbe_assessment_id, learner_id, strand_id, learning_outcome_id, level_code, points, marked_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${CBE_RESULT_COLS}`,
        [input.tenantId, input.cbeAssessmentId, input.learner_id, strandId, outcomeId, level_code, input.points, input.actorUserId],
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
    const same = await tx.query<{ same: boolean }>(`SELECT ($1::numeric = $2::numeric) AS same`, [existing.points, input.points]);
    if (existing.level_code === level_code && same.rows[0]?.same) {
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
          resulting_row_version, reason, revised_by)
       VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9)
       RETURNING id`,
      [input.tenantId, existing.id, existing.level_code, existing.points, level_code, input.points,
       existing.row_version + 1, reason, input.actorUserId],
    );
    const updated = await tx.query<CbeResultRow>(
      `UPDATE cbe_results
          SET level_code = $3, points = $4, marked_at = now(), marked_by = $5, row_version = row_version + 1
        WHERE id = $1 AND row_version = $2
        RETURNING ${CBE_RESULT_COLS}`,
      [existing.id, existing.row_version, level_code, input.points, input.actorUserId],
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
  marked_at: Date | string;
  marked_by: string | null;
  row_version: number;
};

const CBE_RESULT_COLS = `id, tenant_id, cbe_assessment_id, learner_id, strand_id, learning_outcome_id,
  level_code, points::text AS points, marked_at, marked_by, row_version`;

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
  const made = await tx.query<{ new_level_code: string; new_points: string; revised_at: Date | string; revised_by: string }>(
    `SELECT new_level_code, new_points::text AS new_points, revised_at, revised_by
       FROM cbe_result_revisions WHERE tenant_id = $1 AND result_id = $2 AND resulting_row_version = $3`,
    [input.tenantId, resultId, version],
  );
  if (made.rows[0]) {
    const m = made.rows[0];
    return { ...mapCbeResult(row), level_code: m.new_level_code, points: m.new_points, marked_at: isoStamp(m.revised_at), marked_by: m.revised_by, row_version: version };
  }
  const next = await tx.query<{ previous_level_code: string; previous_points: string; previous_marked_at: Date | string; previous_marked_by: string | null }>(
    `SELECT previous_level_code, previous_points::text AS previous_points, previous_marked_at, previous_marked_by
       FROM cbe_result_revisions WHERE tenant_id = $1 AND result_id = $2 AND resulting_row_version = $3`,
    [input.tenantId, resultId, version + 1],
  );
  const n = next.rows[0];
  if (!n) return null;
  return {
    ...mapCbeResult(row),
    level_code: n.previous_level_code,
    points: n.previous_points,
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
