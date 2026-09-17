import { useEffect } from "react";
import { fetchOrganizationTenantSummaries, logOrganizationAccess, formatMoney, type OrganizationTenantSummary } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { HIGHER_ED_SUBTYPE_LABEL } from "../../components/ui/Badge";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";
import { useAsync } from "../../lib/useAsync";
import { useOrgSessionCtx } from "../../lib/orgSessionContext";

/**
 * The org-admin's landing page. Stat cards segment by institution type
 * rather than blending them — an organization can legitimately mix K-12
 * schools and higher-ed institutions, and a single "students" number would
 * quietly conflate a K-12 headcount with a higher-ed enrollment count that
 * happen to share a column (students.active) but not a meaning.
 */
export function OrgDashboard() {
  const { profile, organization } = useOrgSessionCtx();
  const { data, loading, error } = useAsync(() => fetchOrganizationTenantSummaries(organization.id), [organization.id]);

  useEffect(() => {
    void logOrganizationAccess(organization.id, profile.id, "viewed_dashboard");
  }, [organization.id, profile.id]);

  if (error) {
    return (
      <>
        <PageHead eyebrow={organization.name} title="Dashboard" />
        <div className="px-7 py-6">
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load your schools: {error.message}
          </p>
        </div>
      </>
    );
  }

  if (loading || !data) {
    return (
      <>
        <PageHead eyebrow={organization.name} title="Dashboard" />
        <div className="grid gap-3 px-7 py-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
        </div>
      </>
    );
  }

  const k12 = data.filter((s) => s.institution_type === "k12");
  const higherEd = data.filter((s) => s.institution_type === "higher_ed");
  const totalBilled = data.reduce((a, s) => a + s.fees_billed_cents, 0);
  const totalCollected = data.reduce((a, s) => a + s.fees_collected_cents, 0);
  const totalStudents = data.reduce((a, s) => a + s.active_students, 0);
  const totalPresentToday = data.reduce((a, s) => a + s.present_today, 0);

  return (
    <>
      <PageHead
        eyebrow={organization.name}
        title="Dashboard"
        blurb={`${data.length} school${data.length === 1 ? "" : "s"} in this organization.`}
      />

      <div className="px-7 py-6">
        <StatRow
          stats={[
            { label: "Schools", value: String(data.length), sub: `${k12.length} K-12 · ${higherEd.length} higher-ed` },
            { label: "Active students", value: totalStudents.toLocaleString(), sub: `${totalPresentToday.toLocaleString()} present today` },
            // Every school in an org is Kenyan today (country selector
            // locked to Kenya) — a cross-country org's aggregate is a real
            // multi-currency problem to solve when it's first needed.
            {
              label: "Fees collected", value: formatMoney(totalCollected, "KE"),
              sub: totalBilled > 0 ? `${Math.round((totalCollected / totalBilled) * 100)}% of ${formatMoney(totalBilled, "KE")} billed` : "nothing billed yet",
            },
            { label: "Needs attention", value: String(data.filter((s) => s.status !== "active").length), sub: "not active", alarming: data.some((s) => s.status !== "active") },
          ]}
        />

        <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
          {k12.length > 0 && (
            <SegmentCard title="K-12 schools" rows={k12} />
          )}
          {higherEd.length > 0 && (
            <SegmentCard title="Higher-ed institutions" rows={higherEd} />
          )}
        </div>
      </div>
    </>
  );
}

function SegmentCard({ title, rows }: { title: string; rows: OrganizationTenantSummary[] }) {
  const students = rows.reduce((a, r) => a + r.active_students, 0);
  const billed = rows.reduce((a, r) => a + r.fees_billed_cents, 0);
  const collected = rows.reduce((a, r) => a + r.fees_collected_cents, 0);
  // Descriptive only (FIG-357 v1) — a university and a TVET institute behave
  // identically today, this is just a count breakdown for the org-admin.
  const subtypeCounts = rows.reduce((m, r) => {
    if (r.higher_ed_subtype) m.set(r.higher_ed_subtype, (m.get(r.higher_ed_subtype) ?? 0) + 1);
    return m;
  }, new Map<string, number>());
  const subtypeSummary = subtypeCounts.size
    ? [...subtypeCounts.entries()].map(([k, n]) => `${n} ${HIGHER_ED_SUBTYPE_LABEL[k as keyof typeof HIGHER_ED_SUBTYPE_LABEL]}`).join(" · ")
    : null;
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-white">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold">{title}</h2>
        <span className="font-mono text-[11px] text-ink-faint">{rows.length} school{rows.length === 1 ? "" : "s"}</span>
      </header>
      <div className="px-4 py-3.5">
        {subtypeSummary && <div className="mb-2 text-[12px] text-ink-faint">{subtypeSummary}</div>}
        <div className="mb-2 flex justify-between text-[12.5px]"><span className="text-ink-muted">Active students</span><span className="font-mono font-medium">{students.toLocaleString()}</span></div>
        <div className="flex justify-between text-[12.5px]"><span className="text-ink-muted">Fees collected</span><span className="font-mono font-medium">{formatMoney(collected, "KE")} / {formatMoney(billed, "KE")}</span></div>
      </div>
    </section>
  );
}
