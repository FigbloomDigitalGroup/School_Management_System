import type { Tx } from "../../db/sql.js";
import { schoolToday } from "../tenancy/schoolClock.js";
import { isRealCalendarDate } from "../../http/schemas.js";
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
  // node-pg parses a DATE as LOCAL midnight of the Node process, so the calendar day is read with LOCAL parts (UTC parts shift the
  // day in any process timezone other than UTC). The SELECT lists cast dates to text, so this branch is a defence in depth.
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
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

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * S16-6 / S16-2: Neutralize spreadsheet formula injection without corrupting stored learner PII.
 * Leading formula trigger characters (=, +, -, @, tab, CR) on either the raw cell or the trimmed
 * value are rejected, while legitimate internal hyphens/apostrophes (e.g. "Anne-Marie O'Connor")
 * remain valid and untouched.
 */
export function hasFormulaTrigger(raw: string): boolean {
  if (!raw) return false;
  return FORMULA_PREFIX.test(raw) || FORMULA_PREFIX.test(raw.trim());
}

export interface ValidatedLearnerFields {
  admission_no: string;
  full_name: string;
  gender: LearnerGender;
  date_of_birth: string | null;
  boarding: boolean;
}

/**
 * S16-2: Single shared validation contract used by CSV preview, CSV apply, createLearner, and updateLearner.
 */
export function validateLearnerFields(input: {
  admission_no: string;
  full_name: string;
  gender: string;
  date_of_birth?: string | null;
  boarding?: boolean | string | null;
  /** The school's local calendar date (see schoolToday). When omitted the UTC date is used (callers without a tenant clock). */
  today?: string;
}): {
  valid: boolean;
  messages: string[];
  value?: ValidatedLearnerFields;
} {
  const messages: string[] = [];
  const rawAdm = input.admission_no ?? "";
  const rawName = input.full_name ?? "";
  const admission_no = rawAdm.trim();
  const full_name = rawName.trim();
  const genderRaw = (input.gender ?? "").trim().toLowerCase();

  if (rawAdm.includes("\0") || rawName.includes("\0")) {
    messages.push("NUL characters are not allowed");
  }
  if (!admission_no) {
    messages.push("admission_no is required");
  } else if ([...admission_no].length > 32) {
    messages.push("admission_no is too long");
  } else if (hasFormulaTrigger(rawAdm)) {
    messages.push("admission_no cannot start with a formula character");
  }

  if (!full_name) {
    messages.push("full_name is required");
  } else if ([...full_name].length > 120) {
    messages.push("full_name is too long");
  } else if (hasFormulaTrigger(rawName)) {
    messages.push("full_name cannot start with a formula character");
  }

  if (genderRaw !== "male" && genderRaw !== "female") {
    messages.push("gender must be male or female");
  }

  let date_of_birth: string | null = null;
  if (input.date_of_birth != null && String(input.date_of_birth).trim() !== "") {
    const rawDob = String(input.date_of_birth).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDob)) {
      messages.push("date_of_birth must be YYYY-MM-DD");
    } else {
      const parsed = new Date(`${rawDob}T00:00:00Z`);
      if (!isRealCalendarDate(rawDob) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== rawDob) {
        messages.push("date_of_birth is not a valid date");
      } else {
        // "In the future" is judged against the SCHOOL's calendar date, not the UTC date: in a school ahead of UTC, a learner born
        // today (local) must not be refused during the first hours of the local day.
        const nowUtc = new Date();
        const todayDate = input.today ?? new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate())).toISOString().slice(0, 10);
        if (rawDob > todayDate) {
          messages.push("date_of_birth cannot be in the future");
        } else {
          date_of_birth = rawDob;
        }
      }
    }
  }

  let boarding = false;
  if (typeof input.boarding === "boolean") {
    boarding = input.boarding;
  } else if (input.boarding != null && String(input.boarding).trim() !== "") {
    const bRaw = String(input.boarding).trim().toLowerCase();
    if (bRaw === "true" || bRaw === "1" || bRaw === "yes") {
      boarding = true;
    } else if (bRaw === "false" || bRaw === "0" || bRaw === "no") {
      boarding = false;
    } else {
      messages.push("boarding must be true/false, yes/no, or 1/0");
    }
  }

  if (messages.length > 0) {
    return { valid: false, messages };
  }
  return {
    valid: true,
    messages: [],
    value: {
      admission_no,
      full_name,
      gender: genderRaw as LearnerGender,
      date_of_birth,
      boarding,
    },
  };
}

/**
 * Learner writes run on the caller's tenant transaction (FIG-1605).
 * The route sets app.tenant_id / app.user_id. This module does not open a second transaction.
 */
export async function createLearner(db: Tx, input: CreateLearnerInput): Promise<PublicLearner> {
  const checked = validateLearnerFields({
    admission_no: input.admission_no,
    full_name: input.full_name,
    gender: input.gender,
    date_of_birth: input.date_of_birth,
    boarding: input.boarding ?? false,
    today: await schoolToday(db, input.tenantId),
  });
  if (!checked.valid || !checked.value) {
    throw validationError(checked.messages[0] ?? "Invalid learner data");
  }
  const { admission_no, full_name, gender, date_of_birth: dateOfBirth, boarding } = checked.value;

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
            gender,
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

  const rawAdmissionNo =
    input.admission_no !== undefined ? input.admission_no : current.admission_no;
  const rawFullName = input.full_name !== undefined ? input.full_name : current.full_name;
  const rawGender = input.gender !== undefined ? input.gender : current.gender;
  const rawBoarding = input.boarding !== undefined ? input.boarding : current.boarding;
  const rawDateOfBirth =
    input.date_of_birth !== undefined ? input.date_of_birth : current.date_of_birth;

  const checked = validateLearnerFields({
    admission_no: rawAdmissionNo,
    full_name: rawFullName,
    gender: rawGender,
    boarding: rawBoarding,
    date_of_birth: rawDateOfBirth,
    today: await schoolToday(db, input.tenantId),
  });
  if (!checked.valid || !checked.value) {
    throw validationError(checked.messages[0] ?? "Invalid learner data");
  }
  const { admission_no, full_name, gender, boarding, date_of_birth: dateOfBirth } = checked.value;

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
  // Finding 8: a learner who leaves the school leaves their class too, so nothing that counts class memberships
  // counts them. Restore does not give the class back (it may be archived, or the year over); the school places the
  // learner again, which migration 101 allows even in a class they left this year.
  const ended = await db.query<{ id: string }>(
    `UPDATE class_memberships
        SET active = false, archived_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND learner_id = $2 AND active = true
      RETURNING id`,
    [input.tenantId, input.learnerId],
  );
  await recordSecurityEvent(db, {
    eventType: "directory.learner.archived",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { learnerId: row.id, endedClassMembershipIds: ended.rows.map((m) => m.id) },
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

