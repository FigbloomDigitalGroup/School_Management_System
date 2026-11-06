import type { AdminAccess } from "./adminAreas";
import { today } from "./attendance";
import { invokeEdge } from "./edge";
import { supabase } from "./supabase";

/**
 * Early sign-out (20261106000000_early_sign_out.sql, FIG-1513 stage A): a learner marked present who leaves during the day is recorded
 * with who authorised it and who collected them. The register, the learner's record and the parent app show "left early at HH:MM";
 * the office and the gate have a daily list.
 *
 * Stage A leaves the register itself alone: the sign-out is a separate record joined in when a register is shown, so the attendance
 * key, the offline queue and the registers already on phones are unchanged. The afternoon-register treatment (a signed-out learner is
 * not absent without reason) waits for FIG-1514.
 *
 * Who sees what is decided by the database (RLS), not by this file. The sign-out itself (time, reason, collector name and
 * relationship) is read by the attendance and visitors areas, the class teacher, the recorder and the learner's guardians. The
 * restricted details (the collector's ID number and phone, who authorised the sign-out, the note, the void reason) come back only for the attendance
 * area and the person who recorded the sign-out, so fetchCollectorDetails() returns nothing for everyone else. A learner may leave,
 * return and leave again: each departure is its own record.
 */

export interface EarlySignOut {
  id: string;
  tenant_id: string;
  student_id: string;
  class_id: string | null;
  student_name: string;
  class_name: string | null;
  /** The school day, yyyy-mm-dd. */
  taken_on: string;
  signed_out_at: string;
  /** The wall-clock time at the school, "HH:MM:SS": show the first five characters. */
  signed_out_local: string;
  reason: string;
  collected_by_name: string;
  collected_by_relationship: string;
  recorded_by: string | null;
  recorded_at: string;
  voided_at: string | null;
}

/**
 * The restricted details of a sign-out: the collector's ID number and phone, who authorised it, and the free-text note. Personal data
 * and private remarks: RLS gives them only to the attendance area (full admins) and the person who recorded the sign-out.
 */
export interface EarlySignOutCollector {
  sign_out_id: string;
  id_number: string;
  phone: string;
  authorised_by: string;
  note: string | null;
  /** Why a voided sign-out was voided (free text, so restricted like the note). Null while the sign-out is live. */
  void_reason: string | null;
}

export interface EarlySignOutDraft {
  student_id: string;
  reason: string;
  authorised_by: string;
  collected_by_name: string;
  collected_by_relationship: string;
  collected_by_id_number: string;
  collected_by_phone: string;
  note?: string;
  /**
   * An earlier time today on the school's clock, "HH:MM"; empty means now. Never later than now. The database combines it with today
   * in the school's own time zone, so no screen needs to know the time zone.
   */
  signed_out_time?: string;
}

/** "HH:MM", 24 hours: what the optional time-out field accepts. */
export const SIGN_OUT_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The same pattern as the check on early_sign_out_collectors.phone and in record_early_sign_out() (keep the three in step). */
export const COLLECTOR_PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{5,19}$/;

/**
 * Why this draft can't be saved yet, in words for the person recording it; null when it can. The same rules and the same words as
 * record_early_sign_out() (guardrail 5: change both together). The collected-by details are all required.
 */
export function earlySignOutProblem(d: EarlySignOutDraft): string | null {
  const reason = d.reason.trim();
  const authorised = d.authorised_by.trim();
  const name = d.collected_by_name.trim();
  const relationship = d.collected_by_relationship.trim();
  const idNumber = d.collected_by_id_number.trim();
  const phone = d.collected_by_phone.trim();
  const note = d.note?.trim() ?? "";
  if (!d.student_id) return "Pick the learner.";
  if (!reason || reason.length > 200) return "Say why the learner is leaving (up to 200 characters).";
  if (!authorised || authorised.length > 120) return "Say who authorised the sign-out.";
  if (!name || name.length > 120) return "Enter the name of the person collecting the learner.";
  if (!relationship || relationship.length > 60) return "Enter how the collector is related to the learner.";
  if (idNumber.length < 3 || idNumber.length > 30) return "Enter the collector's ID number.";
  if (!COLLECTOR_PHONE_PATTERN.test(phone)) return "Enter the collector's phone number.";
  if (note.length > 500) return "The note can be up to 500 characters.";
  const time = d.signed_out_time?.trim() ?? "";
  if (time && !SIGN_OUT_TIME_PATTERN.test(time)) return "Enter the time as hours and minutes, like 10:45.";
  return null;
}

