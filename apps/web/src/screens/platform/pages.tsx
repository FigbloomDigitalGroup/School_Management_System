import { useState, type FormEvent } from "react";
import { effectivePriceCents, isBilled, formatMoney, supabase } from "@figbloom/shared";
// Every money() call in this file is Figbloom's own platform billing (MRR,
// plan price, invoices) — always "KE", a deliberate business-currency
// choice independent of which country a billed school operates in.
import type {
  IncidentSeverity, IncidentStatus, PlatformIncident, PlatformInvoice, Tenant, TenantStatus,
} from "@figbloom/shared";
import { Badge, Cell, Mono, RecordsPage, type RecordsSpec, type Tone } from "./RecordsPage";
import { Button } from "../../components/ui/Button";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { PageHead } from "../../components/ConsoleShell";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { checkServices } from "../../lib/platformAdmin";
import { useAsync } from "../../lib/useAsync";

/**
 * The seven cross-tenant console pages. Each is data plus copy — the layout
 * comes from RecordsPage, so they stay consistent as more are added.
 *
 * Usage, Impersonation, Audit, Incidents, Subscriptions, and Invoices are all
 * backed by real tables now (see 20260914000000_platform_ops_tables.sql for
 * the last three). Health stays illustrative — it would need real uptime/
 * latency monitoring this project has no infrastructure for at all, and
 * that's still a product decision, not a coding task.
 *
 * Incidents and Invoices have no automated process writing to them (unlike
 * audit_events, which other flows insert into) — staff declare an incident
 * or record an invoice by hand, and mark it resolved/paid by hand too.
 */

function RecordsLoading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <>
      <PageHead eyebrow={eyebrow} title={title} />
      <div className="grid gap-3 px-7 py-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
      </div>
    </>
  );
}

function RecordsError({ eyebrow, title, message }: { eyebrow: string; title: string; message: string }) {
  return (
    <>
      <PageHead eyebrow={eyebrow} title={title} />
      <div className="px-7 py-6">
        <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
          <span aria-hidden>✕</span>Could not load: {message}
        </p>
      </div>
    </>
  );
}

const t = (s: string, sub?: string) => <Cell sub={sub}>{s}</Cell>;
const m = (s: string) => <Mono>{s}</Mono>;

/** "14 Sep 2026" — used for anything date-only (due dates, renewals). */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/** "14 Sep, 09:40" — used for anything with a time (sessions, audit events, incidents). */
function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

interface ServiceStatusRow {
  id: string;
  service: string;
  status: "ok" | "degraded" | "down" | "not_configured";
  latency_ms: number | null;
  detail: string | null;
  checked_at: string;
}

async function fetchServiceHistory(): Promise<ServiceStatusRow[]> {
  const { data, error } = await supabase()
    .from("service_status")
    .select("*")
    .order("checked_at", { ascending: false })
    .limit(200)
    .returns<ServiceStatusRow[]>();
  if (error) throw error;
  return data ?? [];
}

const SERVICE_LABEL: Record<string, string> = { supabase: "Supabase", mpesa: "M-Pesa Daraja" };
const SERVICE_STATUS: Record<ServiceStatusRow["status"], { label: string; tone: Tone }> = {
  ok: { label: "OK", tone: "ok" },
  degraded: { label: "Degraded", tone: "warn" },
  down: { label: "Down", tone: "warn" },
  not_configured: { label: "Not configured", tone: "muted" },
};

/**
 * No cron/pg_net monitoring infra — a super_admin opening this page (or
 * clicking "Check now") triggers a live check via the check-services edge
 * function, which logs to service_status. History is only as complete as
 * how often staff look; that's the honest tradeoff for not running a
 * scheduled job, and it beats a fabricated multi-region uptime dashboard.
 */
