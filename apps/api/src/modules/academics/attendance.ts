import type { Tx } from "../../db/sql.js";
import { conflict, forbidden, notFound, validationError } from "../../http/errors.js";
import { hasPermission } from "../rbac/authorize.js";
import type { AuthzContext } from "../rbac/authorize.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { userMayTeachClass } from "./structure.js";
import { pgCode, pgMessage } from "./pgError.js";
import { pageQuery, type Page, type PageInput } from "./pagination.js";
import { decodeCursor, pageFingerprint, pageFromKeysetRows } from "../../http/pagination.js";

export const AFTERNOON_DISABLED_MESSAGE =
  "This school does not take an afternoon register. It can be turned on in the attendance settings.";

const PHONE = /^\+?[0-9][0-9 ()-]{5,19}$/;

function isoStamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function isoDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  // node-pg parses a DATE as local midnight. UTC parts shift the calendar day west of UTC.
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function trim(value: string, field: string, max: number): string {
  const t = value.trim();
  if (t.length < 1 || t.length > max) throw validationError(`${field} must be 1–${max} characters`);
  return t;
}

function mapRegisterError(err: unknown): never {
  const code = pgCode(err);
  const message = pgMessage(err);
  if (code === "23514") {
    if (message.includes("afternoon register")) throw validationError(AFTERNOON_DISABLED_MESSAGE);
    if (message.includes("register is dated")) throw validationError(message);
    throw validationError("Invalid attendance register");
  }
  if (code === "23503") throw validationError("Learner, class or term must belong to this school");
  throw err;
}

export type AttendanceMark = "present" | "absent" | "late" | "excused";
export type AttendanceSession = "morning" | "afternoon";

export interface PublicRegister {
  id: string;
  tenantId: string;
  session: AttendanceSession;
  learner_id: string;
  class_id: string;
  term_id: string;
  taken_by: string;
  taken_on: string;
  mark: AttendanceMark;
  note: string | null;
  marked_at: string;
}

type RegisterRow = {
  id: string;
  tenant_id: string;
  learner_id: string;
  class_id: string;
  term_id: string;
  taken_by: string;
  taken_on: Date | string;
  mark: AttendanceMark;
  note: string | null;
  marked_at: Date | string;
};

function mapRegister(row: RegisterRow, session: AttendanceSession): PublicRegister {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    session,
    learner_id: row.learner_id,
    class_id: row.class_id,
    term_id: row.term_id,
    taken_by: row.taken_by,
    taken_on: isoDate(row.taken_on),
    mark: row.mark,
    note: row.note,
    marked_at: isoStamp(row.marked_at)!,
  };
}

const REGISTER_RETURNING = `id, tenant_id, learner_id, class_id, term_id, taken_by, taken_on, mark, note, marked_at`;

/** Omitted, null and morning all mean the morning register only. */
export function resolveSession(session: string | null | undefined): AttendanceSession {
  if (session === undefined || session === null || session === "morning") return "morning";
  if (session === "afternoon") return "afternoon";
  throw validationError("session must be morning or afternoon");
}

export async function getAttendanceSettings(tx: Tx, input: { tenantId: string }) {
  const res = await tx.query<{ afternoon_enabled: boolean; percentage_mode: "session" | "day"; updated_at: Date | string | null }>(
    `SELECT afternoon_enabled, percentage_mode, updated_at
       FROM attendance_settings WHERE tenant_id = $1`,
    [input.tenantId],
  );
  const row = res.rows[0];
  if (!row) {
    return { tenantId: input.tenantId, afternoon_enabled: false, percentage_mode: "session" as const, updated_at: null };
  }
  return {
    tenantId: input.tenantId,
    afternoon_enabled: row.afternoon_enabled,
    percentage_mode: row.percentage_mode,
    updated_at: isoStamp(row.updated_at),
  };
}

export async function upsertAttendanceSettings(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    afternoon_enabled: boolean;
    percentage_mode: "session" | "day";
    ip?: string | null;
  },
) {
  const res = await tx.query<{ afternoon_enabled: boolean; percentage_mode: "session" | "day"; updated_at: Date | string }>(
    `INSERT INTO attendance_settings (tenant_id, afternoon_enabled, percentage_mode)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE
       SET afternoon_enabled = EXCLUDED.afternoon_enabled,
           percentage_mode = EXCLUDED.percentage_mode,
           updated_at = now()
     RETURNING afternoon_enabled, percentage_mode, updated_at`,
    [input.tenantId, input.afternoon_enabled, input.percentage_mode],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "attendance.settings.updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { afternoonEnabled: row.afternoon_enabled, percentageMode: row.percentage_mode },
    ip: input.ip,
  });
  return {
    tenantId: input.tenantId,
    afternoon_enabled: row.afternoon_enabled,
    percentage_mode: row.percentage_mode,
    updated_at: isoStamp(row.updated_at),
  };
}