/**
 * Who is offered the "Sign out early" action: full admins, whoever holds the attendance area, and the class teacher of the learner's
 * class. The same people record_early_sign_out() accepts (guardrail 5); the database refuses everyone else, so this only decides what
 * the screens show. `access` is adminAccessFor(); `isClassTeacher` is classes.class_teacher_id = the viewer.
 */
export function mayRecordEarlySignOut(access: AdminAccess, isClassTeacher: boolean): boolean {
  return isClassTeacher || access === "all" || access.includes("attendance");
}

/** Who may void a sign-out: the attendance area (and full admins), or the person who recorded it. Mirrors void_early_sign_out(). */
export function mayVoidEarlySignOut(access: AdminAccess, recordedBy: string | null, viewerId: string): boolean {
  return access === "all" || access.includes("attendance") || (recordedBy !== null && recordedBy === viewerId);
}

/** Who sees the school's daily list: the attendance area and the visitors area (the gate), and full admins. Mirrors early_sign_outs_read. */
export function maySeeSignOutList(access: AdminAccess): boolean {
  return access === "all" || access.includes("attendance") || access.includes("visitors");
}

/** "10:45" from the stored wall-clock time. */
export function signOutTime(s: Pick<EarlySignOut, "signed_out_local">): string {
  return s.signed_out_local.slice(0, 5);
}

/** "left early at 10:45". */
export function leftEarlyText(s: Pick<EarlySignOut, "signed_out_local">): string {
  return `left early at ${signOutTime(s)}`;
}

/** A register mark with the sign-out, if any: "Present, left early at 10:45". A voided sign-out shows nothing extra. */
export function markWithSignOut(markLabel: string, s: Pick<EarlySignOut, "signed_out_local" | "voided_at"> | null | undefined): string {
  return s && !s.voided_at ? `${markLabel}, ${leftEarlyText(s)}` : markLabel;
}

/**
 * The latest live (not voided) sign-out of each learner. A learner may leave, return and leave again in a day, so a learner can have
 * several; the one shown beside their name is the last departure (the order the rows came in does not matter).
 */
export function liveSignOutsByStudent(rows: EarlySignOut[]): Map<string, EarlySignOut> {
  const out = new Map<string, EarlySignOut>();
  for (const r of rows) {
    if (r.voided_at) continue;
    const seen = out.get(r.student_id);
    if (!seen || r.signed_out_at > seen.signed_out_at) out.set(r.student_id, r);
  }
  return out;
}

/** The daily list: live sign-outs first, in the order they left; voided ones after, so a correction is visible. */
export function signOutList(rows: EarlySignOut[]): EarlySignOut[] {
  return [...rows].sort(
    (a, b) => Number(!!a.voided_at) - Number(!!b.voided_at) || a.signed_out_at.localeCompare(b.signed_out_at),
  );
}

/**
 * What the parent's phone is told. The same words the notify function pushes
 * (supabase/functions/early-sign-out-notify/plan.ts): keep the two in step. The collector's ID number and phone are never in it.
 */
export function signOutPushText(s: Pick<EarlySignOut, "student_name" | "signed_out_local" | "collected_by_name" | "collected_by_relationship">): { title: string; body: string } {
  const first = s.student_name.trim().split(/\s+/)[0] || "Your child";
  return {
    title: `${first} was signed out early`,
    body: `Signed out at ${signOutTime(s)}, collected by ${s.collected_by_name} (${s.collected_by_relationship}).`,
  };
}

