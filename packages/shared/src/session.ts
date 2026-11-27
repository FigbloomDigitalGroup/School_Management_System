import { apiLoginWithEmail, apiLogout, apiMe } from "./api/authApi";
import { apiClient } from "./api/client";
import { apiLoadMyWorkspaces, apiLoadOrgSession } from "./api/orgApi";
import { apiOnSessionChange } from "./api/sessionEvents";
import { apiHomeDestination, apiLoadSchoolSession, apiSignInProfile, forgetApiSchools } from "./api/sessionApi";
import { fetchMyAdminAreas, mayHoldAdminAreas, type AdminArea } from "./adminAreas";
import { onApi } from "./backend";
import { fetchAllMyOrganizationTenantSummaries, fetchMyOrganizations } from "./organizations";
import { sessionSchoolSuspended } from "./suspended";
import { supabase } from "./supabase";
import type { Organization, OrganizationTenantSummary, Profile, Role, Tenant } from "./types";

/**
 * The login, in one place (FIG-1896). The web's screens and hooks used to call Supabase Auth themselves; they call
 * these instead, so moving the apps to the new API (FIG-1890) changes this module and not the screens.
 *
 * Nothing here changes what the apps do: each function is the call a screen made before, with the same answers.
 *
 * On an API build (FIG-1890: `onApi()`) the same functions answer from apps/api instead. A function the API cannot answer
 * yet says so by throwing (never by returning something made up), and its screen is not reachable on an API build
 * (capabilities.ts).
 */

// ---------------------------------------------------------------- the login itself

function isUnauthorized(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "unauthorized";
}

/** Who is signed in, checked with the server (an ended login answers null). */
export async function currentUserId(): Promise<string | null> {
  if (onApi()) {
    if (!apiClient().session()) return null;
    try { return (await apiMe()).user.id; } catch (err) { if (isUnauthorized(err)) return null; throw err; }
  }
  const { data: { user } } = await supabase().auth.getUser();
  return user?.id ?? null;
}

/** Who the login kept in this browser belongs to, without asking the server. Null when there is none. */
export async function storedSessionUserId(): Promise<string | null> {
  if (onApi()) {
    const kept = apiClient().session();
    return kept ? (kept.userId ?? currentUserId()) : null;
  }
  const { data } = await supabase().auth.getSession();
  return data.session?.user.id ?? null;
}

/** The kept login's access token, for requests that send it themselves (resumable uploads). Null when signed out. */
export async function currentAccessToken(): Promise<string | null> {
  if (onApi()) return apiClient().session()?.token ?? null;
  const { data } = await supabase().auth.getSession();
  return data.session?.access_token ?? null;
}

/** Whether this browser holds a login right now. Opening a password-reset link signs the person in. */
export async function hasSession(): Promise<boolean> {
  if (onApi()) return apiClient().session() !== null;
  const { data } = await supabase().auth.getSession();
  return !!data.session;
}

/** What changed about the login. */
export type SessionEvent = "initial" | "signed-in" | "signed-out" | "refreshed" | "updated" | "password-recovery" | "other";

const EVENTS: Record<string, SessionEvent> = {
  INITIAL_SESSION: "initial",
  SIGNED_IN: "signed-in",
  SIGNED_OUT: "signed-out",
  TOKEN_REFRESHED: "refreshed",
  USER_UPDATED: "updated",
  PASSWORD_RECOVERY: "password-recovery",
};

/** The login library's own event names, in this module's words. Anything else is "other". */
export function sessionEventOf(event: string): SessionEvent {
  return EVENTS[event] ?? "other";
}

export interface SessionChange {
  event: SessionEvent;
  /** Who is signed in after the change; null when nobody is. */
  userId: string | null;
}

/**
 * Calls `listener` whenever the login changes in this browser: signed in or out, the token renewed, the password
 * changed, a password-reset link opened. Supabase also reports the login as it stands when listening starts
 * ("initial"). Returns the function that stops listening.
 */
export function onSessionChange(listener: (change: SessionChange) => void): () => void {
  if (onApi()) return apiOnSessionChange(listener);
  const { data } = supabase().auth.onAuthStateChange((event, session) => {
    listener({ event: sessionEventOf(event), userId: session?.user.id ?? null });
  });
  return () => data.subscription.unsubscribe();
}

/**
 * Signs in with an email (or the email a login ID resolved to) and a password, and returns the person's id. When the
 * login service refuses, its answer is thrown as it is, so the caller can tell a suspended account (isBannedAuthError)
 * from a wrong password.
 */
