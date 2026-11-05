import { invokeEdge } from "./edge";
import { supabase } from "./supabase";

/**
 * Leave run by Figbloom HR (SCHOOLS_HR_LEAVE_CONTRACT.md section 3; 20261105800000, the my-hr function's leave routes).
 *
 * hr_leave_access() is the rule, about the signed-in person only:
 *   status    not_staff | off (HR_LEAVE_ENABLED, the default) | not_linked (the platform doesn't know the school) |
 *             not_enabled (the platform said HR isn't on for the school) | available (the school's leave is HR's)
 *   approver  the school's admins, and staff holding the leave or fees area (head teacher, deputy, bursar)
 * While it's "available", the leave page applies through HR and the old Schools-only form is hidden; otherwise the
 * old form shows exactly as before. "Leave to approve" shows for approvers while it's "available"; HR decides who
 * actually has applications waiting.
 */
export type HrLeaveStatus = "not_staff" | "off" | "not_linked" | "not_enabled" | "available";
export interface HrLeaveAccess { status: HrLeaveStatus; approver: boolean }

export const LEAVE_TO_APPROVE_LABEL = "Leave to approve";
/** my-hr's sentence for 409 approver_not_linked (the person never opened HR & Payroll from Schools). */
export const HR_CONNECT_ONCE = "Open HR & Payroll once to connect your HR account.";
/** A leave document goes to HR as base64, up to this size. */
export const MAX_LEAVE_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const LEAVE_DOCUMENT_TYPES = [
  "application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

const STATUSES: readonly HrLeaveStatus[] = ["not_staff", "off", "not_linked", "not_enabled", "available"];
const NO_ACCESS: HrLeaveAccess = { status: "off", approver: false };

/** hr_leave_access() for the signed-in person; "off" for an answer it doesn't know (the old form stays). */
export async function fetchHrLeaveAccess(): Promise<HrLeaveAccess> {
  const { data, error } = await supabase().rpc("hr_leave_access");
  if (error) throw new Error(error.message);
  return readAccess(data);
}

export function readAccess(data: unknown): HrLeaveAccess {
  const o = data && typeof data === "object" ? data as { status?: unknown; approver?: unknown } : {};
  if (!STATUSES.includes(o.status as HrLeaveStatus)) return NO_ACCESS;
  return { status: o.status as HrLeaveStatus, approver: o.approver === true };
}

/** Which leave page the person gets: HR's, the school's own (as before), or nothing yet (still asking). */
export function leaveMode(access: HrLeaveAccess | null): "loading" | "hr" | "schools" {
  if (!access) return "loading";
  return access.status === "available" ? "hr" : "schools";
}

/** Whether "Leave to approve" shows. */
export function showsLeaveToApprove(access: HrLeaveAccess | null): boolean {
  return !!access && access.status === "available" && access.approver;
}

/** Whether the other-staff console gets a Leave page (they had none before HR). */
export function showsStaffLeave(access: HrLeaveAccess | null): boolean {
  return !!access && access.status === "available";
}

// ---------------------------------------------------------------- HR's answers, as the pages show them
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v.trim() || null : typeof v === "number" && Number.isFinite(v) ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (...vs: unknown[]) => vs.some((v) => v === true);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

export interface LeaveTypeRule {
  id: string;
  name: string;
  halfDays: boolean;
  documentRequired: boolean;
  maxDays: number | null;
  noticeDays: number | null;
  /** days left this year, when HR says */
  available: number | null;
}
export interface LeaveForm {
  types: LeaveTypeRule[];
  /** "Head teacher (Mary Principal)", in order */
  chain: string[];
}

/** GET leave/form: {leave_types: [{id, name, half_days, requires_document, max_days, notice_days}], balances, approval_chain}. */
export function readLeaveForm(data: unknown): LeaveForm {
  const o = isObj(data) ? data : {};
  const balances = list(o.balances);
  const types = list(o.leave_types).flatMap((t) => {
    const id = str(t.id);
    if (!id) return [];
    const balance = balances.find((b) => str(b.leave_type_id) === id);
    return [{
      id,
      name: str(t.name) ?? "Leave",
      halfDays: bool(t.half_days, t.allow_half_day, t.half_day_allowed),
      documentRequired: bool(t.requires_document, t.document_required),
      maxDays: num(t.max_days),
      noticeDays: num(t.notice_days),
      available: balance ? num(balance.available_days) : null,
    }];
  });
  const chain = list(o.approval_chain).map((s) => {
    const label = str(s.label) ?? str(s.role) ?? "Approver";
    const who = str(s.approver_name) ?? str(s.name);
    return who ? `${label} (${who})` : label;
  });
  return { types, chain };
}

export interface ApprovalItem {
  id: string;
  employee: string;
  type: string;
  from: string | null;
  to: string | null;
  days: number | null;
  halfDay: boolean;
  reason: string | null;
  /** HR's short-lived link to the document, if there is one */
  documentUrl: string | null;
  /** the chain so far: "Head teacher: current" */
  steps: { label: string; status: string; who: string | null }[];
}

/** GET approvals: {approvals: [{application_id, employee_name, leave_type, start_date, end_date, days, reason, document_url, approval: {steps}}]}. */
export function readApprovals(data: unknown): ApprovalItem[] {
  const o = isObj(data) ? data : {};
  return list(o.approvals ?? o.applications ?? o.items).flatMap((a) => {
    const id = str(a.application_id) ?? str(a.id);
    if (!id) return [];
    const doc = isObj(a.document) ? a.document : null;
    return [{
      id,
      employee: str(a.employee_name) ?? (isObj(a.employee) ? str(a.employee.name) : null) ?? "A member of staff",
      type: str(a.leave_type) ?? "Leave",
      from: str(a.start_date),
      to: str(a.end_date),
      days: num(a.days),
      halfDay: a.half_day === true,
      reason: str(a.reason),
      documentUrl: safeLink(str(a.document_url) ?? (doc ? str(doc.url) : null)),
      steps: list(isObj(a.approval) ? a.approval.steps : a.steps).map((s) => ({
        label: str(s.label) ?? "Approval",
        status: str(s.status) ?? "upcoming",
        who: str(s.actor_name) ?? str(s.waiting_on),
      })),
    }];
  });
}

/** Only an https link is shown (a document link comes from HR). */
function safeLink(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).protocol === "https:" ? url : null; } catch { return null; }
}

