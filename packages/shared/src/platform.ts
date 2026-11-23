import type { FunctionInvokeOptions } from "@supabase/supabase-js";
import type { EmailOutcome } from "./passwordReset";
import { currentUserId } from "./session";
import { supabase } from "./supabase";
import { effectivePriceCents } from "./tenancy";
import type { IncidentSeverity, Organization, PlatformIncident, PlatformInvoice, Tenant } from "./types";

/**
 * The platform console and everything that creates or administers schools and organizations (FIG-1898): Figbloom staff's
 * tenant, organization, usage, incident, invoice, impersonation and audit pages, an organization's own self-service,
 * the public organization sign-up, the web-address checks, and the accounts a school's administrators hand out.
 *
 * The screens used to query the database and call the edge functions themselves; they call these instead, so moving
 * the apps to the new API (FIG-1882 is the platform console's turn) changes this module and not the screens.
 *
 * Nothing here changes what the apps do. Each function is the call a screen made before, with the same filters, the
 * same order and the same errors: a call that threw the database's own error still does, and one that threw
 * `new Error(message)` still does.
 */

/**
 * Calls an edge function. supabase-js hides a refusal's own sentence behind a generic "non-2xx" message and puts the
 * response on `error.context`, so this reads `{ error: "..." }` from it and throws that as a plain Error. (invokeEdge
 * in edge.ts does the same job with a timeout and an EdgeError; these calls never had either, and keep not having them.)
 */
async function callFunction<T>(name: string, body?: NonNullable<FunctionInvokeOptions["body"]>): Promise<T> {
  const { data, error } = await (body === undefined
    ? supabase().functions.invoke<T | { error: string }>(name)
    : supabase().functions.invoke<T | { error: string }>(name, { body }));
  if (error) {
    // supabase-js puts a non-2xx function response on error.context (a Response), not `data`.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const answer = (await ctx.json()) as { error?: string };
        if (answer?.error) throw new Error(answer.error);
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
      }
    }
    throw new Error(error.message);
  }
  if (data && "error" in (data as object)) throw new Error((data as { error: string }).error);
  return data as T;
}

// ---------------------------------------------------------------- schools

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

/**
 * Schools created now start 'active' (createTenant/createTenantSelfService
 * both set it), but older ones may still be 'onboarding', and
 * search-schools/resolve-login-id both refuse to sign anyone into a
 * non-'active' school -- so those stay closed until a super_admin (or the
 * owning organization's admin, org_activate_school) activates them.
 */
export async function activateTenant(tenantId: string): Promise<void> {
  const { error } = await supabase().from("tenants").update({ status: "active" }).eq("id", tenantId);
  if (error) throw error;
}

export async function createTenant(input: NewSchoolInput): Promise<Tenant> {
  const { data, error } = await supabase()
    .from("tenants")
    // live straight away, the same as a school an organization adds itself
    .insert({ ...input, status: "active" })
    .select("*")
    .single<Tenant>();
  if (error) throw error;
  return data;
}

/**
 * The org_admin half of "self-service add a school" (FIG-374). Deliberately
 * NOT a reuse of createTenant() as-is: that function does
 * `.insert(...).select("*").single()`, and an org_admin has no direct SELECT
 * access to `tenants` at all (by FIG-332's original design — org_admin only
 * ever reads organization_tenant_summary, never a raw tenant row). Confirmed
 * live while verifying FIG-369's RLS policy: the INSERT itself succeeds, but
 * PostgREST's RETURNING clause is denied by the missing SELECT policy, which
 * surfaces as the exact same RLS-violation error as a rejected insert would.
 *
 * The fix is to never ask for the row back: generate the id client-side (the
 * caller already knows every field they're inserting) and reconstruct the
 * Tenant shape locally instead of reading it from the database.
 *
 * A school an organization adds is 'active' straight away, so its people can
 * find it and sign in the moment it exists: the organization's own admin
 * already administers it (may_administer), and there's no Figbloom review
 * step for now. The insert policy (tenant_write_org_admin) only checks the
 * organization, never the school's status.
 */
