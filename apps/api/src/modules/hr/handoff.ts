import type { AppConfig } from "../../config.js";
import { attachDenialAudit, getDenialAudit } from "../../db/errors.js";
import type { Tx } from "../../db/sql.js";
import { AppError, forbidden, rateLimited } from "../../http/errors.js";
import type { RequestAuth } from "../../http/middleware/authContext.js";
import { logWarn } from "../../log.js";
import { isRecord } from "../../platform/http.js";
import { PlatformError, PlatformTokenClient, platformTokenConfigFrom } from "../../platform/platformClient.js";
import { requirePermission } from "../rbac/authorize.js";
import { hrBadAnswer, hrUnavailable } from "./hrRefusal.js";
import { consumeBucket, PLATFORM_LIMIT, PLATFORM_TOKEN_BUCKET } from "./myHr.js";

/**
 * "HR & Payroll" (docs/HR-HANDOFF.md, slice H1): whether Figbloom HR is there for the school, "Request Figbloom HR", and a
 * one-time sign-in link into HR for the person clicking. A port of the live Supabase function `open-hr` (main,
 * supabase/functions/open-hr/index.ts) and its rule `hr_handoff_status()`, with the API's stricter rule for organisation
 * administrators (only through a delegation of the Fees area; HR-HANDOFF.md risk R5).
 *
 * Who: the permission `resource.hr.handoff` (the school's administrators, and anyone holding the Fees area), and never a
 * platform super administrator (HR has no account for them; they hold every permission, so this is checked in code).
 *
 * The one-time link holds a code: it is never logged, never audited and never put in an error. Nothing the platform sends is
 * logged either: a failure is logged as the school, a reason and a status.
 */

export const HR_HANDOFF_PERMISSION = "resource.hr.handoff";
/** The product the platform signs the person in to. */
export const HR_TARGET = "hr";

const NOT_FOR_YOU = "HR & Payroll is for the school's administrators and the bursar.";
const OFF_OPEN = "Signing in to HR & Payroll from Figbloom Schools isn't available yet.";
const OFF_REQUEST = "HR & Payroll isn't available from Figbloom Schools yet.";
const SCHOOL_NOT_LINKED = "This school isn't connected to the Figbloom platform yet. Try again later, or ask Figbloom.";
const PLATFORM_DOES_NOT_KNOW = "The Figbloom platform doesn't know this school yet. Try again later, or ask Figbloom.";
const ALREADY_CONNECTED = "Figbloom HR is already switched on for this school.";
const PLATFORM_RATE_LIMITED = "Too many HR sign-ins for this school in the last minute. Wait a moment and try again.";

/** What each platform refusal means to the person who clicked (open-hr's TARGET_REFUSALS, word for word). */
export const TARGET_REFUSALS: Readonly<Record<"target_not_enabled" | "target_not_linked" | "target_no_handoff_url", string>> = {
  target_not_enabled: "HR & Payroll isn't switched on for this school yet. Ask Figbloom to turn it on.",
  target_not_linked: "HR & Payroll is on for this school, but its HR company isn't connected yet. Ask Figbloom to finish the setup.",
  target_no_handoff_url: "HR & Payroll isn't ready to accept sign-ins from Figbloom Schools yet. Try again later.",
};
type TargetRefusal = keyof typeof TARGET_REFUSALS;
const isTargetRefusal = (code: string): code is TargetRefusal => Object.hasOwn(TARGET_REFUSALS, code);

export const handoffOff = (what: "open" | "request"): AppError =>
  new AppError(403, "handoff_off", what === "open" ? OFF_OPEN : OFF_REQUEST);
export const schoolNotLinked = (): AppError => new AppError(409, "school_not_linked", SCHOOL_NOT_LINKED);
export const alreadyConnected = (): AppError => new AppError(409, "already_connected", ALREADY_CONNECTED);

// ---------------------------------------------------------------- setting up

export interface HandoffSetup {
  /** off: PLATFORM_HANDOFF_ENABLED is not true. incomplete: it is, but a setting is missing. on: ready. */
  state: "off" | "incomplete" | "on";
  missing: string[];
}

