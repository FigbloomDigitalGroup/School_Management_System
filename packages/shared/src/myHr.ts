import { invokeEdge } from "./edge";
import { supabase } from "./supabase";

/**
 * "My HR" (SCHOOLS_HR_PHASE2_CONTRACT.md section 3; 20261105710000, the my-hr function): a staff member's own
 * payslips, leave, attendance and KPIs from Figbloom HR, view only for now.
 *
 * The database's my_hr_status() is the rule, for the sidebar and for my-hr alike. It is about the signed-in person
 * only (no arguments):
 *   not_staff    not an active, non-archived staff profile (teacher, driver, other staff, school admin) of a
 *                school that isn't suspended
 *   off          MY_HR_ENABLED is off (the default)
 *   not_linked   the platform doesn't know the school yet
 *   not_enabled  the platform said HR isn't on (or linked) for the school, in the last hour
 *   available    show it
 * Whether this person's own HR record is ready is HR's answer, shown on the page.
 */
export type MyHrStatus = "not_staff" | "off" | "not_linked" | "not_enabled" | "available";

export const MY_HR_LABEL = "My HR";

export type MyHrTab = "payslips" | "leave" | "attendance" | "kpis";
export const MY_HR_TABS: readonly { key: MyHrTab; label: string }[] = [
  { key: "payslips", label: "Payslips" },
  { key: "leave", label: "Leave" },
  { key: "attendance", label: "Attendance" },
  { key: "kpis", label: "KPIs" },
];

/** What my-hr says when HR has no employee for the person yet, or their onboarding isn't approved. */
export const MY_HR_NOT_READY = "Your HR record isn't ready yet. Ask the school's HR administrator.";

/** The sidebar shows My HR only when the database says it's available. */
export function showsMyHr(status: MyHrStatus | null | undefined): boolean {
  return status === "available";
}

const STATUSES: readonly MyHrStatus[] = ["not_staff", "off", "not_linked", "not_enabled", "available"];

/** my_hr_status() for the signed-in person; "off" for an answer it doesn't know (the page stays hidden). */
export async function fetchMyHrStatus(): Promise<MyHrStatus> {
  const { data, error } = await supabase().rpc("my_hr_status");
  if (error) throw new Error(error.message);
  return STATUSES.includes(data as MyHrStatus) ? (data as MyHrStatus) : "off";
}

// ---------------------------------------------------------------- HR's answers, as the page shows them
// The field names are bloomHR's (my_hr_routes.js and its my_hr_* SQL functions; docs/PLATFORM_EVENTS.md "My HR").
// Each reader leaves out what isn't there, so the page never breaks on a missing field.

export interface MyHrSummary {
  name: string | null;
  employeeNumber: string | null;
  jobTitle: string | null;
  department: string | null;
  branch: string | null;
  startDate: string | null;
  company: string | null;
  leavePending: number | null;
}

export interface Payslip {
  id: string;
  period: string;
  gross: number | null;
  deductions: number | null;
  net: number | null;
  currency: string;
  /** HR's run status: approved or paid (only those reach Schools). */
  runStatus: string | null;
  paidOn: string | null;
}

/** One line on a payslip. */
export interface PayslipLine { label: string; amount: number }

/** One payslip in full (GET payslips/:id: every saved figure), laid out by the web app. */
export interface PayslipDetail {
  id: string;
  period: string;
  currency: string;
  employeeName: string | null;
  employeeNumber: string | null;
  taxPin: string | null;
  nssfNumber: string | null;
  shifNumber: string | null;
  bank: string | null;
  accountLast4: string | null;
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  gross: number | null;
  totalDeductions: number | null;
  net: number | null;
  taxRelief: number | null;
  note: string | null;
  runStatus: string | null;
  paidOn: string | null;
}

