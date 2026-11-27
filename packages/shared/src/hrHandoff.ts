import type { AdminArea } from "./adminAreas";
import { apiFetchHrHandoffStatus, apiOpenHrHandoff, apiRequestHrHandoff } from "./api/hrHandoffApi";
import { onApi } from "./backend";
import { EdgeError, invokeEdge } from "./edge";
import { supabase } from "./supabase";
import type { Role } from "./types";

/**
 * "HR & Payroll": one click from Figbloom Schools into Figbloom HR, signed in
 * (SCHOOLS_HR_HANDOFF_CONTRACT.md section 3; 20261105700000, the open-hr function).
 *
 * The database's hr_handoff_status(school) is the rule, for the sidebar and
 * for open-hr alike:
 *   forbidden    not the school's admin, an org admin of its organisation, or a holder of the fees area
 *                (the database refuses them, 42501, so it says nothing about other schools)
 *   off          PLATFORM_HANDOFF_ENABLED is off (the default)
 *   not_linked   the platform doesn't know the school yet
 *   not_enabled  the platform said HR isn't on for it, in the last hour
 *   available    show it
 * HR decides real access; this only hides the item from people who can't use it.
 *
 * The phone app still shows its button by this status (showsHrItem). The web console now asks open-hr for the
 * school's HR connection instead (fetchHrStatus, hrItemMode below): its item is there whenever handoff is on.
 *
 * On the API build the four functions that call the backend (fetchHrHandoffStatus, requestHrLink, fetchHrStatus,
 * requestFigbloomHr) call apps/api instead (api/hrHandoffApi.ts, docs/web-on-api/hr-handoff.md): the same answers, the same errors.
 */
export type HrHandoffStatus = "off" | "forbidden" | "not_linked" | "not_enabled" | "available";

export const HR_ITEM_LABEL = "HR & Payroll";

/**
 * Whether this person could ever get the item at the school they're in, from
 * what the console already knows: the school's admin, an org admin acting for
 * it, or a teacher or other staff member holding the fees area (the bursar).
 * Anyone else isn't asked about it at all.
 */
export function mayOfferHr(role: Role, adminAreas: readonly AdminArea[], actingForTenant = false, delegatedOrgConsole = false): boolean {
  if (delegatedOrgConsole) return adminAreas.includes("fees");
  if (actingForTenant || role === "school_admin") return true;
  return (role === "teacher" || role === "staff") && adminAreas.includes("fees");
}

/** The phone app shows its HR & Payroll button only when the person may have it and the database says it's available. */
export function showsHrItem(eligible: boolean, status: HrHandoffStatus | null | undefined): boolean {
  return eligible && status === "available";
}

const STATUSES: readonly HrHandoffStatus[] = ["off", "forbidden", "not_linked", "not_enabled", "available"];

/**
 * hr_handoff_status() for the signed-in person at this school; "off" for an answer it doesn't know (the item stays hidden).
 * On the API build there is no such function: the answer is worked out from the API's status (hrHandoffStatusFrom).
 */
export async function fetchHrHandoffStatus(tenantId: string): Promise<HrHandoffStatus> {
  if (onApi()) {
    try {
      return hrHandoffStatusFrom(readHrStatus(await apiFetchHrHandoffStatus(tenantId)));
    } catch (err) {
      if (err instanceof EdgeError && err.status === 403) return "forbidden";
      throw err;
    }
  }
  const { data, error } = await supabase().rpc("hr_handoff_status", { p_tenant_id: tenantId });
  if (error?.code === "42501") return "forbidden";
  if (error) throw new Error(error.message);
  return STATUSES.includes(data as HrHandoffStatus) ? (data as HrHandoffStatus) : "off";
}

/**
 * A one-time HR sign-in link for the signed-in person (valid for a minute, once). Throws an EdgeError with the reason.
 * The link holds a one-time code: callers open it at once and never show, store or log it. `expires_at` is null when the platform gave none.
 */
export async function requestHrLink(tenantId: string): Promise<{ url: string; expires_at: string | null }> {
  if (onApi()) return apiOpenHrHandoff(tenantId);
  return invokeEdge<{ url: string; expires_at: string }>("open-hr", { tenant_id: tenantId }, { timeoutMs: 20_000 });
}

