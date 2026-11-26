import type { AppConfig } from "../../config.js";
import type { Tx } from "../../db/sql.js";
import { AppError, forbidden, rateLimited, validationError } from "../../http/errors.js";
import type { RequestAuth } from "../../http/middleware/authContext.js";
import { isRealCalendarDate } from "../../http/schemas.js";
import { logWarn } from "../../log.js";
import { callHr, HrCallError, hrBaseUrlFrom, type HrAnswer } from "../../platform/hrApi.js";
import { isRecord } from "../../platform/http.js";
import { platformTokenConfigFrom, PlatformTokenClient } from "../../platform/platformClient.js";
import type { SchoolMembership } from "../tenancy/context.js";
import { hrBadAnswer, hrUnavailable, NOT_READY, refusalFromHr } from "./hrRefusal.js";

/**
 * "My HR" (docs/MY-HR.md): a staff member's own payslips, leave, attendance and KPIs from Figbloom HR, read only. This is the
 * API's port of the Supabase `my-hr` function (supabase/functions/my-hr/index.ts) and of the database rule `my_hr_status()`
 * (20261105710000). The school and the person are the caller's own, taken from the verified session; nothing in a request can
 * name another school or person, and HR's JSON is passed on as HR sent it.
 *
 * Not here (later slices): the HR-run leave routes (leave form, apply, cancel, approvals) and the HR & Payroll hand-off. They can
 * reuse `src/platform/` (the token client and the HR caller) and add their own routes beside these.
 */

const NOT_STAFF = "My HR is for the school's staff.";
const OFF = "My HR isn't available yet.";
const SCHOOL_NOT_LINKED = "This school isn't connected to Figbloom HR yet. Ask Figbloom.";

/** The roles that are a school's staff: they are the people HR has employees for. */
export const MY_HR_STAFF_ROLES: ReadonlySet<string> = new Set(["teacher", "driver", "staff", "school_admin"]);

export const MY_HR_STATUSES = ["not_staff", "off", "not_linked", "not_enabled", "available"] as const;
export type MyHrStatus = (typeof MY_HR_STATUSES)[number];

/** A platform "no" that hides My HR for an hour (a no because of the hand-off URL does not: My HR signs nobody in). */
const NOT_ENABLED_REASONS = ["target_not_enabled", "target_not_linked"] as const;

// ---------------------------------------------------------------- setting up

export interface MyHrSetup {
  /** off: MY_HR_ENABLED is not true. incomplete: it is true but a setting is missing. on: ready to call HR. */
  state: "off" | "incomplete" | "on";
  /** The names of the settings still missing (incomplete only). */
  missing: string[];
}

type MyHrConfig = Pick<
  AppConfig,
  "myHrEnabled" | "platformClientId" | "platformClientSecret" | "platformTokenUrl" | "hrMyHrUrl" | "myHrHttpTimeoutMs"
>;

