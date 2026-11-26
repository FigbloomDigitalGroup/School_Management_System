import {
  apiAddDefaultBehaviourCategories,
  apiFetchBehaviourCategories,
  apiFetchBehaviourClasses,
  apiFetchBehaviourEntriesPage,
  apiFetchBehaviourPoints,
  apiFetchBehaviourRecorders,
  apiFetchBehaviourSettings,
  apiFetchClassLearners,
  apiFetchFamilyBehaviour,
  apiFetchLearnerBehaviour,
  apiFetchSchoolLearners,
  apiRecordBehaviour,
  apiSaveBehaviourCategory,
  apiSaveBehaviourSettings,
  apiSetBehaviourCategoryArchived,
  apiSetBehaviourIncident,
  apiVoidBehaviourEntry,
} from "./api/behaviourApi";
import { onApi } from "./backend";
import { supabase } from "./supabase";

/**
 * Behaviour and discipline log with merit / demerit points (20261124400000_behaviour_log).
 *
 * Each school sets its points up (behaviour_settings): on or off; the mode (merits_only: merits add;
 * demerits_only: demerits take away from a starting balance; both); when points start again (term /
 * year / never); its own categories; thresholds shown as badges; and what families see (merits and the
 * total always, demerits and incidents only when the school turns them on, staff-only notes never).
 *
 * The database is the authority for points (behaviour_points); behaviourPeriod and pointsBalance below
 * are the same rules in TypeScript, for the tests and for a timeline already on screen.
 */

export type BehaviourMode = "merits_only" | "demerits_only" | "both";
export type BehaviourReset = "term" | "year" | "never";
export type BehaviourKind = "merit" | "demerit" | "incident";
export type BehaviourSeverity = "minor" | "major" | "serious";
export type IncidentAction = "warning" | "detention" | "parent_called" | "parent_meeting" | "suspension" | "counsellor" | "other";
export type FollowUpStatus = "open" | "resolved";

export interface BehaviourThreshold { points: number; label: string }

export interface BehaviourSettings {
  tenant_id: string;
  points_enabled: boolean;
  mode: BehaviourMode;
  starting_points: number;
  reset: BehaviourReset;
  max_points_per_entry: number;
  thresholds: BehaviourThreshold[];
  parents_see_demerits: boolean;
  parents_see_incidents: boolean;
}

export interface BehaviourCategory {
  id: string;
  tenant_id: string;
  kind: "merit" | "demerit";
  name: string;
  points: number;
  severity: BehaviourSeverity | null;
  sort_order: number;
  archived_at: string | null;
}

export interface BehaviourEntry {
  id: string;
  tenant_id: string;
  student_id: string;
  category_id: string | null;
  kind: BehaviourKind;
  points: number;
  severity: BehaviourSeverity | null;
  note: string | null;
  occurred_on: string;
  class_id: string | null;
  subject_id: string | null;
  recorded_by: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  action_taken: IncidentAction | null;
  follow_up_status: FollowUpStatus | null;
  resolved_at: string | null;
  parent_notified_at: string | null;
}

/** An entry with the names a list shows. staffNote is null for families (RLS never returns it to them). */
export interface BehaviourEntryRow extends BehaviourEntry {
  studentName: string;
  admissionNo: string | null;
  categoryName: string | null;
  className: string | null;
  recorderName: string | null;
  staffNote: string | null;
}

export interface LearnerPoints {
  student_id: string;
  period_start: string | null;
  period_end: string | null;
  merit_points: number;
  demerit_points: number;
  /** null when the school has points turned off. */
  balance: number | null;
}

export const BEHAVIOUR_MODE_LABEL: Record<BehaviourMode, string> = {
  merits_only: "Merits only (merits add points)",
  demerits_only: "Demerits only (demerits take points away from a starting balance)",
  both: "Both (merits add, demerits take away)",
};
export const BEHAVIOUR_RESET_LABEL: Record<BehaviourReset, string> = {
  term: "Every term", year: "Every school year", never: "Never",
};
export const BEHAVIOUR_KIND_LABEL: Record<BehaviourKind, string> = { merit: "Merit", demerit: "Demerit", incident: "Incident" };
export const SEVERITY_LABEL: Record<BehaviourSeverity, string> = { minor: "Minor", major: "Major", serious: "Serious" };
export const INCIDENT_ACTION_LABEL: Record<IncidentAction, string> = {
  warning: "Warning", detention: "Detention", parent_called: "Parent called", parent_meeting: "Parent meeting",
  suspension: "Suspension", counsellor: "Referred to counsellor", other: "Other",
};