/**
 * Review R10-1: the caller is authorised against class_id, so the learner must be a member of that
 * class (an archived membership still counts, so a past register can be corrected after a move),
 * and the term must belong to the class's academic year. Without this a teacher of one class could
 * write any learner's register in the school by naming their own class.
 */
async function assertRegisterTarget(
  tx: Tx,
  input: { tenantId: string; learner_id: string; class_id: string; term_id: string },
): Promise<void> {
  const res = await tx.query<{ learner: boolean; member: boolean; term_ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM learners WHERE tenant_id = $1 AND id = $2) AS learner,
            EXISTS (SELECT 1 FROM class_memberships cm
                     WHERE cm.tenant_id = $1 AND cm.learner_id = $2 AND cm.class_id = $3) AS member,
            EXISTS (SELECT 1 FROM classes c
                      JOIN academic_terms t ON t.tenant_id = c.tenant_id AND t.academic_year_id = c.academic_year_id
                     WHERE c.tenant_id = $1 AND c.id = $3 AND t.id = $4) AS term_ok`,
    [input.tenantId, input.learner_id, input.class_id, input.term_id],
  );
  const row = res.rows[0];
  if (!row?.learner) throw validationError("learner_id must belong to this school");
  if (!row.member) throw validationError("learner_id is not a member of class_id");
  if (!row.term_ok) throw validationError("term_id must belong to the class's academic year");
}

const REGISTER_TABLE: Record<AttendanceSession, "attendance" | "attendance_afternoon"> = {
  morning: "attendance",
  afternoon: "attendance_afternoon",
};

/**
 * R10-5: what the write did.
 * - applied: the register row was created or changed.
 * - unchanged: the stored row already says this (an identical retry); nothing changed.
 * - stale_ignored: newest-wins kept a newer stored mark; this older submission changed nothing.
 */
export type RegisterOutcome = "applied" | "unchanged" | "stale_ignored";

type RegisterInput = {
  tenantId: string;
  actorUserId: string;
  learner_id: string;
  class_id: string;
  term_id: string;
  taken_on: string;
  mark: AttendanceMark;
  note?: string | null;
  marked_at?: string | null;
  ip?: string | null;
};

async function upsertRegister(
  tx: Tx,
  session: AttendanceSession,
  input: RegisterInput,
): Promise<{ register: PublicRegister; outcome: RegisterOutcome }> {
  await assertRegisterTarget(tx, input);
  const note = input.note === undefined || input.note === null || input.note.trim() === "" ? null : trim(input.note, "note", 500);
  const table = REGISTER_TABLE[session];
  try {
    const before = await tx.query<RegisterRow>(
      `SELECT ${REGISTER_RETURNING} FROM ${table} WHERE tenant_id = $1 AND learner_id = $2 AND taken_on = $3::date FOR UPDATE`,
      [input.tenantId, input.learner_id, input.taken_on],
    );
    const res = await tx.query<RegisterRow>(
      `INSERT INTO ${table}
         (tenant_id, learner_id, class_id, term_id, taken_by, taken_on, mark, note, marked_at)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, COALESCE($9::timestamptz, now()))
       ON CONFLICT (learner_id, taken_on) DO UPDATE SET
         class_id = EXCLUDED.class_id,
         term_id = EXCLUDED.term_id,
         taken_by = EXCLUDED.taken_by,
         mark = EXCLUDED.mark,
         note = EXCLUDED.note,
         marked_at = EXCLUDED.marked_at
       RETURNING ${REGISTER_RETURNING}`,
      [
        input.tenantId,
        input.learner_id,
        input.class_id,
        input.term_id,
        input.actorUserId,
        input.taken_on,
        input.mark,
        note,
        input.marked_at ?? null,
      ],
    );
    const row = res.rows[0]!;
    const old = before.rows[0];
    let outcome: RegisterOutcome = "applied";
    if (old && sameRegister(old, row)) {
      // The guard kept the stored row. Identical content is a retry; anything else lost to a newer mark.
      const asked = old.class_id === input.class_id && old.term_id === input.term_id && old.mark === input.mark && old.note === note;
      outcome = asked ? "unchanged" : "stale_ignored";
    }
    if (outcome === "applied") {
      await recordSecurityEvent(tx, {
        eventType: "attendance.register.upserted",
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        detail: { registerId: row.id, session, learnerId: row.learner_id, takenOn: isoDate(row.taken_on) },
        ip: input.ip,
      });
    } else if (outcome === "stale_ignored") {
      // Observable, but not recorded as a change: the stored register is untouched.
      await recordSecurityEvent(tx, {
        eventType: "attendance.register.stale_ignored",
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        detail: {
          registerId: row.id,
          session,
          learnerId: row.learner_id,
          takenOn: isoDate(row.taken_on),
          submittedMarkedAt: input.marked_at ?? null,
          storedMarkedAt: isoStamp(row.marked_at),
        },
        ip: input.ip,
      });
    }
    return { register: mapRegister(row, session), outcome };
  } catch (err) {
    mapRegisterError(err);
  }
}

function sameRegister(a: RegisterRow, b: RegisterRow): boolean {
  return (
    a.id === b.id &&
    a.class_id === b.class_id &&
    a.term_id === b.term_id &&
    a.taken_by === b.taken_by &&
    a.mark === b.mark &&
    a.note === b.note &&
    isoStamp(a.marked_at) === isoStamp(b.marked_at)
  );
}

export function upsertMorningRegister(tx: Tx, input: RegisterInput) {
  return upsertRegister(tx, "morning", input);
}

export function upsertAfternoonRegister(tx: Tx, input: RegisterInput) {
  return upsertRegister(tx, "afternoon", input);
}

export async function getRegisterById(
  tx: Tx,
  input: { tenantId: string; session: AttendanceSession; registerId: string },
): Promise<PublicRegister | null> {
  const res = await tx.query<RegisterRow>(
    `SELECT ${REGISTER_RETURNING} FROM ${REGISTER_TABLE[input.session]} WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.registerId],
  );
  return res.rows[0] ? mapRegister(res.rows[0], input.session) : null;
}

