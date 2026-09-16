import { supabase } from "./supabase";
import type { Organization, OrganizationAccessLog, OrganizationTenantSummary } from "./types";

/**
 * Data access for the org-admin read-only aggregation layer (FIG-332). The
 * org-admin console (FIG-333) is the only consumer of these — an org_admin
 * has zero RLS access to students/marks/attendance/fee_invoices/payments
 * directly, only to organization_tenant_summary (trigger-maintained, never
 * a live view — see that migration's header).
 */

/**
 * Every organization a profile administers — a profile can belong to more
 * than one (organization_admins only unique-constrains profile+org, not
 * profile alone), the way SignIn.tsx's workspace picker needs when there's
 * more than one to choose from.
 */
export async function fetchMyOrganizations(profileId: string): Promise<Organization[]> {
  const { data, error } = await supabase()
    .from("organization_admins").select("organizations(*)").eq("profile_id", profileId)
    .returns<{ organizations: Organization | null }[]>();
  if (error) throw error;
  return (data ?? []).map((r) => r.organizations).filter((o): o is Organization => o !== null);
}

export interface OrgAdminSummary {
  id: string;
  full_name: string;
  email: string | null;
}

/**
 * Every admin of one organization, including the caller's own co-admins —
 * needs the organization_admins_read_own RLS policy to grant "any org I
 * administer", not just "my own row" (FIG-390's migration), otherwise this
 * silently returns only the caller themselves.
 */
export async function fetchOrgAdminsForOwnOrg(organizationId: string): Promise<OrgAdminSummary[]> {
  // organization_admins has two FKs into profiles (profile_id, added_by), so
  // the embed is ambiguous without a hint — PostgREST rejects it (PGRST201)
  // rather than guessing.
  const { data, error } = await supabase()
    .from("organization_admins").select("profiles!organization_admins_profile_id_fkey(id, full_name, email)").eq("organization_id", organizationId)
    .returns<{ profiles: OrgAdminSummary | null }[]>();
  if (error) throw error;
  return (data ?? []).map((r) => r.profiles).filter((p): p is OrgAdminSummary => p !== null);
}

export async function fetchOrganizationTenantSummaries(organizationId: string): Promise<OrganizationTenantSummary[]> {
  const { data, error } = await supabase()
    .from("organization_tenant_summary").select("*").eq("organization_id", organizationId)
    .order("name").returns<OrganizationTenantSummary[]>();
  if (error) throw error;
  return data ?? [];
}

/**
 * Every school across every organization a profile administers, combined —
 * same organization_tenant_summary table as fetchOrganizationTenantSummaries,
 * just without the organization_id filter. RLS's my_organization_tenant_ids()
 * already unions across every org membership, so this is otherwise identical.
 */
export async function fetchAllMyOrganizationTenantSummaries(): Promise<OrganizationTenantSummary[]> {
  const { data, error } = await supabase()
    .from("organization_tenant_summary").select("*")
    .order("name").returns<OrganizationTenantSummary[]>();
  if (error) throw error;
  return data ?? [];
}

/** Every /org/* page view logs itself — the same trust-but-verify pattern impersonation_sessions already gives Figbloom staff, extended to an owning organization. */
export async function logOrganizationAccess(organizationId: string, profileId: string, action: string, tenantId: string | null = null): Promise<void> {
  const { error } = await supabase().from("organization_access_log").insert({
    organization_id: organizationId, profile_id: profileId, tenant_id: tenantId, action,
  });
  if (error) throw error;
}

/** An org-admin's own view of their access history. */
export async function fetchOrganizationAccessLog(organizationId: string): Promise<OrganizationAccessLog[]> {
  const { data, error } = await supabase()
    .from("organization_access_log").select("*").eq("organization_id", organizationId)
    .order("accessed_at", { ascending: false }).limit(200).returns<OrganizationAccessLog[]>();
  if (error) throw error;
  return data ?? [];
}

/** A school's own view of who from its owning organization looked at it — the same idea as the platform's impersonation log, one layer up. */
export async function fetchTenantOrgAccessLog(tenantId: string): Promise<OrganizationAccessLog[]> {
  const { data, error } = await supabase()
    .from("organization_access_log").select("*").eq("tenant_id", tenantId)
    .order("accessed_at", { ascending: false }).limit(200).returns<OrganizationAccessLog[]>();
  if (error) throw error;
  return data ?? [];
}