export interface LeaveBalance { type: string; accrued: number | null; carriedOver: number | null; used: number | null; pending: number | null; available: number | null }
export interface LeaveApplication {
  id: string; type: string; from: string | null; to: string | null; days: number | null; status: string; reason: string | null;
  /** Who it's waiting on now, or who decided it last. */
  approver: string | null;
  /** The approval chain, step by step ("Head teacher: approved"). */
  steps: { label: string; status: string; who: string | null }[];
}
export interface MyLeave { balances: LeaveBalance[]; applications: LeaveApplication[] }

export interface AttendanceDay { date: string; status: string; clockIn: string | null; clockOut: string | null; hours: number | null; lateMinutes: number | null }
export interface AttendanceNotice { date: string | null; text: string; status: string | null }
export interface MyAttendance { days: AttendanceDay[]; notices: AttendanceNotice[]; missedScans: AttendanceNotice[]; absences: AttendanceNotice[] }

export interface KpiTarget { name: string; target: string | null; actual: string | null; achievement: number | null; weight: number | null; self: string | null }
export interface MyKpis {
  period: string | null;
  targets: KpiTarget[];
  /** HR's weighted score over the scored KPIs (the staff portal's overallScore). */
  overall: number | null;
  measures: { label: string; value: string }[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
}
function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (isObj(v)) return str(pick(v, "name", "full_name", "label", "title"));
  return null;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function list(data: unknown, ...keys: string[]): Obj[] {
  if (Array.isArray(data)) return data.filter(isObj);
  if (!isObj(data)) return [];
  const found = pick(data, ...keys);
  return Array.isArray(found) ? found.filter(isObj) : [];
}
const label = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function isMyHrPending(data: unknown): boolean {
  return isObj(data) && data.status === "pending_hr";
}

/** GET summary: {employee: {employee_number, name, job_title, department, branch, start_date, ...}, company: {name}, leave_pending}. */
export function readSummary(data: unknown): MyHrSummary {
  const o = isObj(data) ? data : {};
  const e = isObj(o.employee) ? o.employee : o;
  return {
    name: str(pick(e, "name", "full_name")),
    employeeNumber: str(pick(e, "employee_number", "number")),
    jobTitle: str(pick(e, "job_title", "position")),
    department: str(pick(e, "department")),
    branch: str(pick(e, "branch")),
    startDate: str(pick(e, "start_date")),
    company: str(o.company),
    leavePending: num(o.leave_pending),
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-10" (or "2026-10-01") -> "October 2026"; anything else as it came. */
export function periodLabel(raw: unknown): string {
  const s = str(raw) ?? "";
  const ym = /^(\d{4})-(\d{2})(?:-\d{2})?/.exec(s);
  if (ym && Number(ym[2]) >= 1 && Number(ym[2]) <= 12) return `${MONTHS[Number(ym[2]) - 1]} ${ym[1]}`;
  return s || "—";
}

/** GET payslips: {payslips: [{id, pay_period, currency, gross_pay, total_deductions, net_pay, run_status, paid_at}]}. */
export function readPayslips(data: unknown): Payslip[] {
  return list(data, "payslips").flatMap((p) => {
    const id = str(p.id);
    if (!id) return [];
    return [{
      id,
      period: periodLabel(p.pay_period),
      gross: num(p.gross_pay),
      deductions: num(p.total_deductions),
      net: num(p.net_pay),
      currency: str(p.currency) ?? "KES",
      runStatus: str(p.run_status),
      paidOn: str(p.paid_at),
    }];
  });
}

/** The named earnings and deductions a payslip (salary_history) can carry, in the order HR's payslip shows them. */
const EARNINGS: [string, string][] = [
  ["basic_salary", "Basic salary"], ["house_allowance", "House allowance"], ["transport_allowance", "Transport allowance"],
  ["medical_allowance", "Medical allowance"], ["other_allowances", "Other allowances"], ["overtime_pay", "Overtime"],
  ["commission", "Commission"], ["bonus", "Bonus"], ["reimbursements", "Reimbursements"],
];
const DEDUCTIONS: [string, string][] = [
  ["paye", "PAYE"], ["paye_tax", "PAYE"], ["nssf_deduction", "NSSF"], ["nssf", "NSSF"], ["shif", "SHIF"],
  ["nhif_deduction", "NHIF"], ["housing_levy", "Housing levy"], ["lst_deduction", "Local service tax"],
  ["heslb_deduction", "HESLB"], ["leave_deduction", "Unpaid leave"], ["loan_deduction", "Loan"],
  ["advance_deduction", "Salary advance"], ["welfare_deduction", "Welfare"], ["other_deductions", "Other deductions"],
];

function lines(p: Obj, named: [string, string][], itemKeys: string[]): PayslipLine[] {
  const out: PayslipLine[] = [];
  const seen = new Set<string>();
  for (const [key, text] of named) {
    const amount = num(p[key]);
    if (amount === null || amount === 0 || seen.has(text)) continue;
    seen.add(text);
    out.push({ label: text, amount });
  }
  // itemised extras (bonuses, overtime lines, other deductions): [{name, amount}]
  for (const k of itemKeys) {
    for (const it of list(p[k])) {
      const amount = num(pick(it, "amount", "value"));
      const name = str(pick(it, "name", "label", "description"));
      if (amount === null || amount === 0 || !name) continue;
      out.push({ label: name, amount });
    }
  }
  return out;
}

/** GET payslips/:id: {payslip: {...every saved figure, account_number_last4, run_status, approved_at, paid_at}}. */
export function readPayslip(data: unknown): PayslipDetail | null {
  const p = isObj(data) && isObj(data.payslip) ? data.payslip : null;
  const id = p ? str(p.id) : null;
  if (!p || !id) return null;
  return {
    id,
    period: periodLabel(p.pay_period),
    currency: str(p.currency) ?? "KES",
    employeeName: str(p.employee_name),
    employeeNumber: str(p.employee_id),
    taxPin: str(p.tax_pin),
    nssfNumber: str(p.nssf_number),
    shifNumber: str(pick(p, "shif_number", "nhif_number")),
    bank: str(p.bank_name),
    accountLast4: str(p.account_number_last4),
    earnings: lines(p, EARNINGS, ["earning_items", "overtime_items", "reimbursement_items"]),
    deductions: lines(p, DEDUCTIONS, ["deduction_items", "leave_items"]),
    gross: num(p.gross_pay),
    totalDeductions: num(p.total_deductions),
    net: num(p.net_pay),
    taxRelief: num(p.tax_relief),
    note: str(p.payslip_note),
    runStatus: str(p.run_status),
    paidOn: str(p.paid_at),
  };
}

/** GET leave: {balances: [{leave_type, accrued_days, carried_over_days, used_days, pending_days, available_days}], applications: [...]}. */
export function readLeave(data: unknown): MyLeave {
  const o = isObj(data) ? data : {};
  const balances = list(o.balances).map((b) => ({
    type: str(b.leave_type) ?? "Leave",
    accrued: num(b.accrued_days),
    carriedOver: num(b.carried_over_days),
    used: num(b.used_days),
    pending: num(b.pending_days),
    available: num(b.available_days),
  }));
  const applications = list(o.applications).map((a, i) => {
    const steps = list(isObj(a.approval) ? a.approval.steps : undefined).map((s) => ({
      label: str(s.label) ?? "Approval",
      status: str(s.status) ?? "upcoming",
      who: str(pick(s, "actor_name", "waiting_on")),
    }));
    const current = steps.find((s) => s.status === "current");
    const decided = [...steps].reverse().find((s) => s.status !== "current" && s.status !== "upcoming" && s.status !== "not_reached" && s.who);
    return {
      id: str(a.id) ?? String(i),
      type: str(a.leave_type) ?? "Leave",
      from: str(a.start_date),
      to: str(a.end_date),
      days: num(a.days),
      status: str(a.status) ?? "pending",
      reason: str(a.reason),
      approver: current?.who ?? decided?.who ?? null,
      steps,
    };
  });
  return { balances, applications };
}

/** GET attendance: {days: [{day, status, clock_in, clock_out, hours, late_minutes}], possible_absence_notices, missed_scan_requests, absences_recorded}. */
export function readAttendance(data: unknown): MyAttendance {
  const o = isObj(data) ? data : {};
  const range = (n: Obj) => {
    const from = str(n.start_date), to = str(n.end_date);
    return from && to && from !== to ? `${from} – ${to}` : from;
  };
  return {
    days: list(o.days).flatMap((d) => {
      const date = str(pick(d, "day", "date"));
      if (!date) return [];
      return [{
        date,
        status: str(d.status) ?? "unknown",
        clockIn: str(d.clock_in),
        clockOut: str(d.clock_out),
        hours: num(d.hours),
        lateMinutes: num(d.late_minutes),
      }];
    }),
    notices: list(o.possible_absence_notices).map((n) => ({
      date: str(n.start_date),
      text: [n.end_date && n.end_date !== n.start_date ? `to ${str(n.end_date)}` : null, n.reply_by ? `reply by ${str(n.reply_by)}` : null].filter(Boolean).join(", "),
      status: null,
    })),
    missedScans: list(o.missed_scan_requests).map((q) => ({
      date: str(q.work_date),
      text: [str(q.reason), str(q.approver_name) ? `to ${str(q.approver_name)}` : null, str(q.decision_comment)].filter(Boolean).join(" · "),
      status: str(q.status),
    })),
    absences: list(o.absences_recorded).map((x) => ({
      date: range(x),
      text: [str(x.kind) ? label(str(x.kind)!) : null, num(x.days) !== null ? `${num(x.days)} day(s)` : null, str(x.note)].filter(Boolean).join(" · "),
      status: str(x.status),
    })),
  };
}

/** GET kpis: {period: {name, ...}, items: [{name, unit, target, weight, self_value, actual, achievement}], overall: {score}, attendance: {...}}. */
export function readKpis(data: unknown): MyKpis {
  const o = isObj(data) ? data : {};
  const period = isObj(o.period) ? str(o.period.name) : str(o.period);
  const targets = list(o.items).map((t) => ({
    name: str(t.name) ?? "KPI",
    target: str(t.target),
    actual: str(pick(t, "actual", "actual_value", "auto_value")),
    achievement: num(t.achievement),
    weight: num(t.weight),
    self: str(t.self_value),
  }));
  const overall = isObj(o.overall) ? num(o.overall.score) : null;
  const att = isObj(o.attendance) ? o.attendance : null;
  const ATT: [string, string][] = [["working_days", "Working days"], ["present", "Present"], ["late", "Late"], ["absent", "Absent"], ["leave", "On leave"], ["late_minutes", "Minutes late"]];
  const measures = att ? ATT.flatMap(([k, l]) => (num(att[k]) !== null ? [{ label: l, value: String(num(att[k])) }] : [])) : [];
  return { period, targets, overall, measures };
}

/** "KES 41,000.00" */
export function formatPay(amount: number | null, currency: string): string {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-KE", { style: "currency", currency, minimumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** A status word from HR as a person reads it ("not_reached" -> "Not reached"). */
export const hrStatusLabel = (s: string) => label(s.toLowerCase());

/** The first and last day of a "YYYY-MM" month: the attendance tab's range (HR takes up to 93 days). */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

// ---------------------------------------------------------------- calls (the my-hr function)
export type MyHrRoute = "summary" | MyHrTab;

/** One section of the signed-in person's HR record. Throws an EdgeError with a sentence to show. */
export async function fetchMyHr(route: MyHrRoute, params: { from?: string; to?: string } = {}): Promise<unknown> {
  return invokeEdge<unknown>("my-hr", { route, ...params }, { timeoutMs: 25_000 });
}

/** One payslip in full (HR has no server-side PDF: the page lays it out and the browser prints or saves it). */
export async function fetchPayslip(payslipId: string): Promise<unknown> {
  return invokeEdge<unknown>("my-hr", { route: "payslip", payslip_id: payslipId }, { timeoutMs: 25_000 });
}