/**
 * Registers of both sessions (or one), newest date first, paged. `scopeClassIds` (OD-2) limits a
 * teacher to the classes they teach; null means every class (attendance readers).
 */
export async function listRegisters(
  tx: Tx,
  input: {
    tenantId: string;
    classId?: string;
    takenOn?: string;
    session?: AttendanceSession;
    scopeClassIds: readonly string[] | null;
    page: PageInput;
  },
): Promise<Page<PublicRegister>> {
  const params: unknown[] = [input.tenantId];
  const filters: string[] = [];
  if (input.classId) {
    params.push(input.classId);
    filters.push(`class_id = $${params.length}`);
  }
  if (input.takenOn) {
    params.push(input.takenOn);
    filters.push(`taken_on = $${params.length}::date`);
  }
  if (input.scopeClassIds) {
    params.push(input.scopeClassIds);
    filters.push(`class_id = ANY($${params.length}::uuid[])`);
  }
  const where = filters.length ? ` AND ${filters.join(" AND ")}` : "";
  const parts: string[] = [];
  if (!input.session || input.session === "morning") {
    parts.push(`SELECT ${REGISTER_RETURNING}, 'morning'::text AS session FROM attendance WHERE tenant_id = $1${where}`);
  }
  if (!input.session || input.session === "afternoon") {
    parts.push(`SELECT ${REGISTER_RETURNING}, 'afternoon'::text AS session FROM attendance_afternoon WHERE tenant_id = $1${where}`);
  }
  const out = await pageQuery<RegisterRow & { session: AttendanceSession }>(
    tx,
    parts.join(" UNION ALL "),
    params,
    { name: "attendance_registers", expr: "q.taken_on", type: "date", dir: "desc" },
    input.page,
  );
  return { items: out.rows.map((row) => mapRegister(row, row.session)), page: out.page };
}

const COUNTED_SESSIONS = new Set(["morning", "afternoon", "day"]);

/**
 * OD-4 counted attendance, one term at a time (termId is required: an unbounded all-time scan is
 * refused), optionally one class, keyset-paged on (taken_on, learner_id, session) with the FIG-1621
 * cursor (bound to tenant, term and class).
 */
