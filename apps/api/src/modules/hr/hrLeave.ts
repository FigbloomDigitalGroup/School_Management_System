import type { AppConfig } from "../../config.js";
import { attachDenialAudit, getDenialAudit } from "../../db/errors.js";
import type { Tx } from "../../db/sql.js";
import { AppError, forbidden, validationError } from "../../http/errors.js";
import type { RequestAuth } from "../../http/middleware/authContext.js";
import { logWarn } from "../../log.js";
import { callHr, HrCallError, hrBaseUrlFrom, type HrAnswer } from "../../platform/hrApi.js";
import { isRecord } from "../../platform/http.js";
import { platformTokenConfigFrom, PlatformTokenClient } from "../../platform/platformClient.js";
import { hasPermission, requirePermission } from "../rbac/authorize.js";
import { hrBadAnswer, hrUnavailable, refusalFromHr } from "./hrRefusal.js";
import { consumeBucket, MY_HR_STAFF_ROLES, PLATFORM_LIMIT, PLATFORM_TOKEN_BUCKET } from "./myHr.js";

/**
 * Leave run by Figbloom HR, the approver's side (docs/HR-HANDOFF.md, slice L1): whether the school's leave is HR's and whether
 * the caller approves it (the Supabase rule `hr_leave_access()`, 20261105800000), the applications HR says wait on the caller
 * (my-hr `approvals`), and a decision on one of them (my-hr `approval_decide`), made in HR as the caller's own HR user. HR
 * decides whose turn it is: the API never models the chain.
 *
 * Who approves: the permission `resource.hr.leave_approvals` (the school's administrators, and anyone holding the Leave or the
 * Fees area; an organisation administrator only through a delegation of one of them), and never a platform super
 * administrator (HR has no account for them; they hold every permission, so this is checked in code).
 *
 * Nothing HR sends is logged: not the applications, the reasons, the names, the comments or the document links (personal data,
 * valid about 5 minutes). A failure is logged as the school, the route and a reason.
 *
 * NOT here (later slices, HR-HANDOFF.md section 4): applying for and cancelling leave through HR (L3), HR's decisions coming
 * back as events (L4). HR_LEAVE_ENABLED must not be switched on for a school before both exist: on Supabase it moves the whole
 * school's leave to HR.
 */

export const HR_LEAVE_APPROVALS_PERMISSION = "resource.hr.leave_approvals";

export const HR_LEAVE_STATUSES = ["not_staff", "off", "not_linked", "not_enabled", "available"] as const;
export type HrLeaveStatus = (typeof HR_LEAVE_STATUSES)[number];
export interface HrLeaveAccess {
  status: HrLeaveStatus;
  approver: boolean;
}

const NOT_APPROVER = "Approving leave is for the head teacher, deputies, the bursar and the school's admins.";
const OFF = "Your school doesn't handle leave in Figbloom HR. Use the school's leave form.";
const SCHOOL_NOT_LINKED = "This school isn't connected to Figbloom HR yet. Ask Figbloom.";

/** A platform "no" that turns HR leave off for the school until the platform's next answer (it never wears off). */
const NOT_ENABLED_REASONS = ["target_not_enabled", "target_not_linked"] as const;

export const hrLeaveOff = (): AppError => new AppError(403, "hr_leave_off", OFF);

// ---------------------------------------------------------------- setting up

export interface HrLeaveSetup {
  /** off: HR_LEAVE_ENABLED is not true. incomplete: it is, but a setting is missing. on: ready. */
  state: "off" | "incomplete" | "on";
  missing: string[];
}

type HrLeaveConfig = Pick<
  AppConfig,
  "hrLeaveEnabled" | "platformClientId" | "platformClientSecret" | "platformTokenUrl" | "platformApiUrl" | "hrMyHrUrl" | "myHrHttpTimeoutMs"
>;

