import { STAFF_ROLES } from "./audience";
import type { LearnerGuardianContact } from "./learnerBio";
import { normalisePhoneForCountry } from "./phone";
import { supabase } from "./supabase";
import type { Role } from "./types";

/**
 * Looking a person up from the office, on the move: a learner by name or admission number, and the people to call
 * about them (their guardians); a member of staff by name. The web's People screen reads the whole school and
 * filters on the page; a phone asks the database for the few that match what was typed.
 */

/** Fewer letters than this match half the school; nothing is searched for them. */
export const MIN_SEARCH_LENGTH = 2;
/** How many are listed: more than that means "type a little more". */
export const SEARCH_LIMIT = 25;

/** What was typed, without the characters that would cut a PostgREST filter short (it splits on commas and brackets). */
export function searchText(q: string): string {
  return q.replace(/[%,()]/g, " ").trim();
}

export interface FoundLearner {
  id: string;
  name: string;
  admissionNo: string;
  className: string | null;
  boarding: boolean;
}

export interface FoundStaff {
  id: string;
  name: string;
  role: Role;
  /** "Deputy principal", when they have one. */
  title: string | null;
  phone: string | null;
  email: string | null;
}

/** Active learners of the school whose name or admission number contains what was typed, by name. */
export async function searchLearners(tenantId: string, q: string): Promise<FoundLearner[]> {
  const text = searchText(q);
  if (text.length < MIN_SEARCH_LENGTH) return [];
  const { data, error } = await supabase().from("students")
    .select("id, full_name, admission_no, boarding, classes(name)")
    .eq("tenant_id", tenantId).eq("active", true)
    .or(`full_name.ilike.%${text}%,admission_no.ilike.%${text}%`)
    .order("full_name").limit(SEARCH_LIMIT)
    .returns<{ id: string; full_name: string; admission_no: string; boarding: boolean | null; classes: { name: string } | null }[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((s) => ({ id: s.id, name: s.full_name, admissionNo: s.admission_no, className: s.classes?.name ?? null, boarding: s.boarding === true }));
}

/** The school's staff (admins, teachers, drivers, other staff) whose name contains what was typed, by name. */
export async function searchStaff(tenantId: string, q: string): Promise<FoundStaff[]> {
  const text = searchText(q);
  if (text.length < MIN_SEARCH_LENGTH) return [];
  const { data, error } = await supabase().from("profiles")
    .select("id, full_name, role, staff_title, phone, email")
    .eq("tenant_id", tenantId).in("role", STAFF_ROLES).ilike("full_name", `%${text}%`)
    .order("full_name").limit(SEARCH_LIMIT)
    .returns<{ id: string; full_name: string; role: Role; staff_title: string | null; phone: string | null; email: string | null }[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((p) => ({ id: p.id, name: p.full_name, role: p.role, title: p.staff_title, phone: p.phone, email: p.email }));
}

/** "ADM 1042 · Form 1A · Boarder": the line under a learner's name. */
export function learnerLine(l: Pick<FoundLearner, "admissionNo" | "className" | "boarding">): string {
  return [`ADM ${l.admissionNo}`, l.className, l.boarding ? "Boarder" : "Day scholar"].filter(Boolean).join(" · ");
}

const STAFF_WORD: Partial<Record<Role, string>> = { school_admin: "Admin", teacher: "Teacher", driver: "Driver", staff: "Staff" };

/** The line under a member of staff's name: their own title, else what they are. */
export function staffLine(s: Pick<FoundStaff, "role" | "title">): string {
  return s.title?.trim() || STAFF_WORD[s.role] || "Staff";
}

/** A guardian's relationship, as a word. */
export const RELATIONSHIP_WORD: Record<LearnerGuardianContact["relationship"], string> = { mother: "Mother", father: "Father", guardian: "Guardian" };

/**
 * The link that starts a call to this number from the phone's dialer, in international form ("0712 345 678" at a Kenyan
 * school is tel:+254712345678); null when there is no number to dial.
 */
export function callUrl(raw: string | null | undefined, country: string): string | null {
  if (!raw || raw.replace(/\D/g, "").length < 7) return null;
  return `tel:${normalisePhoneForCountry(raw, country)}`;
}

export interface GuardianCall {
  /** "phone" or "alt": which of their two numbers. */
  which: "phone" | "alt";
  /** As the school has it on file. */
  number: string;
  url: string;
}

/** The numbers a guardian can be called on, the main one first. */
export function guardianCalls(g: Pick<LearnerGuardianContact, "phone" | "alt_phone">, country: string): GuardianCall[] {
  const calls: GuardianCall[] = [];
  const main = callUrl(g.phone, country);
  if (main) calls.push({ which: "phone", number: g.phone!.trim(), url: main });
  const alt = callUrl(g.alt_phone, country);
  // the same number twice is one number
  if (alt && alt !== main) calls.push({ which: "alt", number: g.alt_phone!.trim(), url: alt });
  return calls;
}
