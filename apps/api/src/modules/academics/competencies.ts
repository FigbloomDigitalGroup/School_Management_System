import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { getTermById } from "./structure.js";
import { pgCode } from "./pgError.js";
import { ONE_ROW, pageQuery, type Page, type PageInput } from "./pagination.js";

/** Stable codes aligned with packages/shared/src/competencies.ts (labels live in the reference catalogue). */
export const COMPETENCY_CODES = [
  "communication",
  "critical_thinking",
  "creativity",
  "citizenship",
  "digital_literacy",
  "learning_to_learn",
  "self_efficacy",
] as const;

export const VALUE_CODES = [
  "love",
  "responsibility",
  "respect",
  "unity",
  "peace",
  "patriotism",
  "integrity",
] as const;

export const COMPETENCY_LEVELS = ["EE", "ME", "AE", "BE"] as const;

export type CompetencyKind = "competency" | "value";
export type CompetencyLevel = (typeof COMPETENCY_LEVELS)[number];

function isoStamp(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function assertItem(kind: CompetencyKind, item: string): string {
  const allowed = kind === "competency" ? COMPETENCY_CODES : VALUE_CODES;
  if (!(allowed as readonly string[]).includes(item)) {
    throw validationError(`Unknown ${kind} item '${item}'`);
  }
  return item;
}

function assertLevel(level: string): CompetencyLevel {
  if (!(COMPETENCY_LEVELS as readonly string[]).includes(level)) {
    throw validationError("level_code must be one of EE, ME, AE, BE");
  }
  return level as CompetencyLevel;
}

export interface PublicCompetencyRating {
  id: string;
  tenantId: string;
  term_id: string;
  learner_id: string;
  kind: CompetencyKind;
  item: string;
  level_code: CompetencyLevel;
  rated_at: string;
  rated_by: string | null;
  row_version: number;
}

type RatingRow = {
  id: string;
  tenant_id: string;
  term_id: string;
  learner_id: string;
  kind: CompetencyKind;
  item: string;
  level_code: CompetencyLevel;
  rated_at: Date | string;
  rated_by: string | null;
  row_version: number;
};

const RATING_COLS = `id, tenant_id, term_id, learner_id, kind, item, level_code, rated_at, rated_by, row_version`;

function mapRating(row: RatingRow): PublicCompetencyRating {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    term_id: row.term_id,
    learner_id: row.learner_id,
    kind: row.kind,
    item: row.item,
    level_code: row.level_code,
    rated_at: isoStamp(row.rated_at),
    rated_by: row.rated_by,
    row_version: row.row_version,
  };
}

