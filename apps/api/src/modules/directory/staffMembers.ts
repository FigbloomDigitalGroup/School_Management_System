import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import {
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_EMAIL_PATTERN,
  CONTACT_PHONE_PATTERN,
} from "./contact.js";
import { LIKE_ESCAPE_CLAUSE, likeContains } from "./search.js";

export type StaffClassification = "school_admin" | "teacher" | "driver" | "staff";

export interface PublicStaffMember {
  id: string;
  tenantId: string;
  full_name: string;
  staff_title: string | null;
  classification: StaffClassification;
  phone: string | null;
  email: string | null;
  userId: string | null;
  active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS = `
  id, tenant_id, full_name, staff_title, classification, phone, email, user_id,
  active, archived_at, created_by, created_at, updated_at
`;

interface StaffRow {
  id: string;
  tenant_id: string;
  full_name: string;
  staff_title: string | null;
  classification: string;
  phone: string | null;
  email: string | null;
  user_id: string | null;
  active: boolean;
  archived_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function isoStamp(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

/**
 * Staff contact validation (P3-AUDIT-013).
 *
 * `phone` and `email` were length-checked only, in the schema and in the database, so
 * `phone: "not a number"` and `email: "@@@"` were stored and then handed to clients and future
 * notification adapters. The directory now applies one rule per kind of field: these are the same
 * patterns the guardian directory has always used (`./contact.ts`), so a phone number means the
 * same thing wherever the directory stores one.
 */
function validateStaffContact(phone: string | null, email: string | null): void {
  if (phone != null && !new RegExp(CONTACT_PHONE_PATTERN).test(phone)) {
    throw validationError("phone is invalid");
  }
  if (email != null) {
    if (email.length > CONTACT_EMAIL_MAX_LENGTH || !new RegExp(CONTACT_EMAIL_PATTERN, "i").test(email)) {
      throw validationError("email is invalid");
    }
  }
}

/** Empty and whitespace-only optional contact values are stored as NULL, not as "". */
function cleanOptional(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Serialise read-modify-write on one staff member (P3-AUDIT-012). Silent on a missing row: the
 * caller's own lookup raises the 404.
 */
async function lockStaffRow(db: Tx, tenantId: string, staffId: string): Promise<void> {
  await db.query(`SELECT 1 FROM staff_members WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
    staffId,
    tenantId,
  ]);
}

function mapPublic(row: StaffRow): PublicStaffMember {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    full_name: row.full_name,
    staff_title: row.staff_title,
    classification: row.classification as StaffClassification,
    phone: row.phone,
    email: row.email,
    userId: row.user_id,
    active: row.active,
    archived_at: row.archived_at == null ? null : isoStamp(row.archived_at),
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

export async function createStaffMember(
  db: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    full_name: string;
    staff_title?: string | null;
    classification?: StaffClassification;
    phone?: string | null;
    email?: string | null;
    userId?: string | null;
    ip?: string | null;
  },
): Promise<PublicStaffMember> {
  const full_name = input.full_name.trim();
  if (!full_name || full_name.length > 120) throw validationError("full_name is required (1–120)");
  const classification = input.classification ?? "staff";
  const phone = cleanOptional(input.phone);
  const email = cleanOptional(input.email);
  validateStaffContact(phone, email);
  try {
    const result = await db.query<StaffRow>(
      `INSERT INTO staff_members (
         tenant_id, full_name, staff_title, classification, phone, email, user_id, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${SELECT_COLS}`,
      [
        input.tenantId,
        full_name,
        input.staff_title?.trim() || null,
        classification,
        phone,
        email,
        input.userId ?? null,
        input.actorUserId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("staff insert returned no row");
    await recordSecurityEvent(db, {
      eventType: "directory.staff.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { staffId: row.id, classification },
      ip: input.ip ?? null,
    });
    return mapPublic(row);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") throw conflict("Staff member already linked to that user account");
    if (code === "23503") throw validationError("userId must belong to an active member of this school");
    throw err;
  }
}

export async function getStaffMemberById(
  db: Tx,
  input: { tenantId: string; staffId: string },
): Promise<PublicStaffMember> {
  const result = await db.query<StaffRow>(
    `SELECT ${SELECT_COLS} FROM staff_members WHERE id = $1 AND tenant_id = $2`,
    [input.staffId, input.tenantId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Staff member not found");
  return mapPublic(row);
}

/**
 * The caller's own ACTIVE staff record in this school (linked through `user_id`), or null when the account has none (a school
 * administrator who was never added to the directory, a parent, a student). It reads only the caller's own row, so it needs no
 * directory permission: a teacher who cannot read the staff list can still learn their own staff id, which is what teaching
 * assignments and class teachers are recorded against.
 */
export async function getOwnStaffMember(db: Tx, input: { tenantId: string; userId: string }): Promise<PublicStaffMember | null> {
  const result = await db.query<StaffRow>(
    `SELECT ${SELECT_COLS} FROM staff_members WHERE tenant_id = $1 AND user_id = $2 AND active = true`,
    [input.tenantId, input.userId],
  );
  const row = result.rows[0];
  return row ? mapPublic(row) : null;
}

export async function listStaffMembersPage(
  db: Tx,
  input: {
    tenantId: string;
    limit: number;
    cursorKeys?: string[] | null;
    active?: boolean | null;
    q?: string | null;
  },
): Promise<Array<PublicStaffMember & { _sort_name: string }>> {
  const params: unknown[] = [input.tenantId];
  const filters = [`tenant_id = $1`];
  if (input.active === true || input.active === false) {
    params.push(input.active);
    filters.push(`active = $${params.length}`);
  }
  if (input.q?.trim()) {
    // P3-AUDIT-013: literal search, not a pattern language.
    params.push(likeContains(input.q.trim()));
    filters.push(`lower(full_name) LIKE $${params.length} ${LIKE_ESCAPE_CLAUSE}`);
  }
  let keyset = "";
  if (input.cursorKeys?.length === 2) {
    params.push(input.cursorKeys[0], input.cursorKeys[1]);
    keyset = `AND (lower(full_name), id) > ($${params.length - 1}::text, $${params.length}::uuid)`;
  }
  params.push(input.limit + 1);
  const result = await db.query<StaffRow & { sort_name: string }>(
    `SELECT ${SELECT_COLS}, lower(full_name) AS sort_name
       FROM staff_members
      WHERE ${filters.join(" AND ")}
      ${keyset}
      ORDER BY lower(full_name) ASC, id ASC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => ({
    ...mapPublic(row),
    _sort_name: row.sort_name,
  }));
}

export async function updateStaffMember(
  db: Tx,
  input: {
    tenantId: string;
    staffId: string;
    actorUserId: string;
    full_name?: string;
    staff_title?: string | null;
    classification?: StaffClassification;
    phone?: string | null;
    email?: string | null;
    userId?: string | null;
    ip?: string | null;
  },
): Promise<PublicStaffMember> {
  await lockStaffRow(db, input.tenantId, input.staffId);
  const current = await getStaffMemberById(db, input);
  if (!current.active) throw validationError("Archived staff cannot be updated; restore first");
  const full_name = input.full_name !== undefined ? input.full_name.trim() : current.full_name;
  if (!full_name || full_name.length > 120) throw validationError("full_name is invalid");
  const phone = input.phone !== undefined ? cleanOptional(input.phone) : current.phone;
  const email = input.email !== undefined ? cleanOptional(input.email) : current.email;
  validateStaffContact(phone, email);
  try {
    const result = await db.query<StaffRow>(
      `UPDATE staff_members SET
         full_name = $3,
         staff_title = $4,
         classification = $5,
         phone = $6,
         email = $7,
         user_id = $8,
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND active = true
       RETURNING ${SELECT_COLS}`,
      [
        input.staffId,
        input.tenantId,
        full_name,
        input.staff_title !== undefined ? input.staff_title?.trim() || null : current.staff_title,
        input.classification ?? current.classification,
        phone,
        email,
        input.userId !== undefined ? input.userId : current.userId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw notFound("Staff member not found");
    await recordSecurityEvent(db, {
      eventType: "directory.staff.updated",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { staffId: row.id },
      ip: input.ip ?? null,
    });
    return mapPublic(row);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") throw conflict("Staff member already linked to that user account");
    if (code === "23503") throw validationError("userId must belong to an active member of this school");
    throw err;
  }
}

export async function archiveStaffMember(
  db: Tx,
  input: { tenantId: string; staffId: string; actorUserId: string; ip?: string | null },
): Promise<PublicStaffMember> {
  const result = await db.query<StaffRow>(
    `UPDATE staff_members
        SET active = false, archived_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND active = true
      RETURNING ${SELECT_COLS}`,
    [input.staffId, input.tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    const existing = await getStaffMemberById(db, input);
    if (!existing.active) throw validationError("Staff member is already archived");
    throw notFound("Staff member not found");
  }
  await recordSecurityEvent(db, {
    eventType: "directory.staff.archived",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { staffId: row.id },
    ip: input.ip ?? null,
  });
  return mapPublic(row);
}

export async function restoreStaffMember(
  db: Tx,
  input: { tenantId: string; staffId: string; actorUserId: string; ip?: string | null },
): Promise<PublicStaffMember> {
  const before = await getStaffMemberById(db, input);
  if (before.active) throw validationError("Staff member is not archived");

  // P3-AUDIT-006: the user link was validated when it was made (migration 022), but the account may
  // have left the school while this record was archived. A restored record never keeps a link to a
  // user who is no longer an active member: the link is cleared (and the audit event says so).
  // A different active record may meanwhile have taken the same user: that is a 409, not a 500.
  let result;
  try {
    result = await db.query<StaffRow>(
      `UPDATE staff_members s
          SET active = true, archived_at = NULL, updated_at = now(),
              user_id = CASE
                WHEN s.user_id IS NULL THEN NULL
                WHEN EXISTS (
                  SELECT 1 FROM school_memberships m
                   WHERE m.user_id = s.user_id AND m.tenant_id = s.tenant_id AND m.archived_at IS NULL
                ) THEN s.user_id
                ELSE NULL
              END
        WHERE s.id = $1 AND s.tenant_id = $2 AND s.active = false
        RETURNING ${SELECT_COLS}`,
      [input.staffId, input.tenantId],
    );
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") throw conflict("Another active staff member is already linked to that user account");
    throw err;
  }
  const row = result.rows[0];
  if (!row) throw notFound("Staff member not found");
  await recordSecurityEvent(db, {
    eventType: "directory.staff.restored",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { staffId: row.id, userLinkCleared: before.userId !== null && row.user_id === null },
    ip: input.ip ?? null,
  });
  return mapPublic(row);
}
