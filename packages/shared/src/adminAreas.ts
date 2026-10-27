import { supabase } from "./supabase";
import type { Role } from "./types";

/**
 * Admin access by area (20261031000000). Full admins (the school_admin role,
 * org admins, super admins) have the whole admin console. A teacher or other
 * staff member can additionally hold areas, each opening one part of it: the
 * deputy keeps their teacher login and gains the admin screens their areas
 * cover. School settings, the overview dashboard, reports, the audit trail
 * and these permissions themselves stay with full admins.
 *
 * The database checks every area itself (has_perm); this module is what the
 * screens show and hide, and the presets the office picks from.
 */
export const ADMIN_AREAS = [
  "people", "fees", "academics", "attendance", "transport", "communication",
  "inventory", "activities", "visitors", "medical", "leave",
] as const;
export type AdminArea = (typeof ADMIN_AREAS)[number];

/** What each area allows, in the words the office reads when giving it. */
export const ADMIN_AREA_INFO: Record<AdminArea, { label: string; allows: string }> = {
  people: { label: "People", allows: "Learner, staff and parent records, admissions, bio data approvals, documents, sign-in accounts and passwords." },
  fees: { label: "Fees", allows: "Invoices, payments and proofs, charges, M-Pesa, receipts and signing invoices." },
  academics: { label: "Academics", allows: "Classes, subjects, timetable, exams and marks, publishing results, report cards, performance, learning materials and online classes." },
  attendance: { label: "Attendance", allows: "See every class's register and correct it." },
  transport: { label: "Transport", allows: "Buses, routes and stops, trips, riders and bus alerts." },
  communication: { label: "Communication", allows: "Announcements to the school, and reading the school's chats and call logs." },
  inventory: { label: "Inventory", allows: "Stock, and issuing and collecting items." },
  activities: { label: "Activities", allows: "Sports, clubs and their events, members and patrons." },
  visitors: { label: "Visitors", allows: "The visitor log at the gate and reception." },
  medical: { label: "Medical", allows: "The sick bay: visits, medication rounds, parents' medication requests and health reports, and learners' health records." },
  leave: { label: "Leave", allows: "Approve or decline staff leave requests." },
};

export interface AdminPreset {
  id: string;
  label: string;
  areas: readonly AdminArea[];
}

/** Quick picks for common jobs. A person can hold several; their areas are the union. */
export const ADMIN_PRESETS: readonly AdminPreset[] = [
  { id: "deputy", label: "Deputy principal", areas: ["people", "academics", "attendance", "communication", "leave", "activities"] },
  { id: "dos", label: "Director of studies", areas: ["academics", "attendance"] },
  { id: "secretary", label: "Secretary", areas: ["people", "communication", "visitors"] },
  { id: "bursar", label: "Bursar / accounts", areas: ["fees"] },
  { id: "operator", label: "Operator / data clerk", areas: ["people"] },
  { id: "receptionist", label: "Receptionist", areas: ["visitors"] },
  { id: "nurse", label: "Nurse / matron", areas: ["medical"] },
  { id: "transport", label: "Transport manager", areas: ["transport"] },
  { id: "storekeeper", label: "Storekeeper", areas: ["inventory"] },
  { id: "games", label: "Games / clubs master", areas: ["activities"] },
];

/** Shown beside the presets: the owner or board is not a preset. */
export const DIRECTOR_NOTE =
  "A director, owner or board member should be a full admin of the school, or an admin of its organization, not a preset here. Full admins see everything, including school settings and the overview.";

export function isAdminArea(value: string): value is AdminArea {
  return (ADMIN_AREAS as readonly string[]).includes(value);
}

/** Known areas only, each once, in the order of ADMIN_AREAS. */
export function sortAreas(areas: readonly string[]): AdminArea[] {
  const wanted = new Set(areas);
  return ADMIN_AREAS.filter((a) => wanted.has(a));
}

/** The union of these presets' areas. */
export function areasOfPresets(presetIds: readonly string[]): AdminArea[] {
  return sortAreas(ADMIN_PRESETS.filter((p) => presetIds.includes(p.id)).flatMap((p) => p.areas));
}

/** Presets whose every area is held: the chips that show as on. */
export function presetsWithin(areas: readonly AdminArea[]): string[] {
  return ADMIN_PRESETS.filter((p) => p.areas.every((a) => areas.includes(a))).map((p) => p.id);
}

/**
 * Turning a preset chip on adds its areas. Turning it off takes them away,
 * except those another held preset needs; a smaller preset inside it (the
 * Operator inside the Deputy) goes with it rather than keeping it on.
 */