export async function listCounted(
  tx: Tx,
  input: { tenantId: string; termId: string; classId?: string; page: PageInput },
): Promise<Page<{ class_id: string; learner_id: string; taken_on: string; session: "morning" | "afternoon" | "day"; here: boolean }>> {
  const sort = "attendance_counted";
  const fingerprint = pageFingerprint(sort, { tenantId: input.tenantId, termId: input.termId, classId: input.classId ?? null });
  const cursor = decodeCursor(input.page.rawCursor, {
    sort,
    fingerprint,
    keySpecs: [{ kind: "text", maxLen: 10 }, { kind: "uuid" }, { kind: "text", maxLen: 9 }],
  });
  if (cursor && (!/^\d{4}-\d{2}-\d{2}$/.test(cursor.k[0]!) || !COUNTED_SESSIONS.has(cursor.k[2]!))) {
    throw validationError("cursor is invalid");
  }
  const res = await tx.query<{ class_id: string; learner_id: string; taken_on: string; session: "morning" | "afternoon" | "day"; here: boolean }>(
    `SELECT class_id, learner_id, taken_on::text AS taken_on, session, here
       FROM attendance_counted_page($1::uuid, $2::uuid, $3::uuid, $4::date, $5::uuid, $6::text, $7::int)`,
    [
      input.tenantId,
      input.termId,
      input.classId ?? null,
      cursor?.k[0] ?? null,
      cursor?.k[1] ?? null,
      cursor?.k[2] ?? null,
      input.page.limit + 1,
    ],
  );
  const out = pageFromKeysetRows(res.rows, {
    limit: input.page.limit,
    sort,
    fingerprint,
    keysOf: (row) => [row.taken_on, row.learner_id, row.session],
  });
  return {
    items: out.items.map((row) => ({
      class_id: row.class_id,
      learner_id: row.learner_id,
      taken_on: row.taken_on,
      session: row.session,
      here: row.here,
    })),
    page: out.page,
  };
}

