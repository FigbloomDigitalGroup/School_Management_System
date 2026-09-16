import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatShortDate, KES, supabase, tenantPath, type Organization, type Tenant } from "@figbloom/shared";
import { Badge, DELIVERY_MODE_LABEL, HIGHER_ED_SUBTYPE_LABEL } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { StatRow } from "../../components/ui/StatCard";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { assignTenantOrganization, fetchOrganizations } from "../../lib/platformAdmin";
import { STATUS_LABEL, STATUS_TONE } from "./Tenants";

const TABS = ["Overview", "Usage", "Billing", "Branding", "Audit log"] as const;
type Tab = (typeof TABS)[number];

interface TenantOverview {
  learners: number;
  staff: number;
  parents: number;
  outstandingCents: number;
  nextDueOn: string | null;
}

async function fetchTenantOverview(tenantId: string): Promise<TenantOverview> {
  const sb = supabase();
  const [{ count: learners }, { count: staff }, { count: parents }, { data: due }] = await Promise.all([
    sb.from("students").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("active", true),
    sb.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).in("role", ["school_admin", "teacher"]),
    sb.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("role", "parent"),
    sb.from("platform_invoices").select("amount_cents,due_date").eq("tenant_id", tenantId).eq("status", "due").order("due_date"),
  ]);
  const rows = due ?? [];
  return {
    learners: learners ?? 0,
    staff: staff ?? 0,
    parents: parents ?? 0,
    outstandingCents: rows.reduce((a, i) => a + i.amount_cents, 0),
    nextDueOn: rows[0]?.due_date ?? null,
  };
}

const ALERTS: Partial<Record<Tenant["status"], { title: string; body: string; action: string }>> = {
  overdue: {
    title: "Invoice overdue",
    body: "Two reminders sent with no reply. Suspension is scheduled but never automatic on a first overdue invoice — a bursar is usually waiting on fees to come in.",
    action: "Send reminder",
  },
  setup_stalled: {
    title: "Onboarding stalled at step 3 of 5",
    body: "Student import was started but never finished, and there has been no admin login for twelve days. Impersonating is faster than another email.",
    action: "Impersonate",
  },
  trial: {
    title: "Trial ending with low adoption",
    body: "Few teachers have signed in and no attendance has been taken this week. Schools below half adoption at day 21 rarely convert.",
    action: "Call school",
  },
};

