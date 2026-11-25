import { isAdminArea, mayHoldAdminAreas, type AdminArea } from "../adminAreas";
import type { Profile, Role, Tenant, TenantStatus } from "../types";
import { apiMe, type ApiMe, type ApiUser } from "./authApi";
import { apiClient, setApiActiveTenant } from "./client";
import { isApiError } from "./errors";
import { forgetOwnLearner, setApiActiveRole } from "./ownLearner";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import type { components } from "./schema";

/**
 * Who is signed in, the school at the address, and their place in it, read from apps/api and shaped as the Supabase
 * path shaped them (the types in types.ts), so the screens that use `useSession` need no change (FIG-1890).
 *
 * The API names no school by its address, so the school at `/s/<slug>` is found by asking for each school the person
 * belongs to (a person has one, nearly always). The API's school record is also thinner than the one the screens
 * expect; what it has not is filled with the plain defaults below, never invented from other data.
 */

type TenantRecord = components["schemas"]["TenantRecord"];
type SchoolProfile = components["schemas"]["SchoolProfile"];

const EPOCH = "1970-01-01T00:00:00.000Z";
const DEFAULT_ACCENT = "#1B4D2E";

const ROLES: readonly Role[] = ["super_admin", "school_admin", "teacher", "parent", "student", "driver", "org_admin", "staff"];
const TENANT_STATUSES: readonly TenantStatus[] = ["active", "trial", "onboarding", "overdue", "suspended", "setup_stalled"];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------- /v1/auth/me, with the fields the schema leaves optional made certain

export interface MembershipView {
  tenantId: string;
  role: string;
  loginId: string | null;
  tenantStatus: string;
}

export interface MeView {
  user: ApiUser;
  memberships: MembershipView[];
  /** What the server decided about the session's own school; null when that school is no longer usable. */
  authz: { role: string | null; isSuperAdmin: boolean } | null;
}

/** Reads the answer of GET /v1/auth/me. A membership without a school or a role is dropped: it can't be acted on. */
export function viewOfMe(me: ApiMe): MeView {
  if (!me?.user || typeof me.user.id !== "string") throw new Error("The server's answer about who is signed in was not understood.");
  const memberships: MembershipView[] = [];
  for (const m of me.memberships ?? []) {
    if (typeof m.tenantId === "string" && typeof m.role === "string") {
      memberships.push({ tenantId: m.tenantId, role: m.role, loginId: m.loginId ?? null, tenantStatus: m.tenantStatus ?? "active" });
    }
  }
  const authz = me.authz ? { role: typeof me.authz.role === "string" ? me.authz.role : null, isSuperAdmin: me.authz.isSuperAdmin === true } : null;
  return { user: me.user, memberships, authz };
}

// ---------------------------------------------------------------- pure mapping (tested without a server)

/** `area.people` -> "people". Permission codes that are not admin areas are left out. */
export function adminAreasFromPermissions(codes: readonly string[]): AdminArea[] {
  const out: AdminArea[] = [];
  for (const code of codes) {
    if (!code.startsWith("area.")) continue;
    const area = code.slice("area.".length);
    if (isAdminArea(area) && !out.includes(area)) out.push(area);
  }
  return out;
}

/** The school's colour as the app uses it: a #RRGGBB hex. The API stores a looser token, so anything else gets the default. */
export function accentFromApi(v: string | null | undefined): string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_ACCENT;
}

function levelFromApi(v: string | null | undefined): Tenant["level"] {
  return v === "primary" || v === "secondary" || v === "combined" ? v : "secondary";
}

function countryFromApi(v: string | null | undefined): string {
  return typeof v === "string" && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : "KE";
}

/**
 * "higher_ed" or "k12". The profile says it when the person may read the profile (administrators); the school record says it for
 * every member, so a lecturer's menu can tell a higher-education school. Anything else is a K-12 school, as before.
 */
function institutionTypeFromApi(v: string | null | undefined): Tenant["institution_type"] {
  return v === "higher_ed" ? "higher_ed" : "k12";
}