export function myHrSetup(config: MyHrConfig): MyHrSetup {
  if (!config.myHrEnabled) return { state: "off", missing: [] };
  const missing = (
    [
      ["PLATFORM_CLIENT_ID", config.platformClientId],
      ["PLATFORM_CLIENT_SECRET", config.platformClientSecret],
      ["PLATFORM_TOKEN_URL", config.platformTokenUrl],
      ["HR_MY_HR_URL", config.hrMyHrUrl],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  return missing.length > 0 ? { state: "incomplete", missing } : { state: "on", missing: [] };
}

// ---------------------------------------------------------------- the rule

/**
 * The rule of my_hr_status(), for the caller. In this order: not staff (an active member of this school, in a school that is
 * not suspended, with a staff role: an org admin acting for a school and Figbloom staff are not its staff), the feature off,
 * the school unknown to the platform, a recent "HR is not on" from the platform, otherwise available. Whether this person's
 * own HR record is ready is HR's answer, per route.
 */
export async function resolveMyHrStatus(
  tx: Tx,
  input: { on: boolean; tenantId: string; membership: Pick<SchoolMembership, "role" | "tenant_status"> | null },
): Promise<MyHrStatus> {
  const { membership } = input;
  if (!membership || !MY_HR_STAFF_ROLES.has(membership.role) || membership.tenant_status === "suspended") return "not_staff";
  if (!input.on) return "off";
  const link = await tx.query<{ recent_no: boolean | null }>(
    `SELECT coalesce(hr_enabled = false
                     AND hr_reason = ANY ($2::text[])
                     AND hr_checked_at > now() - interval '1 hour', false) AS recent_no
       FROM platform_school_links
      WHERE tenant_id = $1`,
    [input.tenantId, [...NOT_ENABLED_REASONS]],
  );
  const row = link.rows[0];
  if (!row) return "not_linked";
  return row.recent_no ? "not_enabled" : "available";
}

// ---------------------------------------------------------------- what to ask HR for

export type MyHrRoute = "summary" | "payslips" | "payslip" | "leave" | "attendance" | "kpis";

/** One read of HR: the route's name (for logs) and HR's path under HR_MY_HR_URL. */
export interface MyHrPlan {
  route: MyHrRoute;
  path: string;
}

const HR_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DAYS = 93;
const DAY_MS = 86_400_000;

export const planMyHr = (route: Exclude<MyHrRoute, "payslip" | "attendance">): MyHrPlan => ({ route, path: route });

/** GET payslips/<id>. The id is HR's own (letters, digits, `_`, `-`); anything else is refused before HR is asked. */
export function planPayslip(id: unknown): MyHrPlan {
  const value = typeof id === "string" ? id.trim() : "";
  if (!HR_ID.test(value)) throw validationError("Say which payslip (payslipId).");
  return { route: "payslip", path: `payslips/${encodeURIComponent(value)}` };
}

/** GET attendance, with `from` and `to` (YYYY-MM-DD, real dates, in order, at most 93 days) when given. Other query fields are ignored. */
export function planAttendance(query: unknown): MyHrPlan {
  const q = isRecord(query) ? query : {};
  const dates: Record<"from" | "to", string | undefined> = { from: undefined, to: undefined };
  for (const key of ["from", "to"] as const) {
    const v = q[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || !isRealCalendarDate(v)) throw validationError("Dates are YYYY-MM-DD.");
    dates[key] = v;
  }
  const { from, to } = dates;
  if (from && to) {
    if (from > to) throw validationError("The start date is after the end date.");
    if ((Date.parse(to) - Date.parse(from)) / DAY_MS > MAX_DAYS - 1) {
      throw validationError(`Choose a range of ${MAX_DAYS} days or less.`);
    }
  }
  const search = new URLSearchParams();
  if (from) search.set("from", from);
  if (to) search.set("to", to);
  const text = search.toString();
  return { route: "attendance", path: text ? `attendance?${text}` : "attendance" };
}

// ---------------------------------------------------------------- the gate (in the caller's transaction)

const USER_LIMIT = 30;
const SCHOOL_LIMIT = 300;
/** Calls made with the platform token, for the whole API: shared by My HR and the HR & Payroll hand-off. */
export const PLATFORM_TOKEN_BUCKET = "my_hr:platform";
export const PLATFORM_LIMIT = 1_500;
const WINDOW_MS = 60_000;

/** One token from a per-minute bucket (`consume_rate_token`), or 429 with Retry-After. */
export async function consumeBucket(tx: Tx, key: string, capacity: number, message: string): Promise<void> {
  const res = await tx.query<{ out_allowed: boolean; out_retry_after_ms: number | null }>(
    `SELECT out_allowed, out_retry_after_ms FROM public.consume_rate_token($1, 1, $2, $2, $3)`,
    [key, capacity, WINDOW_MS],
  );
  const row = res.rows[0];
  if (row && !row.out_allowed) {
    const ms = row.out_retry_after_ms;
    throw rateLimited(message, ms && ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : 5);
  }
}

/** Every call that would reach HR spends a token per person, per school and for the whole platform token. */
export async function assertMyHrRateLimit(tx: Tx, input: { userId: string; tenantId: string }): Promise<void> {
  await consumeBucket(tx, `my_hr:user:${input.userId}`, USER_LIMIT, "Too many My HR requests. Try again in a minute.");
  await consumeBucket(tx, `my_hr:tenant:${input.tenantId}`, SCHOOL_LIMIT, "Too many My HR requests from this school. Try again in a minute.");
  await consumeBucket(tx, PLATFORM_TOKEN_BUCKET, PLATFORM_LIMIT, "Too many My HR requests. Try again in a minute.");
}

/**
 * The rule for a read route, asked as the caller, then the rate limit. Returns the school and the person to ask HR about,
 * which are the session's own. A refusal is the Supabase function's, code for code.
 */
export async function gateMyHrRead(tx: Tx, input: { on: boolean; auth: RequestAuth }): Promise<{ school: string; person: string }> {
  const { auth } = input;
  const tenantId = auth.authz.tenantId;
  if (!tenantId) throw forbidden("Tenant context required");
  const status = await resolveMyHrStatus(tx, { on: input.on, tenantId, membership: auth.authz.membership });
  switch (status) {
    case "not_staff":
      throw forbidden(NOT_STAFF);
    case "off":
      throw new AppError(403, "my_hr_off", OFF);
    case "not_linked":
      throw new AppError(409, "school_not_linked", SCHOOL_NOT_LINKED);
    case "available":
    case "not_enabled": // a recent "no" from the platform is asked again: HR is the authority
      break;
  }
  await assertMyHrRateLimit(tx, { userId: auth.user.id, tenantId });
  return { school: tenantId, person: auth.user.id };
}

// ---------------------------------------------------------------- HR (no database held)

export interface MyHrDeps {
  fetch?: typeof fetch;
}

/**
 * The part of My HR that talks to HR. One per app: it holds the platform token, which is reused between requests.
 * `on` is false unless MY_HR_ENABLED=true and the platform client and the HR address are all set.
 */
export class MyHrGateway {
  readonly setup: MyHrSetup;
  private readonly tokens: PlatformTokenClient | null = null;
  private readonly baseUrl: string | null;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(config: MyHrConfig, deps: MyHrDeps = {}) {
    this.setup = myHrSetup(config);
    this.baseUrl = hrBaseUrlFrom(config);
    this.timeoutMs = config.myHrHttpTimeoutMs;
    this.fetchFn = deps.fetch;
    const tokenConfig = platformTokenConfigFrom(config);
    if (this.setup.state === "on" && tokenConfig) this.tokens = new PlatformTokenClient(tokenConfig, { fetch: deps.fetch });
  }

  get on(): boolean {
    return this.setup.state === "on";
  }

  /**
   * One read of the caller's own record. Returns HR's JSON as it sent it (or the `pending_hr` answer), or throws the API's
   * own error. Nothing HR sends, and no token, is logged.
   */
  async read(plan: MyHrPlan, who: { school: string; person: string }, signal?: AbortSignal): Promise<unknown> {
    if (!this.tokens || !this.baseUrl) throw new AppError(403, "my_hr_off", OFF);
    let answer: HrAnswer;
    try {
      answer = await callHr(this.tokens, `${this.baseUrl}/${plan.path}`, { school: who.school, person: who.person, timeoutMs: this.timeoutMs, signal }, this.fetchFn);
    } catch (err) {
      // no platform token, HR not reached, or the caller left: a reason only
      if (!(err instanceof HrCallError && err.reason === "aborted")) {
        logWarn("my_hr_call_failed", { tenant_id: who.school, reason: plan.route, outcome: err instanceof HrCallError ? err.reason : "token" });
      }
      throw hrUnavailable();
    }
    if (answer.status >= 200 && answer.status < 300) {
      if (answer.tooLarge || !isRecord(answer.json)) {
        logWarn("my_hr_bad_answer", { tenant_id: who.school, reason: plan.route, status: answer.status });
        throw hrBadAnswer();
      }
      if (answer.json.status === "pending_hr") return { status: "pending_hr", message: NOT_READY };
      return answer.json;
    }
    const refusal = refusalFromHr(answer, { notFound: plan.route === "payslip" ? "That payslip isn't available." : undefined });
    if (refusal.statusCode >= 500) logWarn("my_hr_refused", { tenant_id: who.school, reason: plan.route, status: answer.status });
    throw refusal;
  }
}
