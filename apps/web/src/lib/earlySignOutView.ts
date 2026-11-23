import { leftEarlyText, signOutList, type EarlySignOut, type EarlySignOutCollector, type EarlySignOutDraft } from "@figbloom/shared";

/** What a screen shows where the database gave it no ID number or phone for a sign-out (RLS: attendance area and the recorder only). */
export const COLLECTOR_RESTRICTED_TEXT = "ID number and phone: restricted";

/** The collector's ID number and phone, or the restricted sentence: never an empty value. */
export function collectorContactText(details: EarlySignOutCollector | undefined | null): string {
  const id = details?.id_number?.trim();
  const phone = details?.phone?.trim();
  if (!id || !phone) return COLLECTOR_RESTRICTED_TEXT;
  return `ID number ${id} · phone ${phone}`;
}

/** What a screen shows where the database gave it no restricted details (who authorised it, the note). */
export const RESTRICTED_TEXT = "restricted";

/** Who authorised the sign-out, or "restricted" when the database did not return the details (attendance area and the recorder only). */
export function authorisedByText(details: EarlySignOutCollector | undefined | null): string {
  return details?.authorised_by?.trim() || RESTRICTED_TEXT;
}

/** The note: "restricted" when the details were not returned, null when they were and there is no note. */
export function noteText(details: EarlySignOutCollector | undefined | null): string | null {
  if (!details) return RESTRICTED_TEXT;
  return details.note?.trim() || null;
}

/** Why a sign-out was voided, or "restricted" when the database did not return the details (attendance area and the recorder only). */
export function voidReasonText(details: EarlySignOutCollector | undefined | null): string {
  return details?.void_reason?.trim() || RESTRICTED_TEXT;
}

/** The warning shown when the learner being signed out is marked absent today; null for every other mark (or none known). */
export function absentSignOutWarning(studentName: string, todayMark: "present" | "absent" | "late" | "excused" | null | undefined): string | null {
  if (todayMark !== "absent") return null;
  return `${studentName} is marked absent today. A sign-out records that they left school: check this is the right learner.`;
}

/** A picker label; learners who already left today say so, with the time of their latest sign-out. Never contains "ADM ". */
export function signOutPickerLabel(name: string, admissionNo: string, latest: Pick<EarlySignOut, "signed_out_local"> | null | undefined): string {
  const base = `${name} · ${admissionNo}`;
  return latest ? `${base} (signed out ${latest.signed_out_local.slice(0, 5)})` : base;
}

/** "Wanjiru Kamau (mother)". */
export function collectorLine(s: Pick<EarlySignOut, "collected_by_name" | "collected_by_relationship">): string {
  return `${s.collected_by_name} (${s.collected_by_relationship})`;
}

/** "Left early at 10:45", for a badge. */
export function leftEarlyLabel(s: Pick<EarlySignOut, "signed_out_local">): string {
  const t = leftEarlyText(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** A blank form for one learner. */
export function emptySignOutDraft(studentId: string): EarlySignOutDraft {
  return {
    student_id: studentId, reason: "", authorised_by: "", collected_by_name: "", collected_by_relationship: "",
    collected_by_id_number: "", collected_by_phone: "", note: "", signed_out_time: "",
  };
}

/** Every live (not voided) sign-out in these rows, in the order they left: the register's "left early today" list. */
export function liveSignOutRows(rows: EarlySignOut[]): EarlySignOut[] {
  return signOutList(rows).filter((r) => !r.voided_at);
}
