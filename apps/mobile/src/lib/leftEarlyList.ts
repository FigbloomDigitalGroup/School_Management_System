import { leftEarlyText, type EarlySignOut } from "@figbloom/shared";

export interface LeftEarlyLine {
  studentId: string;
  /** "Name - left early at HH:MM" */
  text: string;
}

/**
 * The read-only "Left early" list on the register-is-in summary: one line per learner of the class with a live sign-out today,
 * in roster order. Display only; an empty map gives an empty list. Never carries the collector, ID number or phone.
 */
export function leftEarlyLines(
  roster: Array<{ id: string; full_name: string }> | null | undefined,
  signOuts: Map<string, Pick<EarlySignOut, "signed_out_local">>,
): LeftEarlyLine[] {
  const out: LeftEarlyLine[] = [];
  for (const st of roster ?? []) {
    const so = signOuts.get(st.id);
    if (so) out.push({ studentId: st.id, text: `${st.full_name} - ${leftEarlyText(so)}` });
  }
  return out;
}
