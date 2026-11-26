import {
  DEFAULT_BEHAVIOUR_SETTINGS,
  settingsProblem,
  type BehaviourCategory,
  type BehaviourEntryRow,
  type BehaviourLearner,
  type BehaviourSettings,
  type EntryFilters,
  type FollowUpStatus,
  type IncidentAction,
  type LearnerPoints,
  type RecordBehaviourInput,
} from "../behaviour";
import { apiClient } from "./client";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { activeTenantId } from "./peopleApi";
import { chunk } from "./pool";
import type { components } from "./schema";

/**
 * The behaviour and discipline log on apps/api (docs/web-on-api/behaviour.md): the API side of behaviour.ts.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - The log is read once and paged in the browser (as the paged Fees and Inventory screens are): the API pages by cursor and gives
 *    no total. The read is kept for 30 seconds for the same filters and is forgotten after any write from this tab.
 *  - `fetchSchoolLearners` and `fetchBehaviourPoints(null)` are one API read (the points list carries the learner names and
 *    classes); the two calls the office page makes share it.
 *  - `fetchBehaviourRecorders` lists the people who have recorded something, not every staff member.
 *  - A teacher's learners, classes and entries are the ones they teach (the API decides; there is no id to pass).
 *  - A family (a parent, a learner) reads one call, `fetchFamilyBehaviour`, which carries the school's display settings, the points and
 *    the entries the school lets families see (a parent may not read `/behaviour/settings`).
 */

type ApiSettings = components["schemas"]["BehaviourSettings"];
type ApiCategory = components["schemas"]["BehaviourCategory"];
type ApiEntry = components["schemas"]["BehaviourEntry"];
type ApiPoints = components["schemas"]["BehaviourLearnerPoints"];
type ApiFamily = components["schemas"]["FamilyBehaviour"];

export function behaviourSettingsFromApi(tenantId: string, s: ApiSettings): BehaviourSettings {
  return {
    tenant_id: tenantId,
    points_enabled: s.points_enabled,
    mode: s.mode,
    starting_points: s.starting_points,
    reset: s.reset,
    max_points_per_entry: s.max_points_per_entry,
    thresholds: s.thresholds.map((t) => ({ points: t.points, label: t.label })),
    parents_see_demerits: s.parents_see_demerits,
    parents_see_incidents: s.parents_see_incidents,
  };
}

export function behaviourCategoryFromApi(tenantId: string, c: ApiCategory): BehaviourCategory {
  return { id: c.id, tenant_id: tenantId, kind: c.kind, name: c.name, points: c.points, severity: c.severity ?? null, sort_order: c.sort_order, archived_at: c.archived_at ?? null };
}

export function behaviourEntryFromApi(tenantId: string, e: ApiEntry): BehaviourEntryRow {
  return {
    id: e.id,
    tenant_id: tenantId,
    student_id: e.learner_id,
    category_id: e.category_id ?? null,
    kind: e.kind,
    points: e.points,
    severity: e.severity ?? null,
    note: e.note ?? null,
    occurred_on: e.occurred_on,
    class_id: e.class_id ?? null,
    subject_id: e.subject_id ?? null,
    recorded_by: e.recorded_by ?? null,
    created_at: e.created_at,
    voided_at: e.voided_at ?? null,
    void_reason: e.void_reason ?? null,
    action_taken: (e.action_taken ?? null) as IncidentAction | null,
    follow_up_status: (e.follow_up_status ?? null) as FollowUpStatus | null,
    resolved_at: e.resolved_at ?? null,
    parent_notified_at: e.parent_notified_at ?? null,
    studentName: e.learner_name,
    admissionNo: e.admission_no,
    categoryName: e.category_name ?? null,
    className: e.class_name ?? null,
    recorderName: e.recorder_name ?? null,
    staffNote: e.staff_note ?? null,
  };
}

export function learnerPointsFromApi(p: ApiPoints): LearnerPoints {
  return {
    student_id: p.learner_id,
    period_start: p.period_start ?? null,
    period_end: p.period_end ?? null,
    merit_points: p.merit_points,
    demerit_points: p.demerit_points,
    balance: p.balance ?? null,
  };
}