/** On only with HR_LEAVE_ENABLED=true and the four settings of My HR plus PLATFORM_API_URL (HR-HANDOFF.md 3.2). */
export function hrLeaveSetup(config: HrLeaveConfig): HrLeaveSetup {
  if (!config.hrLeaveEnabled) return { state: "off", missing: [] };
  const missing = (
    [
      ["PLATFORM_CLIENT_ID", config.platformClientId],
      ["PLATFORM_CLIENT_SECRET", config.platformClientSecret],
      ["PLATFORM_TOKEN_URL", config.platformTokenUrl],
      ["PLATFORM_API_URL", config.platformApiUrl],
      ["HR_MY_HR_URL", config.hrMyHrUrl],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  return missing.length > 0 ? { state: "incomplete", missing } : { state: "on", missing: [] };
}

// ---------------------------------------------------------------- the rule (in the caller's transaction)

/**
 * hr_leave_on() for the school: the switch, the school known to the platform (a platform_school_links row), and the platform's
 * last answer about HR not one of the two "no"s. Unlike My HR's hour, that "no" does not wear off: which leave a school uses
 * must not flip back and forth (the next hand-off answer changes it).
 */
export async function schoolHrLeaveState(tx: Tx, input: { on: boolean; tenantId: string }): Promise<Exclude<HrLeaveStatus, "not_staff">> {
  if (!input.on) return "off";
  const res = await tx.query<{ said_no: boolean }>(
    `SELECT coalesce(hr_enabled = false AND hr_reason = ANY ($2::text[]), false) AS said_no
       FROM platform_school_links
      WHERE tenant_id = $1`,
    [input.tenantId, [...NOT_ENABLED_REASONS]],
  );
  const row = res.rows[0];
  if (!row) return "not_linked";
  return row.said_no ? "not_enabled" : "available";
}

/** A staff member as My HR and hr_leave_access() count one: an active teacher, driver, staff or school_admin, school not suspended. */
const isStaff = (auth: RequestAuth): boolean => {
  const m = auth.authz.membership;
  return !!m && MY_HR_STAFF_ROLES.has(m.role) && m.tenant_status !== "suspended";
};

/**
 * hr_leave_access() for the caller: `{status, approver}`. `approver` is the permission (never for a platform super
 * administrator). `status` is `not_staff` for anyone who is neither staff nor an approver (a parent, a learner, Figbloom
 * staff, an organisation administrator without a delegation); otherwise the school's state. Reads only: nothing is asked of HR.
 */
export async function resolveHrLeaveAccess(tx: Tx, input: { on: boolean; auth: RequestAuth }): Promise<HrLeaveAccess> {
  const { auth } = input;
  const tenantId = auth.authz.tenantId;
  if (!tenantId) throw forbidden("Tenant context required");
  if (auth.authz.isSuperAdmin) return { status: "not_staff", approver: false };
  const approver = await hasPermission(tx, auth.authz, HR_LEAVE_APPROVALS_PERMISSION);
  if (!isStaff(auth) && !approver) return { status: "not_staff", approver: false };
  return { status: await schoolHrLeaveState(tx, { on: input.on, tenantId }), approver };
}

/**
 * The rule for the approver's routes, as the caller: a school in the request, not a platform super administrator,
 * `resource.hr.leave_approvals` (the standard audited 403, worded as my-hr words it), then the school's state as my-hr's gate
 * has it (`off` and `not_enabled` 403 hr_leave_off, `not_linked` 409 school_not_linked). Returns the school and the person to
 * ask HR about, which are the session's own.
 */
export async function authorizeHrLeaveApprover(tx: Tx, input: { on: boolean; auth: RequestAuth; ip: string | null }): Promise<{ school: string; person: string }> {
  const { auth, ip } = input;
  const tenantId = auth.authz.tenantId;
  if (!tenantId) throw forbidden("Tenant context required");
  if (auth.authz.isSuperAdmin) {
    const err = forbidden(NOT_APPROVER);
    attachDenialAudit(err, {
      eventType: "rbac.permission.denied",
      actorUserId: auth.user.id,
      tenantId,
      detail: { permission: HR_LEAVE_APPROVALS_PERMISSION, role: auth.authz.role, reason: "platform_super_admin" },
      ip,
    });
    throw err;
  }
  try {
    await requirePermission(tx, auth.authz, HR_LEAVE_APPROVALS_PERMISSION, { ip, deferAudit: true });
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "forbidden") throw err;
    const plain = forbidden(NOT_APPROVER);
    const audit = getDenialAudit(err);
    if (audit) attachDenialAudit(plain, audit);
    throw plain;
  }
  switch (await schoolHrLeaveState(tx, { on: input.on, tenantId })) {
    case "off":
    case "not_enabled":
      throw hrLeaveOff();
    case "not_linked":
      throw new AppError(409, "school_not_linked", SCHOOL_NOT_LINKED);
    case "available":
      break;
  }
  return { school: tenantId, person: auth.user.id };
}

const USER_LIMIT = 30;
const SCHOOL_LIMIT = 300;

/** Every call that would reach HR spends a token per person, per school and for the platform token (shared with My HR). */
export async function assertHrLeaveRateLimit(tx: Tx, input: { userId: string; tenantId: string }): Promise<void> {
  const message = "Too many leave requests to Figbloom HR. Try again in a minute.";
  await consumeBucket(tx, `hr_leave:user:${input.userId}`, USER_LIMIT, message);
  await consumeBucket(tx, `hr_leave:tenant:${input.tenantId}`, SCHOOL_LIMIT, "Too many leave requests to Figbloom HR from this school. Try again in a minute.");
  await consumeBucket(tx, PLATFORM_TOKEN_BUCKET, PLATFORM_LIMIT, message);
}

// ---------------------------------------------------------------- what to ask HR for

export const HR_LEAVE_DECISIONS = ["approve", "decline"] as const;
export type HrLeaveDecision = (typeof HR_LEAVE_DECISIONS)[number];
/** HR's id of an application: letters, digits, `_`, `-` (my-hr's HR_ID). */
const HR_APPLICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_COMMENT = 1000;

export interface DecidePlan {
  applicationId: string;
  decision: HrLeaveDecision;
  /** What HR is sent: the decision, and the comment only when there is one. */
  body: { decision: HrLeaveDecision; comment?: string };
}

/**
 * POST approvals/<id>/decide, as my-hr plans it: HR's own application id, approve or decline, and the comment trimmed (left out
 * when empty). A decline without a comment is HR's to refuse (it answers 422): the page's button waits for one.
 */
export function planDecide(applicationId: unknown, input: { decision: HrLeaveDecision; comment?: string | null }): DecidePlan {
  const id = typeof applicationId === "string" ? applicationId.trim() : "";
  if (!HR_APPLICATION_ID.test(id)) throw validationError("Say which application (applicationId).");
  const comment = typeof input.comment === "string" ? input.comment.trim() : "";
  if (comment.length > MAX_COMMENT) throw validationError(`Keep the comment to ${MAX_COMMENT} characters.`);
  return { applicationId: id, decision: input.decision, body: comment ? { decision: input.decision, comment } : { decision: input.decision } };
}

// ---------------------------------------------------------------- HR's answers

const MAX_LINK_LENGTH = 4_096;

/** A document link from HR, kept only when it is an https address (valid about 5 minutes; never logged). */
function httpsOnly(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LINK_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

function safeDocument(doc: unknown): unknown {
  if (!isRecord(doc)) return doc;
  return { ...doc, url: httpsOnly(doc.url) };
}

/**
 * HR's approvals answer as HR sent it, except that a document link (`document`, `followup_document`) that is not https loses
 * its address (null): the browser opens these links directly, so only an https one is ever handed on.
 */
export function withSafeDocumentLinks(answer: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(answer.approvals)) return answer;
  return {
    ...answer,
    approvals: answer.approvals.map((item) => {
      if (!isRecord(item)) return item;
      const out: Record<string, unknown> = { ...item };
      if ("document" in item) out.document = safeDocument(item.document);
      if ("followup_document" in item) out.followup_document = safeDocument(item.followup_document);
      return out;
    }),
  };
}

// ---------------------------------------------------------------- HR (no database held)

export interface HrLeaveDeps {
  fetch?: typeof fetch;
}

type Who = { school: string; person: string };

/**
 * The part that talks to HR for leave. One per app: it holds the platform token, reused between requests. `on` is false unless
 * HR_LEAVE_ENABLED=true and the platform settings and the HR address are all set.
 */
export class HrLeaveGateway {
  readonly setup: HrLeaveSetup;
  private readonly tokens: PlatformTokenClient | null = null;
  private readonly baseUrl: string | null;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(config: HrLeaveConfig, deps: HrLeaveDeps = {}) {
    this.setup = hrLeaveSetup(config);
    this.baseUrl = hrBaseUrlFrom(config);
    this.timeoutMs = config.myHrHttpTimeoutMs;
    this.fetchFn = deps.fetch;
    const tokenConfig = platformTokenConfigFrom(config);
    if (this.setup.state === "on" && tokenConfig) this.tokens = new PlatformTokenClient(tokenConfig, { fetch: deps.fetch });
  }

  get on(): boolean {
    return this.setup.state === "on" && this.tokens !== null && this.baseUrl !== null;
  }

  /** GET approvals: what waits on the caller's HR user, as HR sent it (document links https only). */
  async approvals(who: Who, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return withSafeDocumentLinks(await this.ask("approvals", { path: "approvals", method: "GET" }, who, signal));
  }

  /** POST approvals/<id>/decide, done in HR as the caller's HR user: HR's `{request_status, application}`. Never repeated. */
  async decide(plan: DecidePlan, who: Who, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.ask(
      "decide",
      { path: `approvals/${encodeURIComponent(plan.applicationId)}/decide`, method: "POST", body: plan.body },
      who,
      signal,
    );
  }

  private async ask(
    route: "approvals" | "decide",
    call: { path: string; method: "GET" | "POST"; body?: unknown },
    who: Who,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.tokens || !this.baseUrl) throw hrLeaveOff();
    let answer: HrAnswer;
    try {
      answer = await callHr(
        this.tokens,
        `${this.baseUrl}/${call.path}`,
        { method: call.method, school: who.school, person: who.person, body: call.body, timeoutMs: this.timeoutMs, signal },
        this.fetchFn,
      );
    } catch (err) {
      // no platform token, HR not reached, or the caller left: a reason only
      if (!(err instanceof HrCallError && err.reason === "aborted")) {
        logWarn("hr_leave_call_failed", { tenant_id: who.school, reason: route, outcome: err instanceof HrCallError ? err.reason : "token" });
      }
      throw hrUnavailable();
    }
    if (answer.status >= 200 && answer.status < 300) {
      if (answer.tooLarge || !isRecord(answer.json)) {
        logWarn("hr_leave_bad_answer", { tenant_id: who.school, reason: route, status: answer.status });
        throw hrBadAnswer();
      }
      // HR has no approved employee record for the person yet: "your HR record isn't ready yet" (404 pending_hr)
      if (answer.json.status === "pending_hr") throw refusalFromHr(answer);
      return answer.json;
    }
    const refusal = refusalFromHr(answer, { notFound: route === "decide" ? "That application isn't available any more." : undefined });
    if (refusal.statusCode >= 500) logWarn("hr_leave_refused", { tenant_id: who.school, reason: route, status: answer.status });
    throw refusal;
  }
}
