import { supabase } from "./supabase";

/**
 * Who may use the Bloom study helper (ai-assist task "tutor"), the parent
 * opt-in, and billing it to the family's fee invoice
 * (supabase/migrations/20261101100000_ai_helper_optin.sql).
 *
 * A school either gives the helper to every learner (the old behaviour) or
 * only to learners whose parent or guardian has turned it on. Billing (a
 * charge per term on the learner's invoice) is built but not available:
 * the database refuses it until a migration turns it on, and this constant
 * keeps the switch and the price out of the screens until then. To turn
 * billing on, see the migration's header; this constant is its step 3.
 */
export const AI_HELPER_BILLING_AVAILABLE = false;

export type AiHelperAccess = "all" | "opt_in";

/** Why a learner can't use the helper: the school has it off, it needs a parent's opt-in, or an exam is on. */
export type AiHelperRefusal = "school_off" | "needs_optin" | "exam";

// ------------------------------------------------------------------ pure

/**
 * Whether an opt-in lets the learner in. Once the school bills for the
 * helper, an opt-in covers the term it was made in, so each term is chosen
 * (and charged) afresh; until then it stands until turned off.
 */
export function optInActive(
  optIn: { status: "on" | "off" | null; termId: string | null } | null,
  billingEnabled: boolean,
  currentTermId: string | null,
): boolean {
  if (!optIn || optIn.status !== "on") return false;
  return !billingEnabled || (optIn.termId !== null && optIn.termId === currentTermId);
}

/**
 * The learner's state, as ai_helper_allowed() answers it, except the exam
 * check, which only the server can make (ai_tutor_blocked()). The screens
 * use it to pick what to show; ai-assist decides.
 */
export function helperRefusal(s: {
  aiEnabled: boolean; tutorEnabled: boolean; access: AiHelperAccess; optInActive: boolean;
}): Exclude<AiHelperRefusal, "exam"> | null {
  if (!s.aiEnabled || !s.tutorEnabled) return "school_off";
  if (s.access === "opt_in" && !s.optInActive) return "needs_optin";
  return null;
}

/** What a learner reads instead of the helper. */
export const AI_HELPER_REFUSAL_TEXT: Record<Exclude<AiHelperRefusal, "exam">, string> = {
  school_off: "Your school hasn't turned on the study helper.",
  needs_optin: "Ask your parent or guardian to turn on the study helper for you (in their Figbloom app).",
};

/** The line on the family's statement: ai_helper_bill_optin() writes the same. */
export function helperChargeReason(termIndex: number): string {
  return `Bloom study helper, Term ${termIndex}`;
}

/**
 * What turning the helper off does to this term's charge, as
 * ai_helper_bill_optin() decides it: cancelled within cancelDays of being
 * made, unless the invoice has already been paid past it (there is no
 * refund flow); otherwise it stands.
 */
export function chargeOnTurnOff(c: {
  chargedAt: string; cancelDays: number; now: Date;
  amountCents: number; invoiceTotalCents: number; invoicePaidCents: number;
}): "cancel" | "keep" {
  const cutOff = new Date(c.chargedAt).getTime() + c.cancelDays * 86_400_000;
  if (c.now.getTime() > cutOff) return "keep";
  if (c.invoicePaidCents > c.invoiceTotalCents - c.amountCents) return "keep";
  return "cancel";
}

/** The last day a charge made at chargedAt can still be cancelled by turning the helper off. */
export function cancelCutOff(chargedAt: string, cancelDays: number): Date {
  return new Date(new Date(chargedAt).getTime() + cancelDays * 86_400_000);
}