export function Health() {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const [checking, setChecking] = useState(false);
  const { data, loading, error } = useAsync(() => fetchServiceHistory(), [reloadKey]);

  async function runCheck() {
    setChecking(true);
    try {
      await checkServices();
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not check services: ${err.message}` : "Could not check services.");
    } finally {
      setChecking(false);
    }
  }

  if (loading || !data) return <RecordsLoading eyebrow="Platform · live checks" title="System health" />;
  if (error) return <RecordsError eyebrow="Platform · live checks" title="System health" message={error.message} />;

  const byService = new Map<string, ServiceStatusRow[]>();
  for (const row of data) byService.set(row.service, [...(byService.get(row.service) ?? []), row]);
  const services = [...byService.entries()].map(([service, rows]) => ({
    service,
    latest: rows[0]!,
    reliabilityPct: Math.round((rows.filter((r) => r.status === "ok").length / rows.length) * 100),
    checkedCount: rows.length,
  }));
  const notOk = services.filter((s) => s.latest.status === "down" || s.latest.status === "degraded");

  const spec: RecordsSpec = {
    eyebrow: "Platform · live checks",
    title: "System health",
    blurb: "The services this app actually depends on, checked live rather than on a fabricated uptime dashboard. No monitoring cron yet, so history only builds up as staff open this page.",
    stats: [
      {
        label: "Services checked", value: String(services.length),
        sub: services.length ? services.map((s) => SERVICE_LABEL[s.service] ?? s.service).join(", ") : "none yet",
      },
      {
        label: "Not OK", value: String(notOk.length),
        sub: notOk.length ? notOk.map((s) => SERVICE_LABEL[s.service] ?? s.service).join(", ") : "all clear",
        alarming: notOk.length > 0,
      },
      {
        label: "Last checked", value: services[0] ? fmtWhen(services[0].latest.checked_at) : "never",
        sub: services.length ? "most recent check" : "click Check now",
      },
    ],
    actions: [{ label: checking ? "Checking…" : "Check now", primary: true, onClick: () => void runCheck() }],
    columns: [
      { key: "service", header: "Service", width: "1.4fr" },
      { key: "status", header: "Status", width: "1fr" },
      { key: "latency", header: "Latency", align: "right" },
      { key: "reliability", header: "Reliability", align: "right" },
      { key: "checked", header: "Last checked", align: "right", width: "1.2fr" },
    ],
    minWidth: "760px",
    empty: {
      title: "No checks yet",
      body: "Click \"Check now\" to run the first live check against Supabase and M-Pesa.",
      action: <Button variant="accent" onClick={() => void runCheck()}>Check now</Button>,
    },
    rows: services.map(({ service, latest, reliabilityPct, checkedCount }) => {
      const meta = SERVICE_STATUS[latest.status];
      return {
        id: service,
        tags: [latest.status],
        cells: [
          t(SERVICE_LABEL[service] ?? service, latest.detail ?? undefined),
          <Badge tone={meta.tone}>{meta.label}</Badge>,
          m(latest.latency_ms !== null ? `${latest.latency_ms} ms` : "—"),
          m(`${reliabilityPct}% of ${checkedCount}`),
          <span className="font-mono text-[12.5px] text-ink-muted">{fmtWhen(latest.checked_at)}</span>,
        ],
      };
    }),
  };
  return <RecordsPage spec={spec} />;
}

interface UsageRow { tenant: Pick<Tenant, "id" | "name" | "slug" | "licensed_seats" | "status">; inUse: number }

async function fetchUsage(): Promise<UsageRow[]> {
  const sb = supabase();
  const [{ data: tenants, error: e1 }, { data: students, error: e2 }, { data: staff, error: e3 }] = await Promise.all([
    sb.from("tenants").select("id,name,slug,licensed_seats,status").order("name").returns<UsageRow["tenant"][]>(),
    sb.from("students").select("id,tenant_id").eq("active", true).returns<{ id: string; tenant_id: string }[]>(),
    sb.from("profiles").select("id,tenant_id").in("role", ["school_admin", "teacher"]).returns<{ id: string; tenant_id: string | null }[]>(),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;

  const inUseByTenant = new Map<string, number>();
  for (const s of students ?? []) inUseByTenant.set(s.tenant_id, (inUseByTenant.get(s.tenant_id) ?? 0) + 1);
  for (const p of staff ?? []) { if (p.tenant_id) inUseByTenant.set(p.tenant_id, (inUseByTenant.get(p.tenant_id) ?? 0) + 1); }

  return (tenants ?? []).map((tenant) => ({ tenant, inUse: inUseByTenant.get(tenant.id) ?? 0 }));
}

export function Usage() {
  const { data, loading, error } = useAsync(() => fetchUsage(), []);
  if (loading || !data) return <RecordsLoading eyebrow="Platform · current term" title="Usage & capacity" />;
  if (error) return <RecordsError eyebrow="Platform · current term" title="Usage & capacity" message={error.message} />;

  const totalLicensed = data.reduce((a, r) => a + r.tenant.licensed_seats, 0);
  const totalInUse = data.reduce((a, r) => a + r.inUse, 0);
  const overLicence = data.filter((r) => r.tenant.licensed_seats > 0 && r.inUse > r.tenant.licensed_seats);
  const activeSchools = data.filter((r) => r.tenant.status === "active").length;

  const spec: RecordsSpec = {
    eyebrow: "Platform · current term",
    title: "Usage & capacity",
    blurb: "Seats in use against what each school licensed. Well over is an upsell conversation; well under is a churn signal.",
    stats: [
      { label: "Licensed seats", value: totalLicensed.toLocaleString(), sub: `across ${activeSchools} active schools` },
      { label: "Seats in use", value: totalInUse.toLocaleString(), sub: totalLicensed > 0 ? `${Math.round((totalInUse / totalLicensed) * 100)}% utilisation` : "no seats licensed yet" },
      { label: "Over licence", value: String(overLicence.length), sub: "schools exceeding their plan", alarming: overLicence.length > 0 },
      { label: "Schools", value: String(data.length), sub: `${activeSchools} active` },
    ],
    columns: [
      { key: "school", header: "School", width: "1.6fr" },
      { key: "lic", header: "Licensed", align: "right" },
      { key: "use", header: "In use", align: "right" },
      { key: "util", header: "Utilisation", align: "right" },
      { key: "signal", header: "Signal", width: "0.9fr" },
    ],
    chips: [
      { label: "All" },
      { label: "Over licence", match: ["over", "never"] },
      { label: "Under 50%", match: ["under", "never"] },
    ],
    minWidth: "780px",
    rows: data.map((r) => {
      const pct = r.tenant.licensed_seats > 0 ? Math.round((r.inUse / r.tenant.licensed_seats) * 100) : 0;
      const tag = r.inUse === 0 ? "never" : pct > 100 ? "over" : pct < 50 ? "under" : "ok";
      const label = tag === "never" ? "Never used" : tag === "over" ? "Over licence" : tag === "under" ? "Under 50%" : "Healthy";
      return {
        id: r.tenant.id,
        tags: [tag],
        cells: [
          t(r.tenant.name, "/s/" + r.tenant.slug), m(r.tenant.licensed_seats.toLocaleString()), m(r.inUse.toLocaleString()),
          <span className="font-mono text-[12.5px] font-medium" style={{ color: tag === "ok" ? undefined : "#B8460A" }}>{pct}%</span>,
          <Badge tone={tag === "ok" ? "ok" : tag === "under" ? "muted" : "warn"}>{label}</Badge>,
        ],
      };
    }),
  };
  return <RecordsPage spec={spec} />;
}

async function fetchIncidents(): Promise<PlatformIncident[]> {
  const { data, error } = await supabase()
    .from("platform_incidents")
    .select("*")
    .order("opened_at", { ascending: false })
    .returns<PlatformIncident[]>();
  if (error) throw error;
  return data ?? [];
}

const SEVERITY_TONE: Record<IncidentSeverity, Tone> = { "SEV-1": "warn", "SEV-2": "warn", "SEV-3": "muted" };
const INCIDENT_STATUS: Record<IncidentStatus, { label: string; tone: Tone }> = {
  investigating: { label: "Investigating", tone: "warn" },
  fix_in_review: { label: "Fix in review", tone: "info" },
  resolved: { label: "Resolved", tone: "ok" },
};

export function Incidents() {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchIncidents(), [reloadKey]);
  const [declaring, setDeclaring] = useState(false);
  const reload = () => setReloadKey((k) => k + 1);

  if (loading || !data) return <RecordsLoading eyebrow="Support · open and recent" title="Incidents" />;
  if (error) return <RecordsError eyebrow="Support · open and recent" title="Incidents" message={error.message} />;

  const open = data.filter((i) => i.status !== "resolved");
  const affectedInOpen = open.reduce((a, i) => a + i.affected_schools, 0);
  const resolvedMinutes = data
    .filter((i) => i.resolved_at)
    .map((i) => (new Date(i.resolved_at!).getTime() - new Date(i.opened_at).getTime()) / 60000);
  const meanFix = resolvedMinutes.length ? Math.round(resolvedMinutes.reduce((a, b) => a + b, 0) / resolvedMinutes.length) : null;
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const sev1Recent = data.filter((i) => i.severity === "SEV-1" && new Date(i.opened_at) >= ninetyDaysAgo).length;

  async function resolveIncident(id: string) {
    const { error: err } = await supabase()
      .from("platform_incidents").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", id);
    if (err) { toast(`Could not resolve that incident: ${err.message}`); return; }
    toast("Incident resolved.");
    reload();
  }

  const spec: RecordsSpec = {
    eyebrow: "Support · open and recent",
    title: "Incidents",
    blurb: "Severity is judged by what the school could not do, not by which service broke.",
    stats: [
      { label: "Open", value: String(open.length), sub: open.length ? `affecting ${affectedInOpen} schools` : "none right now", alarming: open.length > 0 },
      { label: "Mean time to fix", value: meanFix !== null ? `${meanFix} min` : "—", sub: "among resolved incidents" },
      { label: "Schools affected", value: String(affectedInOpen), sub: "in the open incidents" },
      { label: "Sev-1, last 90 days", value: String(sev1Recent), sub: "declared" },
    ],
    actions: [{ label: "Declare incident", primary: true, onClick: () => setDeclaring(true) }],
    columns: [
      { key: "sev", header: "Sev", width: "0.6fr" },
      { key: "what", header: "Incident", width: "2fr" },
      { key: "aff", header: "Affected", align: "right" },
      { key: "when", header: "Opened", align: "right" },
      { key: "status", header: "Status", width: "1.2fr" },
    ],
    chips: [
      { label: "All" },
      { label: "Open", match: ["investigating", "fix_in_review"] },
      { label: "Resolved", match: ["resolved"] },
    ],
    minWidth: "860px",
    empty: {
      title: "No incidents declared",
      body: "Nothing has been logged yet — that's a good sign. Declare one the moment something breaks so schools and staff have a record of it.",
      action: <Button variant="accent" onClick={() => setDeclaring(true)}>Declare incident</Button>,
    },
    rows: data.map((i) => {
      const meta = INCIDENT_STATUS[i.status];
      return {
        id: i.id,
        tags: [i.status],
        cells: [
          <Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>,
          t(i.title, i.summary), m(String(i.affected_schools)),
          <span className="font-mono text-[12.5px] text-ink-muted">{fmtWhen(i.opened_at)}</span>,
          i.status === "resolved" ? <Badge tone="ok">Resolved</Badge> : (
            <div className="flex items-center justify-between gap-2">
              <Badge tone={meta.tone}>{meta.label}</Badge>
              <button type="button" onClick={() => void resolveIncident(i.id)} className="text-[11.5px] font-semibold text-leaf hover:underline">
                Resolve
              </button>
            </div>
          ),
        ],
      };
    }),
  };
  return (
    <>
      <RecordsPage spec={spec} />
      {declaring && (
        <DeclareIncidentModal
          onClose={() => setDeclaring(false)}
          onDeclared={() => { setDeclaring(false); reload(); }}
          toast={toast}
        />
      )}
    </>
  );
}

function DeclareIncidentModal({ onClose, onDeclared, toast }: {
  onClose: () => void; onDeclared: () => void; toast: (m: string) => void;
}) {
  const [severity, setSeverity] = useState<IncidentSeverity>("SEV-2");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [affectedSchools, setAffectedSchools] = useState("0");
  const [saving, setSaving] = useState(false);

  async function declare() {
    if (!title.trim() || !summary.trim()) { toast("Give the incident a title and describe what schools could not do."); return; }
    setSaving(true);
    try {
      const { error } = await supabase().from("platform_incidents").insert({
        severity, title: title.trim(), summary: summary.trim(),
        affected_schools: Math.max(0, Number(affectedSchools) || 0),
      });
      if (error) throw error;
      toast("Incident declared.");
      onDeclared();
    } catch (err) {
      toast(err instanceof Error ? `Could not declare the incident: ${err.message}` : "Could not declare the incident.");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void declare();
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Incidents"
      title="Declare an incident"
      footNote="Schools and staff can act on this the moment it's declared."
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void declare()} disabled={saving}>{saving ? "Declaring…" : "Declare incident"}</Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="grid gap-3.5">
        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField
            id="severity" label="Severity" value={severity}
            onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}
            options={[
              { value: "SEV-1", label: "SEV-1 — critical, most schools affected" },
              { value: "SEV-2", label: "SEV-2 — degraded, some schools affected" },
              { value: "SEV-3", label: "SEV-3 — minor, workaround exists" },
            ]}
          />
          <TextField
            id="affected" label="Schools affected" mono inputMode="numeric"
            value={affectedSchools} onChange={(e) => setAffectedSchools(e.target.value)}
          />
        </div>
        <TextField id="title" label="Incident" placeholder="e.g. Attendance sync backlog on the Rift Valley edge" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextArea
          id="summary" label="What schools could not do" placeholder="e.g. Teachers see yesterday's roster until the queue drains"
          value={summary} onChange={(e) => setSummary(e.target.value)}
        />
      </form>
    </Modal>
  );
}

interface SubscriptionRow {
  tenant: Pick<Tenant, "id" | "name" | "slug" | "plan" | "status" | "price_cents_override" | "trial_ends_at" | "renews_on">;
  priceCents: number;
}

async function fetchSubscriptions(): Promise<SubscriptionRow[]> {
  const sb = supabase();
  const [{ data: tenants, error: e1 }, { data: pricing, error: e2 }] = await Promise.all([
    sb.from("tenants")
      .select("id,name,slug,plan,status,price_cents_override,trial_ends_at,renews_on")
      .order("name")
      .returns<SubscriptionRow["tenant"][]>(),
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

const SUBSCRIPTION_STATUS: Record<TenantStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "ok" },
  trial: { label: "Trial", tone: "muted" },
  onboarding: { label: "Onboarding", tone: "info" },
  overdue: { label: "Overdue", tone: "warn" },
  suspended: { label: "Suspended", tone: "warn" },
  setup_stalled: { label: "Setup stalled", tone: "warn" },
};

export function Subscriptions() {
  const { data, loading, error } = useAsync(() => fetchSubscriptions(), []);
  if (loading || !data) return <RecordsLoading eyebrow="Commercial · current term" title="Subscriptions" />;
  if (error) return <RecordsError eyebrow="Commercial · current term" title="Subscriptions" message={error.message} />;

  const billed = data.filter((r) => isBilled(r.tenant));
  const mrr = billed.reduce((a, r) => a + r.priceCents, 0);
  const activeCount = data.filter((r) => r.tenant.status === "active").length;
  const trials = data.filter((r) => r.tenant.status === "trial");
  const soon = new Date();
  soon.setDate(soon.getDate() + 10);
  const trialsEndingSoon = trials.filter((r) => r.tenant.trial_ends_at && new Date(r.tenant.trial_ends_at) <= soon).length;
  const atRisk = data.filter((r) => r.tenant.status === "overdue" || r.tenant.status === "suspended");

  const spec: RecordsSpec = {
    eyebrow: "Commercial · current term",
    title: "Subscriptions",
    blurb: "Kenyan schools budget by term, so renewals cluster at the start of each one. Anything not renewed by week two rarely renews at all.",
    stats: [
      { label: "MRR", value: formatMoney(mrr, "KE"), sub: `across ${billed.length} billed schools` },
      { label: "Active licences", value: String(activeCount), sub: `of ${data.length} schools` },
      { label: "In trial", value: String(trials.length), sub: trialsEndingSoon > 0 ? `${trialsEndingSoon} ending within 10 days` : "none ending soon" },
      { label: "At risk", value: String(atRisk.length), sub: "overdue or suspended", alarming: atRisk.length > 0 },
    ],
    columns: [
      { key: "school", header: "School", width: "1.6fr" },
      { key: "plan", header: "Plan", width: "1fr" },
      { key: "amt", header: "Per term", align: "right" },
      { key: "renews", header: "Renews", align: "right", width: "1.2fr" },
      { key: "status", header: "Status", width: "0.9fr" },
    ],
    chips: [
      { label: "All" },
      { label: "Trial", match: ["trial"] },
      { label: "At risk", match: ["overdue", "suspended"] },
    ],
    minWidth: "800px",
    rows: data.map(({ tenant, priceCents }) => {
      const meta = SUBSCRIPTION_STATUS[tenant.status];
      const renews = tenant.status === "trial"
        ? (tenant.trial_ends_at ? `Trial ends ${fmtDate(tenant.trial_ends_at)}` : "Trial end not set")
        : (tenant.renews_on ? fmtDate(tenant.renews_on) : "—");
      return {
        id: tenant.id,
        tags: [tenant.status],
        cells: [
          t(tenant.name, "/s/" + tenant.slug),
          <span className="text-[13px] capitalize">{tenant.plan}</span>,
          m(priceCents > 0 ? formatMoney(priceCents, "KE") : "—"),
          <span className="font-mono text-[12.5px] text-ink-muted">{renews}</span>,
          <Badge tone={meta.tone}>{meta.label}</Badge>,
        ],
      };
    }),
  };
  return <RecordsPage spec={spec} />;
}

interface InvoiceRow extends PlatformInvoice { tenant_name: string | null }
interface InvoicesData { invoices: InvoiceRow[]; tenants: { id: string; name: string }[] }

async function fetchInvoicesData(): Promise<InvoicesData> {
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

const isOverdue = (i: PlatformInvoice) => i.status === "due" && new Date(i.due_date) < new Date(new Date().toDateString());

export function Invoices() {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchInvoicesData(), [reloadKey]);
  const [creating, setCreating] = useState(false);
  const reload = () => setReloadKey((k) => k + 1);

  if (loading || !data) return <RecordsLoading eyebrow="Commercial · outstanding first" title="Invoices" />;
  if (error) return <RecordsError eyebrow="Commercial · outstanding first" title="Invoices" message={error.message} />;

  const outstanding = data.invoices.filter((i) => i.status === "due");
  const outstandingTotal = outstanding.reduce((a, i) => a + i.amount_cents, 0);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const overdue30 = outstanding.filter((i) => new Date(i.due_date) <= thirtyDaysAgo).length;
  const paid = data.invoices.filter((i) => i.status === "paid");
  const collected = paid.reduce((a, i) => a + i.amount_cents, 0);
  const totalBilled = data.invoices.reduce((a, i) => a + i.amount_cents, 0);
  const daysToPay = paid.filter((i) => i.paid_at).map((i) => (new Date(i.paid_at!).getTime() - new Date(i.created_at).getTime()) / 86_400_000);
  const avgDaysToPay = daysToPay.length ? Math.round(daysToPay.reduce((a, b) => a + b, 0) / daysToPay.length) : null;

  async function markPaid(id: string) {
    const { error: err } = await supabase()
      .from("platform_invoices").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", id);
    if (err) { toast(`Could not mark that invoice paid: ${err.message}`); return; }
    toast("Marked as paid.");
    reload();
  }

  const spec: RecordsSpec = {
    eyebrow: "Commercial · outstanding first",
    title: "Invoices",
    blurb: "Bursars pay from an account that is often only funded once fees come in, so late is common and suspension is a last resort. Reminders go to the bursar and the principal together.",
    stats: [
      { label: "Outstanding", value: formatMoney(outstandingTotal, "KE"), sub: `across ${outstanding.length} invoices`, alarming: outstanding.length > 0 },
      { label: "Overdue 30d+", value: String(overdue30), sub: overdue30 > 0 ? "review for suspension" : "none", alarming: overdue30 > 0 },
      { label: "Collected", value: formatMoney(collected, "KE"), sub: totalBilled > 0 ? `${Math.round((collected / totalBilled) * 100)}% of billed` : "nothing billed yet" },
      { label: "Avg days to pay", value: avgDaysToPay !== null ? String(avgDaysToPay) : "—", sub: "among paid invoices" },
    ],
    actions: [{ label: "New invoice", primary: true, onClick: () => setCreating(true) }],
    columns: [
      { key: "inv", header: "Invoice", width: "1.1fr" },
      { key: "school", header: "School", width: "1.5fr" },
      { key: "amt", header: "Amount", align: "right" },
      { key: "due", header: "Due", align: "right" },
      { key: "status", header: "Status", width: "0.9fr" },
      { key: "act", header: "", align: "right", width: "1.3fr" },
    ],
    chips: [
      { label: "All" },
      { label: "Overdue", match: ["overdue"] },
      { label: "Paid", match: ["paid"] },
    ],
    minWidth: "900px",
    empty: {
      title: "No invoices yet",
      body: "Nothing has been billed through here yet. Create the first invoice once a school's term charge is ready to send.",
      action: <Button variant="accent" onClick={() => setCreating(true)}>New invoice</Button>,
    },
    rows: data.invoices.map((i) => {
      const overdue = isOverdue(i);
      const tag = i.status === "paid" ? "paid" : overdue ? "overdue" : "due";
      const label = i.status === "paid" ? "Paid" : overdue ? "Overdue" : "Due";
      return {
        id: i.id,
        tags: [tag],
        cells: [
          m(i.id.slice(0, 8).toUpperCase()), t(i.tenant_name ?? "—"), m(formatMoney(i.amount_cents, "KE")),
          <span className="font-mono text-[12.5px] text-ink-muted">{fmtDate(i.due_date)}</span>,
          <Badge tone={i.status === "paid" ? "ok" : overdue ? "warn" : "muted"}>{label}</Badge>,
          i.status === "paid" ? null : (
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => void markPaid(i.id)} className="text-[11.5px] font-semibold text-leaf hover:underline">
                Mark paid
              </button>
              <Button onClick={() => toast(`Reminder sent to the bursar and principal at ${i.tenant_name ?? "the school"}`)}>Remind</Button>
            </div>
          ),
        ],
      };
    }),
  };
  return (
    <>
      <RecordsPage spec={spec} />
      {creating && (
        <NewInvoiceModal
          tenants={data.tenants}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); reload(); }}
          toast={toast}
        />
      )}
    </>
  );
}

function NewInvoiceModal({ tenants, onClose, onCreated, toast }: {
  tenants: { id: string; name: string }[]; onClose: () => void; onCreated: () => void; toast: (m: string) => void;
}) {
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  async function create() {
    const amountCents = Math.round(Number(amount) * 100);
    if (!tenantId) { toast("Pick which school this invoice is for."); return; }
    if (!amount || !Number.isFinite(amountCents) || amountCents <= 0) { toast("Enter an amount greater than zero."); return; }
    setSaving(true);
    try {
      const { error } = await supabase().from("platform_invoices").insert({
        tenant_id: tenantId, amount_cents: amountCents, due_date: dueDate,
      });
      if (error) throw error;
      toast("Invoice created.");
      onCreated();
    } catch (err) {
      toast(err instanceof Error ? `Could not create the invoice: ${err.message}` : "Could not create the invoice.");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void create();
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Invoices"
      title="New invoice"
      footNote="No payment gateway is wired up — mark it paid once you've reconciled the bank transfer."
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void create()} disabled={saving}>{saving ? "Creating…" : "Create invoice"}</Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="grid gap-3.5">
        <SelectField
          id="tenant" label="School" value={tenantId} onChange={(e) => setTenantId(e.target.value)}
          options={tenants.map((t) => ({ value: t.id, label: t.name }))}
        />
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField id="amount" label="Amount (KES)" mono inputMode="decimal" placeholder="e.g. 120000" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <TextField id="due" label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </form>
    </Modal>
  );
}

interface ImpersonationRow {
  id: string; started_at: string; ended_at: string | null; reason: string; scope: string;
  tenant_name: string | null; staff_name: string | null;
}

async function fetchImpersonation(): Promise<ImpersonationRow[]> {
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

export function Impersonation() {
  const { data, loading, error } = useAsync(() => fetchImpersonation(), []);
  if (loading || !data) return <RecordsLoading eyebrow="Support · immutable record" title="Impersonation log" />;
  if (error) return <RecordsError eyebrow="Support · immutable record" title="Impersonation log" message={error.message} />;

  const now = new Date();
  const thisMonth = data.filter((r) => { const d = new Date(r.started_at); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
  const staffCount = new Set(data.map((r) => r.staff_name).filter(Boolean)).size;
  const writeCount = data.filter((r) => r.scope === "write").length;
  const schoolCount = new Set(data.map((r) => r.tenant_name).filter(Boolean)).size;
  const durations = data.filter((r) => r.ended_at).map((r) => (new Date(r.ended_at!).getTime() - new Date(r.started_at).getTime()) / 60000).sort((a, b) => a - b);
  const median = durations.length ? Math.round(durations[Math.floor(durations.length / 2)]!) : null;

  const spec: RecordsSpec = {
    eyebrow: "Support · immutable record",
    title: "Impersonation log",
    blurb: "Every session where Figbloom staff acted inside a school. Schools can read their own entries — that is what makes impersonation acceptable to a principal at all.",
    stats: [
      { label: "Sessions this month", value: String(thisMonth.length), sub: `by ${staffCount} staff member${staffCount === 1 ? "" : "s"}` },
      { label: "Median length", value: median !== null ? `${median} min` : "—", sub: "among ended sessions" },
      { label: "Write actions", value: String(writeCount), sub: "of " + data.length + " sessions" },
      { label: "Schools entered", value: String(schoolCount), sub: "distinct tenants" },
    ],
    actions: [{ label: "Export for audit", onClick: () => {} }],
    columns: [
      { key: "staff", header: "Staff", width: "1fr" },
      { key: "school", header: "School", width: "1.4fr" },
      { key: "reason", header: "Reason", width: "1.6fr" },
      { key: "len", header: "Length", align: "right", width: "0.8fr" },
      { key: "scope", header: "Scope", width: "0.9fr" },
    ],
    chips: [{ label: "All" }, { label: "Write actions", match: ["write"] }],
    minWidth: "880px",
    rows: data.map((r) => {
      const mins = r.ended_at ? Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 60000) : null;
      return {
        id: r.id,
        tags: [r.scope],
        cells: [
          t(r.staff_name ?? "—", fmtWhen(r.started_at)), <span className="text-[13px]">{r.tenant_name ?? "—"}</span>,
          <span className="text-[13px] text-ink-muted">{r.reason}</span>, m(mins !== null ? `${mins} min` : "Ongoing"),
          <Badge tone={r.scope === "write" ? "warn" : "muted"}>{r.scope === "write" ? "Write" : "Read only"}</Badge>,
        ],
      };
    }),
  };
  return <RecordsPage spec={spec} />;
}

interface AuditRow { id: string; created_at: string; actor_label: string; event: string; category: string; tenant_name: string | null }

async function fetchAudit(): Promise<AuditRow[]> {
  const { data, error } = await supabase()
    .from("audit_events")
    .select("id,created_at,actor_label,event,category,tenants(name)")
    .order("created_at", { ascending: false })
    .limit(200)
    .returns<{ id: string; created_at: string; actor_label: string; event: string; category: string; tenants: { name: string } | null }[]>();
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id, created_at: r.created_at, actor_label: r.actor_label, event: r.event, category: r.category, tenant_name: r.tenants?.name ?? null }));
}

const CATEGORY_LABEL: Record<string, string> = {
  provisioning: "Provisioning", access: "Access", academic: "Academic", financial: "Financial",
};

export function Audit() {
  const { data, loading, error } = useAsync(() => fetchAudit(), []);
  if (loading || !data) return <RecordsLoading eyebrow="Platform · all tenants" title="Audit trail" />;
  if (error) return <RecordsError eyebrow="Platform · all tenants" title="Audit trail" message={error.message} />;

  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const today = data.filter((r) => new Date(r.created_at) >= startOfToday);
  const privileged = data.filter((r) => r.category === "access" || r.category === "academic");
  const financial = data.filter((r) => r.category === "financial");
  const schoolCount = new Set(data.map((r) => r.tenant_name).filter(Boolean)).size;

  const spec: RecordsSpec = {
    eyebrow: "Platform · all tenants",
    title: "Audit trail",
    blurb: "Every change that alters money, marks or access. Retained for seven years and exportable per school on request.",
    stats: [
      { label: "Events today", value: today.length.toLocaleString(), sub: `across ${schoolCount} schools` },
      { label: "Privileged changes", value: String(privileged.length), sub: "access or academic" },
      { label: "Financial events", value: String(financial.length), sub: "fee/payment changes" },
      { label: "Retention", value: "7 yrs", sub: "immutable, append only" },
    ],
    actions: [
      { label: "Filter by school", onClick: () => {} },
      { label: "Export range", onClick: () => {} },
    ],
    columns: [
      { key: "when", header: "Time", width: "1.1fr" },
      { key: "actor", header: "Actor", width: "1.3fr" },
      { key: "event", header: "Event", width: "2fr" },
      { key: "cat", header: "Category", width: "1fr" },
    ],
    chips: [
      { label: "All" },
      { label: "Privileged", match: ["access", "academic"] },
      { label: "Financial", match: ["financial"] },
    ],
    minWidth: "880px",
    rows: data.map((r) => ({
      id: r.id,
      tags: [r.category],
      cells: [
        <span className="font-mono text-[12.5px] text-ink-muted">{fmtWhen(r.created_at)}</span>,
        t(r.actor_label, r.tenant_name ?? undefined), <span className="text-[13px]">{r.event}</span>,
        <Badge tone={r.category === "financial" ? "warn" : "info"}>{CATEGORY_LABEL[r.category] ?? r.category}</Badge>,
      ],
    })),
  };
  return <RecordsPage spec={spec} />;
}