/** What "Leave to approve" shows, from the access rule and the call's outcome. */
export type ApprovalsState =
  | { kind: "loading" }
  | { kind: "not_available" }
  | { kind: "not_linked" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "list"; items: ApprovalItem[] };

export function approvalsState(access: HrLeaveAccess | null, result: { loading: boolean; error: { message: string; code?: string } | null; data: unknown }): ApprovalsState {
  if (!access) return { kind: "loading" };
  if (!showsLeaveToApprove(access)) return { kind: "not_available" };
  if (result.error?.code === "approver_not_linked") return { kind: "not_linked" };
  if (result.error) return { kind: "error", message: result.error.message };
  if (result.loading || result.data == null) return { kind: "loading" };
  const items = readApprovals(result.data);
  return items.length ? { kind: "list", items } : { kind: "empty" };
}

/** Why a chosen document can't go (null: it can). */
export function documentProblem(file: { size: number; type: string }): string | null {
  if (file.size > MAX_LEAVE_DOCUMENT_BYTES) return "The document is larger than 5 MB. Choose a smaller file.";
  if (file.size === 0) return "The document is empty. Choose it again.";
  if (!(LEAVE_DOCUMENT_TYPES as readonly string[]).includes(file.type)) return "Attach a PDF, a photo (JPEG, PNG, WebP, HEIC) or a Word document.";
  return null;
}

// ---------------------------------------------------------------- calls (the my-hr function)
const CALL = { timeoutMs: 25_000 };

export function fetchLeaveForm(): Promise<unknown> {
  return invokeEdge<unknown>("my-hr", { route: "leave_form" }, CALL);
}

export function fetchHrLeaveApplications(): Promise<unknown> {
  return invokeEdge<unknown>("my-hr", { route: "leave_applications" }, CALL);
}

export interface LeaveApplicationInput {
  typeId: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  reason: string;
  document?: { name: string; contentType: string; base64: string } | null;
}

export function applyForLeave(input: LeaveApplicationInput): Promise<unknown> {
  return invokeEdge<unknown>("my-hr", {
    route: "leave_apply", type_id: input.typeId, start_date: input.startDate, end_date: input.endDate, half_day: input.halfDay,
    reason: input.reason,
    ...(input.document ? { document: { name: input.document.name, content_type: input.document.contentType, base64: input.document.base64 } } : {}),
  }, { timeoutMs: 60_000 });
}

export function cancelHrLeave(applicationId: string): Promise<unknown> {
  return invokeEdge<unknown>("my-hr", { route: "leave_cancel", application_id: applicationId }, CALL);
}

export function fetchApprovals(): Promise<unknown> {
  return invokeEdge<unknown>("my-hr", { route: "approvals" }, CALL);
}

export function decideApproval(applicationId: string, decision: "approve" | "decline", comment: string): Promise<unknown> {
  const c = comment.trim();
  return invokeEdge<unknown>("my-hr", { route: "approval_decide", application_id: applicationId, decision, ...(c ? { comment: c } : {}) }, CALL);
}
