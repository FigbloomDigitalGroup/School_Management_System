import type { Organization, Profile, Tenant, TenantStatus } from "../types";
import { apiMe } from "./authApi";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { isRole, profileFromApi, roleOutsideSchools, viewOfMe, type MeView } from "./sessionApi";

/**
 * The platform console on apps/api (slice P2 of apps/api/docs/PLATFORM-CONSOLE.md).
 *
 * Every call here is an identity call (`tenantId: null`): platform routes ignore `X-Tenant-Id` and the caller's
 * school on purpose, so school users cannot reach them and a super admin gets the same view from anywhere.
 *
 * What the API exposes today:
 * - `GET /v1/platform/schools` and `GET /v1/platform/schools/{schoolId}` (directory fields + organisation)
 * - `POST /v1/platform/schools` (provision a school + initial school-admin invitation; requires recent re-auth)
 * - `GET /v1/platform/ops/status` (worker heartbeats, job queue, reconciliation and unmatched-callback counters)
 */

const TENANT_STATUSES: readonly TenantStatus[] = ["active", "trial", "onboarding", "overdue", "suspended", "setup_stalled"];
const ORG_KINDS: readonly Organization["kind"][] = ["government", "county", "constituency", "group_owner"];
const ORG_STATUSES: readonly Organization["status"][] = ["pending", "active", "suspended", "rejected"];
const DEFAULT_ACCENT = "#1B4D2E";

// ---------------------------------------------------------------- schools (GET /v1/platform/schools)

export interface PlatformSchoolOrganization {
  id: string;
  name: string;
  slug: string;
  kind: Organization["kind"];
  status: Organization["status"];
}

export interface PlatformSchoolItem {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  timezone: string;
  createdAt: string;
  organization: PlatformSchoolOrganization;
  /** When the school asked Figbloom for HR & Payroll ("Request Figbloom HR", migration 117), or null. */
  hrRequestedAt: string | null;
  /** The id of the account that asked (the API gives no name or e-mail), or null. */
  hrRequestedBy: string | null;
}

interface RawPlatformSchool {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  createdAt: string;
  hrRequestedAt?: string | null;
  hrRequestedBy?: string | null;
  organization: {
    id: string;
    name: string;
    slug: string;
    kind: string;
    status: string;
  };
}

/** Normalizes a server school directory row; unknown statuses fall back safely to non-active values. */
export function platformSchoolFromApi(raw: RawPlatformSchool): PlatformSchoolItem {
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    status: (TENANT_STATUSES as readonly string[]).includes(raw.status) ? (raw.status as TenantStatus) : "setup_stalled",
    timezone: raw.timezone || "Africa/Nairobi",
    createdAt: raw.createdAt,
    organization: {
      id: raw.organization.id,
      name: raw.organization.name,
      slug: raw.organization.slug,
      kind: (ORG_KINDS as readonly string[]).includes(raw.organization.kind)
        ? (raw.organization.kind as Organization["kind"])
        : "group_owner",
      status: (ORG_STATUSES as readonly string[]).includes(raw.organization.status)
        ? (raw.organization.status as Organization["status"])
        : "pending",
    },
    // A request with no time is no request; a person with no request is nobody (the API never sends one without the other's time).
    hrRequestedAt: typeof raw.hrRequestedAt === "string" && raw.hrRequestedAt ? raw.hrRequestedAt : null,
    hrRequestedBy: typeof raw.hrRequestedAt === "string" && raw.hrRequestedAt && typeof raw.hrRequestedBy === "string" && raw.hrRequestedBy ? raw.hrRequestedBy : null,
  };
}

/**
 * Projects a platform school directory row into `Tenant` for shared callers (`fetchAllTenants`).
 * Fields the API does not carry (county, plan, seats, billing) stay empty/0 and are hidden by `platformCapabilities()`.
 */
