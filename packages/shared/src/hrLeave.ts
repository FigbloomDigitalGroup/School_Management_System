import { EdgeError, invokeEdge } from "./edge";
import { formatShortDate } from "./parentData";
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
/**
 * A leave document goes to HR as base64, up to this size. HR takes 5 MB, but its production sits behind Vercel's
 * ~4.5 MB request limit, and base64 adds a third.
 */
export const MAX_LEAVE_DOCUMENT_BYTES = 3 * 1024 * 1024;
/** HR's rule for the reason, when leave/form doesn't say (reason_min_length). */
export const LEAVE_REASON_MIN = 10;
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
  /** the document HR asks for with the application (a doctor's note), and from how many days on (null: always) */
  document: { name: string; withApplication: boolean; longerThan: number | null } | null;
  maxDays: number | null;
  noticeDays: number | null;
  /** the first day it can start (notice) and the day it can first be used (service months), when HR says */
  earliestStart: string | null;
  availableFrom: string | null;
  onePerMonth: boolean;
  /** days left in the balance, when HR keeps one */
  available: number | null;
}
export interface LeaveForm {
  types: LeaveTypeRule[];
  /** "Head teacher (Mary Principal)", in order; skipped steps left out */
  chain: string[];
  /** the reason's least length (HR: 10) */
  reasonMin: number;
}

/**
 * GET leave/form (bloomHR my_hr_leave_form()): {leave_types: [{id, name, half_days, count_days, max_days_per_request,
 * min_notice_days, earliest_start, one_per_month, available_from, document: {name, when, within_days,
 * required_if_longer_than}, balance: {available_days}}], balances, approval_chain: [{label, waiting_on, skipped}],
 * reason_min_length, document_max_bytes}.
 */
export function readLeaveForm(data: unknown): LeaveForm {
  const o = isObj(data) ? data : {};
  const types = list(o.leave_types).flatMap((t) => {
    const id = str(t.id);
    if (!id) return [];
    const doc = isObj(t.document) && str(t.document.name) ? t.document : null;
    const balance = isObj(t.balance) ? t.balance : null;
    return [{
      id,
      name: str(t.name) ?? "Leave",
      halfDays: bool(t.half_days),
      document: doc ? { name: str(doc.name)!, withApplication: doc.when === "with_application", longerThan: num(doc.required_if_longer_than) } : null,
      maxDays: num(t.max_days_per_request),
      noticeDays: num(t.min_notice_days),
      earliestStart: str(t.earliest_start),
      availableFrom: str(t.available_from),
      onePerMonth: bool(t.one_per_month),
      available: balance ? num(balance.available_days) : null,
    }];
  });
  const chain = list(o.approval_chain).filter((s) => s.skipped !== true).map((s) => {
    const label = str(s.label) ?? "Approver";
    const who = str(s.waiting_on);
    return who ? `${label} (${who})` : label;
  });
  return { types, chain, reasonMin: num(o.reason_min_length) ?? LEAVE_REASON_MIN };
}

/** Whether HR wants the document with this application: always, or for leave longer than its limit. */
export function documentNeeded(type: LeaveTypeRule | null, days: number | null): boolean {
  if (!type?.document?.withApplication) return false;
  return type.document.longerThan === null || (days !== null && days > type.document.longerThan);
}

/** A document link from HR: valid for 5 minutes, opened directly, never kept. */
export interface HrDocumentLink { name: string; url: string | null; expiresAt: string | null }

export interface ApprovalItem {
  id: string;
  employee: string;
  type: string;
  from: string | null;
  to: string | null;
  days: number | null;
  halfDay: boolean;
  reason: string | null;
  /** the step this approver decides ("Head teacher") */
  step: string | null;
  documents: HrDocumentLink[];
  /** the chain so far: "Head teacher: current" */
  steps: { label: string; status: string; who: string | null; comment: string | null }[];
}

function link(v: unknown, fallback: string): HrDocumentLink | null {
  if (!isObj(v)) return null;
  return { name: str(v.name) ?? fallback, url: safeLink(str(v.url)), expiresAt: str(v.expires_at) };
}

/**
 * GET approvals (bloomHR my_hr_leave_approval_item()): {approvals: [{application_id, employee: {employee_number, name,
 * external_id}, leave_type, start_date, end_date, days, half_day, reason, status, step_label, document / followup_document:
 * {name, url, expires_at}, approval: {steps: [{label, status, waiting_on, actor_name, comment}]}}]}.
 */
export function readApprovals(data: unknown): ApprovalItem[] {
  const o = isObj(data) ? data : {};
  return list(o.approvals).flatMap((a) => {
    const id = str(a.application_id);
    if (!id) return [];
    return [{
      id,
      employee: (isObj(a.employee) ? str(a.employee.name) : null) ?? "A member of staff",
      type: str(a.leave_type) ?? "Leave",
      from: str(a.start_date),
      to: str(a.end_date),
      days: num(a.days),
      halfDay: a.half_day === true,
      reason: str(a.reason),
      step: str(a.step_label),
      documents: [link(a.document, "Document"), link(a.followup_document, "Follow-up document")].filter((d): d is HrDocumentLink => d !== null),
      steps: list(isObj(a.approval) ? a.approval.steps : undefined).map((s) => ({
        label: str(s.label) ?? "Approval",
        status: str(s.status) ?? "upcoming",
        who: str(s.actor_name) ?? str(s.waiting_on),
        comment: str(s.comment),
      })),
    }];
  });
}