type HandoffConfig = Pick<
  AppConfig,
  "platformHandoffEnabled" | "platformClientId" | "platformClientSecret" | "platformTokenUrl" | "platformApiUrl" | "myHrHttpTimeoutMs"
>;

export function handoffSetup(config: HandoffConfig): HandoffSetup {
  if (!config.platformHandoffEnabled) return { state: "off", missing: [] };
  const missing = (
    [
      ["PLATFORM_CLIENT_ID", config.platformClientId],
      ["PLATFORM_CLIENT_SECRET", config.platformClientSecret],
      ["PLATFORM_TOKEN_URL", config.platformTokenUrl],
      ["PLATFORM_API_URL", config.platformApiUrl],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  return missing.length > 0 ? { state: "incomplete", missing } : { state: "on", missing: [] };
}

// ---------------------------------------------------------------- who (in the caller's transaction)

/**
 * The rule, as the caller: a school in the request, not a platform super administrator, and `resource.hr.handoff`. A refusal
 * is the standard audited 403 (`rbac.permission.denied`, written after the rollback), worded as open-hr words it. Returns the
 * school, which is the session's own.
 */
export async function gateHandoff(tx: Tx, input: { auth: RequestAuth; ip: string | null }): Promise<string> {
  const { auth, ip } = input;
  const tenantId = auth.authz.tenantId;
  if (!tenantId) throw forbidden("Tenant context required");
  if (auth.authz.isSuperAdmin) {
    const err = forbidden(NOT_FOR_YOU);
    attachDenialAudit(err, {
      eventType: "rbac.permission.denied",
      actorUserId: auth.user.id,
      tenantId,
      detail: { permission: HR_HANDOFF_PERMISSION, role: auth.authz.role, reason: "platform_super_admin" },
      ip,
    });
    throw err;
  }
  try {
    await requirePermission(tx, auth.authz, HR_HANDOFF_PERMISSION, { ip, deferAudit: true });
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "forbidden") throw err;
    const plain = forbidden(NOT_FOR_YOU);
    const audit = getDenialAudit(err);
    if (audit) attachDenialAudit(plain, audit);
    throw plain;
  }
  return tenantId;
}

/** The person the platform signs in, from the verified session: the API's own user id, name, real e-mail or null, and role. */
export interface HandoffPerson {
  external_id: string;
  name: string;
  email: string | null;
  role: string;
}

/** Same as open-hr's realEmail() (the database's platform_real_email()): trimmed, lower case, null for a synthetic or malformed address. */
export function realEmail(address: string | null | undefined): string | null {
  const a = (address ?? "").trim().toLowerCase();
  if (!a || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) return null;
  if (/\.(internal|invalid)$/.test(a)) return null;
  return a;
}

export function handoffPerson(auth: RequestAuth): HandoffPerson {
  const role = auth.authz.membership?.role ?? (auth.authz.isOrgAdminForTenant ? "org_admin" : auth.authz.role);
  return { external_id: auth.user.id, name: auth.user.full_name ?? "", email: realEmail(auth.user.email), role };
}

/** What the school's row says: whether the platform knows the school, its platform id, and the school's request for HR. */
export interface HandoffState {
  /** null: no platform_school_links row (the platform does not know the school). */
  link: { platformTenantId: string | null } | null;
  /** tenants.hr_requested_at as ISO, or null. */
  requestedAt: string | null;
}

export async function readHandoffState(tx: Tx, tenantId: string): Promise<HandoffState> {
  const link = await tx.query<{ platform_tenant_id: string | null }>(
    `SELECT platform_tenant_id FROM platform_school_links WHERE tenant_id = $1`,
    [tenantId],
  );
  const school = await tx.query<{ hr_requested_at: Date | null }>(`SELECT hr_requested_at FROM tenants WHERE id = $1`, [tenantId]);
  const at = school.rows[0]?.hr_requested_at ?? null;
  const row = link.rows[0];
  return { link: row ? { platformTenantId: row.platform_tenant_id } : null, requestedAt: at ? at.toISOString() : null };
}

/** Records the platform's last answer about HR for the school (yes, or its refusal code), as open-hr does. Never a 404. */
export async function recordHrAnswer(tx: Tx, tenantId: string, enabled: boolean, reason: TargetRefusal | null): Promise<void> {
  await tx.query(
    `UPDATE platform_school_links SET hr_enabled = $2, hr_reason = $3, hr_checked_at = now() WHERE tenant_id = $1`,
    [tenantId, enabled, enabled ? null : reason],
  );
}

/** "Request Figbloom HR": the first request is kept (hr_record_request(), migration 117). `recorded` is false for a repeat. */
export async function recordHrRequest(tx: Tx): Promise<{ requestedAt: string; recorded: boolean }> {
  const res = await tx.query<{ requested_at: Date; recorded: boolean }>(`SELECT requested_at, recorded FROM public.hr_record_request()`);
  const row = res.rows[0]!;
  return { requestedAt: row.requested_at.toISOString(), recorded: row.recorded };
}

const USER_LIMIT = 10;
const SCHOOL_LIMIT = 120;

/**
 * Rate limit, in the same short transaction, before any network call. Per person (opening and asking), per school, and the
 * platform token bucket shared with My HR when the platform will be asked.
 */
export async function assertHandoffRateLimit(tx: Tx, input: { userId?: string; tenantId: string; platform: boolean }): Promise<void> {
  const message = "Too many HR & Payroll requests. Try again in a minute.";
  if (input.userId) await consumeBucket(tx, `hr_handoff:user:${input.userId}`, USER_LIMIT, message);
  await consumeBucket(tx, `hr_handoff:tenant:${input.tenantId}`, SCHOOL_LIMIT, "Too many HR & Payroll requests from this school. Try again in a minute.");
  if (input.platform) await consumeBucket(tx, PLATFORM_TOKEN_BUCKET, PLATFORM_LIMIT, message);
}

// ---------------------------------------------------------------- the platform (no database held)

/**
 * Whether Figbloom HR is there for the school (open-hr's `connection`):
 *   connected      HR is on and linked: the hand-off will work
 *   setting_up     HR is on, but HR has not created or linked the school's company yet
 *   not_connected  the platform does not know the school, or HR is not switched on for it
 *   unknown        the platform could not be asked: the web offers HR as if connected, and the launch tab says what is wrong
 */
export type HrConnection = "connected" | "setting_up" | "not_connected" | "unknown";

/** How long a school's connection is kept (the platform's cache_seconds, at most this); a failed check only briefly. */
export const CONNECTION_CACHE_SECONDS = 60;
export const UNKNOWN_CACHE_SECONDS = 15;
const MAX_CACHED_SCHOOLS = 5_000;
const MAX_URL_LENGTH = 4_096;

export type OpenResult =
  | { ok: true; url: string; expiresAt: string | null }
  | { ok: false; error: AppError; recordNo: TargetRefusal | null };

export interface HandoffDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The part that talks to the platform. One per app: it holds the platform token and a minute's memory of each school's
 * connection. `on` is false unless PLATFORM_HANDOFF_ENABLED=true and the four platform settings are set.
 */
export class HandoffGateway {
  readonly setup: HandoffSetup;
  private readonly tokens: PlatformTokenClient | null = null;
  private readonly connections = new Map<string, { value: HrConnection; until: number }>();
  private readonly now: () => number;

  constructor(config: HandoffConfig, deps: HandoffDeps = {}) {
    this.setup = handoffSetup(config);
    this.now = deps.now ?? Date.now;
    const tokenConfig = platformTokenConfigFrom(config);
    if (this.setup.state === "on" && tokenConfig) this.tokens = new PlatformTokenClient(tokenConfig, { fetch: deps.fetch, now: deps.now });
  }

  get on(): boolean {
    return this.setup.state === "on" && this.tokens !== null;
  }

  /** The school's connection as last worked out, while it is fresh; null when the platform would have to be asked. */
  cachedConnection(tenantId: string): HrConnection | null {
    const kept = this.connections.get(tenantId);
    return kept && kept.until > this.now() ? kept.value : null;
  }

  forget(tenantId: string): void {
    this.connections.delete(tenantId);
  }

  /**
   * Whether HR is there for the school. Never throws: a platform that cannot be asked is "unknown". No platform row is
   * `not_connected` (as on Supabase); a row without the platform's own id for the school is `unknown` (it cannot be asked).
   */
  async connection(tenantId: string, state: HandoffState): Promise<HrConnection> {
    if (!state.link) return "not_connected";
    const platformTenantId = state.link.platformTenantId;
    if (!this.tokens || !platformTenantId) return "unknown";
    const kept = this.cachedConnection(tenantId);
    if (kept) return kept;
    const { value, seconds } = await this.askPlatform(tenantId, platformTenantId);
    if (this.connections.size >= MAX_CACHED_SCHOOLS) this.connections.clear();
    this.connections.set(tenantId, { value, until: this.now() + seconds * 1000 });
    return value;
  }

  private async askPlatform(tenantId: string, platformTenantId: string): Promise<{ value: HrConnection; seconds: number }> {
    const tokens = this.tokens!;
    const id = encodeURIComponent(platformTenantId);
    try {
      const module = await tokens.call("GET", `/tenants/${id}/modules/${HR_TARGET}`);
      const asked = isRecord(module) ? Number(module.cache_seconds) : Number.NaN;
      const seconds = asked > 0 ? Math.min(asked, CONNECTION_CACHE_SECONDS) : CONNECTION_CACHE_SECONDS;
      if (!isRecord(module) || module.module_status !== "active") return { value: "not_connected", seconds };
      try {
        await tokens.call("GET", `/tenants/${id}/links/${HR_TARGET}`);
        return { value: "connected", seconds };
      } catch (err) {
        if (err instanceof PlatformError && err.status === 404) return { value: "setting_up", seconds };
        throw err;
      }
    } catch (err) {
      logWarn("hr_handoff_check_failed", { tenant_id: tenantId, ...platformFailure(err) });
      return { value: "unknown", seconds: UNKNOWN_CACHE_SECONDS };
    }
  }

  /**
   * POST /handoffs: a one-time sign-in link into HR for this person. Returns the link (https only) or the API's refusal, and
   * which platform "no" to record. A POST that reached the platform is never repeated by the API.
   */
  async open(input: { school: string; person: HandoffPerson }, signal?: AbortSignal): Promise<OpenResult> {
    if (!this.tokens) return { ok: false, error: handoffOff("open"), recordNo: null };
    let answer: unknown;
    try {
      answer = await this.tokens.call(
        "POST",
        "/handoffs",
        { target: HR_TARGET, tenant_local_id: input.school, person: input.person },
        signal,
      );
    } catch (err) {
      if (err instanceof PlatformError && err.status === 409 && isTargetRefusal(err.code)) {
        this.forget(input.school);
        return { ok: false, error: new AppError(409, err.code, TARGET_REFUSALS[err.code]), recordNo: err.code };
      }
      if (err instanceof PlatformError && err.status === 404) {
        this.forget(input.school);
        return { ok: false, error: new AppError(409, "school_not_linked", PLATFORM_DOES_NOT_KNOW), recordNo: null };
      }
      if (err instanceof PlatformError && err.status === 429) {
        return { ok: false, error: rateLimited(PLATFORM_RATE_LIMITED, 60), recordNo: null };
      }
      logWarn("hr_handoff_failed", { tenant_id: input.school, ...platformFailure(err) });
      return { ok: false, error: hrUnavailable(), recordNo: null };
    }
    // never hand the browser anything but an https address to open
    const raw = isRecord(answer) && typeof answer.url === "string" && answer.url.length <= MAX_URL_LENGTH ? answer.url : null;
    let url: URL | null = null;
    try {
      url = raw === null ? null : new URL(raw);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:") {
      logWarn("hr_handoff_bad_answer", { tenant_id: input.school, outcome: "not_https" });
      return { ok: false, error: hrBadAnswer(), recordNo: null };
    }
    const expires = isRecord(answer) && typeof answer.expires_at === "string" && answer.expires_at.length <= 64 ? answer.expires_at : null;
    return { ok: true, url: url.href, expiresAt: expires };
  }
}

/** A platform failure as log fields: a reason and a status, never the platform's words. */
function platformFailure(err: unknown): { outcome: string; status?: number } {
  if (err instanceof PlatformError) return { outcome: /^[a-z_0-9]{1,40}$/.test(err.code) ? err.code : "platform_error", status: err.status };
  return { outcome: "error" };
}