// ---------------------------------------------------------------- settings and categories

export async function apiFetchBehaviourSettings(tenantId: string): Promise<BehaviourSettings> {
  const r = await apiClient().get("/v1/tenants/{tenantId}/behaviour/settings", { path: { tenantId }, tenantId });
  return behaviourSettingsFromApi(tenantId, r.settings);
}

export async function apiSaveBehaviourSettings(s: BehaviourSettings): Promise<void> {
  const problem = settingsProblem(s);
  if (problem) throw new Error(problem);
  await apiClient().put("/v1/tenants/{tenantId}/behaviour/settings", {
    path: { tenantId: s.tenant_id },
    body: {
      points_enabled: s.points_enabled,
      mode: s.mode,
      starting_points: s.starting_points,
      reset: s.reset,
      max_points_per_entry: s.max_points_per_entry,
      thresholds: s.thresholds.map((t) => ({ points: t.points, label: t.label.trim() })),
      parents_see_demerits: s.parents_see_demerits,
      parents_see_incidents: s.parents_see_incidents,
    },
    tenantId: s.tenant_id,
  });
}

export async function apiFetchBehaviourCategories(tenantId: string): Promise<BehaviourCategory[]> {
  const r = await apiClient().get("/v1/tenants/{tenantId}/behaviour/categories", { path: { tenantId }, query: { include_archived: true }, tenantId });
  return r.categories.map((c) => behaviourCategoryFromApi(tenantId, c));
}

export async function apiSaveBehaviourCategory(
  tenantId: string,
  c: Pick<BehaviourCategory, "kind" | "name" | "points" | "severity">,
  id?: string,
): Promise<void> {
  const name = c.name.trim();
  if (name.length < 2 || name.length > 60) throw new Error("A category name is 2 to 60 characters.");
  if (!Number.isInteger(c.points) || c.points < 1 || c.points > 100) throw new Error("Points are a whole number from 1 to 100.");
  const severity = c.kind === "merit" ? undefined : (c.severity ?? "minor");
  if (id) {
    await apiClient().patch("/v1/tenants/{tenantId}/behaviour/categories/{categoryId}", {
      path: { tenantId, categoryId: id },
      body: { name, points: c.points, ...(severity ? { severity } : {}) },
      tenantId,
    });
    return;
  }
  await apiClient().post("/v1/tenants/{tenantId}/behaviour/categories", {
    path: { tenantId },
    body: { kind: c.kind, name, points: c.points, ...(severity ? { severity } : {}) },
    tenantId,
  });
}

export async function apiSetBehaviourCategoryArchived(id: string, archived: boolean): Promise<void> {
  const tenantId = activeTenantId();
  await apiClient().patch("/v1/tenants/{tenantId}/behaviour/categories/{categoryId}", {
    path: { tenantId, categoryId: id },
    body: { archived },
    tenantId,
  });
}

export async function apiAddDefaultBehaviourCategories(tenantId: string): Promise<number> {
  const r = await apiClient().post("/v1/tenants/{tenantId}/behaviour/categories/defaults", { path: { tenantId }, tenantId });
  return r.added;
}

// ---------------------------------------------------------------- recording, voiding, incidents

export async function apiRecordBehaviour(i: RecordBehaviourInput): Promise<number> {
  const tenantId = activeTenantId();
  const r = await apiClient().post("/v1/tenants/{tenantId}/behaviour/entries", {
    path: { tenantId },
    body: {
      learner_ids: i.studentIds,
      kind: i.kind,
      category_id: i.categoryId,
      points: i.points,
      note: i.note.trim() || null,
      staff_note: i.staffNote.trim() || null,
      occurred_on: i.occurredOn || null,
      ...(i.kind === "incident" ? { severity: i.severity ?? "serious" } : {}),
    },
    tenantId,
  });
  forgetBehaviourReads();
  return r.count;
}

export async function apiVoidBehaviourEntry(id: string, reason: string): Promise<void> {
  const tenantId = activeTenantId();
  await apiClient().post("/v1/tenants/{tenantId}/behaviour/entries/{entryId}/void", { path: { tenantId, entryId: id }, body: { reason }, tenantId });
  forgetBehaviourReads();
}

