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
// HR's exact field names are its own (section 2 names the contents, not the fields); these read the likely
// spellings and leave out what isn't there, so the page never breaks on an extra or missing field.

/** HR has the person, but their record isn't ready (a draft employee): no data, just the sentence. */
export interface MyHrPending { pending: true; message: string }

export interface MyHrSummary {
  name: string | null;
  employeeNumber: string | null;
  jobTitle: string | null;
  department: string | null;
}

export interface Payslip {
  id: string;
  period: string;
  gross: number | null;
  deductions: number | null;
  net: number | null;
  currency: string;
  paidOn: string | null;
  hasPdf: boolean;
}

export interface LeaveBalance { type: string; entitled: number | null; taken: number | null; pending: number | null; balance: number | null }
export interface LeaveApplication { id: string; type: string; from: string | null; to: string | null; days: number | null; status: string; approver: string | null }
export interface MyLeave { balances: LeaveBalance[]; applications: LeaveApplication[] }

export interface AttendanceDay { date: string; status: string; clockIn: string | null; clockOut: string | null; lateMinutes: number | null }
export interface AttendanceNotice { date: string | null; text: string; status: string | null }
export interface MyAttendance { days: AttendanceDay[]; notices: AttendanceNotice[]; missedScans: AttendanceNotice[] }

export interface KpiTarget { name: string; target: string | null; score: string | null; weight: number | null }
export interface MyKpis { period: string | null; targets: KpiTarget[]; measures: { label: string; value: string }[] }

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

export function readSummary(data: unknown): MyHrSummary {
  const e = isObj(data) ? (isObj(data.employee) ? data.employee : data) : {};
  return {
    name: str(pick(e, "name", "full_name", "display_name")),
    employeeNumber: str(pick(e, "number", "employee_number", "employee_no", "staff_number")),
    jobTitle: str(pick(e, "job_title", "position", "designation", "title")),
    department: str(pick(e, "department", "department_name")),
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-10" -> "October 2026"; anything else as it came. */
export function periodLabel(raw: unknown, month?: unknown, year?: unknown): string {
  const m = num(month);
  const y = num(year);
  if (m && y && m >= 1 && m <= 12) return `${MONTHS[m - 1]} ${y}`;
  const s = str(raw) ?? "";
  const ym = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(s);
  if (ym && Number(ym[2]) >= 1 && Number(ym[2]) <= 12) return `${MONTHS[Number(ym[2]) - 1]} ${ym[1]}`;
  return s || "—";
}

export function readPayslips(data: unknown): Payslip[] {
  return list(data, "payslips", "items", "data").flatMap((p) => {
    const id = str(pick(p, "id", "payslip_id"));
    if (!id) return [];
    return [{
      id,
      period: periodLabel(pick(p, "period", "pay_period", "period_label", "month_label"), p.month, p.year),
      gross: num(pick(p, "gross", "gross_pay", "gross_salary")),
      deductions: num(pick(p, "deductions", "total_deductions")),
      net: num(pick(p, "net", "net_pay", "net_salary")),
      currency: str(pick(p, "currency")) ?? "KES",
      paidOn: str(pick(p, "paid_on", "pay_date", "payment_date")),
      hasPdf: p.has_pdf !== false && p.pdf_available !== false,
    }];
  });
}

export function readLeave(data: unknown): MyLeave {
  const balances = list(isObj(data) ? data.balances : undefined).map((b) => ({
    type: str(pick(b, "type", "leave_type", "type_name", "name")) ?? "Leave",
    entitled: num(pick(b, "entitled", "entitlement", "allowed", "days_entitled")),
    taken: num(pick(b, "taken", "used", "days_taken")),
    pending: num(pick(b, "pending", "days_pending")),
    balance: num(pick(b, "balance", "remaining", "available", "days_remaining")),
  }));
  const applications = list(isObj(data) ? data.applications ?? data.history ?? data.requests : undefined).map((a, i) => ({
    id: str(pick(a, "id")) ?? String(i),
    type: str(pick(a, "type", "leave_type", "type_name")) ?? "Leave",
    from: str(pick(a, "from", "start_date", "starts_on")),
    to: str(pick(a, "to", "end_date", "ends_on")),
    days: num(pick(a, "days", "number_of_days", "total_days")),
    status: str(pick(a, "status")) ?? "unknown",
    approver: str(pick(a, "approver", "approver_name", "approved_by", "decided_by")),
  }));
  return { balances, applications };
}

export function readAttendance(data: unknown): MyAttendance {
  const o = isObj(data) ? data : {};
  const notice = (n: Obj): AttendanceNotice => ({
    date: str(pick(n, "date", "day", "for_date")),
    text: str(pick(n, "message", "reason", "text", "note", "description")) ?? "",
    status: str(pick(n, "status")),
  });
  return {
    days: list(o.days ?? data).flatMap((d) => {
      const date = str(pick(d, "date", "day"));
      if (!date) return [];
      return [{
        date,
        status: str(pick(d, "status")) ?? "unknown",
        clockIn: str(pick(d, "clock_in", "first_in", "time_in", "in")),
        clockOut: str(pick(d, "clock_out", "last_out", "time_out", "out")),
        lateMinutes: num(pick(d, "late_minutes", "minutes_late")),
      }];
    }),
    notices: list(pick(o, "notices", "possible_absences", "absence_notices")).map(notice),
    missedScans: list(pick(o, "missed_scans", "missed_scan_requests")).map(notice),
  };
}

export function readKpis(data: unknown): MyKpis {
  const o = isObj(data) ? data : {};
  const period = isObj(o.period) ? str(pick(o.period, "name", "label", "title")) : str(o.period);
  const targets = list(pick(o, "targets", "kpis", "items")).map((t) => ({
    name: str(pick(t, "name", "kpi", "title", "description")) ?? "KPI",
    target: str(pick(t, "target", "target_value", "goal")),
    score: str(pick(t, "score", "actual", "achieved", "rating")),
    weight: num(pick(t, "weight", "weighting")),
  }));
  const att = pick(o, "attendance", "attendance_measures");
  const measures = Array.isArray(att)
    ? att.filter(isObj).flatMap((m) => {
      const l = str(pick(m, "label", "name", "measure"));
      const v = str(pick(m, "value", "score"));
      return l && v ? [{ label: l, value: v }] : [];
    })
    : isObj(att)
      ? Object.entries(att).flatMap(([k, v]) => (str(v) ? [{ label: label(k), value: str(v)! }] : []))
      : [];
  return { period, targets, measures };
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

/** A status word from HR as a person reads it ("pending_approval" -> "Pending approval"). */
export const hrStatusLabel = (s: string) => label(s.toLowerCase());

/** The first and last day of a "YYYY-MM" month: the attendance tab's range. */
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

/** A payslip's PDF (my-hr streams HR's file through). */
export async function fetchPayslipPdf(payslipId: string): Promise<Blob> {
  const data = await invokeEdge<unknown>("my-hr", { route: "payslip_pdf", payslip_id: payslipId }, { timeoutMs: 40_000 });
  if (typeof Blob !== "undefined" && data instanceof Blob) return data;
  if (isMyHrPending(data)) throw new Error(MY_HR_NOT_READY);
  throw new Error("The payslip couldn't be downloaded. Try again.");
}
