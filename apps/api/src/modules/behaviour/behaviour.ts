import type { Tx } from "../../db/sql.js";
import { conflict, forbidden, notFound, validationError } from "../../http/errors.js";
import { pageQuery, type Page, type PageInput } from "../academics/pagination.js";
import { pgCode, pgMessage } from "../academics/pgError.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { teachingClassIds } from "../academics/teaching.js";
import { loadEffectivePermissions, requirePermission, type AuthzContext } from "../rbac/authorize.js";
import { schoolToday } from "../tenancy/schoolClock.js";
import { behaviourPeriod, pointsFromSums, type BehaviourMode, type BehaviourReset, type PointsResult } from "./points.js";

/**
 * The behaviour and discipline log (docs/BEHAVIOUR.md). A port of the live Supabase feature. Who may read or write what is
 * decided here, on every request; the database guards the rest (migration 118: the sign and size of the points, the category's
 * kind, the date, the recorder, and that an entry is only ever voided or followed up).
 */
export const DISCIPLINE_READ = "resource.discipline.read" as const;
export const DISCIPLINE_WRITE = "resource.discipline.write" as const;
export const BEHAVIOUR_RECORD = "resource.behaviour.record" as const;

export type BehaviourKind = "merit" | "demerit" | "incident";
export type BehaviourSeverity = "minor" | "major" | "serious";

export interface BehaviourThreshold {
  points: number;
  label: string;
}

export interface BehaviourSettings {
  points_enabled: boolean;
  mode: BehaviourMode;
  starting_points: number;
  reset: BehaviourReset;
  max_points_per_entry: number;
  thresholds: BehaviourThreshold[];
  parents_see_demerits: boolean;
  parents_see_incidents: boolean;
}

/** What a school has before the office changes anything (packages/shared/src/behaviour.ts, DEFAULT_BEHAVIOUR_SETTINGS). */
export const DEFAULT_BEHAVIOUR_SETTINGS: BehaviourSettings = {
  points_enabled: true,
  mode: "both",
  starting_points: 100,
  reset: "term",
  max_points_per_entry: 10,
  thresholds: [
    { points: -15, label: "Parent meeting" },
    { points: 30, label: "Certificate" },
  ],
  parents_see_demerits: false,
  parents_see_incidents: false,
};

// ---------------------------------------------------------------- who may do what

/**
 * What the caller may do with the log. `office` (the Discipline area, a full administrator): everything at the school.
 * Otherwise a teacher (`resource.behaviour.record`): the learners they teach, and what they recorded themselves.
 */
export interface BehaviourAccess {
  office: boolean;
  write: boolean;
  record: boolean;
}

export async function behaviourAccess(tx: Tx, authz: AuthzContext): Promise<BehaviourAccess> {
  const perms = await loadEffectivePermissions(tx, authz);
  return { office: perms.has(DISCIPLINE_READ), write: perms.has(DISCIPLINE_WRITE), record: perms.has(BEHAVIOUR_RECORD) };
}

/** The office, or a teacher who records. Anyone else gets the usual audited 403 (for the office's permission). */
export async function requireBehaviourReader(tx: Tx, authz: AuthzContext, ip: string | null): Promise<BehaviourAccess> {
  const access = await behaviourAccess(tx, authz);
  if (!access.office && !access.record) await requirePermission(tx, authz, DISCIPLINE_READ, { ip, deferAudit: true });
  return access;
}

/** The people who set the log up: `resource.discipline.write`. */
export async function requireBehaviourWriter(tx: Tx, authz: AuthzContext, ip: string | null): Promise<void> {
  await requirePermission(tx, authz, DISCIPLINE_WRITE, { ip, deferAudit: true });
}

/**
 * Whose learners and entries the caller reads. The office reads the whole school; anyone else reads the learners of the classes
 * they teach (the same rule as the teacher reads, `teachingClassIds`) and what they recorded.
 */
export type BehaviourScope = { office: true } | { office: false; userId: string; classIds: string[] };