export function togglePreset(areas: readonly AdminArea[], presetId: string): AdminArea[] {
  const preset = ADMIN_PRESETS.find((p) => p.id === presetId);
  if (!preset) return sortAreas(areas);
  if (!preset.areas.every((a) => areas.includes(a))) return sortAreas([...areas, ...preset.areas]);
  const stillHeld = ADMIN_PRESETS.filter((p) =>
    p.id !== presetId
    && p.areas.every((a) => areas.includes(a))
    && !p.areas.every((a) => preset.areas.includes(a)));
  const keep = new Set(stillHeld.flatMap((p) => p.areas));
  return sortAreas(areas.filter((a) => !preset.areas.includes(a) || keep.has(a)));
}

/** "Fees, People" for a list; "No admin access" for none. */
export function describeAreas(areas: readonly AdminArea[]): string {
  return areas.length ? sortAreas(areas).map((a) => ADMIN_AREA_INFO[a].label).join(", ") : "No admin access";
}

/** Who can hold areas at all: the database refuses a grant to anyone else. */
export function mayHoldAdminAreas(role: Role): boolean {
  return role === "teacher" || role === "staff";
}

/** "all" for a full admin, otherwise the areas held (possibly none). */
export type AdminAccess = "all" | readonly AdminArea[];

/** Full admins see everything; a teacher or other staff member sees their areas; nobody else has any. */
export function adminAccessFor(role: Role, areas: readonly AdminArea[], actingForTenant = false): AdminAccess {
  if (actingForTenant || role === "school_admin" || role === "super_admin" || role === "org_admin") return "all";
  return mayHoldAdminAreas(role) ? sortAreas(areas) : [];
}

export function hasAdminConsole(access: AdminAccess): boolean {
  return access === "all" || access.length > 0;
}

/**
 * Whether a teacher or other staff member gets the "Teacher | Admin" switch.
 * Other staff already keep the visitor log in their own console, so the
 * visitors area alone doesn't send them anywhere new.
 */
export function showsAdminSwitch(role: Role, areas: readonly AdminArea[]): boolean {
  if (role === "teacher") return areas.length > 0;
  if (role === "staff") return areas.some((a) => a !== "visitors");
  return false;
}

/** Where each area's work is in the admin console, for the home page of someone holding only some areas. */
export const ADMIN_AREA_PAGES: Record<AdminArea, { to: string; label: string }[]> = {
  people: [{ to: "admin/people", label: "Students & staff" }],
  fees: [{ to: "admin/fees", label: "Fees" }],
  academics: [
    { to: "admin/classes", label: "Classes" }, { to: "admin/subjects", label: "Subjects" }, { to: "admin/courses", label: "Courses" },
    { to: "admin/exams", label: "Exams" }, { to: "admin/papers", label: "Exams & tests" }, { to: "admin/report-cards", label: "Report cards" },
    { to: "admin/performance", label: "Performance" }, { to: "admin/materials", label: "Learning materials" },
  ],
  attendance: [],
  transport: [{ to: "admin/fleet", label: "Fleet" }],
  communication: [{ to: "admin/announcements", label: "Announcements" }, { to: "admin/chats", label: "Chats" }],
  inventory: [{ to: "admin/inventory", label: "Inventory" }],
  activities: [{ to: "admin/activities", label: "Sports & activities" }],
  visitors: [{ to: "admin/visitors", label: "Visitors" }],
  medical: [{ to: "admin/medical", label: "Sick bay" }],
  leave: [{ to: "admin/leave", label: "Leave requests" }],
};

/**
 * Which area each admin console page needs (NAV.school_admin's `to`).
 * "full": full admins only. null: anyone with the console (their own
 * account, and the home page, which is the overview for full admins and a
 * list of their areas for everyone else).
 */
export const ADMIN_PAGE_AREA: Record<string, AdminArea | "full" | null> = {
  "admin": null,
  "admin/people": "people",
  "admin/classes": "academics",
  "admin/subjects": "academics",
  "admin/courses": "academics",
  "admin/exams": "academics",
  "admin/papers": "academics",
  "admin/materials": "academics",
  "admin/report-cards": "academics",
  "admin/performance": "academics",
  "admin/fees": "fees",
  // who has the study helper on and how much they use it (the bursar answers families about its charge)
  "admin/study-helper": "fees",
  "admin/announcements": "communication",
  "admin/chats": "communication",
  "admin/activities": "activities",
  "admin/leave": "leave",
  "admin/visitors": "visitors",
  "admin/medical": "medical",
  "admin/inventory": "inventory",
  "admin/fleet": "transport",
  "admin/reports": "full",
  "admin/settings": "full",
  "admin/access": "full",
  "admin/bloom": "full",
  "admin/account": null,
};