export async function userIsClassTeacher(
  tx: Tx,
  input: { tenantId: string; userId: string; classId: string },
): Promise<boolean> {
  const res = await tx.query(
    `SELECT 1 FROM staff_members sm
      JOIN classes c ON c.tenant_id = sm.tenant_id AND c.class_teacher_staff_id = sm.id
     WHERE sm.tenant_id = $1 AND sm.user_id = $2 AND sm.active = true
       AND c.id = $3 AND c.active = true
     LIMIT 1`,
    [input.tenantId, input.userId, input.classId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function assertCanTakeRegister(
  tx: Tx,
  authz: AuthzContext,
  classId: string,
  ip: string | null,
  takenOn?: string,
  session?: AttendanceSession,
): Promise<void> {
  if (await hasPermission(tx, authz, "resource.attendance.write")) return;
  if (authz.tenantId && (await userMayTeachClass(tx, { tenantId: authz.tenantId, userId: authz.userId, classId }))) {
    return;
  }
  if (authz.tenantId && takenOn) {
    const cov = await tx.query(
      `SELECT 1 FROM attendance_coverage ac
        JOIN staff_members sm ON sm.tenant_id = ac.tenant_id AND sm.id = ac.covering_staff_id
       WHERE ac.tenant_id = $1 AND ac.class_id = $2 AND ac.coverage_date = $3::date
         AND ac.status = 'active' AND sm.user_id = $4 AND sm.active = true
         AND (ac.session = 'all_day' OR ac.session = $5)
       LIMIT 1`,
      [authz.tenantId, classId, takenOn, authz.userId, session ?? "morning"],
    );
    if ((cov.rowCount ?? 0) > 0) return;
  }
  const { requirePermission } = await import("../rbac/authorize.js");
  await requirePermission(tx, authz, "resource.attendance.write", { ip, deferAudit: true });
}

export interface PublicEarlySignOut {
  id: string;
  tenantId: string;
  learner_id: string;
  class_id: string | null;
  learner_name: string;
  class_name: string | null;
  taken_on: string;
  signed_out_at: string;
  signed_out_local: string;
  reason: string;
  collected_by_name: string;
  collected_by_relationship: string;
  recorded_by: string | null;
  voided_at: string | null;
}

export interface CollectorFields {
  id_number: string;
  phone: string;
  authorised_by: string;
  note: string | null;
  void_reason: string | null;
}

function mapSignOut(row: {
  id: string;
  tenant_id: string;
  learner_id: string;
  class_id: string | null;
  learner_name: string;
  class_name: string | null;
  taken_on: Date | string;
  signed_out_at: Date | string;
  signed_out_local: string;
  reason: string;
  collected_by_name: string;
  collected_by_relationship: string;
  recorded_by: string | null;
  voided_at: Date | string | null;
}): PublicEarlySignOut {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    learner_id: row.learner_id,
    class_id: row.class_id,
    learner_name: row.learner_name,
    class_name: row.class_name,
    taken_on: isoDate(row.taken_on),
    signed_out_at: isoStamp(row.signed_out_at)!,
    signed_out_local: String(row.signed_out_local).slice(0, 8),
    reason: row.reason,
    collected_by_name: row.collected_by_name,
    collected_by_relationship: row.collected_by_relationship,
    recorded_by: row.recorded_by,
    voided_at: isoStamp(row.voided_at),
  };
}

const SIGN_OUT_COLS = `id, tenant_id, learner_id, class_id, learner_name, class_name, taken_on,
  signed_out_at, signed_out_local::text AS signed_out_local, reason, collected_by_name,
  collected_by_relationship, recorded_by, voided_at`;

export async function recordEarlySignOut(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    authz: AuthzContext;
    learner_id: string;
    reason: string;
    collected_by_name: string;
    collected_by_relationship: string;
    id_number: string;
    phone: string;
    authorised_by: string;
    note?: string | null;
    signed_out_time?: string | null;
    ip?: string | null;
  },
): Promise<{ sign_out: PublicEarlySignOut; collector: CollectorFields | null }> {
  const reason = trim(input.reason, "reason", 200);
  const collected_by_name = trim(input.collected_by_name, "collected_by_name", 120);
  const collected_by_relationship = trim(input.collected_by_relationship, "collected_by_relationship", 60);
  const id_number = trim(input.id_number, "id_number", 30);
  if (id_number.length < 3) throw validationError("Enter the collector's ID number.");
  const phone = input.phone.trim();
  if (!PHONE.test(phone)) throw validationError("Enter the collector's phone number.");
  const authorised_by = trim(input.authorised_by, "authorised_by", 120);
  const note =
    input.note === undefined || input.note === null || input.note.trim() === "" ? null : input.note.trim();
  if (note && note.length > 500) throw validationError("The note can be up to 500 characters.");

  // Authorization FIRST: a caller who may not record sign-outs must learn nothing about whether a learner id exists, is archived or
  // is in a class (every such failure is the same 403 for them). The row lock is taken only after the gate.
  const canWrite = await hasPermission(tx, input.authz, "resource.attendance.write");
  const learner = await tx.query<{ full_name: string; active: boolean; class_id: string | null; class_name: string | null }>(
    `SELECT l.full_name, l.active, c.id AS class_id, c.name AS class_name
       FROM learners l
       LEFT JOIN class_memberships cm
         ON cm.tenant_id = l.tenant_id AND cm.learner_id = l.id AND cm.active = true
       LEFT JOIN classes c ON c.tenant_id = cm.tenant_id AND c.id = cm.class_id AND c.active = true
       LEFT JOIN academic_years y ON y.tenant_id = c.tenant_id AND y.id = c.academic_year_id
      WHERE l.tenant_id = $1 AND l.id = $2
      ORDER BY y.is_current DESC NULLS LAST, cm.created_at DESC
      LIMIT 1`,
    [input.tenantId, input.learner_id],
  );
  const who = learner.rows[0];
  const refuse = () => forbidden("You can't record a sign-out for this learner.");
  if (!who) throw canWrite ? validationError("learner_id must belong to this school") : refuse();
  if (!who.active) throw canWrite ? validationError("This learner is archived.") : refuse();
  if (!who.class_id) throw canWrite ? validationError("This learner is not in a class.") : refuse();

  const classTeacher = canWrite
    ? false
    : await userIsClassTeacher(tx, { tenantId: input.tenantId, userId: input.actorUserId, classId: who.class_id });
  if (!canWrite && !classTeacher) throw refuse();
  await tx.query(`SELECT id FROM learners WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [input.tenantId, input.learner_id]);

  const clock = await tx.query<{ at: Date; local_time: string; today: string; too_future: boolean }>(
    `SELECT v.at,
            to_char(LEAST(v.at, now()) AT TIME ZONE z.z, 'HH24:MI:SS') AS local_time,
            (now() AT TIME ZONE z.z)::date::text AS today,
            (v.at > now() + interval '2 minutes') AS too_future
       FROM (SELECT COALESCE(timezone, 'Africa/Nairobi') AS z FROM tenants WHERE id = $1) z,
       LATERAL (
         SELECT CASE
           WHEN $2::time IS NULL THEN now()
           ELSE ((now() AT TIME ZONE z.z)::date + $2::time) AT TIME ZONE z.z
         END AS at
       ) v`,
    [input.tenantId, input.signed_out_time ?? null],
  );
  const when = clock.rows[0];
  if (!when) throw validationError("unknown school");
  if (when.too_future) throw validationError("The time out can't be in the future.");

  const dup = await tx.query(
    `SELECT 1 FROM early_sign_outs
      WHERE learner_id = $1 AND taken_on = $2::date AND voided_at IS NULL
        AND abs(extract(epoch FROM (signed_out_at - LEAST($3::timestamptz, now())))) < 300`,
    [input.learner_id, when.today, when.at],
  );
  if ((dup.rowCount ?? 0) > 0) throw conflict("This learner was already signed out a moment ago.");

  const inserted = await tx.query(
    `INSERT INTO early_sign_outs
       (tenant_id, learner_id, class_id, learner_name, class_name, taken_on, signed_out_at,
        signed_out_local, reason, collected_by_name, collected_by_relationship, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6::date, LEAST($7::timestamptz, now()), $8::time, $9, $10, $11, $12)
     RETURNING ${SIGN_OUT_COLS}`,
    [
      input.tenantId,
      input.learner_id,
      who.class_id,
      who.full_name,
      who.class_name,
      when.today,
      when.at,
      when.local_time,
      reason,
      collected_by_name,
      collected_by_relationship,
      input.actorUserId,
    ],
  );
  const row = inserted.rows[0] as Parameters<typeof mapSignOut>[0];
  await tx.query(
    `INSERT INTO early_sign_out_collectors (sign_out_id, tenant_id, id_number, phone, authorised_by, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.id, input.tenantId, id_number, phone, authorised_by, note],
  );
  await recordSecurityEvent(tx, {
    eventType: "attendance.early_sign_out.recorded",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { signOutId: row.id, learnerId: row.learner_id },
    ip: input.ip,
  });
  const collectorAllowed = await hasPermission(tx, input.authz, "resource.early_sign_out.collector.read");
  return {
    sign_out: mapSignOut(row),
    collector: collectorAllowed ? { id_number, phone, authorised_by, note, void_reason: null } : null,
  };
}

export async function getEarlySignOut(
  tx: Tx,
  input: { tenantId: string; signOutId: string; includeCollector: boolean },
): Promise<{ sign_out: PublicEarlySignOut; collector: CollectorFields | null }> {
  const res = await tx.query(
    `SELECT ${SIGN_OUT_COLS} FROM early_sign_outs WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.signOutId],
  );
  const row = res.rows[0] as Parameters<typeof mapSignOut>[0] | undefined;
  if (!row) throw notFound("Early sign-out not found");
  let collector: CollectorFields | null = null;
  if (input.includeCollector) {
    const c = await tx.query<CollectorFields>(
      `SELECT id_number, phone, authorised_by, note, void_reason
         FROM early_sign_out_collectors WHERE sign_out_id = $1 AND tenant_id = $2`,
      [row.id, input.tenantId],
    );
    collector = c.rows[0] ?? null;
  }
  return { sign_out: mapSignOut(row), collector };
}

export async function listEarlySignOuts(
  tx: Tx,
  input: {
    tenantId: string;
    takenOn?: string;
    includeCollector: boolean;
    /** OD-2: a teacher sees only sign-outs of learners in classes they teach, and never collector PII. */
    scopeClassIds: readonly string[] | null;
    page: PageInput;
  },
) {
  const params: unknown[] = [input.tenantId];
  const filters: string[] = [];
  if (input.takenOn) {
    params.push(input.takenOn);
    filters.push(`taken_on = $${params.length}::date`);
  }
  if (input.scopeClassIds) {
    params.push(input.scopeClassIds);
    filters.push(`class_id = ANY($${params.length}::uuid[])`);
  }
  const where = filters.length ? ` AND ${filters.join(" AND ")}` : "";
  const out = await pageQuery<Parameters<typeof mapSignOut>[0]>(
    tx,
    `SELECT ${SIGN_OUT_COLS} FROM early_sign_outs WHERE tenant_id = $1${where}`,
    params,
    { name: "early_sign_outs", expr: "q.signed_out_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  const rows = out.rows;
  const includeCollector = input.includeCollector && input.scopeClassIds === null;
  if (!includeCollector) {
    return { items: rows.map((row) => ({ sign_out: mapSignOut(row), collector: null })), page: out.page };
  }
  const ids = rows.map((row) => row.id);
  const collectors = ids.length
    ? await tx.query<CollectorFields & { sign_out_id: string }>(
        `SELECT sign_out_id, id_number, phone, authorised_by, note, void_reason
           FROM early_sign_out_collectors WHERE tenant_id = $1 AND sign_out_id = ANY($2::uuid[])`,
        [input.tenantId, ids],
      )
    : { rows: [] as Array<CollectorFields & { sign_out_id: string }> };
  const byId = new Map(collectors.rows.map((c) => [c.sign_out_id, c]));
  return {
    items: rows.map((row) => {
      const c = byId.get(row.id);
      return {
        sign_out: mapSignOut(row),
        collector: c
          ? { id_number: c.id_number, phone: c.phone, authorised_by: c.authorised_by, note: c.note, void_reason: c.void_reason }
          : null,
      };
    }),
    page: out.page,
  };
}

export async function voidEarlySignOut(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; authz: AuthzContext; signOutId: string; reason: string; ip?: string | null },
) {
  const reason = trim(input.reason, "reason", 200);
  const existing = await tx.query<{ recorded_by: string | null; voided_at: Date | null }>(
    `SELECT recorded_by, voided_at FROM early_sign_outs WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.signOutId],
  );
  const row = existing.rows[0];
  if (!row) throw notFound("Early sign-out not found");
  if (row.voided_at) throw conflict("This sign-out is already voided");
  const canWrite = await hasPermission(tx, input.authz, "resource.attendance.write");
  if (!canWrite && row.recorded_by !== input.actorUserId) {
    throw forbidden("You can't void this sign-out.");
  }
  await tx.query(
    `UPDATE early_sign_outs SET voided_at = now(), voided_by = $3 WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.signOutId, input.actorUserId],
  );
  await tx.query(
    `UPDATE early_sign_out_collectors SET void_reason = $3 WHERE tenant_id = $1 AND sign_out_id = $2`,
    [input.tenantId, input.signOutId, reason],
  );
  await recordSecurityEvent(tx, {
    eventType: "attendance.early_sign_out.voided",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { signOutId: input.signOutId },
    ip: input.ip,
  });
  const includeCollector = await hasPermission(tx, input.authz, "resource.early_sign_out.collector.read");
  return getEarlySignOut(tx, { tenantId: input.tenantId, signOutId: input.signOutId, includeCollector });
}

export interface PublicAttendanceCoverage {
  id: string;
  tenantId: string;
  class_id: string;
  covering_staff_id: string;
  covered_staff_id: string | null;
  coverage_date: string;
  session: "morning" | "afternoon" | "all_day";
  reason: string | null;
  status: "active" | "cancelled";
  created_by: string | null;
  created_at: string;
  cancelled_at: string | null;
}

type CoverageRow = {
  id: string;
  tenant_id: string;
  class_id: string;
  covering_staff_id: string;
  covered_staff_id: string | null;
  coverage_date: Date | string;
  session: "morning" | "afternoon" | "all_day";
  reason: string | null;
  status: "active" | "cancelled";
  created_by: string | null;
  created_at: Date | string;
  cancelled_at: Date | string | null;
};

const COVERAGE_COLS = `id, tenant_id, class_id, covering_staff_id, covered_staff_id, coverage_date::text AS coverage_date,
  session, reason, status, created_by, created_at, cancelled_at`;

function mapCoverage(r: CoverageRow): PublicAttendanceCoverage {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    class_id: r.class_id,
    covering_staff_id: r.covering_staff_id,
    covered_staff_id: r.covered_staff_id,
    coverage_date: isoDate(r.coverage_date),
    session: r.session,
    reason: r.reason,
    status: r.status,
    created_by: r.created_by,
    created_at: isoStamp(r.created_at)!,
    cancelled_at: isoStamp(r.cancelled_at),
  };
}

export async function assignAttendanceCoverage(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    class_id: string;
    covering_staff_id: string;
    covered_staff_id?: string | null;
    coverage_date: string;
    session?: "morning" | "afternoon" | "all_day";
    reason?: string | null;
    ip?: string | null;
  },
): Promise<PublicAttendanceCoverage> {
  const cls = await tx.query(`SELECT 1 FROM classes WHERE tenant_id = $1 AND id = $2 AND active = true`, [
    input.tenantId,
    input.class_id,
  ]);
  if (cls.rowCount === 0) throw validationError("class_id must be an active class in this school");
  const covering = await tx.query(`SELECT 1 FROM staff_members WHERE tenant_id = $1 AND id = $2 AND active = true`, [
    input.tenantId,
    input.covering_staff_id,
  ]);
  if (covering.rowCount === 0) throw validationError("covering_staff_id must be an active staff member in this school");
  if (input.covered_staff_id) {
    if (input.covered_staff_id === input.covering_staff_id) {
      throw validationError("covering_staff_id and covered_staff_id cannot be the same");
    }
    const covered = await tx.query(`SELECT 1 FROM staff_members WHERE tenant_id = $1 AND id = $2 AND active = true`, [
      input.tenantId,
      input.covered_staff_id,
    ]);
    if (covered.rowCount === 0) throw validationError("covered_staff_id must be an active staff member in this school");
  }
  const reason = input.reason?.trim() ? trim(input.reason, "reason", 300) : null;
  const session = input.session ?? "all_day";
  try {
    const res = await tx.query<CoverageRow>(
      `INSERT INTO attendance_coverage
         (tenant_id, class_id, covering_staff_id, covered_staff_id, coverage_date, session, reason, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8)
       RETURNING ${COVERAGE_COLS}`,
      [
        input.tenantId,
        input.class_id,
        input.covering_staff_id,
        input.covered_staff_id ?? null,
        input.coverage_date,
        session,
        reason,
        input.actorUserId,
      ],
    );
    const row = res.rows[0]!;
    await recordSecurityEvent(tx, {
      eventType: "attendance.coverage.assigned",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { coverageId: row.id, classId: row.class_id, coveringStaffId: row.covering_staff_id, date: row.coverage_date },
      ip: input.ip,
    });
    return mapCoverage(row);
  } catch (err) {
    if (pgCode(err) === "23505") throw conflict("Active coverage already exists for this class, date and session");
    if (pgCode(err) === "23503") throw validationError("Invalid class or staff reference");
    throw err;
  }
}

export async function listAttendanceCoverage(
  tx: Tx,
  input: { tenantId: string; classId?: string; coverageDate?: string; page: PageInput },
): Promise<Page<PublicAttendanceCoverage>> {
  const params: unknown[] = [input.tenantId];
  const parts: string[] = ["tenant_id = $1"];
  if (input.classId) {
    params.push(input.classId);
    parts.push(`class_id = $${params.length}`);
  }
  if (input.coverageDate) {
    params.push(input.coverageDate);
    parts.push(`coverage_date = $${params.length}::date`);
  }
  const out = await pageQuery<{ id: string }>(
    tx,
    `SELECT ${COVERAGE_COLS} FROM attendance_coverage WHERE ${parts.join(" AND ")}`,
    params,
    { name: "attendance_coverage", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: (out.rows as unknown as CoverageRow[]).map(mapCoverage), page: out.page };
}

export async function cancelAttendanceCoverage(
  tx: Tx,
  input: { tenantId: string; coverageId: string; actorUserId: string; ip?: string | null },
): Promise<PublicAttendanceCoverage> {
  const res = await tx.query<CoverageRow>(
    `UPDATE attendance_coverage
        SET status = 'cancelled', cancelled_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'
      RETURNING ${COVERAGE_COLS}`,
    [input.tenantId, input.coverageId],
  );
  const row = res.rows[0];
  if (!row) {
    const exists = await tx.query(`SELECT 1 FROM attendance_coverage WHERE tenant_id = $1 AND id = $2`, [
      input.tenantId,
      input.coverageId,
    ]);
    if (exists.rowCount === 0) throw notFound("Coverage assignment not found");
    throw conflict("Coverage assignment is already cancelled");
  }
  await recordSecurityEvent(tx, {
    eventType: "attendance.coverage.cancelled",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { coverageId: row.id },
    ip: input.ip,
  });
  return mapCoverage(row);
}