export async function behaviourScope(tx: Tx, input: { tenantId: string; userId: string; access: BehaviourAccess }): Promise<BehaviourScope> {
  if (input.access.office) return { office: true };
  return { office: false, userId: input.userId, classIds: await teachingClassIds(tx, { tenantId: input.tenantId, userId: input.userId }) };
}

const TAUGHT_LEARNER = (alias: string, p: number) =>
  `EXISTS (SELECT 1 FROM class_memberships tcm
            WHERE tcm.tenant_id = ${alias}.tenant_id AND tcm.learner_id = ${alias}.learner_id
              AND tcm.active = true AND tcm.archived_at IS NULL AND tcm.class_id = ANY($${p}::uuid[]))`;

/** A failure the trigger or a constraint raised, as the API's own errors (never the raw database message of a constraint). */
export function mapBehaviourDbError(err: unknown): never {
  const code = pgCode(err);
  const message = pgMessage(err);
  const own = !/violates|constraint|relation|row-level security/i.test(message);
  if (code === "22023" && own) throw validationError(message);
  if (code === "23514" && own) throw conflict(message);
  if (code === "42501" && own) throw forbidden(message);
  if (code === "23505") throw conflict("That already exists");
  if (code === "23503" || code === "23514" || code === "22023") throw validationError("That is not a valid behaviour entry");
  throw err;
}

// ---------------------------------------------------------------- settings

interface SettingsRow extends Omit<BehaviourSettings, "thresholds"> {
  thresholds: unknown;
}