// ---------------------------------------------------------------- connecting to Figbloom HR (HR_CONNECT_SPEC.md)
//
// The web console's sidebar item, its HR & Payroll page and the launch tab, the same way Fleet and Property do it.
// open-hr answers {action: "status"} with whether HR is there for the school, and {action: "request"} records
// that the school asked Figbloom for it (Figbloom staff see it in the console and switch HR on there).

/**
 * Whether Figbloom HR is there for the school (worked out by open-hr from the platform, kept a minute):
 *   connected      open it (the launch tab signs them in)
 *   setting_up     switched on; HR is still creating the school's company (its admins get an email invitation)
 *   not_connected  not switched on: the school can ask Figbloom for it
 *   unknown        couldn't be checked: offered like connected, and the launch tab says what's wrong
 */
export type HrConnection = "connected" | "setting_up" | "not_connected" | "unknown";

/** open-hr's status answer, for someone who may open HR at the school. */
export interface HrStatus {
  /** PLATFORM_HANDOFF_ENABLED: false hides everything. */
  enabled: boolean;
  connection: HrConnection | null;
  /** When the school asked Figbloom for HR (ISO), or null. */
  requestedAt: string | null;
  canRequestHr: boolean;
}

const CONNECTIONS: readonly HrConnection[] = ["connected", "setting_up", "not_connected", "unknown"];

/** open-hr's raw status answer, checked: anything it doesn't recognise reads as switched off (hidden). */
export function readHrStatus(raw: unknown): HrStatus {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const connection = r.enabled === true && CONNECTIONS.includes(r.connection as HrConnection) ? (r.connection as HrConnection) : null;
  const enabled = connection !== null;
  return {
    enabled,
    connection,
    requestedAt: enabled && typeof r.requested_at === "string" && r.requested_at ? r.requested_at : null,
    canRequestHr: enabled && r.can_request_hr === true,
  };
}

/** Switched off, or this person may not open HR at the school (open-hr's 403): nothing to show. */
export const HR_STATUS_HIDDEN: HrStatus = { enabled: false, connection: null, requestedAt: null, canRequestHr: false };

/**
 * The older three-way answer (HrHandoffStatus, which the phone app still asks) from the API's status. The API has no per-school
 * "not linked": a school the platform does not know, or one HR is not on for, is `not_connected`, which reads as `not_enabled`.
 * Switched on and being set up reads as `available` (HR is on; the launch says it is still being prepared), as `connected` and
 * `unknown` do (`unknown`: offered, and the launch says what is wrong).
 */
export function hrHandoffStatusFrom(status: HrStatus): HrHandoffStatus {
  if (!status.enabled || !status.connection) return "off";
  return status.connection === "not_connected" ? "not_enabled" : "available";
}

/**
 * Whether HR is there for the signed-in person's school (open-hr {action: "status"}, or GET .../me/hr/handoff-status on the API
 * build); a 403 is HR_STATUS_HIDDEN. Throws an EdgeError otherwise.
 */
export async function fetchHrStatus(tenantId: string): Promise<HrStatus> {
  try {
    const raw = onApi()
      ? await apiFetchHrHandoffStatus(tenantId)
      : await invokeEdge<unknown>("open-hr", { tenant_id: tenantId, action: "status" }, { timeoutMs: 20_000 });
    return readHrStatus(raw);
  } catch (err) {
    if (err instanceof EdgeError && err.status === 403) return HR_STATUS_HIDDEN;
    throw err;
  }
}

/** The school asks Figbloom for HR (open-hr {action: "request"}): the first request's time. Throws an EdgeError (409 already_connected, ...). */
export async function requestFigbloomHr(tenantId: string): Promise<{ requestedAt: string }> {
  const out = onApi()
    ? await apiRequestHrHandoff(tenantId)
    : await invokeEdge<{ requested_at?: unknown }>("open-hr", { tenant_id: tenantId, action: "request" }, { timeoutMs: 20_000 });
  if (typeof out?.requested_at !== "string") throw new EdgeError("Couldn't send the request. Try again.");
  return { requestedAt: out.requested_at };
}