// ---------------------------------------------------------------- data

/** Never the restricted details (those are in their own table), so a parent's or a teacher's request cannot ask for them. */
const SIGN_OUT_COLUMNS =
  "id, tenant_id, student_id, class_id, student_name, class_name, taken_on, signed_out_at, signed_out_local, reason, " +
  "collected_by_name, collected_by_relationship, recorded_by, recorded_at, voided_at";

/** Records a sign-out through record_early_sign_out(); the database decides who may and refuses with words. Returns the new id. */
export async function recordEarlySignOut(draft: EarlySignOutDraft): Promise<string> {
  const { data, error } = await supabase().rpc("record_early_sign_out", {
    p_student_id: draft.student_id,
    p_reason: draft.reason,
    p_authorised_by: draft.authorised_by,
    p_collected_by_name: draft.collected_by_name,
    p_collected_by_relationship: draft.collected_by_relationship,
    p_collected_by_id_number: draft.collected_by_id_number,
    p_collected_by_phone: draft.collected_by_phone,
    p_note: draft.note?.trim() ? draft.note : null,
    p_signed_out_time: draft.signed_out_time?.trim() ? draft.signed_out_time.trim() : null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Voids a sign-out made by mistake. It stays on record, marked void, with the reason. */
export async function voidEarlySignOut(id: string, reason: string): Promise<void> {
  const { error } = await supabase().rpc("void_early_sign_out", { p_id: id, p_reason: reason });
  if (error) throw new Error(error.message);
}

/** The school's sign-outs for one day (default: today), voided ones included. RLS decides who gets rows. */
export async function fetchEarlySignOuts(tenantId: string, day: string = today()): Promise<EarlySignOut[]> {
  const { data, error } = await supabase().from("early_sign_outs").select(SIGN_OUT_COLUMNS)
    .eq("tenant_id", tenantId).eq("taken_on", day).order("signed_out_at", { ascending: true }).returns<EarlySignOut[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** These learners' sign-outs on one day (default: today): what a register or the parent's home screen joins in. */
export async function fetchEarlySignOutsForStudents(studentIds: string[], day: string = today()): Promise<EarlySignOut[]> {
  if (!studentIds.length) return [];
  const { data, error } = await supabase().from("early_sign_outs").select(SIGN_OUT_COLUMNS)
    .in("student_id", studentIds).eq("taken_on", day).returns<EarlySignOut[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** One learner's sign-outs, newest first: their record. */
export async function fetchStudentEarlySignOuts(studentId: string, limit = 50): Promise<EarlySignOut[]> {
  const { data, error } = await supabase().from("early_sign_outs").select(SIGN_OUT_COLUMNS)
    .eq("student_id", studentId).order("signed_out_at", { ascending: false }).limit(limit).returns<EarlySignOut[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * The collectors' ID numbers and phones for these sign-outs. RLS returns a row only to the attendance area and to the person who
 * recorded the sign-out, so for anyone else the map is empty: show "details restricted", never an empty number.
 */
export async function fetchCollectorDetails(signOutIds: string[]): Promise<Map<string, EarlySignOutCollector>> {
  const out = new Map<string, EarlySignOutCollector>();
  if (!signOutIds.length) return out;
  const { data, error } = await supabase().from("early_sign_out_collectors").select("sign_out_id, id_number, phone, authorised_by, note, void_reason")
    .in("sign_out_id", signOutIds).returns<EarlySignOutCollector[]>();
  if (error) throw new Error(error.message);
  for (const r of data ?? []) out.set(r.sign_out_id, r);
  return out;
}

/** The parent's phone, via early-sign-out-notify. Best effort: the sign-out is already recorded, so a push that fails never fails it. */
export async function pushEarlySignOut(id: string): Promise<void> {
  await invokeEdge("early-sign-out-notify", { sign_out_id: id }, { timeoutMs: 15_000 }).catch(() => {});
}
