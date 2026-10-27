import { supabase } from "./supabase";
import { audienceIncludes, STAFF_ROLES, type AudienceViewer } from "./audience";
import type { Audience, ClassGroup, ClassLevel, Role } from "./types";

/**
 * Everyone in a school a composer can address, each with the AudienceViewer
 * the inboxes would build for them -- so "Reaches N people" is counted with
 * the exact rule that decides who actually sees the message, not a separate
 * estimate that could drift from it. Shared by admin's Announcements and the
 * teacher Messages composers (web and teacher-mobile).
 */

export interface RosterPerson {
  profileId: string;
  name: string;
  role: Role;
  /** One line under the name: a student's class, a parent's children, a staff title. */
  detail: string;
  viewer: AudienceViewer;
}

export interface MessageRoster {
  people: RosterPerson[];
  classes: Pick<ClassGroup, "id" | "name" | "level" | "form_level">[];
}

const PAGE = 1000; // PostgREST's default max-rows; a large school has more people than that

/** Every row of a query, a page at a time. */
async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

const ROLE_WORD: Partial<Record<Role, string>> = {
  school_admin: "Admin",
  teacher: "Teacher",
  driver: "Driver",
  guard: "Guard",
  receptionist: "Receptionist",
  parent: "Parent",
  student: "Student",
};

export async function fetchMessageRoster(tenantId: string): Promise<MessageRoster> {
  const sb = supabase();
  const [profiles, students, guardians, classes] = await Promise.all([
    allRows<{ id: string; full_name: string; role: Role; staff_title: string | null }>((from, to) =>
      sb.from("profiles").select("id, full_name, role, staff_title").eq("tenant_id", tenantId).order("full_name").range(from, to)),
    allRows<{ id: string; profile_id: string | null; full_name: string; class_id: string | null }>((from, to) =>
      sb.from("students").select("id, profile_id, full_name, class_id").eq("tenant_id", tenantId).eq("active", true).order("id").range(from, to)),
    allRows<{ profile_id: string; student_id: string }>((from, to) =>
      sb.from("guardians").select("profile_id, student_id").eq("tenant_id", tenantId).order("student_id").range(from, to)),
    allRows<Pick<ClassGroup, "id" | "name" | "level" | "form_level">>((from, to) =>
      sb.from("classes").select("id, name, level, form_level").eq("tenant_id", tenantId).order("form_level").order("name").range(from, to)),
  ]);

  const classById = new Map(classes.map((c) => [c.id, c]));
  const studentById = new Map(students.map((s) => [s.id, s]));
  const studentByProfile = new Map(students.filter((s) => s.profile_id).map((s) => [s.profile_id!, s]));
  const childrenOf = new Map<string, typeof students>();
  for (const g of guardians) {
    const kid = studentById.get(g.student_id);
    if (!kid) continue;
    const arr = childrenOf.get(g.profile_id) ?? [];
    arr.push(kid);
    childrenOf.set(g.profile_id, arr);
  }

  const yearsOf = (classIds: string[]): { level: ClassLevel; year: number }[] =>
    classIds.map((id) => classById.get(id)).filter((c): c is NonNullable<typeof c> => !!c).map((c) => ({ level: c.level, year: c.form_level }));

  const people: RosterPerson[] = [];
  for (const p of profiles) {
    if (p.role === "super_admin" || p.role === "org_admin") continue;
    let classIds: string[] = [];
    let detail = p.staff_title || ROLE_WORD[p.role] || p.role;
    if (p.role === "student") {
      const s = studentByProfile.get(p.id);
      if (!s) continue; // a student account whose record is inactive -- nothing reaches them
      classIds = s.class_id ? [s.class_id] : [];
      detail = s.class_id ? `Student, ${classById.get(s.class_id)?.name ?? "no class"}` : "Student";
    } else if (p.role === "parent") {
      const kids = childrenOf.get(p.id) ?? [];
      classIds = [...new Set(kids.map((k) => k.class_id).filter((id): id is string => !!id))];
      detail = kids.length
        ? `Parent of ${kids.map((k) => `${k.full_name.split(" ")[0]}${k.class_id ? ` (${classById.get(k.class_id)?.name ?? ""})` : ""}`).join(", ")}`
        : "Parent";
    }
    people.push({
      profileId: p.id,
      name: p.full_name,
      role: p.role,
      detail,
      viewer: { profileId: p.id, role: p.role, classIds, years: yearsOf(classIds) },
    });
  }

  return { people, classes };
}

/** How many of these people an audience reaches -- the same rule their inboxes use. */
export function reachOf(audience: Audience, people: readonly RosterPerson[]): number {
  let n = 0;
  for (const p of people) if (audienceIncludes(audience, p.viewer)) n++;
  return n;
}

/** Who a teacher may pick by name: parents and students of their own
 *  classes, and fellow staff. Never themselves. */
export function teacherPickablePeople(people: readonly RosterPerson[], teacherId: string, classIds: readonly string[]): RosterPerson[] {
  const mine = new Set(classIds);
  return people.filter((p) => p.profileId !== teacherId && (
    STAFF_ROLES.includes(p.role) || p.viewer.classIds.some((id) => mine.has(id))
  ));
}

/** Name/role/class search for the "Specific people" picker. Every word
 *  must match somewhere in the name or detail line. */
export function searchRoster(people: readonly RosterPerson[], query: string, limit = 8): RosterPerson[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: RosterPerson[] = [];
  for (const p of people) {
    const hay = `${p.name} ${p.detail} ${ROLE_WORD[p.role] ?? ""}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
