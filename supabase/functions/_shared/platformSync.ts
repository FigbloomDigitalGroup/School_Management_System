/**
 * Figbloom Schools <-> the Figbloom platform (design 5.8): sending the
 * registration queue, the one-off backfill, the hourly reconcile, and
 * registering the decision webhook. The database side is
 * 20261104900000_platform_registration.sql; platform-sync calls these.
 */

import { type OrganizationAnswer, type PlatformClient, PlatformError, type PlatformOrganizationStatus } from "./platformClient.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

const PAGE = 500;

interface QueueRow { id: number; kind: "organization" | "tenant"; local_id: string; attempts: number; version: number }
interface OrganizationRow { id: string; name: string; contact_email: string | null; created_at: string; status: string }
interface TenantRow { id: string; name: string; slug: string; organization_id: string | null; created_at: string }

/** Schools' organisation status, as the platform names it (the same four words since 20261104900000). */
export function platformStatusOf(status: string): PlatformOrganizationStatus {
  return status === "active" || status === "suspended" || status === "rejected" ? status : "pending";
}

export async function decisionsEnabled(admin: Admin): Promise<boolean> {
  const { data, error } = await admin.rpc("platform_decisions_enabled");
  if (error) throw new Error(`could not read PLATFORM_DECISIONS_ENABLED: ${error.message}`);
  return data === true;
}

