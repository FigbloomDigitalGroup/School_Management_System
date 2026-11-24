import type { Organization, OrganizationAccessLog, OrganizationTenantSummary, Profile, TenantStatus } from "../types";
import { apiMe } from "./authApi";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { isRole, profileFromApi, roleOutsideSchools, viewOfMe, type MeView } from "./sessionApi";

/**
 * The organisation console on apps/api (S11, apps/api/docs/ORG-CONSOLE.md). An org admin may read, for organisations
 * they administer: the organisations themselves, the schools in them (name, address, status), the other org admins and
 * their OWN audit events. Inside one school they hold only what was delegated to them, and they may give or take away a
 * co-admin's access there (FIG-1609). Every call is an identity call (no school), except the three school-access calls,
 * which name the school.
 *
 * What the API does not give an org admin (per-school learner, attendance and fee figures; the school's kind; the school's
 * own admins) is not filled in with made-up values: `orgCapabilities()` hides it on the screens. The numeric fields of an
 * OrganizationTenantSummary are 0 on this backend and are never shown.
 */

const EPOCH = "1970-01-01T00:00:00.000Z";
const KINDS: readonly Organization["kind"][] = ["government", "county", "constituency", "group_owner"];
const ORG_STATUSES: readonly Organization["status"][] = ["pending", "active", "suspended", "rejected"];
const TENANT_STATUSES: readonly TenantStatus[] = ["active", "trial", "onboarding", "overdue", "suspended", "setup_stalled"];

// ---------------------------------------------------------------- pure mapping (tested without a server)

export interface ApiOrganization {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
}

export function organizationFromApi(o: ApiOrganization): Organization {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    kind: (KINDS as readonly string[]).includes(o.kind) ? (o.kind as Organization["kind"]) : "group_owner",
    county: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    // An unknown status is treated as not active: it gives no access.
    status: (ORG_STATUSES as readonly string[]).includes(o.status) ? (o.status as Organization["status"]) : "pending",
    created_at: EPOCH,
    created_by: null,
  };
}

export interface ApiOrgSchool {
  id: string;
  name: string;
  slug: string;
  status: string;
  organizationId: string;
}

/** A school of the organisation, with only what the API says: name, address and status. The figures stay 0 and hidden. */
export function orgSchoolFromApi(s: ApiOrgSchool): OrganizationTenantSummary {
  return {
    tenant_id: s.id,
    organization_id: s.organizationId,
    name: s.name,
    slug: s.slug,
    institution_type: "k12",
    higher_ed_subtype: null,
    delivery_mode: "in_person",
    // An unknown status counts as needing attention, never as active.
    status: (TENANT_STATUSES as readonly string[]).includes(s.status) ? (s.status as TenantStatus) : "setup_stalled",
    active_students: 0,
    present_today: 0,
    present_today_pm: 0,
    fees_billed_cents: 0,
    fees_collected_cents: 0,
    updated_at: EPOCH,
  };
}

export interface OrgAdminView {
  id: string;
  full_name: string;
  email: string | null;
  status: string;
  since: string;
  is_you: boolean;
}

export interface ApiOrgAuditEvent {
  id: string;
  occurredAt: string;
  eventType: string;
  schoolId: string | null;
  schoolName: string | null;
}

/** One of the caller's own audit events, in the shape the Audit log page lists (`action` is the event type). */
export function auditEntryFromApi(e: ApiOrgAuditEvent, organizationId: string, userId: string): OrganizationAccessLog {
  return {
    id: e.id,
    organization_id: organizationId,
    profile_id: userId,
    tenant_id: e.schoolId,
    school_name: e.schoolName,
    action: e.eventType,
    accessed_at: e.occurredAt,
  };
}

// ---------------------------------------------------------------- reading from the server

/** Every organisation the signed-in person administers, any status (GET /v1/org/organizations). */
export async function apiFetchMyOrganizations(): Promise<Organization[]> {
  const rows = await listAllPages(async (cursor) => {
    const res = await apiClient().get("/v1/org/organizations", { query: { limit: API_PAGE_LIMIT, cursor }, tenantId: null });
    return { items: res.items, page: res.page };
  });
  return rows.map(organizationFromApi);
}

/** Every school in the signed-in person's active organisations (GET /v1/org/schools), or in one of them. */
export async function apiFetchOrgSchools(organizationId?: string): Promise<OrganizationTenantSummary[]> {
  const rows = await listAllPages(async (cursor) => {
    const res = await apiClient().get("/v1/org/schools", { query: { limit: API_PAGE_LIMIT, cursor }, tenantId: null });
    return { items: res.items, page: res.page };
  });
  return rows.filter((s) => !organizationId || s.organizationId === organizationId).map(orgSchoolFromApi);
}