/** The school the screens expect, from the API's record and (when the person may read it) its profile. */
export function tenantFromApi(record: TenantRecord, profile: SchoolProfile | null): Tenant {
  const status = (TENANT_STATUSES as readonly string[]).includes(record.status ?? "") ? (record.status as TenantStatus) : "active";
  return {
    id: record.id ?? profile?.tenantId ?? "",
    name: record.name ?? profile?.name ?? "",
    slug: record.slug ?? profile?.slug ?? "",
    county: profile?.county ?? "",
    country: countryFromApi(profile?.country),
    level: levelFromApi(profile?.level),
    institution_type: institutionTypeFromApi(profile?.institution_type ?? record.institutionType),
    higher_ed_subtype: null,
    delivery_mode: "in_person",
    role_labels: {},
    moe_registration: profile?.moe_registration ?? null,
    plan: "standard",
    status,
    accent: accentFromApi(profile?.accent),
    logo_url: null,
    licensed_seats: 0,
    payment_paybill: null,
    payment_till: null,
    payment_bank_details: null,
    payment_notes: null,
    price_cents_override: null,
    trial_ends_at: null,
    renews_on: null,
    organization_id: record.organizationId ?? profile?.organizationId ?? null,
    timezone: record.timezone ?? profile?.timezone,
    created_at: EPOCH,
  };
}

/**
 * The signed-in person as a Profile. `membership` is their place in the school (school roles); without one they are an
 * org_admin or super_admin, who belong to no school.
 */
export function profileFromApi(me: MeView, membership: MembershipView | null, role: Role): Profile {
  return {
    id: me.user.id,
    tenant_id: membership?.tenantId ?? null,
    role,
    full_name: me.user.full_name,
    email: me.user.email,
    phone: null,
    staff_title: null,
    login_id: membership?.loginId ?? null,
    avatar_url: null,
    must_change_password: me.user.must_change_password,
    photo_changed_at: null,
    created_at: EPOCH,
  };
}

/** The role to act as when the person is not tied to a school: the platform's or an organization's. */
export function roleOutsideSchools(me: MeView): Role | null {
  if (me.user.platform_role === "super_admin" || me.authz?.isSuperAdmin) return "super_admin";
  if (me.authz?.role === "org_admin") return "org_admin";
  return null;
}

// ---------------------------------------------------------------- reading from the server

/** school id -> its record, so a person's schools are asked about once per page load, not per screen. */
const tenantRecords = new Map<string, TenantRecord>();

async function tenantRecord(tenantId: string): Promise<TenantRecord | null> {
  const known = tenantRecords.get(tenantId);
  if (known) return known;
  try {
    const rec = await apiClient().get("/v1/tenants/{tenantId}", { path: { tenantId }, tenantId });
    tenantRecords.set(tenantId, rec);
    return rec;
  } catch (err) {
    if (isApiError(err) && (err.code === "forbidden" || err.code === "not_found")) return null;
    throw err;
  }
}

async function schoolProfile(tenantId: string): Promise<SchoolProfile | null> {
  try {
    const res = await apiClient().get("/v1/tenants/{tenantId}/school-profile", { path: { tenantId }, tenantId });
    return res.schoolProfile;
  } catch (err) {
    // Not everyone may read the profile (a parent, a driver): the school is shown without it.
    if (isApiError(err) && (err.code === "forbidden" || err.code === "not_found")) return null;
    throw err;
  }
}