export const DEFAULT_BEHAVIOUR_SETTINGS: Omit<BehaviourSettings, "tenant_id"> = {
  points_enabled: true,
  mode: "both",
  starting_points: 100,
  reset: "term",
  max_points_per_entry: 10,
  thresholds: [{ points: -15, label: "Parent meeting" }, { points: 30, label: "Certificate" }],
  parents_see_demerits: false,
  parents_see_incidents: false,
};

// ---------------------------------------------------------------- the rules

export interface TermDates { year: number; starts_on: string }
export interface Period { start: string | null; end: string | null }

const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** The points period holding `on` (YYYY-MM-DD). The same rule as behaviour_period in the migration. */
export function behaviourPeriod(reset: BehaviourReset, terms: readonly TermDates[], on: string): Period {
  if (reset === "never") return { start: null, end: null };
  const sorted = [...terms].sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  const cur = [...sorted].reverse().find((t) => t.starts_on <= on) ?? null;
  const year = cur?.year ?? Number(on.slice(0, 4));
  if (reset === "term") {
    const next = sorted.find((t) => t.starts_on > on) ?? null;
    return { start: cur?.starts_on ?? `${year}-01-01`, end: next ? dayBefore(next.starts_on) : null };
  }
  const firstOf = (y: number) => sorted.find((t) => t.year === y)?.starts_on ?? null;
  return { start: firstOf(year) ?? `${year}-01-01`, end: dayBefore(firstOf(year + 1) ?? `${year + 1}-01-01`) };
}

export interface PointsResult { merit_points: number; demerit_points: number; balance: number | null }

/**
 * A learner's points from their entries (any order), in the period holding `on`, as behaviour_points
 * counts them: voided entries and those after `on` don't count; the mode picks what the balance adds.
 */
export function pointsBalance(
  entries: readonly Pick<BehaviourEntry, "points" | "occurred_on" | "voided_at">[],
  settings: Pick<BehaviourSettings, "points_enabled" | "mode" | "starting_points" | "reset">,
  terms: readonly TermDates[],
  on: string,
): PointsResult {
  const { start, end } = behaviourPeriod(settings.reset, terms, on);
  let merit = 0;
  let demerit = 0;
  for (const e of entries) {
    if (e.voided_at || e.occurred_on > on) continue;
    if (start && e.occurred_on < start) continue;
    if (end && e.occurred_on > end) continue;
    if (e.points > 0) merit += e.points; else demerit += e.points;
  }
  const balance = !settings.points_enabled ? null
    : settings.mode === "merits_only" ? merit
    : settings.mode === "demerits_only" ? settings.starting_points + demerit
    : merit + demerit;
  return { merit_points: merit, demerit_points: demerit, balance };
}

/** The thresholds a learner has reached: a negative one by their demerits, a positive one by their merits. */
export function thresholdsReached(p: Pick<PointsResult, "merit_points" | "demerit_points">, thresholds: readonly BehaviourThreshold[]): BehaviourThreshold[] {
  return thresholds.filter((t) => (t.points < 0 ? p.demerit_points <= t.points : p.merit_points >= t.points));
}

/** Whether a mode's balance moves with this kind of entry ("doesn't change points" otherwise). */
export function kindCounts(mode: BehaviourMode, kind: BehaviourKind): boolean {
  if (kind === "merit") return mode !== "demerits_only";
  return mode !== "merits_only";
}

/** "+2", "−3", "0". */
export function formatPoints(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
}