export async function apiSetBehaviourIncident(id: string, action: IncidentAction | null, status: FollowUpStatus, parentNotified: boolean): Promise<void> {
  const tenantId = activeTenantId();
  await apiClient().put("/v1/tenants/{tenantId}/behaviour/entries/{entryId}/incident", {
    path: { tenantId, entryId: id },
    body: { action_taken: action, follow_up_status: status, parent_notified: parentNotified },
    tenantId,
  });
  forgetBehaviourReads();
}

// ---------------------------------------------------------------- reads, kept briefly

const KEEP_MS = 30_000;
const kept = new Map<string, { at: number; read: Promise<unknown> }>();

/** One read for each key, shared for 30 seconds (the office page asks for the same list twice). A failed read is not kept. */
function keepFor<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.read as Promise<T>;
  const p = read();
  kept.set(key, { at: Date.now(), read: p });
  p.catch(() => kept.delete(key));
  return p;
}

/** Forget what was read: after a write from this tab, and between tests. */
export function forgetBehaviourReads(): void {
  kept.clear();
}

function entryQuery(f: EntryFilters) {
  return {
    class_id: f.classId || undefined,
    kind: f.kind || undefined,
    category_id: f.categoryId || undefined,
    recorded_by: f.recordedBy || undefined,
    learner_id: f.studentId || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    open_only: f.openOnly ? true : undefined,
    serious_only: f.seriousOnly ? true : undefined,
    include_voided: f.includeVoided ? true : undefined,
  };
}

function readEntries(tenantId: string, f: EntryFilters, max: number): Promise<BehaviourEntryRow[]> {
  return keepFor(`entries:${tenantId}:${max}:${JSON.stringify(entryQuery(f))}`, async () => {
    const rows: BehaviourEntryRow[] = [];
    await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/behaviour/entries", {
        path: { tenantId },
        query: { ...entryQuery(f), limit: API_PAGE_LIMIT, cursor },
        tenantId,
      });
      rows.push(...r.entries.map((e) => behaviourEntryFromApi(tenantId, e)));
      // stop reading at the cap: the next page cursor is dropped
      return { items: [], page: { next_cursor: rows.length >= max ? null : r.page.next_cursor } };
    });
    return rows.slice(0, max);
  });
}

/** One page of the log, newest first, with the total for the pager. The log is read once (at most 5,000 entries) and paged here. */
export async function apiFetchBehaviourEntriesPage(tenantId: string, f: EntryFilters, offset: number, limit: number): Promise<{ rows: BehaviourEntryRow[]; total: number }> {
  const all = await readEntries(tenantId, f, 5000);
  return { rows: all.slice(offset, offset + limit), total: all.length };
}

/** A learner's whole log, newest first (what the caller may see of it), at most 500 entries. */
export async function apiFetchLearnerBehaviour(studentId: string, includeVoided = false): Promise<BehaviourEntryRow[]> {
  const tenantId = activeTenantId();
  return readEntries(tenantId, { studentId, includeVoided }, 500);
}

function readPoints(tenantId: string, query: { class_id?: string; learner_ids?: string; on?: string }): Promise<ApiPoints[]> {
  return keepFor(`points:${tenantId}:${JSON.stringify(query)}`, () =>
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/behaviour/points", { path: { tenantId }, query: { ...query, limit: API_PAGE_LIMIT, cursor }, tenantId });
      return { items: r.learners, page: r.page };
    }),
  );
}

/** Points for these learners, or (null) every current learner the caller may see (the office: the school; a teacher: their classes). */
export async function apiFetchBehaviourPoints(studentIds: string[] | null, on?: string): Promise<Map<string, LearnerPoints>> {
  if (studentIds && studentIds.length === 0) return new Map();
  const tenantId = activeTenantId();
  const rows: ApiPoints[] = [];
  if (studentIds === null) rows.push(...(await readPoints(tenantId, { on })));
  else for (const ids of chunk(studentIds, 100)) rows.push(...(await readPoints(tenantId, { learner_ids: ids.join(","), on })));
  return new Map(rows.map((p) => [p.learner_id, learnerPointsFromApi(p)]));
}