/** The settings form's price, typed in whole shillings ("500", "1,500", "1500.50"), as cents; null if it isn't one. */
export function priceCentsFromKes(input: string): number | null {
  const s = input.replace(/[,\s]/g, "").replace(/^KES/i, "");
  if (s === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents <= 10_000_000 ? cents : null;
}

/** What set_ai_helper_optin answered, in words a parent reads. */
export function optInOutcomeText(outcome: string, childFirst: string): string {
  switch (outcome) {
    case "on": return `The study helper is on for ${childFirst}.`;
    case "off": return `The study helper is off for ${childFirst}.`;
    case "charged": return `The study helper is on for ${childFirst}, and this term's charge is on the fee invoice.`;
    case "already_charged": return `The study helper is on for ${childFirst}. This term is already paid for on the fee invoice.`;
    case "cancelled": return `The study helper is off for ${childFirst}, and this term's charge has been taken off the invoice.`;
    case "kept": return `The study helper is off for ${childFirst}. This term's charge stays on the invoice.`;
    default: return outcome === "nothing_to_cancel" || outcome === "billing_off" || outcome === "free"
      ? `Saved for ${childFirst}.` : "Saved.";
  }
}

// ------------------------------------------------------------------ the school's settings (full admins)

export interface AiHelperSettings {
  access: AiHelperAccess;
  priceCents: number;
  /** Always false until AI_HELPER_BILLING_AVAILABLE (the database holds it there). */
  billingEnabled: boolean;
  cancelDays: number;
}

export async function fetchAiHelperSettings(tenantId: string): Promise<AiHelperSettings | null> {
  const { data, error } = await supabase().from("tenants")
    .select("ai_tutor_access, ai_helper_price_cents, ai_helper_billing_enabled, ai_helper_cancel_days")
    .eq("id", tenantId).maybeSingle();
  if (error) throw new Error(error.message);
  const r = data as { ai_tutor_access: string; ai_helper_price_cents: number; ai_helper_billing_enabled: boolean; ai_helper_cancel_days: number } | null;
  return r ? {
    access: r.ai_tutor_access === "opt_in" ? "opt_in" : "all",
    priceCents: Number(r.ai_helper_price_cents ?? 0),
    billingEnabled: !!r.ai_helper_billing_enabled,
    cancelDays: r.ai_helper_cancel_days ?? 7,
  } : null;
}

export async function saveAiHelperSettings(tenantId: string, s: AiHelperSettings): Promise<void> {
  const { error } = await supabase().rpc("set_ai_helper_settings", {
    p_tenant_id: tenantId, p_access: s.access, p_price_cents: s.priceCents,
    p_billing_enabled: AI_HELPER_BILLING_AVAILABLE && s.billingEnabled, p_cancel_days: s.cancelDays,
  });
  if (error) throw new Error(error.message);
}

// ------------------------------------------------------------------ one learner (the learner, their guardians, the fees area)

export interface AiHelperStatus {
  studentId: string;
  fullName: string;
  /** Bloom and the study helper are both on at the school. */
  schoolOn: boolean;
  access: AiHelperAccess;
  billingEnabled: boolean;
  priceCents: number;
  cancelDays: number;
  /** The stored choice; null when nobody has made one. */
  status: "on" | "off" | null;
  /** The opt-in lets the learner in (optInActive()). */
  optInActive: boolean;
  termName: string | null;
  turnedOnBy: string | null;
  turnedOnAt: string | null;
  changedBy: string | null;
  changedAt: string | null;
  questionsThisMonth: number;
  lastUsedAt: string | null;
  /** This term's standing study helper charge, when billing has made one. */
  chargeCents: number | null;
}

interface StatusRow {
  student_id: string; full_name: string; school_on: boolean; access: string; billing_enabled: boolean; price_cents: number;
  cancel_days: number; status: "on" | "off" | null; active: boolean | null; term_name: string | null;
  turned_on_by_name: string | null; turned_on_at: string | null; changed_by_name: string | null; changed_at: string | null;
  questions_this_month: number; last_used_at: string | null; charge_cents: number | null;
}

/** A learner's study helper picture; studentId null: the signed-in learner's own. Null when the caller may not see it. */
export async function fetchAiHelperStatus(studentId: string | null): Promise<AiHelperStatus | null> {
  const { data, error } = await supabase().rpc("ai_helper_status", { p_student_id: studentId });
  if (error) throw new Error(error.message);
  const r = (data as StatusRow[] | null)?.[0];
  return r ? {
    studentId: r.student_id, fullName: r.full_name, schoolOn: !!r.school_on,
    access: r.access === "opt_in" ? "opt_in" : "all", billingEnabled: !!r.billing_enabled,
    priceCents: Number(r.price_cents ?? 0), cancelDays: r.cancel_days,
    status: r.status, optInActive: !!r.active, termName: r.term_name,
    turnedOnBy: r.turned_on_by_name, turnedOnAt: r.turned_on_at, changedBy: r.changed_by_name, changedAt: r.changed_at,
    questionsThisMonth: Number(r.questions_this_month ?? 0), lastUsedAt: r.last_used_at,
    chargeCents: r.charge_cents == null ? null : Number(r.charge_cents),
  } : null;
}

/** A parent or guardian turns the helper on or off for their child. Answers what happened (see optInOutcomeText). */
export async function setAiHelperOptIn(studentId: string, on: boolean): Promise<string> {
  const { data, error } = await supabase().rpc("set_ai_helper_optin", { p_student_id: studentId, p_on: on });
  if (error) throw new Error(error.message);
  return String(data ?? "");
}

// ------------------------------------------------------------------ the office (full admins and the fees area)

export interface AiHelperRosterRow {
  studentId: string;
  fullName: string;
  admissionNo: string;
  className: string | null;
  status: "on" | "off" | null;
  optInActive: boolean;
  turnedOnBy: string | null;
  turnedOnAt: string | null;
  changedBy: string | null;
  changedAt: string | null;
  questionsThisMonth: number;
  tokensThisMonth: number;
  lastUsedAt: string | null;
  chargeCents: number | null;
}

/** Learners with an opt-in or this month's use, by name. Empty for anyone without the fees area. */
export async function fetchAiHelperRoster(tenantId: string): Promise<AiHelperRosterRow[]> {
  const { data, error } = await supabase().rpc("ai_helper_roster", { p_tenant_id: tenantId });
  if (error) throw new Error(error.message);
  return ((data ?? []) as {
    student_id: string; full_name: string; admission_no: string; class_name: string | null; status: "on" | "off" | null; active: boolean;
    turned_on_by_name: string | null; turned_on_at: string | null; changed_by_name: string | null; changed_at: string | null;
    questions_this_month: number; tokens_this_month: number; last_used_at: string | null; charge_cents: number | null;
  }[]).map((r) => ({
    studentId: r.student_id, fullName: r.full_name, admissionNo: r.admission_no, className: r.class_name,
    status: r.status, optInActive: !!r.active, turnedOnBy: r.turned_on_by_name, turnedOnAt: r.turned_on_at,
    changedBy: r.changed_by_name, changedAt: r.changed_at,
    questionsThisMonth: Number(r.questions_this_month ?? 0), tokensThisMonth: Number(r.tokens_this_month ?? 0),
    lastUsedAt: r.last_used_at, chargeCents: r.charge_cents == null ? null : Number(r.charge_cents),
  }));
}

/** The roster's summary line: how many learners have it on, and this month's questions in all. */
export function rosterSummary(rows: readonly Pick<AiHelperRosterRow, "optInActive" | "questionsThisMonth">[]): { on: number; questions: number } {
  return {
    on: rows.filter((r) => r.optInActive).length,
    questions: rows.reduce((n, r) => n + r.questionsThisMonth, 0),
  };
}