/** What the settings form refuses, or null. */
export function settingsProblem(s: Omit<BehaviourSettings, "tenant_id">): string | null {
  if (!Number.isInteger(s.starting_points) || s.starting_points < 0 || s.starting_points > 10000) return "The starting balance is a whole number from 0 to 10,000.";
  if (!Number.isInteger(s.max_points_per_entry) || s.max_points_per_entry < 1 || s.max_points_per_entry > 100) return "The most points for one entry is a whole number from 1 to 100.";
  if (s.thresholds.length > 10) return "At most 10 thresholds.";
  for (const t of s.thresholds) {
    if (!Number.isInteger(t.points) || t.points === 0 || Math.abs(t.points) > 10000) return "Each threshold needs a whole number of points other than 0 (negative for demerits).";
    const label = t.label.trim();
    if (label.length < 1 || label.length > 60) return "Each threshold needs a label of up to 60 characters.";
  }
  return null;
}

/** Families' wording of a kind they may see (the school's settings). */
export function familySees(s: Pick<BehaviourSettings, "parents_see_demerits" | "parents_see_incidents">): BehaviourKind[] {
  return ["merit", ...(s.parents_see_demerits ? ["demerit" as const] : []), ...(s.parents_see_incidents ? ["incident" as const] : [])];
}

// ---------------------------------------------------------------- reading and writing

export async function fetchBehaviourSettings(tenantId: string): Promise<BehaviourSettings> {
  if (onApi()) return apiFetchBehaviourSettings(tenantId);
  const { data, error } = await supabase().from("behaviour_settings").select("*").eq("tenant_id", tenantId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? (data as BehaviourSettings) : { tenant_id: tenantId, ...DEFAULT_BEHAVIOUR_SETTINGS };
}

export async function saveBehaviourSettings(s: BehaviourSettings): Promise<void> {
  if (onApi()) return apiSaveBehaviourSettings(s);
  const problem = settingsProblem(s);
  if (problem) throw new Error(problem);
  const row = {
    tenant_id: s.tenant_id, points_enabled: s.points_enabled, mode: s.mode, starting_points: s.starting_points, reset: s.reset,
    max_points_per_entry: s.max_points_per_entry, parents_see_demerits: s.parents_see_demerits, parents_see_incidents: s.parents_see_incidents,
    thresholds: s.thresholds.map((t) => ({ points: t.points, label: t.label.trim() })), updated_at: new Date().toISOString(),
  };
  const { error } = await supabase().from("behaviour_settings").upsert(row, { onConflict: "tenant_id" });
  if (error) throw new Error(error.message);
}

export async function fetchBehaviourCategories(tenantId: string): Promise<BehaviourCategory[]> {
  if (onApi()) return apiFetchBehaviourCategories(tenantId);
  const { data, error } = await supabase().from("behaviour_categories").select("*").eq("tenant_id", tenantId)
    .order("kind").order("sort_order").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as BehaviourCategory[];
}

export async function saveBehaviourCategory(tenantId: string, c: Pick<BehaviourCategory, "kind" | "name" | "points" | "severity">, id?: string): Promise<void> {
  if (onApi()) return apiSaveBehaviourCategory(tenantId, c, id);
  const name = c.name.trim();
  if (name.length < 2 || name.length > 60) throw new Error("A category name is 2 to 60 characters.");
  if (!Number.isInteger(c.points) || c.points < 1 || c.points > 100) throw new Error("Points are a whole number from 1 to 100.");
  const row = { name, points: c.points, severity: c.kind === "merit" ? null : (c.severity ?? "minor") };
  const q = id
    ? supabase().from("behaviour_categories").update(row).eq("id", id)
    : supabase().from("behaviour_categories").insert({ ...row, tenant_id: tenantId, kind: c.kind, sort_order: 100 });
  const { error } = await q;
  if (error) throw new Error(error.message.includes("behaviour_categories_name_unique") ? `There is already a ${c.kind} called "${name}".` : error.message);
}

export async function setBehaviourCategoryArchived(id: string, archived: boolean): Promise<void> {
  if (onApi()) return apiSetBehaviourCategoryArchived(id, archived);
  const { error } = await supabase().from("behaviour_categories").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function addDefaultBehaviourCategories(tenantId: string): Promise<number> {
  if (onApi()) return apiAddDefaultBehaviourCategories(tenantId);
  const { data, error } = await supabase().rpc("add_default_behaviour_categories", { p_tenant: tenantId });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}

export interface RecordBehaviourInput {
  studentIds: string[];
  kind: BehaviourKind;
  categoryId: string | null;
  /** The size, 1..max (signed by the kind); null for the category's default. */
  points: number | null;
  note: string;
  staffNote: string;
  occurredOn: string;
  severity?: BehaviourSeverity | null;
}

export async function recordBehaviour(i: RecordBehaviourInput): Promise<number> {
  if (onApi()) return apiRecordBehaviour(i);
  const { data, error } = await supabase().rpc("record_behaviour", {
    p_student_ids: i.studentIds, p_kind: i.kind, p_category_id: i.categoryId, p_points: i.points,
    p_note: i.note.trim() || null, p_staff_note: i.staffNote.trim() || null, p_occurred_on: i.occurredOn,
    p_severity: i.kind === "incident" ? (i.severity ?? "serious") : null,
  });
  if (error) throw new Error(friendlyBehaviourError(error.message));
  return (data as number) ?? 0;
}

export async function voidBehaviourEntry(id: string, reason: string): Promise<void> {
  if (onApi()) return apiVoidBehaviourEntry(id, reason);
  const { error } = await supabase().rpc("void_behaviour_entry", { p_id: id, p_reason: reason });
  if (error) throw new Error(error.message);
}

export async function setBehaviourIncident(id: string, action: IncidentAction | null, status: FollowUpStatus, parentNotified: boolean): Promise<void> {
  if (onApi()) return apiSetBehaviourIncident(id, action, status, parentNotified);
  const { error } = await supabase().rpc("set_behaviour_incident", { p_id: id, p_action: action, p_status: status, p_parent_notified: parentNotified });
  if (error) throw new Error(error.message);
}

export function friendlyBehaviourError(message: string): string {
  if (/row-level security|42501/.test(message)) return "You can only record behaviour for learners you teach.";
  return message;
}

/** Points for these learners, or (null) every current learner the caller may see at their school. */
export async function fetchBehaviourPoints(studentIds: string[] | null, on?: string): Promise<Map<string, LearnerPoints>> {
  if (onApi()) return apiFetchBehaviourPoints(studentIds, on);
  if (studentIds && studentIds.length === 0) return new Map();
  const { data, error } = await supabase().rpc("behaviour_points", { p_student_ids: studentIds, p_on: on ?? null });
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as LearnerPoints[]).map((p) => [p.student_id, p]));
}