/** A link HR said is valid until `expiresAt` has run out (reload the list for a new one). */
export function linkExpired(doc: HrDocumentLink, now = Date.now()): boolean {
  return !doc.url || (!!doc.expiresAt && Date.parse(doc.expiresAt) <= now);
}

/** HR's refusal of an application, as the form shows it: its sentence and one line per rule (422 leave_rules). */
export function leaveProblems(err: unknown): { message: string; problems: string[] } {
  const message = err instanceof Error ? err.message : "Could not apply for leave.";
  const d = err && typeof err === "object" && "details" in err ? (err as { details?: unknown }).details : null;
  const problems = isObj(d) && Array.isArray(d.problems) ? d.problems.filter((p): p is string => typeof p === "string") : [];
  return { message, problems };
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

/**
 * "Leave to approve", read from HR for the phone: the applications waiting, nothing, or "this person never opened HR &
 * Payroll from Schools" (a state with its own message, not a failure). Anything else HR refuses with throws its sentence.
 */
export async function loadApprovals(): Promise<Extract<ApprovalsState, { kind: "list" | "empty" | "not_linked" }>> {
  try {
    const items = readApprovals(await fetchApprovals());
    return items.length ? { kind: "list", items } : { kind: "empty" };
  } catch (err) {
    if (err instanceof EdgeError && err.code === "approver_not_linked") return { kind: "not_linked" };
    throw err;
  }
}

/** What the screen says once HR has recorded a decision (the web's toast and the phone's banner). */
export function approvalDecisionMessage(decision: "approve" | "decline", employee: string): string {
  return decision === "approve"
    ? `Approved \u2014 ${employee}'s leave goes on in Figbloom HR.`
    : `Declined \u2014 ${employee} will see your comment in HR.`;
}

/** HR refuses a decline without a comment, so the button waits for one. */
export const mayDecline = (comment: string): boolean => comment.trim().length > 0;

/** A date from HR ("2026-11-09", or a full timestamp) as the pages show it. */
const shortDate = (d: string | null) => (d ? formatShortDate(d.slice(0, 10)) : "\u2014");

/** "9 Nov \u2013 11 Nov", or one date when the leave is a single day. */
export function leaveRange(from: string | null, to: string | null): string {
  return from && to && from !== to ? `${shortDate(from)} \u2013 ${shortDate(to)}` : shortDate(from ?? to);
}

/** "Half a day", "3 days", or null when HR gave no count. */
export function leaveDaysWords(days: number | null, halfDay: boolean): string | null {
  return halfDay ? "Half a day" : days === null ? null : `${days} ${days === 1 ? "day" : "days"}`;
}

/** A date typed as YYYY-MM-DD that is a real day ("2026-02-30" is not). */
export function isDateOnly(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}

/** Calendar days from one date to the other, both counted (HR counts its own way; this only decides what to ask for). */
export function leaveSpanDays(from: string, to: string): number | null {
  return isDateOnly(from) && isDateOnly(to) && to >= from ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 : null;
}

/** What HR says about a leave type, on one line: days left, limits, notice, the document it wants, half days. */
export function leaveTypeRules(type: LeaveTypeRule): string {
  return [
    type.available !== null && `${type.available} ${type.available === 1 ? "day" : "days"} left`,
    type.maxDays !== null && `up to ${type.maxDays} days at a time`,
    type.noticeDays ? `${type.noticeDays} days' notice${type.earliestStart ? ` (from ${shortDate(type.earliestStart)})` : ""}` : null,
    type.availableFrom && `can be used from ${shortDate(type.availableFrom)}`,
    type.onePerMonth && "once a month",
    type.document && (type.document.withApplication
      ? `${type.document.name} needed${type.document.longerThan !== null ? ` for more than ${type.document.longerThan} days` : ""}`
      : `${type.document.name} to follow`),
    type.halfDays && "half days allowed",
  ].filter(Boolean).join(" \u00b7 ");
}

/** What the application form holds (the web and the phone keep the same fields). */
export interface LeaveApplicationDraft {
  typeId: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  reason: string;
  documentName: string | null;
}

/**
 * The leave type chosen, whether HR wants its document with this application, and whether the form can be sent.
 * Ready only decides when the button works; HR still applies its own rules and answers with them (422 leave_rules).
 */
export function applicationReadiness(form: LeaveForm, v: LeaveApplicationDraft): { type: LeaveTypeRule | null; needsDocument: boolean; ready: boolean } {
  const type = form.types.find((t) => t.id === v.typeId) ?? null;
  const needsDocument = documentNeeded(type, v.halfDay ? 0.5 : leaveSpanDays(v.startDate, v.endDate));
  const ready = !!type && isDateOnly(v.startDate) && isDateOnly(v.endDate) && v.endDate >= v.startDate
    && v.reason.trim().length >= form.reasonMin && (!needsDocument || !!v.documentName);
  return { type, needsDocument, ready };
}

/** What the screen says once HR has taken an application, or cancelled one (the web's toast and the phone's banner). */
export const HR_LEAVE_SENT = "Sent to Figbloom HR for approval.";
export const HR_LEAVE_CANCELLED = "Cancelled in Figbloom HR.";

/** Why a chosen document can't go (null: it can). */
export function documentProblem(file: { size: number; type: string }): string | null {
  if (file.size > MAX_LEAVE_DOCUMENT_BYTES) return "The document is larger than 3 MB. Choose a smaller file.";
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