/** Whether this access opens that admin page. A page not listed is full admins only. */
export function mayOpenAdminPage(access: AdminAccess, page: string): boolean {
  if (access === "all") return true;
  if (access.length === 0) return false;
  const need = ADMIN_PAGE_AREA[page];
  if (need === null) return true;
  return need !== undefined && need !== "full" && access.includes(need);
}

/** The signed-in person's areas at their school: their own and those of every school role they hold. */
export async function fetchMyAdminAreas(): Promise<AdminArea[]> {
  const { data, error } = await supabase().rpc("my_admin_areas");
  if (error) throw new Error(error.message);
  return sortAreas((data ?? []) as string[]);
}

/** Everyone's direct areas at a school, by profile (full admins only; RLS returns nothing to anyone else). */
export async function fetchSchoolAdminAreas(tenantId: string): Promise<Map<string, AdminArea[]>> {
  const { data, error } = await supabase().from("staff_permissions").select("profile_id, area").eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);
  const byProfile = new Map<string, string[]>();
  for (const r of (data ?? []) as { profile_id: string; area: string }[]) {
    byProfile.set(r.profile_id, [...(byProfile.get(r.profile_id) ?? []), r.area]);
  }
  return new Map([...byProfile].map(([id, areas]) => [id, sortAreas(areas)]));
}

/** Replaces a teacher's or other staff member's areas (set_staff_areas: full admins only, never your own). */
export async function setStaffAreas(profileId: string, areas: readonly AdminArea[]): Promise<AdminArea[]> {
  const { data, error } = await supabase().rpc("set_staff_areas", { p_profile_id: profileId, p_areas: sortAreas(areas) });
  if (error) throw new Error(error.message);
  return sortAreas((data ?? []) as string[]);
}

// ---------------------------------------------------------------- school roles
/** A role a school made for itself ("Exams officer"): a name and areas, given to teachers and other staff. */
export interface SchoolRole {
  id: string;
  name: string;
  areas: AdminArea[];
  /** Who holds it, by profile id. */
  holderIds: string[];
}

/** The school's roles with who holds each (full admins only; RLS returns nothing to anyone else). */
export async function fetchSchoolRoles(tenantId: string): Promise<SchoolRole[]> {
  const [{ data: roles, error }, { data: held, error: heldError }] = await Promise.all([
    supabase().from("school_roles").select("id, name, areas").eq("tenant_id", tenantId).order("name"),
    supabase().from("staff_role_assignments").select("role_id, profile_id").eq("tenant_id", tenantId),
  ]);
  if (error) throw new Error(error.message);
  if (heldError) throw new Error(heldError.message);
  const holders = new Map<string, string[]>();
  for (const a of (held ?? []) as { role_id: string; profile_id: string }[]) {
    holders.set(a.role_id, [...(holders.get(a.role_id) ?? []), a.profile_id]);
  }
  return ((roles ?? []) as { id: string; name: string; areas: string[] }[])
    .map((r) => ({ id: r.id, name: r.name, areas: sortAreas(r.areas), holderIds: holders.get(r.id) ?? [] }));
}

/** The role ids a person holds, from fetchSchoolRoles' answer. */
export function rolesHeldBy(roles: readonly SchoolRole[], profileId: string): string[] {
  return roles.filter((r) => r.holderIds.includes(profileId)).map((r) => r.id);
}

/** Everything a person can do: their direct areas and their roles' areas. */
export function effectiveAreas(direct: readonly AdminArea[], roles: readonly SchoolRole[], roleIds: readonly string[]): AdminArea[] {
  return sortAreas([...direct, ...roles.filter((r) => roleIds.includes(r.id)).flatMap((r) => r.areas)]);
}

/** Creates a role (id null) or changes one; everyone holding it gets the new areas straight away. */
export async function saveSchoolRole(tenantId: string, id: string | null, name: string, areas: readonly AdminArea[]): Promise<string> {
  const { data, error } = await supabase().rpc("save_school_role", { p_id: id, p_tenant_id: tenantId, p_name: name, p_areas: sortAreas(areas) });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Deletes a role, taking its areas from everyone who held it; answers how many people that was. */
export async function deleteSchoolRole(id: string): Promise<number> {
  const { data, error } = await supabase().rpc("delete_school_role", { p_id: id });
  if (error) throw new Error(error.message);
  return (data ?? 0) as number;
}

/** Replaces the school roles a teacher or other staff member holds (full admins only, never your own). */
export async function setStaffRoles(profileId: string, roleIds: readonly string[]): Promise<string[]> {
  const { data, error } = await supabase().rpc("set_staff_roles", { p_profile_id: profileId, p_role_ids: [...roleIds] });
  if (error) throw new Error(error.message);
  return (data ?? []) as string[];
}