export async function createTenantSelfService(input: NewSchoolInput): Promise<Tenant> {
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const row: Tenant = {
    id,
    created_at,
    status: "active",
    logo_url: null,
    payment_paybill: null,
    payment_till: null,
    payment_bank_details: null,
    payment_notes: null,
    price_cents_override: null,
    trial_ends_at: null,
    renews_on: null,
    role_labels: {},
    ...input,
    organization_id: input.organization_id ?? null,
  };

  const { error } = await supabase().from("tenants").insert(row);
  if (error) throw error;
  return row;
}

/**
 * Opens one of this organization's schools for sign-in. Only for schools
 * still 'onboarding' (added before org-created schools went live straight
 * away); a school Figbloom has suspended stays suspended. See
 * org_activate_school in 20261025040000_open_signup_and_password_resets.sql.
 */
export async function activateOrgSchool(tenantId: string): Promise<void> {
  const { error } = await supabase().rpc("org_activate_school", { p_tenant_id: tenantId });
  if (error) throw error;
}

/**
 * Saves the crest the onboarding wizard just uploaded on the school's row. A failure is not an error here: the school
 * exists either way and the wizard carries on without the crest, so this answers null instead of throwing.
 */
export async function saveNewSchoolLogo(tenantId: string, logoUrl: string): Promise<Tenant | null> {
  const { data, error } = await supabase()
    .from("tenants").update({ logo_url: logoUrl }).eq("id", tenantId).select("*").single<Tenant>();
  return !error && data ? data : null;
}

/** A school's address (its slug) from its id, for an organization's admin opening that school's console. */
export async function fetchTenantSlug(tenantId: string): Promise<string> {
  const { data, error } = await supabase().from("tenants").select("slug").eq("id", tenantId).maybeSingle();
  if (error || !data) throw error ?? new Error("This school's address could not be found.");
  return (data as { slug: string }).slug;
}

// ---------------------------------------------------------------- accounts a school's administrators hand out

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
  /** Whether the sign-in details were emailed to them as well. */
  emailed?: EmailOutcome;
}

export async function inviteAdmin(input: InviteAdminInput): Promise<InviteAdminResult> {
  return callFunction<InviteAdminResult>("invite-admin", input);
}

/**
 * Adds a teacher, driver or other staff member at a school (FIG-398/400) — the invite-admin
 * edge function's other branch: no email, an auto-assigned login_id
 * instead (e.g. "TC-0001"). Kept as its own function/types rather than
 * folded into inviteAdmin()/InviteAdminResult above, since those two stay
 * untouched for the school_admin-onboarding callers that already depend on
 * their email-based shape.
 */
export interface InviteStaffInput {
  tenant_id: string;
  full_name: string;
  role: "teacher" | "driver" | "staff";
  staff_title?: string;
  phone?: string;
  /** Optional: their sign-in details are emailed here (they still sign in with the login ID). */
  email?: string;
}

export interface InviteStaffResult {
  ok: true;
  login_id: string;
  password: string;
  emailed?: EmailOutcome;
}

export async function inviteStaff(input: InviteStaffInput): Promise<InviteStaffResult> {
  return callFunction<InviteStaffResult>("invite-admin", input);
}

export interface ProvisionGuardianInput {
  tenant_id: string;
  full_name: string;
  students: { student_id: string; relationship?: "mother" | "father" | "guardian"; is_primary_payer?: boolean }[];
  phone?: string;
  email?: string;
}

export interface ProvisionGuardianResult {
  ok: true;
  login_id: string;
  password: string;
  emailed?: EmailOutcome;
}

export async function provisionGuardian(input: ProvisionGuardianInput): Promise<ProvisionGuardianResult> {
  return callFunction<ProvisionGuardianResult>("provision-guardian", input);
}

export interface ProvisionStudentInput {
  tenant_id: string;
  student_id: string;
}

export interface ProvisionStudentResult {
  ok: true;
  login_id: string;
  password: string;
}

/**
 * Creates a sign-in for an already-admitted learner (FIG-402) — "Add a
 * learner" only ever creates the `students` record; this is the separate
 * action that actually gives them a login_id + password, mirroring
 * inviteStaff/provisionGuardian above.
 */
export async function provisionStudent(input: ProvisionStudentInput): Promise<ProvisionStudentResult> {
  return callFunction<ProvisionStudentResult>("provision-student", input);
}

