import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { LIKE_ESCAPE_CLAUSE, likeContains } from "./search.js";

export type LearnerGender = "male" | "female";

export interface LearnerRecord {
  id: string;
  tenant_id: string;
  admission_no: string;
  full_name: string;
  gender: LearnerGender;
  boarding: boolean;
  date_of_birth: string | null;
  active: boolean;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateLearnerInput {
  tenantId: string;
  actorUserId: string;
  admission_no: string;
  full_name: string;
  gender: LearnerGender;
  boarding?: boolean;
  date_of_birth?: string | null;
  ip?: string | null;
}

export interface PublicLearner {
  id: string;
  tenantId: string;
  admission_no: string;
  full_name: string;
  gender: LearnerGender;
  boarding: boolean;
  date_of_birth: string | null;
  active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function isoDate(value: Date | string | null): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  // pg returns JS Date for `date` using local midnight; use UTC calendar parts
  // only when the driver already normalized — prefer SQL ::text when possible.
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, "0");
  const d = String(value.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isoStamp(value: Date | string): string {
  if (typeof value === "string") return value;
  return value.toISOString();
}

export function toPublicLearner(row: LearnerRecord): PublicLearner {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    admission_no: row.admission_no,
    full_name: row.full_name,
    gender: row.gender,
    boarding: row.boarding,
    date_of_birth: row.date_of_birth,
    active: row.active,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapRow(row: {
  id: string;
  tenant_id: string;
  admission_no: string;
  full_name: string;
  gender: string;
  boarding: boolean;
  date_of_birth: Date | string | null;
  active: boolean;
  archived_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): LearnerRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    admission_no: row.admission_no,
    full_name: row.full_name,
    gender: row.gender as LearnerGender,
    boarding: row.boarding,
    date_of_birth: isoDate(row.date_of_birth),
    active: row.active,
    archived_at: row.archived_at == null ? null : isoStamp(row.archived_at),
    created_by: row.created_by,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

const SELECT_COLS = `
  id, tenant_id, admission_no, full_name, gender, boarding,
  date_of_birth::text AS date_of_birth,
  active, archived_at, created_by, created_at, updated_at
`;

/**
 * Learner writes run on the caller's tenant transaction (FIG-1605).
 * The route sets app.tenant_id / app.user_id. This module does not open a second transaction.
 */
export async function createLearner(db: Tx, input: CreateLearnerInput): Promise<PublicLearner> {
  const admission_no = input.admission_no.trim();
  const full_name = input.full_name.trim();
  if (!admission_no) throw validationError("Admission number is required");
  if (!full_name) throw validationError("Full name is required");
  if (admission_no.length > 32) throw validationError("Admission number is too long");
  if (full_name.length > 120) throw validationError("Full name is too long");
  if (input.gender !== "male" && input.gender !== "female") {
    throw validationError("Gender must be male or female");
  }

  let dateOfBirth: string | null = null;
  if (input.date_of_birth != null && String(input.date_of_birth).trim() !== "") {
    const raw = String(input.date_of_birth).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw validationError("date_of_birth must be YYYY-MM-DD");
    }
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
      throw validationError("date_of_birth is not a valid date");
    }
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    if (parsed > todayUtc) throw validationError("date_of_birth cannot be in the future");
    dateOfBirth = raw;
  }

  const boarding = input.boarding === true;

  try {
    const created = await (async () => {
        const result = await db.query<{
          id: string;
          tenant_id: string;
          admission_no: string;
          full_name: string;
          gender: string;
          boarding: boolean;
          date_of_birth: Date | string | null;
          active: boolean;
          archived_at: Date | string | null;
          created_by: string | null;
          created_at: Date | string;
          updated_at: Date | string;
        }>(
          `INSERT INTO learners (
             tenant_id, admission_no, full_name, gender, boarding, date_of_birth, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6::date, $7)
           RETURNING ${SELECT_COLS}`,
          [
            input.tenantId,
            admission_no,
            full_name,
            input.gender,
            boarding,
            dateOfBirth,
            input.actorUserId,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error("learner insert returned no row");

        await recordSecurityEvent(db, {
          eventType: "directory.learner.created",
          actorUserId: input.actorUserId,
          tenantId: input.tenantId,
          detail: {
            learnerId: row.id,
            admission_no: row.admission_no,
          },
          ip: input.ip ?? null,
        });

        return mapRow(row);
    })();
    return toPublicLearner(created);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      throw conflict(`Admission ${admission_no} is already on the roster`);
    }
    throw err;
  }
}

export async function getLearnerById(
  db: Tx,
  input: { tenantId: string; learnerId: string; actorUserId: string },
): Promise<PublicLearner> {
  const row = await (async () => {
      const result = await db.query<{
        id: string;
        tenant_id: string;
        admission_no: string;
        full_name: string;
        gender: string;
        boarding: boolean;
        date_of_birth: Date | string | null;
        active: boolean;
        archived_at: Date | string | null;
        created_by: string | null;
        created_at: Date | string;
        updated_at: Date | string;
      }>(
        `SELECT ${SELECT_COLS}
         FROM learners
         WHERE id = $1 AND tenant_id = $2`,
        [input.learnerId, input.tenantId],
      );
      return result.rows[0] ?? null;
  })();

  if (!row) throw notFound("Learner not found");
  return toPublicLearner(mapRow(row));
}

export interface ListLearnersInput {
  tenantId: string;
  limit: number;
  /** Cursor keys: [lower(full_name), id] when sort=name; [created_at micros, id] when sort=created */
  cursorKeys?: string[] | null;
  sort: "name" | "created";
  active?: boolean | null;
  q?: string | null;
}

export async function listLearnersPage(
  db: Tx,
  input: ListLearnersInput,
): Promise<Array<PublicLearner & { _sort_name?: string; _sort_created?: string }>> {
  const params: unknown[] = [input.tenantId];
  const filters: string[] = [`tenant_id = $1`];

  if (input.active === true || input.active === false) {
    params.push(input.active);
    filters.push(`active = $${params.length}`);
  }

  if (input.q != null && input.q.trim() !== "") {
    // P3-AUDIT-013: a search box is not a pattern language. `%`, `_` and `\` in the caller's term
    // are escaped, so `q=%` no longer returns the whole roster and `q=_` no longer matches every
    // single-character admission number.
    params.push(likeContains(input.q.trim()));
    filters.push(
      `(lower(full_name) LIKE $${params.length} ${LIKE_ESCAPE_CLAUSE}` +
        ` OR lower(admission_no) LIKE $${params.length} ${LIKE_ESCAPE_CLAUSE})`,
    );
  }

  let keyset = "";
  if (input.cursorKeys && input.cursorKeys.length === 2) {
    if (input.sort === "name") {
      params.push(input.cursorKeys[0], input.cursorKeys[1]);
      keyset = `AND (lower(full_name), id) > ($${params.length - 1}::text, $${params.length}::uuid)`;
    } else {
      params.push(input.cursorKeys[0], input.cursorKeys[1]);
      keyset = `AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
  }

  params.push(input.limit + 1);
  const order =
    input.sort === "name"
      ? `lower(full_name) ASC, id ASC`
      : `created_at ASC, id ASC`;

  const result = await db.query<{
    id: string;
    tenant_id: string;
    admission_no: string;
    full_name: string;
    gender: string;
    boarding: boolean;
    date_of_birth: Date | string | null;
    active: boolean;
    archived_at: Date | string | null;
    created_by: string | null;
    created_at: Date | string;
    updated_at: Date | string;
    sort_name: string;
    sort_created: string;
  }>(
    `SELECT ${SELECT_COLS},
            lower(full_name) AS sort_name,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created
       FROM learners
      WHERE ${filters.join(" AND ")}
      ${keyset}
      ORDER BY ${order}
      LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    ...toPublicLearner(mapRow(row)),
    _sort_name: row.sort_name,
    _sort_created: row.sort_created,
  }));
}

export interface UpdateLearnerInput {
  tenantId: string;
  learnerId: string;
  actorUserId: string;
  admission_no?: string;
  full_name?: string;
  gender?: LearnerGender;
  boarding?: boolean;
  date_of_birth?: string | null;
  ip?: string | null;
}

/**
 * Serialise read-modify-write on one learner (P3-AUDIT-012). Without it two concurrent PATCHes
 * each read the same `current` and the later write silently discards the earlier one's fields.
 * Deliberately silent on a missing row: the caller's own lookup raises the 404, so the lock is
 * never a second existence oracle. `FOR UPDATE` needs UPDATE privilege, held at column level
 * from migration 027.
 */
async function lockLearnerRow(db: Tx, tenantId: string, learnerId: string): Promise<void> {
  await db.query(`SELECT 1 FROM learners WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
    learnerId,
    tenantId,
  ]);
}

export async function updateLearner(db: Tx, input: UpdateLearnerInput): Promise<PublicLearner> {
  await lockLearnerRow(db, input.tenantId, input.learnerId);
  const current = await getLearnerById(db, {
    tenantId: input.tenantId,
    learnerId: input.learnerId,
    actorUserId: input.actorUserId,
  });
  if (!current.active) throw validationError("Archived learners cannot be updated; restore first");

  const admission_no =
    input.admission_no !== undefined ? input.admission_no.trim() : current.admission_no;
  const full_name = input.full_name !== undefined ? input.full_name.trim() : current.full_name;
  const gender = input.gender !== undefined ? input.gender : current.gender;
  const boarding = input.boarding !== undefined ? input.boarding : current.boarding;
  let dateOfBirth = current.date_of_birth;
  if (input.date_of_birth !== undefined) {
    if (input.date_of_birth == null || String(input.date_of_birth).trim() === "") {
      dateOfBirth = null;
    } else {
      const raw = String(input.date_of_birth).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw validationError("date_of_birth must be YYYY-MM-DD");
      const parsed = new Date(`${raw}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
        throw validationError("date_of_birth is not a valid date");
      }
      const today = new Date();
      const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      if (parsed > todayUtc) throw validationError("date_of_birth cannot be in the future");
      dateOfBirth = raw;
    }
  }

