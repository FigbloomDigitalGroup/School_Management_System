import { apiClient } from "./client";
import { API_PAGE_LIMIT, listAllPages } from "./paging";

/**
 * Organisation sign-up on apps/api (slice S6a/S6b, apps/api/docs/ORG-SIGNUP.md).
 *
 * Two public calls (no session, no school): ask for an organisation, and confirm the e-mail address with the link that was sent.
 * Nothing here creates an account: a super administrator approves the request in the platform console, and only then does the
 * first administrator get a link to choose a password. The platform calls are identity calls (`tenantId: null`) and are the
 * ones that need a recent sign-in (the client asks for the password by itself on `reauth_required`).
 */

export type OrgSignupKind = "government" | "county" | "constituency" | "group_owner";
export const ORG_SIGNUP_KINDS: readonly OrgSignupKind[] = ["government", "county", "constituency", "group_owner"];

export type OrgSignupStatus = "pending_email" | "pending_review" | "approved" | "rejected" | "expired";
const STATUSES: readonly OrgSignupStatus[] = ["pending_email", "pending_review", "approved", "rejected", "expired"];

export interface OrgSignupInput {
  name: string;
  kind: OrgSignupKind;
  county?: string;
  contactPhone?: string;
  adminFullName: string;
  adminEmail: string;
}

/**
 * Asks for an organisation. The server answers the same whether or not the address already has a request or an account, so
 * this resolves either way; only a wrong body (400), the person's own limits (429) and "not available" (503: switched off, no
 * e-mail, or today's cap) throw. The confirmation link is e-mailed, never returned.
 */
export async function apiRequestOrgSignup(input: OrgSignupInput): Promise<void> {
  const county = input.county?.trim();
  const phone = input.contactPhone?.trim();
  await apiClient().post("/v1/signup/organizations", {
    body: {
      name: input.name.trim(),
      kind: input.kind,
      ...(county ? { county } : {}),
      ...(phone ? { contact_phone: phone } : {}),
      admin_full_name: input.adminFullName.trim(),
      admin_email: input.adminEmail.trim(),
    },
    auth: false,
    tenantId: null,
  });
}

/** Confirms the address with the token from the link. A link that is unknown, used, replaced or expired is a 400 ApiError. */
export async function apiConfirmOrgSignup(token: string): Promise<void> {
  await apiClient().post("/v1/signup/organizations/verify", { body: { token: token.trim() }, auth: false, tenantId: null });
}

// ---------------------------------------------------------------- the platform's side

export interface PlatformOrgSignup {
  id: string;
  name: string;
  kind: OrgSignupKind;
  county: string | null;
  contactPhone: string | null;
  adminFullName: string;
  adminEmail: string;
  status: OrgSignupStatus;
  createdAt: string;
  verifiedAt: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionReason: string | null;
  organizationId: string | null;
  organizationSlug: string | null;
}

/** The password-setup link of a first administrator: e-mailed, and returned (once) only when the server could not send it. */
export interface OrgSignupSetup {
  expiresAt: string;
  delivery: "sent" | "not_configured";
  token: string | null;
}

interface RawSignup {
  id: string;
  name: string;
  kind: string;
  county: string | null;
  contactPhone: string | null;
  adminFullName: string;
  adminEmail: string;
  status: string;
  createdAt: string;
  verifiedAt: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionReason: string | null;
  organizationId: string | null;
  organizationSlug: string | null;
}

/**
 * The server writes times with microseconds ("2026-11-26T10:00:00.123456Z"). JavaScript's own parser is only sure of three
 * fractional digits (Safari refuses more), so they are cut to milliseconds here and every page can use `new Date(...)`.
 */
export function isoToMillis(iso: string): string {
  return iso.replace(/(\.\d{3})\d+/, "$1");
}