export async function getBehaviourSettings(tx: Tx, tenantId: string): Promise<BehaviourSettings> {
  const res = await tx.query<SettingsRow>(
    `SELECT points_enabled, mode, starting_points, reset, max_points_per_entry, thresholds, parents_see_demerits, parents_see_incidents
       FROM behaviour_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = res.rows[0];
  if (!row) return { ...DEFAULT_BEHAVIOUR_SETTINGS, thresholds: DEFAULT_BEHAVIOUR_SETTINGS.thresholds.map((t) => ({ ...t })) };
  return { ...row, thresholds: row.thresholds as BehaviourThreshold[] };
}

export async function saveBehaviourSettings(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; settings: BehaviourSettings },
): Promise<BehaviourSettings> {
  const s = input.settings;
  const thresholds = s.thresholds.map((t) => ({ points: t.points, label: t.label.trim() }));
  const res = await tx.query<SettingsRow>(
    `INSERT INTO behaviour_settings (tenant_id, points_enabled, mode, starting_points, reset, max_points_per_entry, thresholds,
                                     parents_see_demerits, parents_see_incidents, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
     ON CONFLICT (tenant_id) DO UPDATE SET
       points_enabled = EXCLUDED.points_enabled, mode = EXCLUDED.mode, starting_points = EXCLUDED.starting_points,
       reset = EXCLUDED.reset, max_points_per_entry = EXCLUDED.max_points_per_entry, thresholds = EXCLUDED.thresholds,
       parents_see_demerits = EXCLUDED.parents_see_demerits, parents_see_incidents = EXCLUDED.parents_see_incidents,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING points_enabled, mode, starting_points, reset, max_points_per_entry, thresholds, parents_see_demerits, parents_see_incidents`,
    [
      input.tenantId,
      s.points_enabled,
      s.mode,
      s.starting_points,
      s.reset,
      s.max_points_per_entry,
      JSON.stringify(thresholds),
      s.parents_see_demerits,
      s.parents_see_incidents,
      input.actorUserId,
    ],
  );
  await recordSecurityEvent(tx, {
    eventType: "academics.behaviour.settings_updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { mode: s.mode, reset: s.reset, pointsEnabled: s.points_enabled },
  });
  const row = res.rows[0]!;
  return { ...row, thresholds: row.thresholds as BehaviourThreshold[] };
}

// ---------------------------------------------------------------- categories

export interface BehaviourCategory {
  id: string;
  kind: "merit" | "demerit";
  name: string;
  points: number;
  severity: BehaviourSeverity | null;
  sort_order: number;
  archived_at: string | null;
}

const CATEGORY_COLS = `id, kind, name, points, severity, sort_order, archived_at`;

export async function listBehaviourCategories(tx: Tx, input: { tenantId: string; includeArchived: boolean }): Promise<BehaviourCategory[]> {
  const res = await tx.query<BehaviourCategory>(
    `SELECT ${CATEGORY_COLS} FROM behaviour_categories
      WHERE tenant_id = $1 ${input.includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY kind, sort_order, lower(name), id
      LIMIT 500`,
    [input.tenantId],
  );
  return res.rows;
}

const duplicateName = (kind: string, name: string) => conflict(`There is already a ${kind} called "${name}"`);

export async function createBehaviourCategory(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; kind: "merit" | "demerit"; name: string; points: number; severity?: BehaviourSeverity | null },
): Promise<BehaviourCategory> {
  const name = input.name.trim();
  const severity = input.kind === "merit" ? null : (input.severity ?? "minor");
  if (input.kind === "merit" && input.severity) throw validationError("A merit has no severity");
  try {
    const res = await tx.query<BehaviourCategory>(
      `INSERT INTO behaviour_categories (tenant_id, kind, name, points, severity, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,100,$6) RETURNING ${CATEGORY_COLS}`,
      [input.tenantId, input.kind, name, input.points, severity, input.actorUserId],
    );
    await recordSecurityEvent(tx, {
      eventType: "academics.behaviour.category_created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { categoryId: res.rows[0]!.id, kind: input.kind },
    });
    return res.rows[0]!;
  } catch (err) {
    if (pgCode(err) === "23505") throw duplicateName(input.kind, name);
    throw err;
  }
}

export async function updateBehaviourCategory(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    categoryId: string;
    name?: string;
    points?: number;
    severity?: BehaviourSeverity;
    archived?: boolean;
  },
): Promise<BehaviourCategory> {
  const cur = await tx.query<BehaviourCategory>(`SELECT ${CATEGORY_COLS} FROM behaviour_categories WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
    input.tenantId,
    input.categoryId,
  ]);
  const existing = cur.rows[0];
  if (!existing) throw notFound("Behaviour category not found");
  if (input.severity !== undefined && existing.kind === "merit") throw validationError("A merit has no severity");
  const name = input.name !== undefined ? input.name.trim() : existing.name;
  const archivedAt = input.archived === undefined ? existing.archived_at : input.archived ? (existing.archived_at ?? new Date().toISOString()) : null;
  try {
    const res = await tx.query<BehaviourCategory>(
      `UPDATE behaviour_categories
          SET name = $3, points = $4, severity = $5, archived_at = $6::timestamptz
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${CATEGORY_COLS}`,
      [input.tenantId, input.categoryId, name, input.points ?? existing.points, input.severity ?? existing.severity, archivedAt],
    );
    const eventType =
      input.archived === true && existing.archived_at === null
        ? "academics.behaviour.category_archived"
        : input.archived === false && existing.archived_at !== null
          ? "academics.behaviour.category_restored"
          : "academics.behaviour.category_updated";
    await recordSecurityEvent(tx, {
      eventType,
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { categoryId: input.categoryId },
    });
    return res.rows[0]!;
  } catch (err) {
    if (pgCode(err) === "23505") throw duplicateName(existing.kind, name);
    throw err;
  }
}

/** The suggested categories for a Kenyan school (the Supabase add_default_behaviour_categories list). */
const DEFAULT_CATEGORIES: ReadonlyArray<readonly [kind: "merit" | "demerit", name: string, points: number, severity: BehaviourSeverity | null, order: number]> = [
  ["merit", "Helping others", 2, null, 1],
  ["merit", "Leadership", 3, null, 2],
  ["merit", "Academic effort", 2, null, 3],
  ["merit", "Clean classroom duty", 1, null, 4],
  ["merit", "Sportsmanship", 2, null, 5],
  ["demerit", "Late to class", 1, "minor", 11],
  ["demerit", "Incomplete homework", 1, "minor", 12],
  ["demerit", "Uniform not proper", 1, "minor", 13],
  ["demerit", "Disrupting class", 2, "minor", 14],
  ["demerit", "Disrespect", 3, "major", 15],
  ["demerit", "Vandalism", 5, "major", 16],
  ["demerit", "Fighting", 5, "serious", 17],
  ["demerit", "Bullying", 10, "serious", 18],
  ["demerit", "Exam malpractice", 10, "serious", 19],
];

/** Adds the suggested categories the school does not have yet (same name and kind). Returns how many were added. */
export async function addDefaultBehaviourCategories(tx: Tx, input: { tenantId: string; actorUserId: string }): Promise<number> {
  const res = await tx.query(
    `INSERT INTO behaviour_categories (tenant_id, kind, name, points, severity, sort_order, created_by)
     SELECT $1, d.kind, d.name, d.points, d.severity, d.ord, $2
       FROM unnest($3::text[], $4::text[], $5::int[], $6::text[], $7::int[]) AS d(kind, name, points, severity, ord)
      WHERE NOT EXISTS (SELECT 1 FROM behaviour_categories c
                         WHERE c.tenant_id = $1 AND c.kind = d.kind AND lower(btrim(c.name)) = lower(d.name))`,
    [
      input.tenantId,
      input.actorUserId,
      DEFAULT_CATEGORIES.map((c) => c[0]),
      DEFAULT_CATEGORIES.map((c) => c[1]),
      DEFAULT_CATEGORIES.map((c) => c[2]),
      DEFAULT_CATEGORIES.map((c) => c[3]),
      DEFAULT_CATEGORIES.map((c) => c[4]),
    ],
  );
  const added = res.rowCount ?? 0;
  await recordSecurityEvent(tx, {
    eventType: "academics.behaviour.defaults_added",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { added },
  });
  return added;
}

// ---------------------------------------------------------------- recording

export interface RecordBehaviourInput {
  tenantId: string;
  actorUserId: string;
  scope: BehaviourScope;
  learnerIds: string[];
  kind: BehaviourKind;
  categoryId: string | null;
  /** The size, positive (the kind signs it); null takes the category's default. */
  points: number | null;
  note: string | null;
  staffNote: string | null;
  occurredOn: string | null;
  subjectId: string | null;
  severity: BehaviourSeverity | null;
}

export const NOT_YOUR_LEARNER = "You can only record behaviour for learners you teach";

/**
 * One entry for each learner, with the same note and staff-only note. A teacher may record only for the learners they teach
 * (403 for any other, whatever the reason, so the answer is not an oracle for learner ids); the office for any active learner of
 * the school. Returns the new entry ids. All or none: one transaction.
 */
export async function recordBehaviour(tx: Tx, input: RecordBehaviourInput): Promise<string[]> {
  const ids = [...new Set(input.learnerIds)];
  if (ids.length === 0) throw validationError("Choose at least one learner");
  if (ids.length > 80) throw validationError("Record for at most 80 learners at once");

  if (input.scope.office) {
    const found = await tx.query<{ id: string }>(
      `SELECT id FROM learners WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND active = true AND archived_at IS NULL`,
      [input.tenantId, ids],
    );
    if (found.rows.length !== ids.length) throw validationError("Every learner must be an active learner of this school");
  } else {
    const taught = await tx.query<{ learner_id: string }>(
      `SELECT DISTINCT cm.learner_id
         FROM class_memberships cm
         JOIN learners l ON l.tenant_id = cm.tenant_id AND l.id = cm.learner_id AND l.active = true AND l.archived_at IS NULL
        WHERE cm.tenant_id = $1 AND cm.active = true AND cm.archived_at IS NULL
          AND cm.class_id = ANY($2::uuid[]) AND cm.learner_id = ANY($3::uuid[])`,
      [input.tenantId, input.scope.classIds, ids],
    );
    if (taught.rows.length !== ids.length) throw forbidden(NOT_YOUR_LEARNER);
  }

  if (input.categoryId !== null) {
    const cat = await tx.query<{ kind: string; archived_at: string | null; name: string }>(
      `SELECT kind, archived_at, name FROM behaviour_categories WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.categoryId],
    );
    const c = cat.rows[0];
    if (!c) throw notFound("Behaviour category not found");
    if (c.archived_at !== null) throw conflict(`"${c.name}" is no longer in use`);
    const ok = input.kind === "incident" ? c.kind === "demerit" : c.kind === input.kind;
    if (!ok) throw validationError(`"${c.name}" is a ${c.kind} category`);
  } else if (input.kind !== "incident") {
    throw validationError("Choose a category");
  } else if (input.note === null || input.note.trim() === "") {
    throw validationError("An incident without a category needs a note");
  }

  const occurredOn = input.occurredOn ?? (await schoolToday(tx, input.tenantId));
  const signed = input.points === null ? null : input.kind === "merit" ? input.points : -input.points;
  const staffNote = input.staffNote === null ? null : input.staffNote.trim() === "" ? null : input.staffNote.trim().slice(0, 1000);
  const created: string[] = [];
  try {
    for (const learnerId of ids) {
      const res = await tx.query<{ id: string }>(
        `INSERT INTO behaviour_entries (tenant_id, learner_id, category_id, kind, points, severity, note, occurred_on, subject_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9) RETURNING id`,
        [input.tenantId, learnerId, input.categoryId, input.kind, signed, input.kind === "incident" ? (input.severity ?? "serious") : null, input.note, occurredOn, input.subjectId],
      );
      const entryId = res.rows[0]!.id;
      created.push(entryId);
      if (staffNote !== null) {
        await tx.query(`INSERT INTO behaviour_staff_notes (entry_id, tenant_id, note, created_by) VALUES ($1,$2,$3,$4)`, [
          entryId,
          input.tenantId,
          staffNote,
          input.actorUserId,
        ]);
      }
    }
  } catch (err) {
    mapBehaviourDbError(err);
  }
  await recordSecurityEvent(tx, {
    eventType: "academics.behaviour.recorded",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { kind: input.kind, count: created.length, entryIds: created },
  });
  return created;
}

// ---------------------------------------------------------------- the log

export interface BehaviourEntry {
  id: string;
  learner_id: string;
  learner_name: string;
  admission_no: string;
  category_id: string | null;
  category_name: string | null;
  kind: BehaviourKind;
  points: number;
  severity: BehaviourSeverity | null;
  note: string | null;
  occurred_on: string;
  class_id: string | null;
  class_name: string | null;
  subject_id: string | null;
  recorded_by: string | null;
  recorder_name: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  action_taken: string | null;
  follow_up_status: "open" | "resolved" | null;
  resolved_at: string | null;
  parent_notified_at: string | null;
  /** The staff-only note. The log is for staff only: a family or a learner never reads it (S2b). */
  staff_note: string | null;
}

export interface EntryFilters {
  classId?: string;
  kind?: BehaviourKind;
  categoryId?: string;
  recordedBy?: string;
  learnerId?: string;
  from?: string;
  to?: string;
  /** Serious entries still open. */
  openOnly?: boolean;
  /** Serious entries, open or resolved. */
  seriousOnly?: boolean;
  includeVoided?: boolean;
}

const ENTRY_SELECT = `
  SELECT e.id, e.learner_id, l.full_name AS learner_name, l.admission_no, e.category_id, bc.name AS category_name, e.kind, e.points,
         e.severity, e.note, e.occurred_on::text AS occurred_on, e.class_id, cl.name AS class_name, e.subject_id, e.recorded_by,
         u.full_name AS recorder_name, e.created_at, e.voided_at, e.void_reason, e.action_taken, e.follow_up_status, e.resolved_at,
         e.parent_notified_at, sn.note AS staff_note
    FROM behaviour_entries e
    JOIN learners l ON l.tenant_id = e.tenant_id AND l.id = e.learner_id
    LEFT JOIN behaviour_categories bc ON bc.tenant_id = e.tenant_id AND bc.id = e.category_id
    LEFT JOIN classes cl ON cl.tenant_id = e.tenant_id AND cl.id = e.class_id
    LEFT JOIN users u ON u.id = e.recorded_by
    LEFT JOIN behaviour_staff_notes sn ON sn.tenant_id = e.tenant_id AND sn.entry_id = e.id`;

/** Newest day first, then the latest recorded: one text key (the day, then the time to the microsecond), then the id. */
const ENTRY_SORT = {
  name: "behaviour_entries_day_desc",
  expr: `(q.occurred_on || to_char(q.created_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISSUS'))`,
  type: "text" as const,
  dir: "desc" as const,
};

type EntryRow = Omit<BehaviourEntry, "created_at" | "voided_at" | "resolved_at" | "parent_notified_at"> & {
  created_at: Date | string;
  voided_at: Date | string | null;
  resolved_at: Date | string | null;
  parent_notified_at: Date | string | null;
};

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : v);

function toEntry(r: EntryRow & { page_key?: string }): BehaviourEntry {
  const { page_key: _k, ...rest } = r;
  return {
    ...rest,
    created_at: iso(r.created_at)!,
    voided_at: iso(r.voided_at),
    resolved_at: iso(r.resolved_at),
    parent_notified_at: iso(r.parent_notified_at),
  };
}

function entryScopeSql(scope: BehaviourScope, params: unknown[]): string {
  if (scope.office) return "";
  params.push(scope.userId);
  const me = params.length;
  params.push(scope.classIds);
  return ` AND (e.recorded_by = $${me}::uuid OR ${TAUGHT_LEARNER("e", params.length)})`;
}

export async function listBehaviourEntries(
  tx: Tx,
  input: { tenantId: string; scope: BehaviourScope; filters: EntryFilters; page: PageInput },
): Promise<Page<BehaviourEntry>> {
  const params: unknown[] = [input.tenantId];
  let where = " WHERE e.tenant_id = $1";
  const f = input.filters;
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where += ` AND ${sql.replace("?", `$${params.length}`)}`;
  };
  if (f.classId) add("e.class_id = ?::uuid", f.classId);
  if (f.kind) add("e.kind = ?", f.kind);
  if (f.categoryId) add("e.category_id = ?::uuid", f.categoryId);
  if (f.recordedBy) add("e.recorded_by = ?::uuid", f.recordedBy);
  if (f.learnerId) add("e.learner_id = ?::uuid", f.learnerId);
  if (f.from) add("e.occurred_on >= ?::date", f.from);
  if (f.to) add("e.occurred_on <= ?::date", f.to);
  if (f.openOnly) where += " AND e.follow_up_status = 'open'";
  if (f.seriousOnly) where += " AND e.severity = 'serious'";
  if (!f.includeVoided) where += " AND e.voided_at IS NULL";
  where += entryScopeSql(input.scope, params);
  const res = await pageQuery<EntryRow & { id: string }>(tx, `${ENTRY_SELECT}${where}`, params, ENTRY_SORT, input.page);
  return { items: res.rows.map(toEntry), page: res.page };
}

/** One entry the caller may read (the same scope as the list), or null. */
export async function getBehaviourEntry(tx: Tx, input: { tenantId: string; scope: BehaviourScope; entryId: string }): Promise<BehaviourEntry | null> {
  const params: unknown[] = [input.tenantId, input.entryId];
  const where = ` WHERE e.tenant_id = $1 AND e.id = $2${entryScopeSql(input.scope, params)}`;
  const res = await tx.query<EntryRow>(`${ENTRY_SELECT}${where}`, params);
  return res.rows[0] ? toEntry(res.rows[0]) : null;
}

// ---------------------------------------------------------------- voiding

export const NOT_YOUR_ENTRY = "Only whoever recorded this, or the office, can void it";

/**
 * Voids an entry (a mistake): it stays in the log, struck through for staff, and stops counting and showing to families.
 * Whoever recorded it, or the office. An entry the caller may not read is not found; one they may read but not void is 403.
 */
export async function voidBehaviourEntry(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; access: BehaviourAccess; scope: BehaviourScope; entryId: string; reason: string },
): Promise<BehaviourEntry> {
  const entry = await getBehaviourEntry(tx, { tenantId: input.tenantId, scope: input.scope, entryId: input.entryId });
  if (!entry) throw notFound("Behaviour entry not found");
  if (!input.access.write && !(input.access.record && entry.recorded_by === input.actorUserId)) throw forbidden(NOT_YOUR_ENTRY);
  if (entry.voided_at !== null) throw conflict("This entry is already voided");
  const reason = input.reason.trim();
  if (reason.length < 3) throw validationError("Say why it is being voided");
  if (reason.length > 300) throw validationError("The reason is at most 300 characters");
  try {
    const res = await tx.query(
      `UPDATE behaviour_entries SET voided_at = now(), voided_by = $3, void_reason = $4
        WHERE tenant_id = $1 AND id = $2 AND voided_at IS NULL`,
      [input.tenantId, input.entryId, input.actorUserId, reason],
    );
    if ((res.rowCount ?? 0) !== 1) throw conflict("This entry is already voided");
  } catch (err) {
    mapBehaviourDbError(err);
  }
  await recordSecurityEvent(tx, {
    eventType: "academics.behaviour.voided",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { entryId: input.entryId },
  });
  return (await getBehaviourEntry(tx, { tenantId: input.tenantId, scope: input.scope, entryId: input.entryId }))!;
}

// ---------------------------------------------------------------- points

export interface LearnerPoints extends PointsResult {
  learner_id: string;
  full_name: string;
  admission_no: string;
  class_id: string | null;
  class_name: string | null;
  period_start: string | null;
  period_end: string | null;
}

/**
 * The learners in scope, by name, with their points in the period holding `on` (the school's today by default). The office: every
 * ACTIVE learner; anyone else: the active learners of the classes they teach. `classId` narrows to one class (a class a teacher
 * does not teach gives an empty page), `learnerIds` to those learners.
 */
export async function listLearnerPoints(
  tx: Tx,
  input: { tenantId: string; scope: BehaviourScope; classId?: string; learnerIds?: string[]; on?: string; page: PageInput },
): Promise<Page<LearnerPoints>> {
  const settings = await getBehaviourSettings(tx, input.tenantId);
  const on = input.on ?? (await schoolToday(tx, input.tenantId));
  const terms = await tx.query<{ academic_year_id: string; starts_on: string }>(
    `SELECT academic_year_id, starts_on::text AS starts_on FROM academic_terms WHERE tenant_id = $1`,
    [input.tenantId],
  );
  const period = behaviourPeriod(settings.reset, terms.rows, on);

  const params: unknown[] = [input.tenantId, on, period.start, period.end];
  let where = " WHERE l.tenant_id = $1 AND l.active = true AND l.archived_at IS NULL";
  const inClasses = (classIds: string[]) => {
    params.push(classIds);
    where += ` AND EXISTS (SELECT 1 FROM class_memberships m
                            WHERE m.tenant_id = l.tenant_id AND m.learner_id = l.id AND m.active = true AND m.archived_at IS NULL
                              AND m.class_id = ANY($${params.length}::uuid[]))`;
  };
  if (input.scope.office) {
    if (input.classId) inClasses([input.classId]);
  } else {
    const classIds = input.classId ? input.scope.classIds.filter((c) => c === input.classId) : input.scope.classIds;
    if (classIds.length === 0) return { items: [], page: { next_cursor: null, limit: input.page.limit } };
    inClasses(classIds);
  }
  if (input.learnerIds && input.learnerIds.length > 0) {
    params.push(input.learnerIds);
    where += ` AND l.id = ANY($${params.length}::uuid[])`;
  }

  const res = await pageQuery<{
    id: string;
    full_name: string;
    admission_no: string;
    class_id: string | null;
    class_name: string | null;
    merit_points: number;
    demerit_points: number;
  }>(
    tx,
    `SELECT l.id, l.full_name, l.admission_no, cur.class_id, cur.class_name,
            COALESCE(SUM(e.points) FILTER (WHERE e.points > 0), 0)::int AS merit_points,
            COALESCE(SUM(e.points) FILTER (WHERE e.points < 0), 0)::int AS demerit_points
       FROM learners l
       LEFT JOIN LATERAL (
         SELECT c.id AS class_id, c.name AS class_name
           FROM class_memberships cm
           JOIN classes c ON c.tenant_id = cm.tenant_id AND c.id = cm.class_id AND c.active = true AND c.archived_at IS NULL
           JOIN academic_years y ON y.tenant_id = cm.tenant_id AND y.id = cm.academic_year_id AND y.is_current = true
          WHERE cm.tenant_id = l.tenant_id AND cm.learner_id = l.id AND cm.active = true AND cm.archived_at IS NULL
          ORDER BY cm.created_at DESC, cm.id
          LIMIT 1) cur ON true
       LEFT JOIN behaviour_entries e
         ON e.tenant_id = l.tenant_id AND e.learner_id = l.id AND e.voided_at IS NULL AND e.occurred_on <= $2::date
        AND ($3::date IS NULL OR e.occurred_on >= $3::date) AND ($4::date IS NULL OR e.occurred_on <= $4::date)
      ${where}
      GROUP BY l.id, l.full_name, l.admission_no, cur.class_id, cur.class_name`,
    params,
    { name: "behaviour_points_name", expr: "lower(q.full_name)", type: "text", dir: "asc" },
    input.page,
  );
  return {
    items: res.rows.map((r) => ({
      learner_id: r.id,
      full_name: r.full_name,
      admission_no: r.admission_no,
      class_id: r.class_id,
      class_name: r.class_name,
      period_start: period.start,
      period_end: period.end,
      ...pointsFromSums(r.merit_points, r.demerit_points, settings),
    })),
    page: res.page,
  };
}

// ---------------------------------------------------------------- the small reads the forms need

export interface BehaviourClass {
  id: string;
  name: string;
  form_level: number | null;
  stream: string | null;
}

/** The classes the caller works with: the office, every active class of the current academic year; a teacher, the classes they teach. */
export async function listBehaviourClasses(tx: Tx, input: { tenantId: string; scope: BehaviourScope }): Promise<BehaviourClass[]> {
  if (input.scope.office) {
    const res = await tx.query<BehaviourClass>(
      `SELECT c.id, c.name, c.form_level, c.stream
         FROM classes c
         JOIN academic_years y ON y.tenant_id = c.tenant_id AND y.id = c.academic_year_id AND y.is_current = true
        WHERE c.tenant_id = $1 AND c.active = true AND c.archived_at IS NULL
        ORDER BY lower(c.name), c.id LIMIT 500`,
      [input.tenantId],
    );
    return res.rows;
  }
  if (input.scope.classIds.length === 0) return [];
  const res = await tx.query<BehaviourClass>(
    `SELECT c.id, c.name, c.form_level, c.stream FROM classes c
      WHERE c.tenant_id = $1 AND c.id = ANY($2::uuid[]) ORDER BY lower(c.name), c.id LIMIT 500`,
    [input.tenantId, input.scope.classIds],
  );
  return res.rows;
}

/** The people who have recorded an entry in this school (the log's teacher filter). The office only. */
export async function listBehaviourRecorders(tx: Tx, tenantId: string): Promise<Array<{ user_id: string; full_name: string }>> {
  const res = await tx.query<{ user_id: string; full_name: string }>(
    `SELECT DISTINCT e.recorded_by AS user_id, u.full_name
       FROM behaviour_entries e JOIN users u ON u.id = e.recorded_by
      WHERE e.tenant_id = $1
      ORDER BY u.full_name, e.recorded_by LIMIT 500`,
    [tenantId],
  );
  return res.rows;
}