/** The permission codes the signed-in person holds in this school (`GET /v1/rbac/permissions`, every page). */
export async function permissionCodes(tenantId: string): Promise<string[]> {
  return listAllPages(async (cursor) => {
    const res = await apiClient().get("/v1/rbac/permissions", { query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: res.items, page: res.page };
  });
}

/** The school at `slug` among the ones this person belongs to, with their membership in it. */
async function findMemberSchool(me: MeView, slug: string): Promise<{ record: TenantRecord; membership: MembershipView } | null> {
  for (const membership of me.memberships) {
    const record = await tenantRecord(membership.tenantId);
    if (record?.slug === slug) return { record, membership };
  }
  return null;
}

export interface ApiSchoolSession {
  profile: Profile | null;
  tenant: Tenant | null;
  actingForTenant: boolean;
  actingOrganization: { id: string; name: string; slug: string } | null;
  adminAreas: AdminArea[];
  schoolSuspended: boolean;
}

const noSchool = (): Omit<ApiSchoolSession, "profile"> => ({ tenant: null, actingForTenant: false, actingOrganization: null, adminAreas: [], schoolSuspended: false });

/**
 * What a school's console knows about the signed-in person there (the API side of session.ts `loadSchoolSession`).
 * Null when nobody is signed in. A session the server no longer honours is cleared by the client and answers null.
 *
 * Not on the API yet, and so not answered: an org_admin or super_admin inside a school (they reach it through their
 * organization or the platform, which have no list the client can match a slug against). They get a null school, which
 * the screens treat as "not your school".
 */
export async function apiLoadSchoolSession(slug: string | null): Promise<ApiSchoolSession | null> {
  const c = apiClient();
  if (!c.session()) return null;

  let me: MeView;
  try {
    me = viewOfMe(await apiMe());
  } catch (err) {
    if (isApiError(err) && err.code === "unauthorized") return null;
    throw err;
  }

  const outside = roleOutsideSchools(me);
  const first = me.memberships[0];

  if (!slug) {
    setApiActiveTenant(null);
    setApiActiveRole(null);
    if (outside) return { ...noSchool(), profile: profileFromApi(me, null, outside) };
    return { ...noSchool(), profile: first && isRole(first.role) ? profileFromApi(me, first, first.role) : null };
  }

  const found = await findMemberSchool(me, slug);
  if (!found) {
    setApiActiveTenant(null);
    setApiActiveRole(null);
    return { ...noSchool(), profile: outside ? profileFromApi(me, null, outside) : null };
  }
  const { record, membership } = found;
  if (!isRole(membership.role)) throw new Error(`The server gave a role this app does not know: ${membership.role}`);

  const profile = profileFromApi(me, membership, membership.role);
  setApiActiveTenant(membership.tenantId);
  setApiActiveRole(membership.role);

  // A suspended school refuses every call but the sign-in ones; say so instead of failing three requests.
  if (membership.tenantStatus === "suspended") return { ...noSchool(), profile, schoolSuspended: true };

  const tenantId = membership.tenantId;
  const [prof, codes] = await Promise.all([
    schoolProfile(tenantId),
    mayHoldAdminAreas(membership.role) ? permissionCodes(tenantId) : Promise.resolve([] as string[]),
  ]);

  return {
    profile,
    tenant: tenantFromApi(record, prof),
    actingForTenant: false,
    actingOrganization: null,
    adminAreas: adminAreasFromPermissions(codes),
    schoolSuspended: false,
  };
}

// ---------------------------------------------------------------- after sign-in

/** Where the sign-in stands, from the server: the role and school to open (the API side of `fetchSignInProfile`). */
export async function apiSignInProfile(): Promise<{ role: Role; tenant_id: string | null } | null> {
  const me = viewOfMe(await apiMe());
  const outside = roleOutsideSchools(me);
  if (outside) return { role: outside, tenant_id: null };
  const first = me.memberships[0];
  if (first && isRole(first.role)) return { role: first.role, tenant_id: first.tenantId };
  return null;
}

/** The address and kind of the school a person's console is in (the API side of `fetchHomeDestination`, school people only). */
export async function apiHomeDestination(tenantId: string): Promise<{ slug: string | null; institutionType?: Tenant["institution_type"] }> {
  const record = await tenantRecord(tenantId);
  if (!record?.slug) return { slug: null };
  const profile = await schoolProfile(tenantId);
  return { slug: record.slug, institutionType: institutionTypeFromApi(profile?.institution_type ?? record.institutionType) };
}

/** Forgets what was learnt about schools: on sign-out, so the next person on this browser starts clean. */
export function forgetApiSchools(): void {
  tenantRecords.clear();
  setApiActiveTenant(null);
  setApiActiveRole(null);
  forgetOwnLearner();
}
