import { invokeEdge } from "./edge";
import { supabase } from "./supabase";
import type { Role } from "./types";

/**
 * Visitors, from the gate to the office (20261027010001_gate_reception.sql).
 * The guard records a visit; it reaches reception live; the receptionist
 * moves it along; the person they came to see, and the principal's office
 * when it's escalated, are told in their console and on their phone.
 */

export type VisitStatus = "expected" | "at_reception" | "with_host" | "left";
export type VisitHostKind = "office" | "principal" | "teacher" | "learner";

export interface Visit {
  id: string;
  tenant_id: string;
  visitor_name: string;
  visitor_phone: string | null;
  id_number: string | null;
  vehicle_plate: string | null;
  purpose: string;
  host_kind: VisitHostKind;
  host_id: string | null;
  student_id: string | null;
  host_name: string | null;
  student_name: string | null;
  entry_point: "gate" | "reception";
  status: VisitStatus;
  escalated: boolean;
  escalated_at: string | null;
  note: string | null;
  recorded_by: string | null;
  arrived_at: string;
  reception_at: string | null;
  with_host_at: string | null;
  left_at: string | null;
  updated_at: string;
}

export interface VisitDraft {
  visitor_name: string;
  visitor_phone?: string;
  id_number?: string;
  vehicle_plate?: string;
  purpose: string;
  host_kind: VisitHostKind;
  host_id?: string | null;
  student_id?: string | null;
}

export interface VisitHost { id: string; full_name: string; role: Role; staff_title: string | null }
export interface VisitLearner { id: string; full_name: string; admission_no: string | null; class_name: string | null }

export const VISIT_STATUS_LABEL: Record<VisitStatus, string> = {
  expected: "On the way from the gate",
  at_reception: "At reception",
  with_host: "With host",
  left: "Left",
};

export const VISIT_HOST_KIND_LABEL: Record<VisitHostKind, string> = {
  office: "The office",
  principal: "The principal",
  teacher: "A member of staff",
  learner: "About a learner (parent or guardian)",
};

/** Mirrors visits_stamp(): a visit for the principal is escalated the moment it's recorded. */
export function escalatesOnArrival(kind: VisitHostKind): boolean {
  return kind === "principal";
}

/** Why this draft can't be saved yet, in words for the person at the desk; null when it can. */
export function visitDraftProblem(d: VisitDraft): string | null {
  if (!d.visitor_name.trim()) return "Enter the visitor's name.";
  if (d.visitor_name.trim().length > 120) return "That name is too long.";
  if (!d.purpose.trim()) return "Say why they've come.";
  if (d.purpose.trim().length > 300) return "Keep the reason under 300 characters.";
  if (d.host_kind === "teacher" && !d.host_id) return "Pick who they've come to see.";
  if (d.host_kind === "learner" && !d.student_id) return "Pick the learner they've come about.";
  if ((d.visitor_phone?.trim().length ?? 0) > 30) return "That phone number is too long.";
  if ((d.id_number?.trim().length ?? 0) > 40) return "That ID number is too long.";
  if ((d.vehicle_plate?.trim().length ?? 0) > 20) return "That number plate is too long.";
  return null;
}

/** Who the visitor is for, in a few words: "Mr Otieno", "the principal", "about Amani Wanjiru". */
export function visitHostLabel(v: Pick<Visit, "host_kind" | "host_name" | "student_name">): string {
  switch (v.host_kind) {
    case "office": return "the office";
    case "principal": return "the principal";
    case "teacher": return v.host_name ?? "a member of staff";
    case "learner": return v.student_name ? `about ${v.student_name}` : "about a learner";
  }
}

/** The steps the front desk can take next. The guard only signs visitors out at the gate; reception moves them along. */
export function nextVisitSteps(status: VisitStatus, role: Role): VisitStatus[] {
  if (status === "left") return [];
  if (role === "guard") return ["left"];
  switch (status) {
    case "expected": return ["at_reception", "left"];
    case "at_reception": return ["with_host", "left"];
    case "with_host": return ["left"];
  }
}

/** The button that moves a visit to each status. */
export const VISIT_STEP_LABEL: Record<VisitStatus, string> = {
  expected: "Expected",
  at_reception: "Arrived",
  with_host: "Taken to host",
  left: "Sign out",
};

/** Still on the premises: reception's queue in the order they came in, escalated ones first. */
export function visitQueue(visits: Visit[]): Visit[] {
  return visits
    .filter((v) => v.status !== "left")
    .sort((a, b) => Number(b.escalated) - Number(a.escalated) || a.arrived_at.localeCompare(b.arrived_at));
}