export interface DeleteAccountInput {
  tenant_id: string;
  profile_id: string;
}

export interface DeleteAccountResult {
  ok: true;
  warning?: string;
}

/**
 * Removes a staff account (teacher/driver/school_admin) — a plain
 * `.from("profiles").delete()` from the browser can't also remove the
 * matching `auth.users` login, so this needs the service-role edge
 * function, same reasoning as provisionStudent/inviteStaff above.
 */
export async function deleteAccount(input: DeleteAccountInput): Promise<DeleteAccountResult> {
  return callFunction<DeleteAccountResult>("delete-account", input);
}

export interface SchoolAdmin {
  id: string;
  full_name: string;
  email: string | null;
  staff_title: string | null;
}

/**
 * A school's administrators (role school_admin). Figbloom staff read every
 * profile and an organization's admins read their schools' (profile_admin_manage,
 * which also lets the school's own admin read them; this list is shown to the first two).
 */
export async function fetchSchoolAdmins(tenantId: string): Promise<SchoolAdmin[]> {
  const { data, error } = await supabase()
    .from("profiles")
    .select("id, full_name, email, staff_title")
    .eq("tenant_id", tenantId)
    .eq("role", "school_admin")
    .order("full_name")
    .returns<SchoolAdmin[]>();
  if (error) throw error;
  return data ?? [];
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
  const userId = await currentUserId();
  const { data, error } = await supabase()
    .from("organizations")
    .insert({ ...input, created_by: userId })
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

/**
 * Tenant-to-org assignment is staff-assigned only in v1 — a tenant never picks its own org.
 * Every school belongs to an organisation (20261104920000): to take one out of a group,
 * give it its own (giveSchoolOwnOrganization), never none.
 */
export async function assignTenantOrganization(tenantId: string, organizationId: string): Promise<void> {
  const { error } = await supabase().from("tenants").update({ organization_id: organizationId }).eq("id", tenantId);
  if (error) throw error;
}

/** Moves a school into a new organisation of its own, named after it (Figbloom staff only). Returns its id. */
export async function giveSchoolOwnOrganization(tenantId: string): Promise<string> {
  const { data, error } = await supabase().rpc("give_school_own_organization", { p_tenant_id: tenantId });
  if (error) throw error;
  return data as string;
}

/** One-click approve (FIG-375): a self-registered organization sits 'pending' until staff do this. */
export async function approveOrganization(organizationId: string): Promise<void> {
  const { error } = await supabase().from("organizations").update({ status: "active" }).eq("id", organizationId);
  if (error) throw error;
}

/** The schools in one organization, by name. */
export async function fetchOrganizationMemberSchools(organizationId: string): Promise<Tenant[]> {
  const { data, error } = await supabase().from("tenants").select("*").eq("organization_id", organizationId).order("name").returns<Tenant[]>();
  if (error) throw error;
  return data ?? [];
}

export interface OrganizationAdminProfile { id: string; full_name: string; email: string | null }

/** The people who administer one organization. */
export async function fetchOrganizationAdminProfiles(organizationId: string): Promise<OrganizationAdminProfile[]> {
  // organization_admins has two FKs into profiles (profile_id, added_by), so
  // the embed is ambiguous without a hint — PostgREST rejects it (PGRST201)
  // rather than guessing, and that rejection was previously going unnoticed
  // (useAsync's caught error left the list silently empty, read as "no admins
  // invited yet" instead of "the query failed").
  const { data, error } = await supabase()
    .from("organization_admins").select("profiles!organization_admins_profile_id_fkey(id, full_name, email)").eq("organization_id", organizationId)
    .returns<{ profiles: OrganizationAdminProfile | null }[]>();
  if (error) throw error;
  return (data ?? []).map((r) => r.profiles).filter((p): p is OrganizationAdminProfile => p !== null);
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
  emailed?: EmailOutcome;
}

export async function inviteOrgAdmin(input: OrgAdminInviteInput): Promise<OrgAdminInviteResult> {
  return callFunction<OrgAdminInviteResult>("invite-org-admin", input);
}

export interface NewMyOrganizationInput {
  name: string;
  slug: string;
  kind: Organization["kind"];
  county?: string;
  contact_email?: string;
  contact_phone?: string;
}

export interface NewMyOrganizationResult {
  ok: true;
  slug: string;
}

/**
 * The in-app "+ Create new organization" action (FIG-394) — an already
 * signed-in org_admin spinning up an ADDITIONAL workspace for themselves.
 * Unlike createOrganization() above (staff-only, direct RLS insert), org_admin
 * has no insert policy on organizations at all, so this goes through the
 * create-organization edge function the same way invite-org-admin does —
 * it links the caller's own existing profile rather than making a new one,
 * and the new organization starts 'pending', same approval gate as any
 * other self-registered org.
 */
export async function createMyOrganization(input: NewMyOrganizationInput): Promise<NewMyOrganizationResult> {
  return callFunction<NewMyOrganizationResult>("create-organization", input);
}

// ---------------------------------------------------------------- signing up an organization, and checking web addresses

/**
 * The one edge function callable with no signed-in session at all (FIG-370)
 * — supabase-js's functions.invoke() falls back to the anon key when there's
 * no active session, which is exactly right here: the person calling this
 * has no account yet.
 */
export interface SignupOrganizationInput {
  name: string;
  slug: string;
  kind: "government" | "county" | "constituency" | "group_owner";
  county?: string;
  contact_email?: string;
  contact_phone?: string;
  admin_full_name: string;
  admin_email: string;
  admin_password: string;
}

/** The same whether or not the address already had an account (FIG-1337): the next step is the email. */
export interface SignupOrganizationResult {
  ok: true;
  confirm_email: true;
}

export async function signupOrganization(input: SignupOrganizationInput): Promise<SignupOrganizationResult> {
  return callFunction<SignupOrganizationResult>("signup-organization", input);
}

export type SlugKind = "school" | "organization";

/**
 * Which of these addresses are already in use. Goes through the
 * tenant_slugs_taken / organization_slugs_taken functions because most people
 * filling in these forms can't read the tables themselves.
 */
export async function fetchTakenSlugs(kind: SlugKind, slugs: string[]): Promise<Set<string>> {
  const fn = kind === "school" ? "tenant_slugs_taken" : "organization_slugs_taken";
  const { data, error } = await supabase().rpc(fn, { p_slugs: slugs });
  if (error) throw error;
  return new Set((data ?? []) as string[]);
}

// ---------------------------------------------------------------- the console's schools and their figures

/** Every school, by name (Figbloom staff read them all). */
export async function fetchAllTenants(): Promise<Tenant[]> {
  const { data, error } = await supabase().from("tenants").select("*").order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Tenant[];
}

export interface PlatformTenantSummary {
  listPrice: Map<string, number>;
  activeStudents: number;
}

/** MRR needs the plan price list; learner seats need the real roster — neither
 *  lives on the tenant row itself, so this is its own fetch alongside it. */
export async function fetchPlatformTenantSummary(): Promise<PlatformTenantSummary> {
  const sb = supabase();
  const [{ data: pricing, error: e1 }, { count: activeStudents, error: e2 }] = await Promise.all([
    sb.from("plan_pricing").select("plan,price_cents").returns<{ plan: string; price_cents: number }[]>(),
    sb.from("students").select("id", { count: "exact", head: true }).eq("active", true),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  return {
    listPrice: new Map((pricing ?? []).map((p) => [p.plan, p.price_cents])),
    activeStudents: activeStudents ?? 0,
  };
}

export interface PlatformTenantOverview {
  learners: number;
  staff: number;
  parents: number;
  outstandingCents: number;
  nextDueOn: string | null;
}

/** One school's headcounts and what it owes Figbloom. A failed count reads as 0, as it always did. */
export async function fetchPlatformTenantOverview(tenantId: string): Promise<PlatformTenantOverview> {
  const sb = supabase();
  const [{ count: learners }, { count: staff }, { count: parents }, { data: due }] = await Promise.all([
    sb.from("students").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("active", true),
    sb.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).in("role", ["school_admin", "teacher"]),
    sb.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("role", "parent"),
    sb.from("platform_invoices").select("amount_cents,due_date").eq("tenant_id", tenantId).eq("status", "due").order("due_date"),
  ]);
  const rows = (due ?? []) as { amount_cents: number; due_date: string }[];
  return {
    learners: learners ?? 0,
    staff: staff ?? 0,
    parents: parents ?? 0,
    outstandingCents: rows.reduce((a, i) => a + i.amount_cents, 0),
    nextDueOn: rows[0]?.due_date ?? null,
  };
}

export interface PlatformNavCounts { tenants: number; openIncidents: number; dueInvoices: number }

/** The console's sidebar figures. A failed count reads as 0 (so no badge), as it always did. */
export async function fetchPlatformNavCounts(): Promise<PlatformNavCounts> {
  const sb = supabase();
  const [{ count: tenantCount }, { count: openIncidents }, { count: dueInvoices }] = await Promise.all([
    sb.from("tenants").select("id", { count: "exact", head: true }),
    sb.from("platform_incidents").select("id", { count: "exact", head: true }).neq("status", "resolved"),
    sb.from("platform_invoices").select("id", { count: "exact", head: true }).eq("status", "due"),
  ]);
  return { tenants: tenantCount ?? 0, openIncidents: openIncidents ?? 0, dueInvoices: dueInvoices ?? 0 };
}

// ---------------------------------------------------------------- system health

export interface ServiceCheckResult {
  service: string;
  status: "ok" | "degraded" | "down" | "not_configured";
  latency_ms: number | null;
  detail: string | null;
}

/** Triggers a fresh, live check of the services the Health page tracks — see supabase/functions/check-services. */
export async function checkServices(): Promise<ServiceCheckResult[]> {
  return (await callFunction<{ results: ServiceCheckResult[] }>("check-services")).results;
}

export interface ServiceStatusRow {
  id: string;
  service: string;
  status: "ok" | "degraded" | "down" | "not_configured";
  latency_ms: number | null;
  detail: string | null;
  checked_at: string;
}

/** The last 200 checks, newest first. */
export async function fetchServiceHistory(): Promise<ServiceStatusRow[]> {
  const { data, error } = await supabase()
    .from("service_status")
    .select("*")
    .order("checked_at", { ascending: false })
    .limit(200)
    .returns<ServiceStatusRow[]>();
  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------- usage and capacity

export interface PlatformUsageRow {
  tenant: Pick<Tenant, "id" | "name" | "slug" | "licensed_seats" | "status">;
  /** Learners plus staff. */
  inUse: number;
}

export async function fetchPlatformUsage(): Promise<PlatformUsageRow[]> {
  const sb = supabase();
  const [{ data: tenants, error: e1 }, { data: counts, error: e2 }] = await Promise.all([
    sb.from("tenants").select("id,name,slug,licensed_seats,status").order("name").returns<PlatformUsageRow["tenant"][]>(),
    // Counted in the database: the API answers at most 1,000 rows and says nothing when it stops (FIG-1450).
    sb.rpc("platform_usage_counts"),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const inUseByTenant = new Map<string, number>();
  for (const c of (counts ?? []) as { tenant_id: string; learners: number; staff: number }[]) inUseByTenant.set(c.tenant_id, c.learners + c.staff);

  return (tenants ?? []).map((tenant) => ({ tenant, inUse: inUseByTenant.get(tenant.id) ?? 0 }));
}

// ---------------------------------------------------------------- incidents

/** Newest first. */
export async function fetchPlatformIncidents(): Promise<PlatformIncident[]> {
  const { data, error } = await supabase()
    .from("platform_incidents")
    .select("*")
    .order("opened_at", { ascending: false })
    .returns<PlatformIncident[]>();
  if (error) throw error;
  return data ?? [];
}

export async function resolvePlatformIncident(id: string): Promise<void> {
  const { error } = await supabase()
    .from("platform_incidents").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export interface NewPlatformIncident {
  severity: IncidentSeverity;
  title: string;
  summary: string;
  affected_schools: number;
}

export async function declarePlatformIncident(input: NewPlatformIncident): Promise<void> {
  const { error } = await supabase().from("platform_incidents").insert({
    severity: input.severity, title: input.title, summary: input.summary,
    affected_schools: input.affected_schools,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------- subscriptions

export interface PlatformSubscriptionRow {
  tenant: Pick<Tenant, "id" | "name" | "slug" | "plan" | "status" | "price_cents_override" | "trial_ends_at" | "renews_on">;
  priceCents: number;
}

export async function fetchPlatformSubscriptions(): Promise<PlatformSubscriptionRow[]> {
  const sb = supabase();
  const [{ data: tenants, error: e1 }, { data: pricing, error: e2 }] = await Promise.all([
    sb.from("tenants")
      .select("id,name,slug,plan,status,price_cents_override,trial_ends_at,renews_on")
      .order("name")
      .returns<PlatformSubscriptionRow["tenant"][]>(),
    sb.from("plan_pricing").select("plan,price_cents").returns<{ plan: string; price_cents: number }[]>(),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const listPrice = new Map((pricing ?? []).map((p) => [p.plan, p.price_cents]));
  return (tenants ?? []).map((tenant) => ({
    tenant,
    priceCents: effectivePriceCents(tenant, listPrice),
  }));
}

// ---------------------------------------------------------------- invoices

export interface PlatformInvoiceRow extends PlatformInvoice { tenant_name: string | null }
export interface PlatformInvoicesData { invoices: PlatformInvoiceRow[]; tenants: { id: string; name: string }[] }

/** Every invoice by due date, and the school list the "New invoice" form picks from. */
export async function fetchPlatformInvoices(): Promise<PlatformInvoicesData> {
  const sb = supabase();
  const [{ data: invoices, error: e1 }, { data: tenants, error: e2 }] = await Promise.all([
    sb.from("platform_invoices")
      .select("*,tenants(name)")
      .order("due_date")
      .returns<(PlatformInvoice & { tenants: { name: string } | null })[]>(),
    sb.from("tenants").select("id,name").order("name").returns<{ id: string; name: string }[]>(),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  return {
    invoices: (invoices ?? []).map((r) => ({ ...r, tenant_name: r.tenants?.name ?? null })),
    tenants: tenants ?? [],
  };
}

export async function markPlatformInvoicePaid(id: string): Promise<void> {
  const { error } = await supabase()
    .from("platform_invoices").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export interface NewPlatformInvoice { tenant_id: string; amount_cents: number; due_date: string }

export async function createPlatformInvoice(input: NewPlatformInvoice): Promise<void> {
  const { error } = await supabase().from("platform_invoices").insert({
    tenant_id: input.tenant_id, amount_cents: input.amount_cents, due_date: input.due_date,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------- impersonation log and audit trail

export interface ImpersonationLogRow {
  id: string; started_at: string; ended_at: string | null; reason: string; scope: string;
  tenant_name: string | null; staff_name: string | null;
}

/** The last 100 sessions, newest first. */
export async function fetchImpersonationLog(): Promise<ImpersonationLogRow[]> {
  const { data, error } = await supabase()
    .from("impersonation_sessions")
    .select("id,started_at,ended_at,reason,scope,tenants(name),profiles(full_name)")
    .order("started_at", { ascending: false })
    .limit(100)
    .returns<{ id: string; started_at: string; ended_at: string | null; reason: string; scope: string; tenants: { name: string } | null; profiles: { full_name: string } | null }[]>();
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id, started_at: r.started_at, ended_at: r.ended_at, reason: r.reason, scope: r.scope,
    tenant_name: r.tenants?.name ?? null, staff_name: r.profiles?.full_name ?? null,
  }));
}

export interface PlatformAuditRow { id: string; created_at: string; actor_label: string; event: string; category: string; tenant_name: string | null }

/** The last 200 events across every school, newest first. */
export async function fetchPlatformAudit(): Promise<PlatformAuditRow[]> {
  const { data, error } = await supabase()
    .from("audit_events")
    .select("id,created_at,actor_label,event,category,tenants(name)")
    .order("created_at", { ascending: false })
    .limit(200)
    .returns<{ id: string; created_at: string; actor_label: string; event: string; category: string; tenants: { name: string } | null }[]>();
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id, created_at: r.created_at, actor_label: r.actor_label, event: r.event, category: r.category, tenant_name: r.tenants?.name ?? null }));
}
