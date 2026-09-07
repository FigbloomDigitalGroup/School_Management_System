import { KES, supabase } from "@figbloom/shared";
import type { Tenant } from "@figbloom/shared";
import { Badge, Cell, Mono, RecordsPage, type RecordsSpec } from "./RecordsPage";
import { Button } from "../../components/ui/Button";
import { PageHead } from "../../components/ConsoleShell";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

/**
 * The seven cross-tenant console pages. Each is data plus copy — the layout
 * comes from RecordsPage, so they stay consistent as more are added.
 *
 * Usage, Impersonation, and Audit are backed by real tables (tenants+roster
 * counts, impersonation_sessions, audit_events — all already exist with
 * super_admin-readable RLS). Health, Incidents, Subscriptions, and Invoices
 * stay illustrative: they'd need real infrastructure this schema doesn't
 * model yet (uptime/latency monitoring, an incident tracker, a billing
 * system) — building fake tables for those would just move the fakeness
 * into SQL, not fix it. That's a product decision, not a coding task.
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

export function Health() {
  const spec: RecordsSpec = {
    eyebrow: "Platform · last 24 hours",
    title: "System health",
    blurb: "Everything that has to be up for a teacher to take attendance at 08:00. Schools sit on unreliable links, so degraded is normal and worth watching before it becomes down.",
    stats: [
      { label: "Uptime 30d", value: "99.97%", sub: "SLA is 99.9%" },
      { label: "API p95", value: "212 ms", sub: "Nairobi edge" },
      { label: "Queue depth", value: "1,204", sub: "attendance sync jobs", alarming: true },
      { label: "Open incidents", value: "2", sub: "1 degraded, 1 investigating", alarming: true },
    ],
    actions: [
      { label: "Status page", onClick: () => {} },
      { label: "Declare incident", primary: true, onClick: () => {} },
    ],
    columns: [
      { key: "region", header: "Region", width: "1.4fr" },
      { key: "schools", header: "Schools", align: "right" },
      { key: "p95", header: "p95", align: "right" },
      { key: "err", header: "Error rate", align: "right" },
      { key: "status", header: "Status", width: "0.9fr" },
    ],
    chips: [{ label: "All" }, { label: "Degraded", match: ["degraded"] }],
    rows: [
      ["Nairobi metro", "94", "188 ms", "0.02%", "Healthy"],
      ["Central", "51", "204 ms", "0.03%", "Healthy"],
      ["Rift Valley", "48", "412 ms", "0.31%", "Degraded"],
      ["Nyanza", "27", "236 ms", "0.04%", "Healthy"],
      ["Western", "18", "298 ms", "0.09%", "Healthy"],
      ["Coast", "10", "521 ms", "0.44%", "Degraded"],
    ].map((r) => ({
      id: r[0]!,
      tags: [r[4] === "Degraded" ? "degraded" : "healthy"],
      cells: [
        t(r[0]!), m(r[1]!), m(r[2]!),
        <span className="font-mono text-[12.5px]" style={{ color: r[4] === "Degraded" ? "#B8460A" : undefined }}>{r[3]}</span>,
        <Badge tone={r[4] === "Degraded" ? "warn" : "ok"}>{r[4]}</Badge>,
      ],
    })),
    extra: <ServiceCards />,
  };
  return <RecordsPage spec={spec} />;
}

function ServiceCards() {
  const services = [
    { name: "API", value: "212 ms", note: "p95 latency", ok: true },
    { name: "Attendance sync", value: "backed up", note: "queue draining", ok: false },
    { name: "M-Pesa callbacks", value: "99.4%", note: "success rate", ok: true },
    { name: "SMS gateway", value: "97.1%", note: "delivery rate", ok: true },
    { name: "Report card render", value: "1.8 s", note: "median job", ok: true },
    { name: "File storage", value: "68%", note: "of provisioned", ok: true },
  ];
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
      {services.map((s) => (
        <div key={s.name} className="min-w-0 rounded-lg border border-line px-4 py-3.5">
          <div className="mb-2 flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.ok ? "#2E7D4F" : "#F26A1B" }} />
            <span className="truncate text-[13px] font-semibold">{s.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[11.5px] text-ink-faint">{s.note}</span>
            <span className="font-mono text-[11.5px]" style={{ color: s.ok ? "#2E7D4F" : "#B8460A" }}>{s.value}</span>
          </div>
        </div>
      ))}
    </div>
  );
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

export function Incidents() {
  const spec: RecordsSpec = {
    eyebrow: "Support · open and recent",
    title: "Incidents",
    blurb: "Severity is judged by what the school could not do, not by which service broke.",
    stats: [
      { label: "Open", value: "2", sub: "both under investigation", alarming: true },
      { label: "Mean time to fix", value: "42 min", sub: "last 90 days" },
      { label: "Schools affected", value: "58", sub: "in the open incidents" },
      { label: "Sev-1 this term", value: "1", sub: "resolved 14 Aug" },
    ],
    actions: [
      { label: "Postmortems", onClick: () => {} },
      { label: "Declare incident", primary: true, onClick: () => {} },
    ],
    columns: [
      { key: "sev", header: "Sev", width: "0.6fr" },
      { key: "what", header: "Incident", width: "2fr" },
      { key: "aff", header: "Affected", align: "right" },
      { key: "when", header: "Opened", align: "right" },
      { key: "status", header: "Status", width: "0.9fr" },
    ],
    chips: [
      { label: "All" },
      { label: "Open", match: ["Investigating", "Fix in review"] },
      { label: "Resolved", match: ["Resolved"] },
    ],
    minWidth: "840px",
    rows: [
      ["SEV-2", "Attendance sync backlog on the Rift Valley edge", "Teachers see yesterday's roster until the queue drains", "48 schools", "Today 06:40", "Investigating"],
      ["SEV-3", "Report card PDFs render without the school crest", "Only schools that uploaded an SVG logo", "10 schools", "Yesterday 15:12", "Fix in review"],
      ["SEV-1", "M-Pesa callbacks dropped for 22 minutes", "Parent payments succeeded but showed as unpaid", "231 schools", "14 Aug 11:03", "Resolved"],
      ["SEV-3", "SMS invites delayed up to 40 minutes", "Gateway throttled during exam registration", "63 schools", "09 Aug 08:20", "Resolved"],
      ["SEV-2", "Grade entry timed out on large classes", "Classes over 60 learners could not submit", "17 schools", "02 Aug 13:47", "Resolved"],
    ].map((r, i) => ({
      id: "inc" + i,
      tags: [r[5]!],
      cells: [
        <Badge tone={r[0] === "SEV-1" ? "warn" : r[0] === "SEV-2" ? "warn" : "muted"}>{r[0]}</Badge>,
        t(r[1]!, r[2]!), m(r[3]!),
        <span className="font-mono text-[12.5px] text-ink-muted">{r[4]}</span>,
        <Badge tone={r[5] === "Resolved" ? "ok" : r[5] === "Fix in review" ? "info" : "warn"}>{r[5]}</Badge>,
      ],
    })),
  };
  return <RecordsPage spec={spec} />;
}

export function Subscriptions() {
  const spec: RecordsSpec = {
    eyebrow: "Commercial · term 3, 2026",
    title: "Subscriptions",
    blurb: "Kenyan schools budget by term, so renewals cluster at the start of each one. Anything not renewed by week two rarely renews at all.",
    stats: [
      { label: "MRR", value: KES(412_000_00), sub: "+3.1% vs August" },
      { label: "Renewing this term", value: "84", sub: "62 confirmed" },
      { label: "In trial", value: "12", sub: "3 ending within 10 days" },
      { label: "At risk", value: "5", sub: "low adoption or unpaid", alarming: true },
    ],
    actions: [
      { label: "Plan settings", onClick: () => {} },
      { label: "Onboard a school", primary: true, onClick: () => {} },
    ],
    columns: [
      { key: "school", header: "School", width: "1.6fr" },
      { key: "plan", header: "Plan", width: "1.1fr" },
      { key: "amt", header: "Per term", align: "right" },
      { key: "renews", header: "Renews", align: "right", width: "1.1fr" },
      { key: "status", header: "Status", width: "0.9fr" },
    ],
    chips: [
      { label: "All" },
      { label: "Trial", match: ["Trial"] },
      { label: "At risk", match: ["At risk"] },
    ],
    minWidth: "800px",
    rows: [
      ["Alliance High School", "Institution", KES(214_000_00), "01 Jan 2027", "Confirmed"],
      ["Mang'u High School", "Institution", KES(202_000_00), "01 Jan 2027", "Confirmed"],
      ["Kenya High School", "Institution", KES(186_000_00), "01 Jan 2027", "Confirmed"],
      ["Lenana School", "Institution", KES(168_000_00), "01 Jan 2027", "Confirmed"],
      ["Moi Girls Eldoret", "Standard", KES(96_400_00), "01 Jan 2027", "At risk"],
      ["Kisumu Boys High", "Standard", KES(182_000_00), "01 Jan 2027", "At risk"],
      ["Nakuru Girls High", "Standard", "—", "Trial ends 10 Sep", "Trial"],
      ["Kabarak High School", "Standard", "—", "Trial ends 30 Sep", "Trial"],
    ].map((r) => ({
      id: r[0]!,
      tags: [r[4]!],
      cells: [
        t(r[0]!), <span className="text-[13px]">{r[1]}</span>, m(r[2]!),
        <span className="font-mono text-[12.5px] text-ink-muted">{r[3]}</span>,
        <Badge tone={r[4] === "Confirmed" ? "ok" : r[4] === "Trial" ? "muted" : "warn"}>{r[4]}</Badge>,
      ],
    })),
  };
  return <RecordsPage spec={spec} />;
}

export function Invoices() {
  const toast = useToast();
  const spec: RecordsSpec = {
    eyebrow: "Commercial · outstanding first",
    title: "Invoices",
    blurb: "Bursars pay from an account that is often only funded once fees come in, so late is common and suspension is a last resort. Reminders go to the bursar and the principal together.",
    stats: [
      { label: "Outstanding", value: KES(612_400_00), sub: "across 7 invoices", alarming: true },
      { label: "Overdue 30d+", value: "2", sub: "suspension scheduled", alarming: true },
      { label: "Collected this term", value: KES(11_800_000_00), sub: "94% of billed" },
      { label: "Avg days to pay", value: "18", sub: "net 14 terms" },
    ],
    actions: [
      { label: "Export for accounts", onClick: () => {} },
      { label: "Chase all overdue", primary: true, onClick: () => {} },
    ],
    columns: [
      { key: "inv", header: "Invoice", width: "1.1fr" },
      { key: "school", header: "School", width: "1.5fr" },
      { key: "amt", header: "Amount", align: "right" },
      { key: "due", header: "Due", align: "right" },
      { key: "status", header: "Status", width: "0.9fr" },
      { key: "act", header: "", align: "right" },
    ],
    chips: [
      { label: "All" },
      { label: "Overdue", match: ["overdue"] },
      { label: "Paid", match: ["paid"] },
    ],
    minWidth: "880px",
    rows: [
      ["INV-2026-0812", "Kisumu Boys High", KES(182_000_00), "01 Aug 2026", "Overdue 31d", "overdue"],
      ["INV-2026-0831", "Moi Girls Eldoret", KES(96_400_00), "18 Aug 2026", "Overdue 14d", "overdue"],
      ["INV-2026-0844", "St. Mary's Yala", KES(118_000_00), "05 Sep 2026", "Due soon", "due"],
      ["INV-2026-0790", "Alliance High School", KES(214_000_00), "01 Aug 2026", "Paid", "paid"],
      ["INV-2026-0791", "Mang'u High School", KES(202_000_00), "01 Aug 2026", "Paid", "paid"],
      ["INV-2026-0792", "Kenya High School", KES(186_000_00), "01 Aug 2026", "Paid", "paid"],
    ].map((r) => ({
      id: r[0]!,
      tags: [r[5]!],
      cells: [
        m(r[0]!), t(r[1]!), m(r[2]!),
        <span className="font-mono text-[12.5px] text-ink-muted">{r[3]}</span>,
        <Badge tone={r[5] === "paid" ? "ok" : r[5] === "due" ? "muted" : "warn"}>{r[4]}</Badge>,
        r[5] === "paid" ? null : (
          <Button onClick={() => toast(`Reminder sent to the bursar and principal at ${r[1]}`)}>Send reminder</Button>
        ),
      ],
    })),
  };
  return <RecordsPage spec={spec} />;
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

function fmtSessionWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
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
          t(r.staff_name ?? "—", fmtSessionWhen(r.started_at)), <span className="text-[13px]">{r.tenant_name ?? "—"}</span>,
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

function fmtAuditWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
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
        <span className="font-mono text-[12.5px] text-ink-muted">{fmtAuditWhen(r.created_at)}</span>,
        t(r.actor_label, r.tenant_name ?? undefined), <span className="text-[13px]">{r.event}</span>,
        <Badge tone={r.category === "financial" ? "warn" : "info"}>{CATEGORY_LABEL[r.category] ?? r.category}</Badge>,
      ],
    })),
  };
  return <RecordsPage spec={spec} />;
}
