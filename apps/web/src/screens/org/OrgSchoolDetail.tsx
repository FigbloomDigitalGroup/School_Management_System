import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { fetchOrganizationTenantSummaries, logOrganizationAccess, formatMoney, supabase } from "@figbloom/shared";
import { Badge, DELIVERY_MODE_LABEL, HIGHER_ED_SUBTYPE_LABEL } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { PageHead } from "../../components/ConsoleShell";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";
import { EmptyState } from "../../components/ui/DataTable";
import { useAsync } from "../../lib/useAsync";
import { useOrgSessionCtx } from "../../lib/orgSessionContext";

/**
 * Aggregate figures (same organization_tenant_summary the schools list
 * reads) plus an "Open school console" entry point — an org owner gets the
 * exact same admin console this school's own school_admin has (FIG-391's
 * RLS grant is what actually authorizes it; this is just the door). Every
 * entry is logged, the same way viewing this page already is.
 */
export function OrgSchoolDetail() {
  const { profile, organization } = useOrgSessionCtx();
  const { tenantId } = useParams();
  const nav = useNavigate();
  const { data: summaries, loading, error } = useAsync(() => fetchOrganizationTenantSummaries(organization.id), [organization.id]);
  const school = summaries?.find((s) => s.tenant_id === tenantId) ?? null;
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (tenantId) void logOrganizationAccess(organization.id, profile.id, "viewed_tenant_detail", tenantId);
  }, [organization.id, profile.id, tenantId]);

  async function openConsole() {
    if (!tenantId) return;
    setOpening(true);
    try {
      const { data: tenant, error: tenantErr } = await supabase().from("tenants").select("slug").eq("id", tenantId).maybeSingle();
      if (tenantErr || !tenant) throw tenantErr ?? new Error("This school's address could not be found.");
      await logOrganizationAccess(organization.id, profile.id, "entered_school_console", tenantId);
      nav(`/s/${tenant.slug}/admin`);
    } finally {
      setOpening(false);
    }
  }

  if (loading) {
    return (
      <>
        <PageHead eyebrow={organization.name} title="Loading…" />
        <div className="grid gap-3 px-7 py-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
        </div>
      </>
    );
  }

  if (error || !school) {
    return (
      <>
        <PageHead eyebrow={organization.name} title="School" actions={<Button onClick={() => nav("../schools")}>Back to schools</Button>} />
        <div className="px-7 py-6">
          <EmptyState title="School not found" body={error ? `Could not load: ${error.message}` : "This school is not part of your organization."} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        eyebrow={organization.name}
        title={school.name}
        blurb={`${school.institution_type === "higher_ed" ? (school.higher_ed_subtype ? HIGHER_ED_SUBTYPE_LABEL[school.higher_ed_subtype] : "Higher-ed institution") : "K-12 school"}${school.delivery_mode !== "in_person" ? ` · ${DELIVERY_MODE_LABEL[school.delivery_mode]}` : ""} · last updated ${new Date(school.updated_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}
        actions={
          <>
            <Button onClick={() => nav("../schools")}>Back to schools</Button>
            <Button variant="accent" onClick={() => void openConsole()} disabled={opening}>
              {opening ? "Opening…" : "Open school console"}
            </Button>
          </>
        }
      />

      <div className="px-7 py-6">
        <div className="mb-4 flex items-center gap-2">
          <Badge tone={school.status === "active" ? "ok" : "warn"}>{school.status}</Badge>
        </div>

        <StatRow
          stats={[
            { label: "Active students", value: school.active_students.toLocaleString() },
            { label: "Present today", value: school.present_today.toLocaleString(), sub: school.active_students > 0 ? `${Math.round((school.present_today / school.active_students) * 100)}% of enrolled` : undefined },
            // organization_tenant_summary has no country column yet — every
            // school in an org is Kenyan today (the selector is locked to
            // Kenya), so this is safe; a cross-country org is a real
            // aggregation problem to solve when it's first needed.
            { label: "Fees billed", value: formatMoney(school.fees_billed_cents, "KE") },
            {
              label: "Fees collected", value: formatMoney(school.fees_collected_cents, "KE"),
              sub: school.fees_billed_cents > 0 ? `${Math.round((school.fees_collected_cents / school.fees_billed_cents) * 100)}% collected` : "nothing billed yet",
            },
          ]}
        />

        <p className="mt-5 max-w-[560px] text-[12.5px] leading-relaxed text-ink-faint">
          "Open school console" gives you the same access this school's own admin has — its students, staff, fees,
          and everything else. Every visit is logged here and the school can see it, the same way this page view
          already is.
        </p>
      </div>
    </>
  );
}