export function orgSignupFromApi(raw: RawSignup): PlatformOrgSignup {
  return {
    id: raw.id,
    name: raw.name,
    kind: (ORG_SIGNUP_KINDS as readonly string[]).includes(raw.kind) ? (raw.kind as OrgSignupKind) : "group_owner",
    county: raw.county,
    contactPhone: raw.contactPhone,
    adminFullName: raw.adminFullName,
    adminEmail: raw.adminEmail,
    status: (STATUSES as readonly string[]).includes(raw.status) ? (raw.status as OrgSignupStatus) : "pending_email",
    createdAt: isoToMillis(raw.createdAt),
    verifiedAt: raw.verifiedAt ? isoToMillis(raw.verifiedAt) : null,
    decidedAt: raw.decidedAt ? isoToMillis(raw.decidedAt) : null,
    decidedByName: raw.decidedByName,
    decisionReason: raw.decisionReason,
    organizationId: raw.organizationId,
    organizationSlug: raw.organizationSlug,
  };
}

function setupFromApi(raw: { expiresAt: string; delivery: "sent" | "not_configured"; token?: string }): OrgSignupSetup {
  return { expiresAt: raw.expiresAt, delivery: raw.delivery, token: raw.delivery === "not_configured" ? (raw.token ?? null) : null };
}

/** Every request, newest first, optionally of one status. Reading the list is audited by the server (a count). */
export async function apiFetchPlatformOrgSignups(status?: OrgSignupStatus): Promise<PlatformOrgSignup[]> {
  const rows = await listAllPages(async (cursor) => {
    const res = await apiClient().get("/v1/platform/org-signups", {
      query: { limit: API_PAGE_LIMIT, ...(cursor ? { cursor } : {}), ...(status ? { status } : {}) },
      tenantId: null,
    });
    return { items: res.items, page: res.page };
  });
  return rows.map(orgSignupFromApi);
}

/**
 * Approves a confirmed request: creates the organisation, its first administrator and a password link (needs a recent sign-in).
 * `slug` is the organisation's address when the reviewer types one; without it the server makes it from the name.
 * An address that already has an account, or an address that is taken, is a 409 with a message written for people.
 */
export async function apiApprovePlatformOrgSignup(
  id: string,
  slug?: string,
): Promise<{ signup: PlatformOrgSignup; organization: { id: string; slug: string }; setup: OrgSignupSetup }> {
  const res = await apiClient().post("/v1/platform/org-signups/{signupId}/approve", {
    path: { signupId: id },
    body: slug?.trim() ? { slug: slug.trim() } : {},
    tenantId: null,
  });
  return { signup: orgSignupFromApi(res.signup), organization: res.organization, setup: setupFromApi(res.setup) };
}

/** Rejects a request that has not been decided. The reason stays with the platform; `notified` says whether a notice went out. */
export async function apiRejectPlatformOrgSignup(id: string, reason?: string): Promise<{ signup: PlatformOrgSignup; notified: boolean }> {
  const res = await apiClient().post("/v1/platform/org-signups/{signupId}/reject", {
    path: { signupId: id },
    body: reason?.trim() ? { reason: reason.trim() } : {},
    tenantId: null,
  });
  return { signup: orgSignupFromApi(res.signup), notified: res.notified };
}

/** A new password link for an approved organisation's administrator who has not chosen a password yet (409 once they have). */
export async function apiReissuePlatformOrgSetup(id: string): Promise<OrgSignupSetup> {
  const res = await apiClient().post("/v1/platform/org-signups/{signupId}/reissue-setup", { path: { signupId: id }, tenantId: null });
  return setupFromApi(res.setup);
}

/** True while a request is waiting for a reviewer (its address is confirmed and nobody has decided). */
export function orgSignupAwaitsReview(s: Pick<PlatformOrgSignup, "status">): boolean {
  return s.status === "pending_review";
}

/** How a status reads on the page. */
export const ORG_SIGNUP_STATUS_LABEL: Record<OrgSignupStatus, string> = {
  pending_email: "Waiting for the e-mail to be confirmed",
  pending_review: "Waiting for review",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Link expired",
};
