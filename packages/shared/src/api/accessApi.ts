import { ADMIN_AREA_INFO, isAdminArea, sortAreas, type AdminArea } from "../adminAreas";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { listStaffMembers } from "./peopleApi";

/**
 * Who may do what, on apps/api (the API side of adminAreas.ts and the Access & roles screen):
 *
 *  - admin areas given to one person (`GET` and `PUT /v1/rbac/staff-areas`). The API has no school roles to give out ("Exams
 *    officer"): areas are given one by one, so roles are not offered on an API build (accessCapabilities());
 *  - access to guardian records, given to one person (`/v1/rbac/guardian-access`, read and write apart);
 *  - what an organization administrator has been given in this school (`/v1/rbac/org-delegations`).
 *
 * Every change here needs the password confirmed recently: the client asks for it (the re-enter-password prompt) and retries.
 */

/** A teacher or other staff member as the Access screen needs them: the sign-in they have (if any) and the record they are in the directory. */
export interface AccessPerson {
  staffId: string;
  /** The person's sign-in. Null until they have one: areas belong to a sign-in, so they cannot be given before. */
  userId: string | null;
  name: string;
  title: string | null;
  classification: "school_admin" | "teacher" | "driver" | "staff";
}

/** Why a person's admin areas cannot be changed from the Access screen, in a sentence for the page; null when they can. */
export function accessLockedReason(p: AccessPerson, selfUserId: string): string | null {
  if (p.classification === "school_admin") return "A full admin: already has everything.";
  if (p.classification === "driver") return "Drivers cannot hold admin areas.";
  if (!p.userId) return "No sign-in yet. Areas belong to a sign-in.";
  if (p.userId === selfUserId) return "You cannot change your own areas.";
  return null;
}

/** Everyone in the school's staff directory, active only, in the API's order (by name). */
export async function apiFetchAccessPeople(tenantId: string): Promise<AccessPerson[]> {
  const staff = await listStaffMembers(tenantId, true);
  return staff.map((s) => ({ staffId: s.id, userId: s.userId ?? null, name: s.full_name, title: s.staff_title ?? null, classification: s.classification }));
}

// ---------------------------------------------------------------- admin areas, one person at a time

/** user id -> the areas given to that person directly. People with none are not in the map. */
export async function apiFetchStaffAreas(): Promise<Map<string, AdminArea[]>> {
  const rows = await listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/rbac/staff-areas", { query: { limit: API_PAGE_LIMIT, cursor } });
    return { items: r.items, page: r.page };
  });
  return new Map(rows.map((r) => [r.userId, sortAreas(r.areas)]));
}

/** Replaces a person's areas with these and answers what they hold now. The server refuses your own areas and a person who is not a teacher or staff member. */
export async function apiSetStaffAreas(userId: string, areas: readonly AdminArea[]): Promise<AdminArea[]> {
  const res = await apiClient().put("/v1/rbac/staff-areas", { body: { userId, areas: sortAreas(areas) } });
  return sortAreas(res.areas ?? []);
}

// ---------------------------------------------------------------- guardian records

/** Reading and changing the parents' records are separate: someone may be given one without the other. */
export interface GuardianAccess {
  read: boolean;
  write: boolean;
}

export const GUARDIAN_READ = "resource.guardian.read" as const;
export const GUARDIAN_WRITE = "resource.guardian.write" as const;

export function guardianAccessFromCodes(codes: readonly string[]): GuardianAccess {
  return { read: codes.includes(GUARDIAN_READ), write: codes.includes(GUARDIAN_WRITE) };
}

export async function apiFetchGuardianAccess(userId: string): Promise<GuardianAccess> {
  const res = await apiClient().get("/v1/rbac/guardian-access", { query: { userId } });
  return guardianAccessFromCodes((res.items ?? []).map((i) => i.permissionCode ?? ""));
}

/** Makes a person's guardian access `wanted`, giving and taking away only what differs from `current`. Answers whether anything changed. */
export async function apiSetGuardianAccess(userId: string, current: GuardianAccess, wanted: GuardianAccess): Promise<boolean> {
  const codeOf = (g: GuardianAccess) => [g.read ? GUARDIAN_READ : null, g.write ? GUARDIAN_WRITE : null].filter((c): c is typeof GUARDIAN_READ | typeof GUARDIAN_WRITE => c !== null);
  const have = new Set<string>(codeOf(current));
  const want = new Set<string>(codeOf(wanted));
  const grant = codeOf(wanted).filter((c) => !have.has(c));
  const revoke = codeOf(current).filter((c) => !want.has(c));
  if (grant.length > 0) await apiClient().post("/v1/rbac/guardian-access", { body: { userId, permissionCodes: grant } });
  if (revoke.length > 0) await apiClient().delete("/v1/rbac/guardian-access", { body: { userId, permissionCodes: revoke } });
  return grant.length + revoke.length > 0;
}

// ---------------------------------------------------------------- organization administrators

/** What one organization administrator has been given in this school. The API names the person by id only. */
export interface OrgDelegation {
  delegateUserId: string;
  codes: string[];
  /** When the earliest of these was given (ISO). */
  since: string;
}

/** What a permission code means, in words for the person reading the list. Areas use the Access screen's own names. */
export function describeDelegatedCode(code: string): string {
  if (code.startsWith("area.")) {
    const area = code.slice("area.".length);
    if (isAdminArea(area)) return `${ADMIN_AREA_INFO[area].label} area`;
  }
  const known: Record<string, string> = {
    "tenant.read": "See the school's details",
    "rbac.staff_areas.manage": "Give staff admin areas",
    "rbac.school_roles.manage": "Manage school roles",
    "resource.learner.read": "Read learner records",
  };
  return known[code] ?? code;
}

/** The active delegations in this school, one entry per person. A person who may not read them (403) gets none. */
export async function apiFetchOrgDelegations(): Promise<OrgDelegation[]> {
  let rows;
  try {
    rows = await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/rbac/org-delegations", { query: { limit: API_PAGE_LIMIT, cursor, status: "active" } });
      return { items: r.items, page: r.page };
    });
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return [];
    throw err;
  }
  const byPerson = new Map<string, OrgDelegation>();
  for (const r of rows) {
    if (!r.delegateUserId || !r.permissionCode) continue;
    const held = byPerson.get(r.delegateUserId);
    const since = r.createdAt ?? "";
    if (!held) byPerson.set(r.delegateUserId, { delegateUserId: r.delegateUserId, codes: [r.permissionCode], since });
    else {
      held.codes.push(r.permissionCode);
      if (since && (!held.since || since < held.since)) held.since = since;
    }
  }
  return [...byPerson.values()].map((d) => ({ ...d, codes: [...d.codes].sort() }));
}

/** Takes away everything an organization administrator was given in this school. */
export async function apiRevokeOrgDelegations(delegateUserId: string): Promise<void> {
  await apiClient().delete("/v1/rbac/org-delegations", { body: { delegateUserId } });
}