export function platformSchoolToTenant(s: PlatformSchoolItem): Tenant {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    county: "",
    country: "KE",
    level: "secondary",
    institution_type: "k12",
    higher_ed_subtype: null,
    delivery_mode: "in_person",
    role_labels: {},
    moe_registration: null,
    plan: "standard",
    status: s.status,
    accent: DEFAULT_ACCENT,
    logo_url: null,
    licensed_seats: 0,
    payment_paybill: null,
    payment_till: null,
    payment_bank_details: null,
    payment_notes: null,
    price_cents_override: null,
    trial_ends_at: null,
    renews_on: null,
    organization_id: s.organization.id,
    timezone: s.timezone,
    created_at: s.createdAt,
  };
}

/** Every school in the platform directory, keyset-paginated (`GET /v1/platform/schools`). */
export async function apiFetchPlatformSchools(filter?: {
  status?: TenantStatus;
  organizationId?: string;
}): Promise<PlatformSchoolItem[]> {
  const rows = await listAllPages(async (cursor) => {
    const res = await apiClient().get("/v1/platform/schools", {
      query: {
        limit: API_PAGE_LIMIT,
        cursor,
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.organizationId ? { organizationId: filter.organizationId } : {}),
      },
      tenantId: null,
    });
    return { items: res.items, page: res.page };
  });
  return rows.map(platformSchoolFromApi);
}

/** One school's directory record (`GET /v1/platform/schools/{schoolId}`). */
export async function apiFetchPlatformSchool(schoolId: string): Promise<PlatformSchoolItem> {
  const row = await apiClient().get("/v1/platform/schools/{schoolId}", {
    path: { schoolId },
    tenantId: null,
  });
  return platformSchoolFromApi(row);
}

// ---------------------------------------------------------------- organizations & admins (slice P3)

export interface PlatformOrganizationItem {
  id: string;
  name: string;
  slug: string;
  kind: Organization["kind"];
  status: Organization["status"];
  createdAt: string;
  schoolCount: number;
}

interface RawPlatformOrganization {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
  createdAt: string;
  schoolCount: number;
}

export function platformOrganizationFromApi(raw: RawPlatformOrganization): PlatformOrganizationItem {
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    kind: (ORG_KINDS as readonly string[]).includes(raw.kind) ? (raw.kind as Organization["kind"]) : "group_owner",
    status: (ORG_STATUSES as readonly string[]).includes(raw.status) ? (raw.status as Organization["status"]) : "pending",
    createdAt: raw.createdAt,
    schoolCount: typeof raw.schoolCount === "number" && Number.isFinite(raw.schoolCount) ? Math.max(0, Math.trunc(raw.schoolCount)) : 0,
  };
}

export function platformOrganizationToOrg(o: PlatformOrganizationItem): Organization {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    kind: o.kind,
    county: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    status: o.status,
    created_at: o.createdAt,
    created_by: null,
  };
}

export interface PlatformAdminItem {
  userId: string;
  fullName: string;
  email: string | null;
  status: "active" | "disabled" | "invited";
  since: string;
}

/** Every organization in the platform directory (`GET /v1/platform/organizations`). */
export async function apiFetchPlatformOrganizations(filter?: {
  status?: Organization["status"];
  kind?: Organization["kind"];
}): Promise<PlatformOrganizationItem[]> {
  const rows = await listAllPages(async (cursor) => {
    const res = await apiClient().get("/v1/platform/organizations", {
      query: {
        limit: API_PAGE_LIMIT,
        cursor,
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.kind ? { kind: filter.kind } : {}),
      },
      tenantId: null,
    });
    return { items: res.items, page: res.page };
  });
  return rows.map(platformOrganizationFromApi);
}

/** One organization's directory record (`GET /v1/platform/organizations/{organizationId}`). */
export async function apiFetchPlatformOrganization(organizationId: string): Promise<PlatformOrganizationItem> {
  const row = await apiClient().get("/v1/platform/organizations/{organizationId}", {
    path: { organizationId },
    tenantId: null,
  });
  return platformOrganizationFromApi(row);
}