export async function upsertCompetencyRating(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    term_id: string;
    learner_id: string;
    kind: CompetencyKind;
    item: string;
    level_code: string;
    row_version?: number | null;
    ip?: string | null;
  },
): Promise<{ rating: PublicCompetencyRating; outcome: "created" | "updated" | "unchanged" }> {
  await getTermById(tx, { tenantId: input.tenantId, termId: input.term_id });
  const learner = await tx.query(
    `SELECT id FROM learners WHERE tenant_id = $1 AND id = $2 AND active = true`,
    [input.tenantId, input.learner_id],
  );
  if (learner.rowCount === 0) throw validationError("learner_id must be an active learner in this school");
  const kind = input.kind;
  if (kind !== "competency" && kind !== "value") throw validationError("kind must be competency or value");
  const item = assertItem(kind, input.item);
  const level_code = assertLevel(input.level_code);

  const current = await tx.query<RatingRow>(
    `SELECT ${RATING_COLS} FROM learner_competency_ratings
      WHERE tenant_id = $1 AND term_id = $2 AND learner_id = $3 AND kind = $4 AND item = $5
      FOR UPDATE`,
    [input.tenantId, input.term_id, input.learner_id, kind, item],
  );
  const existing = current.rows[0];
  try {
    if (!existing) {
      if (input.row_version !== undefined && input.row_version !== null && input.row_version !== 0) {
        throw conflict("The rating was changed by someone else");
      }
      const res = await tx.query<RatingRow>(
        `INSERT INTO learner_competency_ratings
           (tenant_id, term_id, learner_id, kind, item, level_code, rated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${RATING_COLS}`,
        [input.tenantId, input.term_id, input.learner_id, kind, item, level_code, input.actorUserId],
      );
      const row = res.rows[0]!;
      await recordSecurityEvent(tx, {
        eventType: "academics.competency.rated",
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        detail: { ratingId: row.id, kind, item, learnerId: row.learner_id, termId: row.term_id },
        ip: input.ip,
      });
      return { rating: mapRating(row), outcome: "created" };
    }
    if (existing.level_code === level_code) {
      return { rating: mapRating(existing), outcome: "unchanged" };
    }
    if (input.row_version === undefined || input.row_version === null || input.row_version !== existing.row_version) {
      throw conflict("Send the current row_version to change a competency rating");
    }
    const updated = await tx.query<RatingRow>(
      `UPDATE learner_competency_ratings
          SET level_code = $3, rated_by = $4, rated_at = now(), row_version = row_version + 1
        WHERE id = $1 AND row_version = $2
        RETURNING ${RATING_COLS}`,
      [existing.id, existing.row_version, level_code, input.actorUserId],
    );
    const row = updated.rows[0];
    if (!row) throw conflict("The rating was changed by someone else");
    await tx.query(
      `INSERT INTO learner_competency_rating_revisions
         (tenant_id, rating_id, previous_level_code, new_level_code, resulting_row_version, revised_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.tenantId, row.id, existing.level_code, level_code, row.row_version, input.actorUserId],
    );
    await recordSecurityEvent(tx, {
      eventType: "academics.competency.rated",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: {
        ratingId: row.id,
        kind,
        item,
        learnerId: row.learner_id,
        termId: row.term_id,
        fromRowVersion: existing.row_version,
        toRowVersion: row.row_version,
      },
      ip: input.ip,
    });
    return { rating: mapRating(row), outcome: "updated" };
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("The rating was changed by someone else");
    if (pgCode(err) === "23503") throw validationError("term_id or learner_id must belong to this school");
    throw err;
  }
}

export async function listCompetencyRatings(
  tx: Tx,
  input: {
    tenantId: string;
    termId?: string;
    learnerId?: string;
    page: PageInput;
    id?: string;
  },
): Promise<Page<PublicCompetencyRating>> {
  const params: unknown[] = [input.tenantId];
  const parts: string[] = ["tenant_id = $1"];
  if (input.termId) {
    params.push(input.termId);
    parts.push(`term_id = $${params.length}`);
  }
  if (input.learnerId) {
    params.push(input.learnerId);
    parts.push(`learner_id = $${params.length}`);
  }
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT ${RATING_COLS} FROM learner_competency_ratings WHERE ${parts.join(" AND ")}`,
    params,
    { name: "learner_competency_ratings", expr: "q.rated_at", type: "timestamptz", dir: "desc" },
    input.page,
    input.id,
  );
  return { items: (res.rows as unknown as RatingRow[]).map(mapRating), page: res.page };
}

export async function getCompetencyRatingById(
  tx: Tx,
  input: { tenantId: string; id: string },
): Promise<PublicCompetencyRating | null> {
  return (await listCompetencyRatings(tx, { ...input, page: ONE_ROW })).items[0] ?? null;
}

export async function listCompetencyRatingsForClassTerm(
  tx: Tx,
  input: { tenantId: string; classId: string; termId: string },
): Promise<PublicCompetencyRating[]> {
  const res = await tx.query<RatingRow>(
    `SELECT r.id, r.tenant_id, r.term_id, r.learner_id, r.kind, r.item, r.level_code,
            r.rated_at, r.rated_by, r.row_version
       FROM learner_competency_ratings r
       JOIN class_memberships cm
         ON cm.tenant_id = r.tenant_id AND cm.learner_id = r.learner_id AND cm.active = true
      WHERE r.tenant_id = $1 AND r.term_id = $2 AND cm.class_id = $3
      ORDER BY r.learner_id, r.kind, r.item`,
    [input.tenantId, input.termId, input.classId],
  );
  return res.rows.map(mapRating);
}

export async function requireCompetencyRating(
  tx: Tx,
  input: { tenantId: string; id: string },
): Promise<PublicCompetencyRating> {
  const row = await getCompetencyRatingById(tx, input);
  if (!row) throw notFound("Competency rating not found");
  return row;
}