const ENTRY_SELECT =
  "*, student:students(full_name, admission_no), category:behaviour_categories(name), class:classes(name), " +
  "recorder:profiles!behaviour_entries_recorded_by_fkey(full_name), staff:behaviour_staff_notes(note)";

type EntryJoin = BehaviourEntry & {
  student: { full_name: string; admission_no: string | null } | null;
  category: { name: string } | null;
  class: { name: string } | null;
  recorder: { full_name: string } | null;
  staff: { note: string } | { note: string }[] | null;
};

function toRow(e: EntryJoin): BehaviourEntryRow {
  const { student, category, class: cls, recorder, staff, ...rest } = e;
  const note = Array.isArray(staff) ? staff[0]?.note ?? null : staff?.note ?? null;
  return {
    ...rest, studentName: student?.full_name ?? "Learner", admissionNo: student?.admission_no ?? null,
    categoryName: category?.name ?? null, className: cls?.name ?? null, recorderName: recorder?.full_name ?? null, staffNote: note,
  };
}

export interface EntryFilters {
  classId?: string | null;
  kind?: BehaviourKind | null;
  categoryId?: string | null;
  recordedBy?: string | null;
  studentId?: string | null;
  from?: string | null;
  to?: string | null;
  /** Serious ones still open. */
  openOnly?: boolean;
  /** Serious ones (open or resolved). */
  seriousOnly?: boolean;
  includeVoided?: boolean;
}

