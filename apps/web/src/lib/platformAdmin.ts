import { supabase, type Organization, type Tenant } from "@figbloom/shared";

/** A super_admin may insert tenants directly — RLS allows it, no edge function needed. */
export interface NewSchoolInput {
  name: string;
  slug: string;
  county: string;
  country: string;
  level: Tenant["level"];
  institution_type: Tenant["institution_type"];
  higher_ed_subtype: Tenant["higher_ed_subtype"];
  delivery_mode: Tenant["delivery_mode"];
  organization_id?: string | null;
  moe_registration: string | null;
  plan: Tenant["plan"];
  accent: string;
  licensed_seats: number;
}

export async function createTenant(input: NewSchoolInput): Promise<Tenant> {
  const { data, error } = await supabase()
    .from("tenants")
    .insert({ ...input, status: "onboarding" })
    .select("*")
    .single<Tenant>();
  if (error) throw error;
  return data;
}

/**
 * Creating a login needs the service-role key, so this calls the invite-admin
 * edge function rather than writing to auth.users directly from the browser.
 */
export interface InviteAdminInput {
  tenant_id: string;
  full_name: string;
  staff_title: string;
  email: string;
  phone?: string;
}

export interface InviteAdminResult {
  ok: true;
  email: string;
  password: string;
}

export async function inviteAdmin(input: InviteAdminInput): Promise<InviteAdminResult> {
  const { data, error } = await supabase().functions.invoke<InviteAdminResult | { error: string }>(
    "invite-admin",
    { body: input },
  );
  if (error) {
    // supabase-js puts a non-2xx function response on error.context (a Response), not `data`.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const body = (await ctx.json()) as { error?: string };
        if (body?.error) throw new Error(body.error);
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
      }
    }
    throw new Error(error.message);
  }
  if (data && "error" in data) throw new Error(data.error);
  return data as InviteAdminResult;
}

// ---------------------------------------------------------------- organizations (FIG-331)

export interface NewOrganizationInput {
  name: string;
  slug: string;
  kind: Organization["kind"];
  county: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

/** Org creation is staff-only, same as tenant creation — RLS (organization_write_super) allows a super_admin to insert directly. */
export async function createOrganization(input: NewOrganizationInput): Promise<Organization> {
  const { data: { user } } = await supabase().auth.getUser();
  const { data, error } = await supabase()
    .from("organizations")
    .insert({ ...input, created_by: user?.id ?? null })
    .select("*")
    .single<Organization>();
  if (error) throw error;
  return data;
}

export async function fetchOrganizations(): Promise<Organization[]> {
  const { data, error } = await supabase().from("organizations").select("*").order("name").returns<Organization[]>();
  if (error) throw error;
  return data ?? [];
}

/** Tenant-to-org assignment is staff-assigned only in v1 — a tenant never picks its own org. */
export async function assignTenantOrganization(tenantId: string, organizationId: string | null): Promise<void> {
  const { error } = await supabase().from("tenants").update({ organization_id: organizationId }).eq("id", tenantId);
  if (error) throw error;
}

export interface OrgAdminInviteInput {
  organization_id: string;
  full_name: string;
  email: string;
}

export interface OrgAdminInviteResult {
  ok: true;
  email: string;
  /** True when this invite linked an existing org_admin account to a new
   *  organization instead of creating a new login — no password to show,
   *  they already have working credentials. */
  linkedExisting: boolean;
  password?: string;
}

export async function inviteOrgAdmin(input: OrgAdminInviteInput): Promise<OrgAdminInviteResult> {
  const { data, error } = await supabase().functions.invoke<OrgAdminInviteResult | { error: string }>(
    "invite-org-admin",
    { body: input },
  );
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const body = (await ctx.json()) as { error?: string };
        if (body?.error) throw new Error(body.error);
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
      }
    }
    throw new Error(error.message);
  }
  if (data && "error" in data) throw new Error(data.error);
  return data as OrgAdminInviteResult;
}

export interface ServiceCheckResult {
  service: string;
  status: "ok" | "degraded" | "down" | "not_configured";
  latency_ms: number | null;
  detail: string | null;
}

/** Triggers a fresh, live check of the services the Health page tracks — see supabase/functions/check-services. */
export async function checkServices(): Promise<ServiceCheckResult[]> {
  const { data, error } = await supabase().functions.invoke<{ results: ServiceCheckResult[] } | { error: string }>(
    "check-services",
  );
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const body = (await ctx.json()) as { error?: string };
        if (body?.error) throw new Error(body.error);
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
      }
    }
    throw new Error(error.message);
  }
  if (data && "error" in data) throw new Error(data.error);
  return (data as { results: ServiceCheckResult[] }).results;
}
