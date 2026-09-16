import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { fetchOrganizationTenantSummaries, logOrganizationAccess, KES } from "@figbloom/shared";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { PageHead } from "../../components/ConsoleShell";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";
import { EmptyState } from "../../components/ui/DataTable";
import { useAsync } from "../../lib/useAsync";
import { useOrgSessionCtx } from "../../lib/orgSessionContext";

/**
 * A stripped-down, read-only version of platform/TenantDetail.tsx — aggregate
 * figures only (same organization_tenant_summary the schools list reads),
 * no edit controls, no impersonation entry point. An org-admin manages
 * nothing about a member school directly; this is visibility, not control.
 */
export function OrgSchoolDetail() {
  const { profile, organization } = useOrgSessionCtx();
  const { tenantId } = useParams();
  const nav = useNavigate();
  const { data: summaries, loading, error } = useAsync(() => fetchOrganizationTenantSummaries(organization.id), [organization.id]);
  const school = summaries?.find((s) => s.tenant_id === tenantId) ?? null;

  useEffect(() => {
    if (tenantId) void logOrganizationAccess(organization.id, profile.id, "viewed_tenant_detail", tenantId);
  }, [organization.id, profile.id, tenantId]);

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
        blurb={`${school.institution_type === "higher_ed" ? "Higher-ed institution" : "K-12 school"} · last updated ${new Date(school.updated_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}
        actions={<Button onClick={() => nav("../schools")}>Back to schools</Button>}
      />

      <div className="px-7 py-6">
        <div className="mb-4 flex items-center gap-2">
          <Badge tone={school.status === "active" ? "ok" : "warn"}>{school.status}</Badge>
        </div>

        <StatRow
          stats={[
            { label: "Active students", value: school.active_students.toLocaleString() },
            { label: "Present today", value: school.present_today.toLocaleString(), sub: school.active_students > 0 ? `${Math.round((school.present_today / school.active_students) * 100)}% of enrolled` : undefined },
            { label: "Fees billed", value: KES(school.fees_billed_cents) },
            {
              label: "Fees collected", value: KES(school.fees_collected_cents),
              sub: school.fees_billed_cents > 0 ? `${Math.round((school.fees_collected_cents / school.fees_billed_cents) * 100)}% collected` : "nothing billed yet",
            },
          ]}
        />

        <p className="mt-5 max-w-[560px] text-[12.5px] leading-relaxed text-ink-faint">
          These are aggregate figures only — your organization does not have access to individual student records,
          marks, or payment details for this school. This view is logged; the school's own admin can see that you
          looked.
        </p>
      </div>
    </>
  );
}