/** Administrators of one organization (`GET /v1/platform/organizations/{organizationId}/admins`, read-audited). */
export async function apiFetchPlatformOrganizationAdmins(organizationId: string): Promise<PlatformAdminItem[]> {
  const rows = await listAllPages(async (cursor) => {
    const res = await apiClient().get("/v1/platform/organizations/{organizationId}/admins", {
      path: { organizationId },
      query: { limit: API_PAGE_LIMIT, cursor },
      tenantId: null,
    });
    return { items: res.items, page: res.page };
  });
  return rows.map((a) => ({
    userId: a.userId,
    fullName: a.fullName,
    email: a.email ?? null,
    status: a.status,
    since: a.since,
  }));
}

/** Active school administrators of one school (`GET /v1/platform/schools/{schoolId}/admins`, read-audited). */
export async function apiFetchPlatformSchoolAdmins(schoolId: string): Promise<PlatformAdminItem[]> {
  const rows = await listAllPages(async (cursor) => {
    const res = await apiClient().get("/v1/platform/schools/{schoolId}/admins", {
      path: { schoolId },
      query: { limit: API_PAGE_LIMIT, cursor },
      tenantId: null,
    });
    return { items: res.items, page: res.page };
  });
  return rows.map((a) => ({
    userId: a.userId,
    fullName: a.fullName,
    email: a.email ?? null,
    status: a.status,
    since: a.since,
  }));
}

// ---------------------------------------------------------------- usage counts (slice P4)

export interface PlatformUsageSchoolItem {
  tenantId: string;
  name: string;
  slug: string;
  status: TenantStatus;
  activeLearners: number;
  activeStaff: number;
  activeGuardianLinks: number;
}

export interface PlatformUsageSummary {
  items: PlatformUsageSchoolItem[];
  totals: {
    schools: number;
    activeLearners: number;
    activeStaff: number;
    activeGuardianLinks: number;
  };
}

/** Counts-only cross-school usage summary (`GET /v1/platform/usage`). */
export async function apiFetchPlatformUsage(): Promise<PlatformUsageSummary> {
  const res = await apiClient().get("/v1/platform/usage", { tenantId: null });
  return {
    items: res.items.map((r) => ({
      tenantId: r.tenantId,
      name: r.name,
      slug: r.slug,
      status: (TENANT_STATUSES as readonly string[]).includes(r.status) ? (r.status as TenantStatus) : "setup_stalled",
      activeLearners: r.activeLearners,
      activeStaff: r.activeStaff,
      activeGuardianLinks: r.activeGuardianLinks,
    })),
    totals: res.totals,
  };
}

// ---------------------------------------------------------------- audit trail (slice P5)

export interface PlatformAuditEventItem {
  id: string;
  occurredAt: string;
  eventType: string;
  schoolId: string | null;
  schoolName: string | null;
  actorUserId: string | null;
  actorName: string | null;
}

export interface PlatformAuditPage {
  items: PlatformAuditEventItem[];
  nextCursor: string | null;
}

/** One page of platform-wide audit events (`GET /v1/platform/audit-events`, newest first, read-audited). */
export async function apiFetchPlatformAuditEvents(opts?: {
  schoolId?: string;
  eventPrefix?: string;
  since?: string;
  limit?: number;
  cursor?: string | null;
}): Promise<PlatformAuditPage> {
  const res = await apiClient().get("/v1/platform/audit-events", {
    query: {
      limit: opts?.limit ?? 100,
      ...(opts?.cursor ? { cursor: opts.cursor } : {}),
      ...(opts?.schoolId ? { schoolId: opts.schoolId } : {}),
      ...(opts?.eventPrefix ? { eventPrefix: opts.eventPrefix } : {}),
      ...(opts?.since ? { since: opts.since } : {}),
    },
    tenantId: null,
  });
  return {
    items: res.items.map((e) => ({
      id: e.id,
      occurredAt: e.occurredAt,
      eventType: e.eventType,
      schoolId: e.schoolId,
      schoolName: e.schoolName,
      actorUserId: e.actorUserId,
      actorName: e.actorName,
    })),
    nextCursor: res.page.next_cursor ?? null,
  };
}