  if (!admission_no || admission_no.length > 32) throw validationError("Admission number is invalid");
  if (!full_name || full_name.length > 120) throw validationError("Full name is invalid");
  if (gender !== "male" && gender !== "female") throw validationError("Gender must be male or female");

  try {
    const result = await db.query<{
      id: string;
      tenant_id: string;
      admission_no: string;
      full_name: string;
      gender: string;
      boarding: boolean;
      date_of_birth: Date | string | null;
      active: boolean;
      archived_at: Date | string | null;
      created_by: string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `UPDATE learners
          SET admission_no = $3,
              full_name = $4,
              gender = $5,
              boarding = $6,
              date_of_birth = $7::date,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND active = true
        RETURNING ${SELECT_COLS}`,
      [input.learnerId, input.tenantId, admission_no, full_name, gender, boarding, dateOfBirth],
    );
    const row = result.rows[0];
    if (!row) throw notFound("Learner not found");

    await recordSecurityEvent(db, {
      eventType: "directory.learner.updated",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { learnerId: row.id },
      ip: input.ip ?? null,
    });
    return toPublicLearner(mapRow(row));
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") throw conflict(`Admission ${admission_no} is already on the roster`);
    throw err;
  }
}

export async function archiveLearner(
  db: Tx,
  input: { tenantId: string; learnerId: string; actorUserId: string; ip?: string | null },
): Promise<PublicLearner> {
  const result = await db.query<{
    id: string;
    tenant_id: string;
    admission_no: string;
    full_name: string;
    gender: string;
    boarding: boolean;
    date_of_birth: Date | string | null;
    active: boolean;
    archived_at: Date | string | null;
    created_by: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    `UPDATE learners
        SET active = false, archived_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND active = true
      RETURNING ${SELECT_COLS}`,
    [input.learnerId, input.tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    const existing = await getLearnerById(db, input);
    if (!existing.active) throw validationError("Learner is already archived");
    throw notFound("Learner not found");
  }
  await recordSecurityEvent(db, {
    eventType: "directory.learner.archived",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { learnerId: row.id },
    ip: input.ip ?? null,
  });
  return toPublicLearner(mapRow(row));
}

export async function restoreLearner(
  db: Tx,
  input: { tenantId: string; learnerId: string; actorUserId: string; ip?: string | null },
): Promise<PublicLearner> {
  const result = await db.query<{
    id: string;
    tenant_id: string;
    admission_no: string;
    full_name: string;
    gender: string;
    boarding: boolean;
    date_of_birth: Date | string | null;
    active: boolean;
    archived_at: Date | string | null;
    created_by: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    `UPDATE learners
        SET active = true, archived_at = NULL, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND active = false
      RETURNING ${SELECT_COLS}`,
    [input.learnerId, input.tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    const existing = await getLearnerById(db, input);
    if (existing.active) throw validationError("Learner is not archived");
    throw notFound("Learner not found");
  }
  await recordSecurityEvent(db, {
    eventType: "directory.learner.restored",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { learnerId: row.id },
    ip: input.ip ?? null,
  });
  return toPublicLearner(mapRow(row));
}

/** Direct pool queries for least-privilege / RLS tests (SET ROLE figbloom_app). */
export async function countLearnersVisibleAsAppRole(db: Tx, tenantId: string): Promise<number> {
  const result = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM learners WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(result.rows[0]?.n ?? 0);
}