/** The current learners of a class the caller may see, for the record form's picker. */
export async function apiFetchClassLearners(classId: string): Promise<BehaviourLearner[]> {
  const rows = await readPoints(activeTenantId(), { class_id: classId });
  return rows.map((p) => ({ id: p.learner_id, full_name: p.full_name, admission_no: p.admission_no, class_id: p.class_id ?? null }));
}

/** Every current learner the caller may see, with their class name (the office's points list). */
export async function apiFetchSchoolLearners(tenantId: string): Promise<(BehaviourLearner & { className: string | null })[]> {
  const rows = await readPoints(tenantId, {});
  return rows.map((p) => ({ id: p.learner_id, full_name: p.full_name, admission_no: p.admission_no, class_id: p.class_id ?? null, className: p.class_name ?? null }));
}

export async function apiFetchBehaviourClasses(tenantId: string): Promise<{ id: string; name: string }[]> {
  const r = await keepFor(`classes:${tenantId}`, () => apiClient().get("/v1/tenants/{tenantId}/behaviour/classes", { path: { tenantId }, tenantId }));
  return r.classes.map((c) => ({ id: c.id, name: c.name }));
}

/** The people who have recorded an entry (the log's teacher filter). */
export async function apiFetchBehaviourRecorders(tenantId: string): Promise<{ id: string; full_name: string }[]> {
  const r = await apiClient().get("/v1/tenants/{tenantId}/behaviour/recorders", { path: { tenantId }, tenantId });
  return r.recorders.map((x) => ({ id: x.user_id, full_name: x.full_name }));
}

// ---------------------------------------------------------------- what a family reads

export interface FamilyBehaviourView {
  settings: BehaviourSettings;
  entries: BehaviourEntryRow[];
  points: LearnerPoints | undefined;
}

/**
 * What the school shares with a learner's family (a parent for their child, a learner for themself): the display settings, the entries
 * the school lets families see, and the points. A voided entry, the staff-only note and who recorded an entry never come.
 */
export async function apiFetchFamilyBehaviour(studentId: string): Promise<FamilyBehaviourView> {
  const tenantId = activeTenantId();
  const r = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/behaviour", { path: { tenantId, learnerId: studentId }, tenantId });
  const b: ApiFamily = r.behaviour;
  return {
    settings: {
      ...DEFAULT_BEHAVIOUR_SETTINGS,
      tenant_id: tenantId,
      points_enabled: b.settings.points_enabled,
      mode: b.settings.mode,
      starting_points: b.settings.starting_points,
      reset: b.settings.reset,
      thresholds: b.settings.thresholds.map((t) => ({ points: t.points, label: t.label })),
      parents_see_demerits: b.settings.parents_see_demerits,
      parents_see_incidents: b.settings.parents_see_incidents,
    },
    entries: b.entries.map((e) => ({
      id: e.id,
      tenant_id: tenantId,
      student_id: studentId,
      category_id: null,
      kind: e.kind,
      points: e.points,
      severity: e.severity ?? null,
      note: e.note ?? null,
      occurred_on: e.occurred_on,
      class_id: null,
      subject_id: null,
      recorded_by: null,
      created_at: e.occurred_on,
      voided_at: null,
      void_reason: null,
      action_taken: (e.action_taken ?? null) as IncidentAction | null,
      follow_up_status: (e.follow_up_status ?? null) as FollowUpStatus | null,
      resolved_at: e.resolved_at ?? null,
      parent_notified_at: e.parent_notified_at ?? null,
      studentName: "",
      admissionNo: null,
      categoryName: e.category_name ?? null,
      className: null,
      recorderName: null,
      staffNote: null,
    })),
    points: { student_id: studentId, period_start: b.points.period_start ?? null, period_end: b.points.period_end ?? null, merit_points: b.points.merit_points, demerit_points: b.points.demerit_points, balance: b.points.balance ?? null },
  };
}
