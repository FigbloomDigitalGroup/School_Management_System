import { supabase } from "./supabase";

/**
 * A parent's or guardian's consent before the school keeps a learner's health
 * details (health_consents, see 20261103100000_health_consent.sql). Without
 * it, health details can only be removed; withdrawing clears them. The family
 * doctor and emergency contact are outside it.
 */

export type HealthConsentStatus = "given" | "withdrawn";
export type HealthConsentMethod = "app" | "paper";

/** What the parent reads before deciding, on the web and in the app. */
export const HEALTH_CONSENT_PURPOSE =
  "Sharing your child's health details is optional. The school uses them only to know which activities your child can join, what they can eat, and what to do in an emergency. Only staff who need them can see them.";
export const HEALTH_CONSENT_NO_PRESSURE =
  "If you'd rather not share, that's fine: your child will be treated exactly the same. You can change your mind at any time.";
export const HEALTH_CONSENT_WITHDRAW_WARNING =
  "Withdrawing deletes the allergies, conditions, medication, blood group, diet, support needs and notes on file. The family doctor and emergency contact are kept.";

export interface HealthConsent {
  studentId: string;
  /** null: nobody has decided yet */
  status: HealthConsentStatus | null;
  method: HealthConsentMethod | null;
  guardianName: string | null;
  recordedByName: string | null;
  signedBy: string | null;
  formDate: string | null;
  changedAt: string | null;
  /** health details are on file (whether or not consent was given) */
  hasDetails: boolean;
}

/** One learner's consent, or null when the caller may not see it. */
export async function fetchHealthConsent(studentId: string): Promise<HealthConsent | null> {
  const { data, error } = await supabase().rpc("health_consent_status", { p_student_id: studentId });
  if (error) throw new Error(error.message);
  const r = (data as {
    student_id: string; status: HealthConsentStatus | null; method: HealthConsentMethod | null; guardian_name: string | null;
    recorded_by_name: string | null; signed_by: string | null; form_date: string | null; changed_at: string | null; has_details: boolean;
  }[] | null)?.[0];
  return r ? {
    studentId: r.student_id, status: r.status, method: r.method, guardianName: r.guardian_name, recordedByName: r.recorded_by_name,
    signedBy: r.signed_by, formDate: r.form_date, changedAt: r.changed_at, hasDetails: !!r.has_details,
  } : null;
}

/**
 * Give or withdraw consent. A guardian decides in their app; the office
 * records a signed form (who signed it and its date; to withdraw, who asked).
 * Withdrawing clears the health details.
 */
export async function setHealthConsent(
  studentId: string, give: boolean, paper?: { signedBy: string; formDate?: string | null },
): Promise<HealthConsentStatus> {
  const { data, error } = await supabase().rpc("set_health_consent", {
    p_student_id: studentId, p_give: give, p_signed_by: paper?.signedBy ?? null, p_form_date: paper?.formDate ?? null,
  });
  if (error) throw new Error(error.message);
  return data as HealthConsentStatus;
}

/** The caller's children with health details on file and no decision yet. */
export async function fetchHealthConsentRequests(): Promise<{ studentId: string; fullName: string }[]> {
  const { data, error } = await supabase().rpc("my_health_consent_requests");
  if (error) throw new Error(error.message);
  return ((data ?? []) as { student_id: string; full_name: string }[]).map((r) => ({ studentId: r.student_id, fullName: r.full_name }));
}

/** "Given in the app by Jane Doe on 3 Nov 2026" / "Given on a signed form (John Doe, 1 Nov 2026), recorded by …" */
export function describeHealthConsent(c: HealthConsent): string {
  if (!c.status) return c.hasDetails ? "Consent not recorded" : "No decision yet";
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
  const verb = c.status === "given" ? "Given" : "Withdrawn";
  if (c.method === "app") return `${verb} in the app by ${c.guardianName ?? "a guardian"}${c.changedAt ? ` on ${day(c.changedAt)}` : ""}`;
  const form = c.status === "given" ? `on a signed form (${c.signedBy}${c.formDate ? `, ${day(c.formDate)}` : ""})` : `at ${c.signedBy}'s request`;
  return `${verb} ${form}${c.recordedByName ? `, recorded by ${c.recordedByName}` : ""}`;
}