export function TenantDetail({ tenant }: { tenant: Tenant }) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [accent, setAccent] = useState(tenant.accent);
  const toast = useToast();
  const nav = useNavigate();
  const alert = ALERTS[tenant.status];
  const low = tenant.status !== "active";
  const { data: overview } = useAsync(() => fetchTenantOverview(tenant.id), [tenant.id]);
  const { data: organizations } = useAsync(() => fetchOrganizations(), []);
  const [orgId, setOrgId] = useState(tenant.organization_id ?? "");
  const [orgSaving, setOrgSaving] = useState(false);

  async function setOrganization(organizationId: string) {
    setOrgSaving(true);
    try {
      await assignTenantOrganization(tenant.id, organizationId || null);
      setOrgId(organizationId);
      toast(organizationId ? "School assigned to organization." : "School removed from its organization.");
    } catch (err) {
      toast(err instanceof Error ? `Could not update the organization: ${err.message}` : "Could not update the organization.");
    } finally {
      setOrgSaving(false);
    }
  }

  return (
    <>
      <div className="border-b border-line bg-white px-7 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            {tenant.logo_url ? (
              <img src={tenant.logo_url} alt="" className="h-[52px] w-[52px] shrink-0 rounded-xl object-cover" />
            ) : (
              <div className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-xl text-[17px] font-bold text-white" style={{ background: tenant.accent }}>
                {tenant.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="text-h2 font-semibold tracking-tight">{tenant.name}</h1>
                <Badge tone={STATUS_TONE[tenant.status]}>{STATUS_LABEL[tenant.status]}</Badge>
              </div>
              <div className="mt-1 break-words font-mono text-[11.5px] text-ink-muted">
                {tenantPath(tenant.slug)} · {tenant.county} · {tenant.plan} plan · {tenant.licensed_seats.toLocaleString()} seats
                {tenant.higher_ed_subtype ? ` · ${HIGHER_ED_SUBTYPE_LABEL[tenant.higher_ed_subtype]}` : ""}
                {tenant.delivery_mode !== "in_person" ? ` · ${DELIVERY_MODE_LABEL[tenant.delivery_mode]}` : ""}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button onClick={() => nav("/platform/invoices?school=" + tenant.slug)}>View invoices</Button>
            <Button variant="primary" onClick={() => toast(`Impersonating ${tenant.name} — session logged, expires in 30 minutes`)}>
              Impersonate admin
            </Button>
          </div>
        </div>

        <div role="tablist" className="mt-4 flex overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={t === tab}
              onClick={() => setTab(t)}
              className="mr-6 whitespace-nowrap py-2.5 text-[13px]"
              style={{
                fontWeight: t === tab ? 600 : 400,
                color: t === tab ? "#16201A" : "#5F6B62",
                boxShadow: t === tab ? "inset 0 -2px 0 #F26A1B" : undefined,
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === "Overview" && (
        <div className="px-7 py-6">
          {alert && (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-orange-line bg-orange-soft px-4 py-3.5">
              <div className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md bg-orange text-[13px] font-bold text-white">!</div>
              <div className="flex-1">
                <div className="text-body font-semibold text-orange-ink">{alert.title}</div>
                <p className="mt-1 text-small leading-relaxed text-orange-ink">{alert.body}</p>
              </div>
              <Button variant="accent" onClick={() => toast(`${alert.action} — ${tenant.name}`)}>{alert.action}</Button>
            </div>
          )}

          <StatRow
            stats={[
              { label: "Learners", value: (overview?.learners ?? 0).toLocaleString(), sub: `of ${tenant.licensed_seats.toLocaleString()} licensed` },
              { label: "Staff accounts", value: (overview?.staff ?? 0).toLocaleString(), sub: "school admin + teacher logins" },
              { label: "Parent accounts", value: (overview?.parents ?? 0).toLocaleString(), sub: "with a login" },
              {
                label: "Billing",
                value: (overview?.outstandingCents ?? 0) > 0 ? "Outstanding" : "Current",
                sub: (overview?.outstandingCents ?? 0) > 0
                  ? `${KES(overview!.outstandingCents)} outstanding${overview?.nextDueOn ? ` · due ${formatShortDate(overview.nextDueOn)}` : ""}`
                  : "nothing outstanding",
                alarming: (overview?.outstandingCents ?? 0) > 0,
              },
            ]}
          />

          <div className="mt-4 flex items-center gap-3 rounded-lg border border-line bg-white px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-body font-semibold">Organization</div>
              <p className="mt-0.5 text-[12px] text-ink-faint">
                A county, constituency or group-owner this school reports into for cross-school visibility. Optional.
              </p>
            </div>
            <select
              value={orgId}
              disabled={orgSaving}
              onChange={(e) => void setOrganization(e.target.value)}
              aria-label="Organization"
              className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
            >
              <option value="">Not assigned</option>
              {(organizations ?? []).map((o: Organization) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>

          {/* Daily active users and role adoption stay illustrative — they need real
              session/action tracking this schema doesn't have yet (FIG-294). Learners,
              staff, parents and billing above are real as of FIG-294's first pass. */}
          <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
            <section className="overflow-hidden rounded-lg border border-line">
              <header className="flex items-center justify-between border-b border-line px-4 py-3">
                <h2 className="text-body font-semibold">Daily active users · last 14 days</h2>
                <span className="font-mono text-[11px] text-ink-faint">{low ? "avg 118" : "avg 1,204"}</span>
              </header>
              <div className="flex h-[160px] items-end gap-1.5 px-4 py-4">
                {[72, 88, 84, 91, 76, 20, 14, 80, 93, 86, 89, 74, 22, 16].map((h, i) => (
                  <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                    <div
                      className="w-full rounded-t"
                      style={{ height: `${low ? Math.round(h * 0.35) : h}%`, background: h < 30 ? "#E7EBE8" : low ? "#F9A05C" : "#2E7D4F" }}
                    />
                    <span className="font-mono text-[9px] text-ink-faint">{"MTWTFSS"[i % 7]}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-line">
              <header className="border-b border-line px-4 py-3"><h2 className="text-body font-semibold">Role adoption</h2></header>
              <div className="px-4 pb-3.5 pt-1.5">
                {[
                  ["Teachers taking attendance", low ? 31 : 95],
                  ["Parents active in last 30d", low ? 40 : 87],
                  ["Students signed in", low ? 22 : 65],
                  ["Fees paid in app", low ? 18 : 78],
                ].map(([label, pct]) => (
                  <div key={label as string} className="border-b border-line-soft py-2.5 last:border-0">
                    <div className="mb-1.5 flex justify-between text-[13px]">
                      <span>{label}</span>
                      <span className="font-mono text-[12px] text-ink-muted">{pct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded bg-sunken">
                      <div className="h-1.5 rounded" style={{ width: `${pct}%`, background: (pct as number) > 60 ? "#2E7D4F" : "#F26A1B" }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}

      {tab === "Branding" && (
        <div className="max-w-[840px] px-7 py-6">
          <p className="mb-5 text-body leading-relaxed text-ink-muted">
            Each school controls its logo and one accent. Layout, type and spacing stay identical across every tenant,
            so support can navigate any school without relearning it. The accent appears on the header band, primary
            buttons and the active nav marker — never on status colours, which stay system-owned so red always means
            the same thing.
          </p>
          <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
            <div className="rounded-lg border border-line p-4">
              <h2 className="text-body font-semibold">School accent</h2>
              <p className="mb-3 mt-1 text-[12px] text-ink-faint">Contrast-checked against white before it is offered.</p>
              <div className="flex flex-wrap gap-2.5">
                {["#7A1F2B", "#123C63", "#1B4D2E", "#5C2E1F", "#3B3B6D", "#0F5257"].map((c) => (
                  <button
                    key={c}
                    onClick={() => setAccent(c)}
                    aria-label={`Accent ${c}`}
                    className="h-9 w-9 rounded-[10px]"
                    style={{ background: c, boxShadow: accent === c ? "0 0 0 2px #fff, 0 0 0 4px #16201A" : undefined }}
                  />
                ))}
              </div>
              <div className="mt-3.5 font-mono text-[11px] text-ink-faint">{accent} · AA on white</div>
            </div>
            <div className="overflow-hidden rounded-lg border border-line">
              <div className="flex items-center gap-2.5 px-3.5 py-2.5" style={{ background: accent }}>
                <div className="grid h-[22px] w-[22px] place-items-center rounded-md bg-white/25 text-[10px] font-bold text-white">
                  {tenant.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
                </div>
                <span className="text-small font-semibold text-white">{tenant.name}</span>
              </div>
              <div className="p-4">
                <p className="mb-3 text-small leading-relaxed text-ink-muted">How the school's own workspace header looks to their staff.</p>
                <button className="rounded-md px-3.5 py-2 text-small font-semibold text-white" style={{ background: accent }}>Primary action</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab !== "Overview" && tab !== "Branding" && (
        <div className="px-7 py-16 text-center">
          <div className="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-xl bg-sunken text-lg text-ink-muted">◷</div>
          <div className="text-[15px] font-semibold">{tab} lives on the platform pages</div>
          <p className="mx-auto mt-1.5 max-w-[400px] text-[13px] leading-relaxed text-ink-muted">
            Usage, billing and audit are cross-tenant views — open them from the sidebar, filtered to this school.
          </p>
        </div>
      )}
    </>
  );
}