/** The admins of one organisation the signed-in person administers. */
export async function apiFetchOrgAdmins(organizationId: string): Promise<OrgAdminView[]> {
  const rows = await listAllPages(async (cursor) => {
    const res = await apiClient().get("/v1/org/organizations/{organizationId}/admins", {
      path: { organizationId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId: null,
    });
    return { items: res.items, page: res.page };
  });
  return rows.map((a) => ({ id: a.userId, full_name: a.fullName, email: a.email ?? null, status: a.status, since: a.since, is_you: a.isYou }));
}

/** The signed-in person's own audit events about one organisation, newest first: the latest 200, as the page shows. */
export async function apiFetchMyOrgAuditLog(organizationId: string): Promise<OrganizationAccessLog[]> {
  const userId = apiClient().session()?.userId ?? "";
  const res = await apiClient().get("/v1/org/organizations/{organizationId}/audit-events", {
    path: { organizationId }, query: { limit: API_PAGE_LIMIT }, tenantId: null,
  });
  return res.items.map((e) => auditEntryFromApi(e, organizationId, userId));
}

// ---------------------------------------------------------------- the console's session

async function meOrNull(): Promise<MeView | null> {
  if (!apiClient().session()) return null;
  try {
    return viewOfMe(await apiMe());
  } catch (err) {
    if (isApiError(err) && err.code === "unauthorized") return null;
    throw err;
  }
}

/** The signed-in person as the org console sees them: an org_admin, or (for the console to send away) their school role. */
function orgProfile(me: MeView): Profile | null {
  const outside = roleOutsideSchools(me);
  if (outside) return profileFromApi(me, null, outside);
  const first = me.memberships[0];
  return first && isRole(first.role) ? profileFromApi(me, first, first.role) : null;
}

/**
 * Who is signed in and the organisation at `orgSlug` (the API side of session.ts `loadOrgSession`). Null when nobody is
 * signed in. The organisation is found among the person's own; any other address, or a person who is not an org admin,
 * gets a null organisation, which the console treats as "not yours".
 */
export async function apiLoadOrgSession(orgSlug: string | null): Promise<{ profile: Profile | null; organization: Organization | null } | null> {
  const me = await meOrNull();
  if (!me) return null;
  const profile = orgProfile(me);
  if (profile?.role !== "org_admin" || !orgSlug) return { profile, organization: null };
  const orgs = await apiFetchMyOrganizations();
  return { profile, organization: orgs.find((o) => o.slug === orgSlug) ?? null };
}

/** The workspace picker's data (the API side of session.ts `loadMyWorkspaces`). Null for anyone who is not an org admin. */
export async function apiLoadMyWorkspaces(): Promise<{ name: string; orgs: Organization[]; schools: OrganizationTenantSummary[] } | null> {
  const me = await meOrNull();
  if (!me || roleOutsideSchools(me) !== "org_admin") return null;
  const [orgs, schools] = await Promise.all([apiFetchMyOrganizations(), apiFetchOrgSchools()]);
  return { name: me.user.full_name, orgs, schools };
}

/** Where an org admin goes after signing in: their organisation's dashboard, the picker when they run several, else nowhere. */
export function orgHomePath(orgs: readonly Organization[]): string | null {
  if (orgs.length === 0) return null;
  if (orgs.length === 1) return `/org/${encodeURIComponent(orgs[0]!.slug)}/dashboard`;
  return "/org-picker";
}

// ---------------------------------------------------------------- school access (delegations, FIG-1609)

/**
 * The school-level permissions an org admin may be given (the API's allowlist, `DELEGABLE_PERMISSIONS`); their names come
 * from `describeDelegatedCode`. `rbac.school_roles.manage` is left out: it is on the allowlist but no API route uses it
 * yet, so it would give nothing. `area.people` is not delegable (owner decision, 2026-11-17).
 */
export const SCHOOL_ACCESS_CODES: readonly string[] = [
  "tenant.read", "resource.learner.read", "rbac.staff_areas.manage",
  "area.fees", "area.academics", "area.attendance", "area.transport", "area.communication", "area.inventory",
  "area.activities", "area.visitors", "area.medical", "area.leave", "area.audit",
];

/** What the signed-in org admin was given in this school (`delegatedPermissions` of GET /v1/rbac/permissions there). */
export async function apiFetchMySchoolAccess(tenantId: string): Promise<string[]> {
  const res = await apiClient().get("/v1/rbac/permissions", { query: { limit: 1 }, tenantId });
  return [...new Set(res.delegatedPermissions ?? [])].sort();
}

/** Gives a co-admin of the same organisation these permissions in this school. Needs the password confirmed recently. */
export async function apiGrantSchoolAccess(tenantId: string, delegateUserId: string, permissionCodes: string[]): Promise<string[]> {
  const res = await apiClient().post("/v1/rbac/org-delegations", { body: { delegateUserId, permissionCodes }, tenantId });
  return res.granted ?? [];
}

/** Takes away everything a co-admin was given in this school. Needs the password confirmed recently. Says how many went. */
export async function apiRemoveSchoolAccess(tenantId: string, delegateUserId: string): Promise<number> {
  const res = await apiClient().delete("/v1/rbac/org-delegations", { body: { delegateUserId }, tenantId });
  return Array.isArray(res.revoked) ? res.revoked.length : 0;
}