/**
 * The pop-up a signed-in person gets for a visit, if any: its host when it's
 * theirs, an admin when it's escalated. The same words visit-notify pushes
 * (supabase/functions/visit-notify/plan.ts) -- keep the two in step.
 * `isNew`: the visit was just recorded. On a later change only an escalation
 * pops up again, recognised by the trigger stamping escalated_at and
 * updated_at with the same now() in the update that escalated it.
 */
export function visitAlert(v: Visit, viewer: { profileId: string; role: Role }, isNew: boolean): { title: string; body: string } | null {
  if (v.status === "left") return null;
  const where = v.status === "expected" ? "At the gate, on the way to the office." : "At the office.";
  if (isNew && v.host_id === viewer.profileId) {
    return { title: `${v.visitor_name} is here to see you`, body: `${where} ${v.purpose}` };
  }
  if (viewer.role === "school_admin" && v.escalated && (isNew || v.escalated_at === v.updated_at)) {
    const about = v.host_kind === "learner" && v.student_name ? ` about ${v.student_name}` : "";
    return {
      title: v.host_kind === "principal" ? `${v.visitor_name} is here to see the principal` : `Visitor escalated: ${v.visitor_name}${about}`,
      body: `${where} ${v.purpose}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------- data

const trimOrNull = (s?: string) => s?.trim() || null;

export async function recordVisit(tenantId: string, draft: VisitDraft, entryPoint: Visit["entry_point"]): Promise<Visit> {
  const { data, error } = await supabase().from("visits").insert({
    tenant_id: tenantId,
    visitor_name: draft.visitor_name.trim(),
    visitor_phone: trimOrNull(draft.visitor_phone),
    id_number: trimOrNull(draft.id_number),
    vehicle_plate: trimOrNull(draft.vehicle_plate)?.toUpperCase() ?? null,
    purpose: draft.purpose.trim(),
    host_kind: draft.host_kind,
    host_id: draft.host_kind === "teacher" ? draft.host_id ?? null : null,
    student_id: draft.host_kind === "learner" ? draft.student_id ?? null : null,
    entry_point: entryPoint,
  }).select("*").single<Visit>();
  if (error) throw new Error(error.message);
  return data;
}

export async function setVisitStatus(id: string, status: VisitStatus): Promise<void> {
  const { error } = await supabase().from("visits").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function escalateVisit(id: string): Promise<void> {
  const { error } = await supabase().from("visits").update({ escalated: true }).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Visits that arrived since `since` (and before `until`, when given), newest first. */
export async function listVisits(tenantId: string, since: Date, until?: Date): Promise<Visit[]> {
  let q = supabase().from("visits").select("*").eq("tenant_id", tenantId).gte("arrived_at", since.toISOString());
  if (until) q = q.lt("arrived_at", until.toISOString());
  const { data, error } = await q.order("arrived_at", { ascending: false }).limit(500).returns<Visit[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function fetchVisitHosts(tenantId: string): Promise<VisitHost[]> {
  const { data, error } = await supabase().rpc("visit_hosts", { p_tenant_id: tenantId });
  if (error) throw new Error(error.message);
  return (data ?? []) as VisitHost[];
}

export async function findVisitLearners(tenantId: string, query: string): Promise<VisitLearner[]> {
  if (query.trim().length < 2) return [];
  const { data, error } = await supabase().rpc("visit_find_learners", { p_tenant_id: tenantId, p_query: query });
  if (error) throw new Error(error.message);
  return (data ?? []) as VisitLearner[];
}

/** Phones, via visit-notify. Best effort: the consoles already show the visit live, so a push that fails never fails the desk. */
export async function pushVisit(id: string): Promise<void> {
  await invokeEdge("visit-notify", { visit_id: id }, { timeoutMs: 15_000 }).catch(() => {});
}

/** Every visit this person may see, as it's recorded or changes. RLS decides which rows arrive. */
export function subscribeVisits(tenantId: string, onChange: (v: Visit, isNew: boolean) => void): () => void {
  const channel = supabase()
    .channel(`visits-${tenantId}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "visits", filter: `tenant_id=eq.${tenantId}` },
      (payload) => {
        if (payload.eventType === "DELETE") return;
        onChange(payload.new as Visit, payload.eventType === "INSERT");
      },
    )
    .subscribe();
  return () => { void supabase().removeChannel(channel); };
}