/** HR opens directly (the launch tab) when it's there, or when it couldn't be checked: the launch tab then shows the precise problem. */
export function hrOpensDirectly(connection: HrConnection | null | undefined): boolean {
  return connection === "connected" || connection === "unknown";
}

/**
 * What the sidebar's "HR & Payroll" item does: null (hidden: not this person, switched off, or the answer isn't in),
 * "launch" (opens the launch tab, external-link mark) or "page" (the HR & Payroll page, where the school can ask for it).
 */
export function hrItemMode(eligible: boolean, status: HrStatus | null | undefined): "launch" | "page" | null {
  if (!eligible || !status?.enabled || !status.connection) return null;
  return hrOpensDirectly(status.connection) ? "launch" : "page";
}

/** The HR & Payroll card's state: requested is not connected with a request on record. */
export type HrCardState = "connected" | "setting_up" | "not_connected" | "requested";

export function hrCardState(status: Pick<HrStatus, "connection" | "requestedAt">): HrCardState {
  if (hrOpensDirectly(status.connection)) return "connected";
  if (status.connection === "setting_up") return "setting_up";
  return status.requestedAt ? "requested" : "not_connected";
}

/** The in-app HR & Payroll page (admin console; the fees area opens it). */
export const HR_PAGE = "admin/hr";
export const hrPagePath = (slug: string) => `/s/${slug}/${HR_PAGE}`;

/** The launch tab (a page of its own, outside the school's console). */
export const HR_LAUNCH_PATH = "/hr/launch";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The launch tab's address for this school: its id (for open-hr) and slug (for the links back). */
export function hrLaunchUrl(tenantId: string, slug: string): string {
  return `${HR_LAUNCH_PATH}?${new URLSearchParams({ school: tenantId, slug }).toString()}`;
}

/** The launch tab's query string read back; null when the school id is missing or malformed. A bad slug is dropped. */
export function readHrLaunchParams(search: string): { tenantId: string; slug: string | null } | null {
  const q = new URLSearchParams(search);
  const tenantId = (q.get("school") ?? "").trim();
  if (!UUID.test(tenantId)) return null;
  const slug = (q.get("slug") ?? "").trim();
  return { tenantId, slug: SLUG.test(slug) ? slug : null };
}

/** Only an https address is ever opened (the one-time HR sign-in link). */
export function isHttpsLink(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** What went wrong in the launch tab, from open-hr's refusal. */
export type HrLaunchProblem = "not_enabled" | "setting_up" | "forbidden" | "session" | "rate_limited" | "unreachable";

export function hrLaunchProblem(err: { status?: number; code?: string } | null | undefined): HrLaunchProblem {
  const code = err?.code;
  if (code === "target_not_enabled" || code === "school_not_linked") return "not_enabled";
  if (code === "target_not_linked" || code === "target_no_handoff_url") return "setting_up";
  if (code === "rate_limited" || err?.status === 429) return "rate_limited";
  if (code === "unauthorized" || err?.status === 401) return "session";
  if (code === "forbidden") return "forbidden";
  // handoff_off, platform_not_configured, platform_unavailable, platform_bad_answer, status_failed, a network error; on the API
  // build also hr_unavailable (503) and hr_bad_answer (502), the platform down or answering badly
  return "unreachable";
}

export const HR_LAUNCH_PROBLEMS: Record<HrLaunchProblem, { title: string; message: string }> = {
  not_enabled: {
    title: "Figbloom HR isn't set up for your school yet",
    message: "Ask Figbloom for HR & Payroll, and we'll get in touch to set it up.",
  },
  setting_up: {
    title: "Figbloom HR is still being set up",
    message: "Figbloom HR is switched on for your school and is being prepared. The school's admins will receive an email invitation once it's ready.",
  },
  forbidden: {
    title: "Only the school's administrators and the bursar can open HR & Payroll",
    message: "Ask your school's administrator if you need access to HR & Payroll.",
  },
  session: {
    title: "Your session has ended",
    message: "Sign in to Figbloom Schools again, then open HR & Payroll.",
  },
  rate_limited: {
    title: "Too many attempts",
    message: "Too many attempts. Wait a minute and try again.",
  },
  unreachable: {
    title: "We couldn't reach Figbloom HR",
    message: "Figbloom HR didn't answer. Check your connection and try again in a minute.",
  },
};