/** One page of the log, newest first, with the total for the pager. RLS decides whose entries come back. */
export async function fetchBehaviourEntriesPage(tenantId: string, f: EntryFilters, offset: number, limit: number): Promise<{ rows: BehaviourEntryRow[]; total: number }> {
  if (onApi()) return apiFetchBehaviourEntriesPage(tenantId, f, offset, limit);
  let q = supabase().from("behaviour_entries").select(ENTRY_SELECT, { count: "exact" }).eq("tenant_id", tenantId);
  if (f.classId) q = q.eq("class_id", f.classId);
  if (f.kind) q = q.eq("kind", f.kind);
  if (f.categoryId) q = q.eq("category_id", f.categoryId);
  if (f.recordedBy) q = q.eq("recorded_by", f.recordedBy);
  if (f.studentId) q = q.eq("student_id", f.studentId);
  if (f.from) q = q.gte("occurred_on", f.from);
  if (f.to) q = q.lte("occurred_on", f.to);
  if (f.openOnly) q = q.eq("follow_up_status", "open");
  if (f.seriousOnly) q = q.eq("severity", "serious");
  if (!f.includeVoided) q = q.is("voided_at", null);
  const { data, error, count } = await q.order("occurred_on", { ascending: false }).order("created_at", { ascending: false }).order("id")
    .range(offset, offset + limit - 1).returns<EntryJoin[]>();
  if (error) throw new Error(error.message);
  return { rows: (data ?? []).map(toRow), total: count ?? 0 };
}

/** A learner's whole log, newest first (what the caller may see of it). */
export async function fetchLearnerBehaviour(studentId: string, includeVoided = false): Promise<BehaviourEntryRow[]> {
  if (onApi()) return apiFetchLearnerBehaviour(studentId, includeVoided);
  let q = supabase().from("behaviour_entries").select(ENTRY_SELECT).eq("student_id", studentId);
  if (!includeVoided) q = q.is("voided_at", null);
  const { data, error } = await q.order("occurred_on", { ascending: false }).order("created_at", { ascending: false }).limit(500).returns<EntryJoin[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toRow);
}

export interface BehaviourLearner { id: string; full_name: string; admission_no: string | null; class_id: string | null }

/** The current learners of a class, for the record form's picker. */
export async function fetchClassLearners(classId: string): Promise<BehaviourLearner[]> {
  if (onApi()) return apiFetchClassLearners(classId);
  const { data, error } = await supabase().from("students").select("id, full_name, admission_no, class_id")
    .eq("class_id", classId).is("archived_at", null).order("full_name").returns<BehaviourLearner[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The staff who have recorded something (the log's teacher filter). */
export async function fetchBehaviourRecorders(tenantId: string): Promise<{ id: string; full_name: string }[]> {
  if (onApi()) return apiFetchBehaviourRecorders(tenantId);
  const { data, error } = await supabase().from("profiles").select("id, full_name").eq("tenant_id", tenantId)
    .in("role", ["teacher", "school_admin", "staff"]).is("archived_at", null).order("full_name").returns<{ id: string; full_name: string }[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The school's classes, for the office's filters and the record form's class picker. */
export async function fetchBehaviourClasses(tenantId: string): Promise<{ id: string; name: string }[]> {
  if (onApi()) return apiFetchBehaviourClasses(tenantId);
  const { data, error } = await supabase().from("classes").select("id, name").eq("tenant_id", tenantId).order("name").returns<{ id: string; name: string }[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Every current learner at the school with their class name (the office's points list). */
export async function fetchSchoolLearners(tenantId: string): Promise<(BehaviourLearner & { className: string | null })[]> {
  if (onApi()) return apiFetchSchoolLearners(tenantId);
  const out: (BehaviourLearner & { className: string | null })[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase().from("students").select("id, full_name, admission_no, class_id, classes(name)")
      .eq("tenant_id", tenantId).is("archived_at", null).order("full_name").order("id").range(from, from + 999)
      .returns<(BehaviourLearner & { classes: { name: string } | null })[]>();
    if (error) throw new Error(error.message);
    for (const r of data ?? []) out.push({ id: r.id, full_name: r.full_name, admission_no: r.admission_no, class_id: r.class_id, className: r.classes?.name ?? null });
    if ((data ?? []).length < 1000) return out;
  }
}

/** What the school shares with a learner's family: the display settings, the entries a family may see, and the points. */
export async function fetchFamilyBehaviour(studentId: string, tenantId: string): Promise<{ settings: BehaviourSettings; entries: BehaviourEntryRow[]; points: LearnerPoints | undefined }> {
  if (onApi()) return apiFetchFamilyBehaviour(studentId);
  const [settings, entries, points] = await Promise.all([fetchBehaviourSettings(tenantId), fetchLearnerBehaviour(studentId, false), fetchBehaviourPoints([studentId])]);
  return { settings, entries, points: points.get(studentId) };
}