/** Every row of a table, a page at a time (PostgREST answers at most 1000 rows). */
async function selectAll<T>(admin: Admin, table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from(table).select(columns).order("created_at").order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`could not read ${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

async function rpc<T = unknown>(admin: Admin, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

const organizationBody = (o: OrganizationRow) => ({ name: o.name, owner_email: o.contact_email ?? null, created_at: o.created_at });
const tenantBody = (t: TenantRow) => ({ name: t.name, slug: t.slug, organization_local_id: t.organization_id!, created_at: t.created_at });

/**
 * Applies the platform's answer for an organisation to Schools, after
 * switch-on only: registration answers with the platform's decision (a new
 * organisation starts pending there, or active with auto-approve).
 */
async function adoptPlatformStatus(admin: Admin, organization: OrganizationRow, answer: OrganizationAnswer, source: string): Promise<string | null> {
  if (!answer?.status || answer.status === organization.status) return null;
  const result = await rpc<{ outcome: string }>(admin, "platform_apply_organization_decision", {
    p_organization_id: organization.id, p_status: answer.status, p_reason: answer.status_reason ?? null,
    p_decided_by: `platform:${source}`, p_decided_at: null, p_delivery_id: null, p_source: source,
  });
  return result?.outcome ?? null;
}

// ---------------------------------------------------------------- the queue
export interface SyncReport {
  claimed: number;
  sent: number;
  failed: { kind: string; local_id: string; error: string }[];
  /** Rows handed back without trying, because the platform was unreachable. */
  deferred: number;
  /** Organisations whose status was set from the platform's answer (after switch-on). */
  adopted: number;
}

/**
 * Sends what is due in platform_sync_queue, organisations first. Safe to run
 * twice at once: rows are leased (skip locked), so a second run takes others
 * or none. What is sent is the record as it is now. A school whose
 * organisation isn't registered yet queues its organisation and waits a
 * minute; if the platform can't be reached, the rest of the batch waits too.
 */
export async function processQueue(admin: Admin, client: PlatformClient, { limit = 50 } = {}): Promise<SyncReport> {
  const enabled = await decisionsEnabled(admin);
  const rows = (await rpc<QueueRow[]>(admin, "platform_sync_claim", { p_limit: limit })) ?? [];
  const report: SyncReport = { claimed: rows.length, sent: 0, failed: [], deferred: 0, adopted: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      if (row.kind === "organization") {
        const { data: o, error } = await admin.from("organizations")
          .select("id, name, contact_email, created_at, status").eq("id", row.local_id).maybeSingle();
        if (error) throw new Error(`could not read the organisation: ${error.message}`);
        if (!o) { await rpc(admin, "platform_sync_done", { p_id: row.id, p_version: row.version, p_platform_id: null }); continue; } // deleted since
        const answer = await client.putOrganization(o.id, organizationBody(o));
        // false: it changed while on its way, and is handed back to be sent again
        await rpc(admin, "platform_sync_done", { p_id: row.id, p_version: row.version, p_platform_id: answer?.organization_id ?? null });
        report.sent++;
        if (enabled && (await adoptPlatformStatus(admin, o, answer, "registration")) === "applied") report.adopted++;
      } else {
        const { data: t, error } = await admin.from("tenants")
          .select("id, name, slug, organization_id, created_at").eq("id", row.local_id).maybeSingle();
        if (error) throw new Error(`could not read the school: ${error.message}`);
        if (!t) { await rpc(admin, "platform_sync_done", { p_id: row.id, p_version: row.version, p_platform_id: null }); continue; }
        if (!t.organization_id) {
          // every school belongs to an organisation on the platform; this one waits for staff (or the backfill) to give it one
          await rpc(admin, "platform_sync_failed", { p_id: row.id, p_error: "no_organization: the school has no organisation yet", p_retry_in_seconds: 3600 });
          report.failed.push({ kind: row.kind, local_id: row.local_id, error: "no_organization" });
          continue;
        }
        try {
          const answer = await client.putTenant(t.id, tenantBody(t));
          await rpc(admin, "platform_sync_done", { p_id: row.id, p_version: row.version, p_platform_id: answer?.tenant_id ?? answer?.id ?? null });
          report.sent++;
        } catch (err) {
          if (err instanceof PlatformError && err.code === "organization_not_registered") {
            await rpc(admin, "platform_sync_enqueue", { p_kind: "organization", p_local_id: t.organization_id });
            await rpc(admin, "platform_sync_failed", { p_id: row.id, p_error: "organization_not_registered: waiting for its organisation", p_retry_in_seconds: 60 });
            report.failed.push({ kind: row.kind, local_id: row.local_id, error: "organization_not_registered" });
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`platform-sync: ${row.kind} ${row.local_id} not sent (attempt ${row.attempts}): ${message}`);
      await rpc(admin, "platform_sync_failed", { p_id: row.id, p_error: message, p_retry_in_seconds: null });
      report.failed.push({ kind: row.kind, local_id: row.local_id, error: message });
      if (err instanceof PlatformError && (err.status === 0 || err.status >= 500 || err.code === "token_failed")) {
        // the platform (or its sign-in) is down: hand the rest back for a minute rather than wait out each timeout
        for (const rest of rows.slice(i + 1)) {
          await rpc(admin, "platform_sync_failed", { p_id: rest.id, p_error: `deferred: ${message}`, p_retry_in_seconds: 60 });
          report.deferred++;
        }
        break;
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------- the backfill
export interface BackfillReport {
  dry_run: boolean;
  /** Schools with no organisation: each gets its own, named after it. */
  organizations_to_create: { school_id: string; school_name: string; organization_name: string }[];
  organizations_created: { school_id: string; organization_id: string }[];
  organizations: { id: string; name: string; status: string; platform_status: PlatformOrganizationStatus; result?: string }[];
  schools: { id: string; name: string; slug: string; organization_id: string | null; result?: string }[];
  errors: { kind: string; id: string; error: string }[];
}

/**
 * Registers every organisation, with today's status (backfill: true), then
 * every school. Schools without an organisation get their own first (in a
 * dry run they are only listed). Run it once after the webhook is
 * registered and before switch-on; running it again only re-sends names, and
 * the platform refuses a status staff have already decided (409
 * decided_on_platform), which is reported and leaves the platform's decision.
 */
export async function backfill(admin: Admin, client: PlatformClient | null, { dryRun = true } = {}): Promise<BackfillReport> {
  const report: BackfillReport = { dry_run: dryRun, organizations_to_create: [], organizations_created: [], organizations: [], schools: [], errors: [] };

  const loneSchools = (await selectAll<TenantRow>(admin, "tenants", "id, name, slug, organization_id, created_at")).filter((t) => !t.organization_id);
  report.organizations_to_create = loneSchools.map((t) => ({ school_id: t.id, school_name: t.name, organization_name: t.name }));
  if (!dryRun) {
    for (const t of loneSchools) {
      try {
        const id = await rpc<string>(admin, "platform_create_school_organization", { p_tenant_id: t.id });
        report.organizations_created.push({ school_id: t.id, organization_id: id });
      } catch (err) {
        report.errors.push({ kind: "organization_create", id: t.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // What is queued now, before anything is read: once a record's current state is sent, its row is
  // done, unless the record changed meanwhile (the version moved on), when the queue sends it again.
  const queued = new Map<string, { id: number; version: number }>();
  if (!dryRun) {
    const { data, error } = await admin.from("platform_sync_queue").select("id, kind, local_id, version").is("done_at", null);
    if (error) throw new Error(`could not read platform_sync_queue: ${error.message}`);
    for (const q of data ?? []) queued.set(`${q.kind}:${q.local_id}`, { id: q.id, version: q.version });
  }
  const sent = async (kind: "organization" | "tenant", localId: string, platformId: string | null) => {
    const q = queued.get(`${kind}:${localId}`);
    if (q) await rpc(admin, "platform_sync_done", { p_id: q.id, p_version: q.version, p_platform_id: platformId });
    else await rpc(admin, "platform_record_link", { p_kind: kind, p_local_id: localId, p_platform_id: platformId });
  };

  const organizations = await selectAll<OrganizationRow>(admin, "organizations", "id, name, contact_email, created_at, status");
  for (const o of organizations) {
    const entry: BackfillReport["organizations"][number] = { id: o.id, name: o.name, status: o.status, platform_status: platformStatusOf(o.status) };
    report.organizations.push(entry);
    if (dryRun) continue;
    try {
      let answer: OrganizationAnswer;
      try {
        answer = await client!.putOrganization(o.id, { ...organizationBody(o), status: platformStatusOf(o.status), backfill: true });
        entry.result = "registered";
      } catch (err) {
        if (!(err instanceof PlatformError && err.code === "decided_on_platform")) throw err;
        // staff have decided it on the platform already: keep their decision, send the name only
        answer = await client!.putOrganization(o.id, organizationBody(o));
        entry.result = "decided_on_platform";
      }
      await sent("organization", o.id, answer?.organization_id ?? null);
    } catch (err) {
      entry.result = "error";
      report.errors.push({ kind: "organization", id: o.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const created = new Map(report.organizations_created.map((c) => [c.school_id, c.organization_id]));
  const schools = await selectAll<TenantRow>(admin, "tenants", "id, name, slug, organization_id, created_at");
  for (const t of schools) {
    const organization_id = t.organization_id ?? created.get(t.id) ?? null;
    const entry: BackfillReport["schools"][number] = { id: t.id, name: t.name, slug: t.slug, organization_id };
    report.schools.push(entry);
    if (dryRun) continue;
    if (!organization_id) { entry.result = "error"; report.errors.push({ kind: "school", id: t.id, error: "no organisation" }); continue; }
    try {
      const answer = await client!.putTenant(t.id, tenantBody({ ...t, organization_id }));
      await sent("tenant", t.id, answer?.tenant_id ?? answer?.id ?? null);
      entry.result = "registered";
    } catch (err) {
      entry.result = "error";
      report.errors.push({ kind: "school", id: t.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

// ---------------------------------------------------------------- the reconcile
export interface ReconcileReport {
  skipped?: "not_enabled";
  checked: number;
  fixed: { organization_id: string; from: string; to: string }[];
  not_registered: string[];
  errors: { organization_id: string; error: string }[];
}

/**
 * The safety net for a missed decision (after switch-on only): asks the
 * platform for the organisations most worth checking (flagged ones, then
 * the least recently checked) and applies any difference through the same
 * decision function. Never on a request: hourly, from pg_cron.
 */
export async function reconcile(admin: Admin, client: PlatformClient, { limit = 50 } = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, fixed: [], not_registered: [], errors: [] };
  if (!(await decisionsEnabled(admin))) return { ...report, skipped: "not_enabled" };

  const candidates = (await rpc<{ organization_id: string; status: string }[]>(admin, "platform_reconcile_candidates", { p_limit: limit })) ?? [];
  for (const c of candidates) {
    try {
      const answer = await client.getOrganization(c.organization_id);
      report.checked++;
      if (answer.status !== c.status) {
        console.warn(`platform-sync: organisation ${c.organization_id} is ${c.status} here but ${answer.status} on the platform; applying the platform's`);
        const result = await rpc<{ outcome: string }>(admin, "platform_apply_organization_decision", {
          p_organization_id: c.organization_id, p_status: answer.status, p_reason: answer.status_reason ?? null,
          p_decided_by: "platform:reconcile", p_decided_at: null, p_delivery_id: null, p_source: "reconcile",
        });
        if (result?.outcome === "applied") report.fixed.push({ organization_id: c.organization_id, from: c.status, to: answer.status });
      } else {
        await rpc(admin, "platform_mark_checked", { p_organization_id: c.organization_id });
      }
    } catch (err) {
      if (err instanceof PlatformError && err.status === 404) {
        // the platform doesn't know it (yet): register it
        await rpc(admin, "platform_sync_enqueue", { p_kind: "organization", p_local_id: c.organization_id });
        report.not_registered.push(c.organization_id);
        continue;
      }
      report.errors.push({ organization_id: c.organization_id, error: err instanceof Error ? err.message : String(err) });
      if (err instanceof PlatformError && (err.status === 0 || err.status >= 500)) break; // try again next hour
    }
  }
  return report;
}

// ---------------------------------------------------------------- the webhook address
/** Where the platform should send decisions: PLATFORM_WEBHOOK_URL, or this project's platform-decisions function. */
export function decisionWebhookUrl(env: { get(name: string): string | undefined } = Deno.env, given?: unknown): string | null {
  const candidate = typeof given === "string" && given.trim() ? given.trim()
    : env.get("PLATFORM_WEBHOOK_URL")?.trim() || (env.get("SUPABASE_URL") ? `${env.get("SUPABASE_URL")!.replace(/\/+$/, "")}/functions/v1/platform-decisions` : "");
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