export async function signInWithEmail(email: string, password: string): Promise<string | null> {
  if (onApi()) return (await apiLoginWithEmail(email, password)).user.id;
  const { data, error } = await supabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user?.id ?? null;
}

/**
 * Ends the login in this browser only: the person's other devices stay signed in (FIG-1340; supabase-js signs out
 * everywhere unless told otherwise). The answer is not checked, as before: the screen goes to sign-in either way.
 */
export async function signOutHere(): Promise<void> {
  if (onApi()) { await apiLogout(); forgetApiSchools(); return; }
  await supabase().auth.signOut({ scope: "local" });
}

/** Emails a link for choosing a new password; the link opens `redirectTo`. Throws when the service refuses. */
export async function sendPasswordResetEmail(email: string, redirectTo: string): Promise<void> {
  if (onApi()) throw new Error("Password reset by email is not on the new system yet (no email provider is set up).");
  const { error } = await supabase().auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

/** Changes the signed-in person's password. Throws the service's answer when it refuses (too short, too weak). */
export async function changeMyPassword(password: string): Promise<void> {
  // The API asks for the current password too (apiChangePassword): a screen on an API build calls that instead.
  if (onApi()) throw new Error("Changing the password on the new system needs the current password: use apiChangePassword.");
  const { error } = await supabase().auth.updateUser({ password });
  if (error) throw error;
}

// ---------------------------------------------------------------- who the signed-in person is

/** What a school's console knows about the signed-in person there (the web's useSession). */
export interface SchoolSessionSnapshot {
  profile: Profile | null;
  /** The school at that address, if this person may see it: row-level security answers, not the app. */
  tenant: Tenant | null;
  /** An org_admin inside a school of one of their organizations (their own profile has no school). */
  actingForTenant: boolean;
  /** The organization that gives that access, while actingForTenant. */
  actingOrganization: { id: string; name: string; slug: string } | null;
  /** On the API build, an org administrator has only the explicitly delegated area permissions. */
  delegatedOrgConsole: boolean;
  /** Current API delegation set, used to prevent client caches crossing a permission change. */
  delegatedPermissions: string[];
  /** A teacher's or other staff member's admin areas; empty for everyone else. */
  adminAreas: AdminArea[];
  /** The person's own school is suspended, so the console shows that instead of bouncing to sign-in. */
  schoolSuspended: boolean;
}

/**
 * Reads who is signed in and, for a school's address (`slug`), that school and the person's place in it. Null when
 * nobody is signed in. With `slug` null (outside any school) no school is read.
 */
export async function loadSchoolSession(slug: string | null): Promise<SchoolSessionSnapshot | null> {
  if (onApi()) return apiLoadSchoolSession(slug);
  const userId = await currentUserId();
  if (!userId) return null;

  const { data: profile } = await supabase().from("profiles").select("*").eq("id", userId).single<Profile>();

  let tenant: Tenant | null = null;
  if (slug) {
    // maybeSingle, not single: no row is an expected answer here (the wrong school, or one this person may not see),
    // and single() would give the same null with a 406 on the wire for every such visit.
    const { data } = await supabase().from("tenants").select("*").eq("slug", slug).maybeSingle<Tenant>();
    tenant = data ?? null;
  }

  // An org_admin's own tenant_id is always null, so a school read here is one they reach through their organization
  // (organization_read_own already refused it otherwise).
  const actingForTenant = profile?.role === "org_admin" && !!tenant;
  let actingOrganization: SchoolSessionSnapshot["actingOrganization"] = null;
  if (actingForTenant && tenant?.organization_id) {
    const { data: org } = await supabase()
      .from("organizations").select("id, name, slug").eq("id", tenant.organization_id)
      .maybeSingle<{ id: string; name: string; slug: string }>();
    actingOrganization = org ?? null;
  }

  // A failed lookup leaves them with their own console only, never more.
  const adminAreas = profile && tenant && mayHoldAdminAreas(profile.role)
    ? await fetchMyAdminAreas().catch((err: unknown) => { console.error(err); return [] as AdminArea[]; })
    : [];

  // Only asked inside a school's routes, and only when that school couldn't be read.
  const schoolSuspended = slug ? await sessionSchoolSuspended(profile ?? null, !!tenant) : false;

  return { profile: profile ?? null, tenant, actingForTenant, actingOrganization, delegatedOrgConsole: false, delegatedPermissions: [], adminAreas, schoolSuspended };
}

/** What the org-admin console knows about the signed-in person (the web's useOrgSession). */
export interface OrgSessionSnapshot {
  profile: Profile | null;
  /** The organization at that address. Only one the person administers is readable, so this is the access check. */
  organization: Organization | null;
}

/** Reads who is signed in and the organization at `orgSlug`. Null when nobody is signed in. */
export async function loadOrgSession(orgSlug: string | null): Promise<OrgSessionSnapshot | null> {
  // On the API the organisation is found among the person's own (GET /v1/org/organizations, S11).
  if (onApi()) return apiLoadOrgSession(orgSlug);
  const userId = await currentUserId();
  if (!userId) return null;

  const { data: profile } = await supabase().from("profiles").select("*").eq("id", userId).single<Profile>();

  let organization: Organization | null = null;
  if (orgSlug) {
    const { data } = await supabase().from("organizations").select("*").eq("slug", orgSlug).maybeSingle<Organization>();
    organization = data ?? null;
  }
  return { profile: profile ?? null, organization };
}

/** An org_admin's workspaces: their name, the organizations they run, and every school in them. */
export interface MyWorkspaces {
  name: string;
  orgs: Organization[];
  schools: OrganizationTenantSummary[];
}

/** The workspace picker's data. Null when nobody is signed in or the person is not an org_admin. */
export async function loadMyWorkspaces(): Promise<MyWorkspaces | null> {
  if (onApi()) return apiLoadMyWorkspaces();
  const userId = await currentUserId();
  if (!userId) return null;

  const { data: profile } = await supabase()
    .from("profiles").select("id, full_name, role").eq("id", userId)
    .maybeSingle<{ id: string; full_name: string; role: Role }>();
  if (!profile || profile.role !== "org_admin") return null;

  const [orgs, schools] = await Promise.all([fetchMyOrganizations(profile.id), fetchAllMyOrganizationTenantSummaries()]);
  return { name: profile.full_name, orgs, schools };
}

// ---------------------------------------------------------------- where to go after signing in

/** The signed-in person's role and school, read straight after signing in. */
export interface SignInProfile {
  role: Role;
  tenant_id: string | null;
}

/** Null when the account has no profile yet (not fully set up). */
export async function fetchSignInProfile(userId: string): Promise<SignInProfile | null> {
  if (onApi()) return apiSignInProfile();
  const { data } = await supabase()
    .from("profiles").select("role, tenant_id").eq("id", userId).maybeSingle<SignInProfile>();
  return data ?? null;
}

/** Where a signed-in person's console is. */
export interface HomeDestination {
  /** Their school's slug, or an org_admin's organization's. Null when it cannot be read, and for a super_admin. */
  slug: string | null;
  institutionType?: Tenant["institution_type"];
  /** An org_admin who runs more than one organization chooses one on the workspace picker. */
  pickOrganization: boolean;
}

/**
 * Finds the console a person belongs in: by their real school, not one assumed in the app (every school onboarded
 * after the first needs this to reach its console). An org_admin has no school: organization_admins says which
 * organizations they run. They can run several (only profile+organization is unique), so one goes straight there and
 * several go to the picker.
 */
export async function fetchHomeDestination(userId: string, profile: SignInProfile): Promise<HomeDestination> {
  if (onApi()) {
    if (profile.tenant_id) return { ...(await apiHomeDestination(profile.tenant_id)), pickOrganization: false };
    return { slug: null, pickOrganization: false };
  }
  if (profile.tenant_id) {
    const { data: tenant } = await supabase()
      .from("tenants").select("slug, institution_type").eq("id", profile.tenant_id)
      .maybeSingle<{ slug: string; institution_type: Tenant["institution_type"] }>();
    return { slug: tenant?.slug ?? null, institutionType: tenant?.institution_type, pickOrganization: false };
  }
  if (profile.role === "org_admin") {
    const { data: links } = await supabase()
      .from("organization_admins").select("organizations(slug)").eq("profile_id", userId)
      .returns<{ organizations: { slug: string } | null }[]>();
    const slugs = (links ?? []).map((l) => l.organizations?.slug).filter((s): s is string => !!s);
    if (slugs.length > 1) return { slug: null, pickOrganization: true };
    return { slug: slugs[0] ?? null, pickOrganization: false };
  }
  return { slug: null, pickOrganization: false };
}
