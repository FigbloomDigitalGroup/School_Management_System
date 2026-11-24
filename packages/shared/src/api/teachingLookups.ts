import { apiClient } from "./client";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import type { components } from "./schema";
import { listApiSubjects } from "./setupApi";

/**
 * What a teacher teaches, on apps/api (the lookups behind "My classes" and the teacher's timetable).
 *
 * A plain teacher reads very little on the API (OD-2): their own classes, and the memberships, assignments and timetable slots
 * of those classes. They cannot read the staff list, the learner list or (until the subjects read is scoped too) the subject
 * list. Every lookup here that a plain teacher may be refused answers "nothing" on a 403 and never fails the page; what the
 * screens then cannot say (a colleague's name, a subject's name) they leave out.
 */

type TeachingAssignment = components["schemas"]["TeachingAssignment"];

function tenantIdOrThrow(tenantId?: string): string {
  const id = tenantId ?? apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

/** A refused read (403) answers `fallback`; any other failure is passed on. */
export function whenRefused<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (isApiError(err) && err.code === "forbidden") return fallback;
    throw err;
  };
}

// ---------------------------------------------------------------- short-lived lookups

/**
 * The timetable page asks for one timetable per class, and each needs the same school-wide lookups. They are kept for a few
 * seconds so a page of six classes asks for them once, not six times. Short, so a change an administrator just made shows on
 * the next look.
 */
const LOOKUP_TTL_MS = 8_000;
const lookups = new Map<string, { at: number; value: Promise<unknown> }>();

function remembered<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = lookups.get(key);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  lookups.set(key, { at: Date.now(), value });
  // A failed lookup is not kept: the next look asks again.
  value.catch(() => { if (lookups.get(key)?.value === value) lookups.delete(key); });
  return value;
}

/** Forgets the kept lookups (a sign-out, a switch of school, and every test). */
export function clearTeachingLookups(): void {
  lookups.clear();
}

/**
 * The signed-in person's own staff id in this school, or null when they have no staff record (a school administrator who was
 * never added to the directory). Class teachers and teaching assignments are recorded against staff ids, not sign-in ids.
 * `GET .../staff/me` needs no directory permission, so it answers for a plain teacher too.
 */
export function apiMyStaffId(tenantId?: string): Promise<string | null> {
  const tid = tenantIdOrThrow(tenantId);
  return remembered(`me:${tid}:${apiClient().store.get()?.userId ?? ""}`, async () => {
    try {
      const r = await apiClient().get("/v1/tenants/{tenantId}/staff/me", { path: { tenantId: tid }, tenantId: tid });
      return r.staff.id;
    } catch (err) {
      if (isApiError(err) && err.code === "not_found") return null;
      throw err;
    }
  });
}

/** Every active subject by id. A person who may not read subjects gets an empty map. */
export function apiSubjectNames(tenantId?: string): Promise<Map<string, string>> {
  const tid = tenantIdOrThrow(tenantId);
  return remembered(`subjects:${tid}`, async () => {
    const subjects = await listApiSubjects(tid).catch(whenRefused([]));
    return new Map(subjects.map((s) => [s.id, s.name]));
  });
}

/** Every active staff member's name by staff id. A person who may not read the staff list gets an empty map. */
export function apiStaffNames(tenantId?: string): Promise<Map<string, string>> {
  const tid = tenantIdOrThrow(tenantId);
  return remembered(`staff:${tid}`, async () => {
    const staff = await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/staff", { path: { tenantId: tid }, query: { active: true, limit: API_PAGE_LIMIT, cursor }, tenantId: tid });
      return { items: r.staff, page: r.page };
    }).catch(whenRefused([]));
    return new Map(staff.map((s) => [s.id, s.full_name]));
  });
}

/** Active teaching assignments, one class's or the school's. Scoped by the API for a plain teacher (only the classes they teach). */
export async function apiListTeachingAssignments(tenantId: string, classId?: string): Promise<TeachingAssignment[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/teaching-assignments", {
      path: { tenantId }, query: { classId, active: true, limit: API_PAGE_LIMIT, cursor }, tenantId,
    });
    return { items: r.assignments, page: r.page };
  }).catch(whenRefused([]));
}