// ---------------------------------------------------------------- Figbloom billing invoices (migration 123)

export type PlatformBillingInvoiceStatus = "due" | "paid";

export interface PlatformBillingInvoice {
  invoiceId: string;
  tenantId: string;
  tenantName: string;
  amountCents: number;
  dueDate: string;
  status: PlatformBillingInvoiceStatus;
  paidAt: string | null;
  createdAt: string;
}

/** All Figbloom invoices for schools, ordered by due date and invoice id. */
export async function apiFetchPlatformInvoices(): Promise<PlatformBillingInvoice[]> {
  return listAllPages(async (cursor) => {
    const res = await apiClient().get("/v1/platform/invoices", {
      query: { limit: API_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      tenantId: null,
    });
    return { items: res.items, page: res.page };
  });
}

/** Creates a Figbloom school invoice; recent password confirmation is handled by the API client. */
export async function apiCreatePlatformInvoice(input: {
  tenantId: string;
  amountCents: number;
  dueDate: string;
}): Promise<string> {
  const res = await apiClient().post("/v1/platform/invoices", { body: input, tenantId: null });
  return res.invoiceId;
}

/** Records a manually reconciled payment and returns whether the invoice changed to paid. */
export async function apiMarkPlatformInvoicePaid(invoiceId: string): Promise<boolean> {
  const res = await apiClient().put("/v1/platform/invoices/{invoiceId}/mark-paid", {
    path: { invoiceId },
    tenantId: null,
  });
  return res.changed;
}

// ---------------------------------------------------------------- provisioning (POST /v1/platform/schools)

export interface ProvisionSchoolInput {
  schoolName: string;
  slug: string;
  adminEmail: string;
  adminName?: string;
  organizationId?: string;
  organizationName?: string;
}

export interface ProvisionSchoolResult {
  school: {
    tenantId: string;
    organizationId: string;
  };
  invitation: {
    id: string;
    role: string;
    expiresAt: string;
    delivery: "sent" | "not_configured";
    /** Returned once, only when `delivery === "not_configured"`. */
    token: string | null;
  };
}

/**
 * Provisions a new school and issues its first school-administrator invitation (`POST /v1/platform/schools`).
 * Requires recent password confirmation (handled automatically by the session guard's re-auth modal).
 */
export async function apiProvisionSchool(input: ProvisionSchoolInput): Promise<ProvisionSchoolResult> {
  const body = {
    school_name: input.schoolName.trim(),
    slug: input.slug.trim().toLowerCase(),
    admin_email: input.adminEmail.trim(),
    ...(input.adminName?.trim() ? { admin_name: input.adminName.trim() } : {}),
    ...(input.organizationId?.trim() ? { organization_id: input.organizationId.trim() } : {}),
    ...(input.organizationName?.trim() ? { organization_name: input.organizationName.trim() } : {}),
  };
  const res = await apiClient().post("/v1/platform/schools", { body, tenantId: null });
  return {
    school: {
      tenantId: res.school.tenant_id,
      organizationId: res.school.organization_id,
    },
    invitation: {
      id: res.invitation.id,
      role: res.invitation.role,
      expiresAt: res.invitation.expires_at,
      delivery: res.invitation.delivery,
      token: res.invitation.token ?? null,
    },
  };
}

// ---------------------------------------------------------------- ops health (GET /v1/platform/ops/status)

export interface OpsWorkerStatus {
  worker: string;
  lastSeenAgeSeconds: number | null;
  lastSweepAgeSeconds: number | null;
  lastCycleOutcome: string | null;
}

export interface OpsQueueStatus {
  queuedDue: number;
  queuedFuture: number;
  leased: number;
  dead: number;
  oldestDueLagSeconds: number | null;
  retrying: number;
}

export interface OpsReconciliationStatus {
  openCases: number;
  escalatedOpen: number;
  unassignedOpen: number;
  oldestOpenAgeSeconds: number | null;
}

export interface OpsUnmatchedCasesStatus {
  open: number;
  escalatedOpen: number;
  unassignedOpen: number;
  oldestOpenAgeSeconds: number | null;
}

export interface PlatformOpsStatus {
  generatedAt: string | null;
  workers: OpsWorkerStatus[];
  queue: OpsQueueStatus;
  reconciliation: OpsReconciliationStatus;
  unmatchedCallbacks: number;
  unmatchedCases: OpsUnmatchedCasesStatus | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asInt(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function asNullableInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Parses the JSON snapshot returned by `finance_ops_snapshot()` cleanly, tolerating missing optional fields. */
export function parsePlatformOpsStatus(raw: unknown): PlatformOpsStatus {
  const root = asRecord(raw);
  const rawWorkers = Array.isArray(root.workers) ? root.workers : [];
  const workers: OpsWorkerStatus[] = rawWorkers.map((item) => {
    const w = asRecord(item);
    return {
      worker: asNullableString(w.worker) ?? "worker",
      lastSeenAgeSeconds: asNullableInt(w.last_seen_age_seconds),
      lastSweepAgeSeconds: asNullableInt(w.last_sweep_age_seconds),
      lastCycleOutcome: asNullableString(w.last_cycle_outcome),
    };
  });

  const q = asRecord(root.queue);
  const r = asRecord(root.reconciliation);
  const uc = root.unmatched_cases ? asRecord(root.unmatched_cases) : null;

  return {
    generatedAt: asNullableString(root.generated_at),
    workers,
    queue: {
      queuedDue: asInt(q.queued_due),
      queuedFuture: asInt(q.queued_future),
      leased: asInt(q.leased),
      dead: asInt(q.dead),
      oldestDueLagSeconds: asNullableInt(q.oldest_due_lag_seconds),
      retrying: asInt(q.retrying),
    },
    reconciliation: {
      openCases: asInt(r.open_cases),
      escalatedOpen: asInt(r.escalated_open),
      unassignedOpen: asInt(r.unassigned_open),
      oldestOpenAgeSeconds: asNullableInt(r.oldest_open_age_seconds),
    },
    unmatchedCallbacks: asInt(root.unmatched_callbacks),
    unmatchedCases: uc
      ? {
          open: asInt(uc.open),
          escalatedOpen: asInt(uc.escalated_open),
          unassignedOpen: asInt(uc.unassigned_open),
          oldestOpenAgeSeconds: asNullableInt(uc.oldest_open_age_seconds),
        }
      : null,
  };
}

/** Live operational health snapshot: worker heartbeats, job queue, reconciliation and unmatched callbacks. */
export async function apiFetchPlatformOpsStatus(): Promise<PlatformOpsStatus> {
  const res = await apiClient().get("/v1/platform/ops/status", { tenantId: null });
  return parsePlatformOpsStatus(res.status);
}

// ---------------------------------------------------------------- platform console session

async function meOrNull(): Promise<MeView | null> {
  if (!apiClient().session()) return null;
  try {
    return viewOfMe(await apiMe());
  } catch (err) {
    if (isApiError(err) && err.code === "unauthorized") return null;
    throw err;
  }
}

/**
 * Who is signed in as the platform console sees them. Null when nobody is signed in.
 * Non-super-admin callers still get their profile so the console gate can redirect them to `/signin`.
 */
export async function apiLoadPlatformSession(): Promise<{ profile: Profile | null } | null> {
  const me = await meOrNull();
  if (!me) return null;
  const outside = roleOutsideSchools(me);
  if (outside) return { profile: profileFromApi(me, null, outside) };
  const first = me.memberships[0];
  if (first && isRole(first.role)) return { profile: profileFromApi(me, first, first.role) };
  return { profile: null };
}
