import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiFetchMySchoolAccess, fetchOrganizationTenantSummaries, fetchTenantSlug, logOrganizationAccess, formatMoney, onApi, orgCapabilities } from "@figbloom/shared";
import { Badge, DELIVERY_MODE_LABEL, HIGHER_ED_SUBTYPE_LABEL } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { PageHead } from "../../components/ConsoleShell";
import { SchoolAdmins } from "../../components/SchoolAdmins";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";
import { EmptyState } from "../../components/ui/DataTable";
import { useAsync } from "../../lib/useAsync";
import { useOrgSessionCtx } from "../../lib/orgSessionContext";
import { SchoolAccessPanel } from "./SchoolAccessPanel";

/**
 * Aggregate figures (same organization_tenant_summary the schools list
 * reads) plus an "Open school console" entry point. On the API build, the
 * school authorizes this with tenant.read and the console shows only delegated areas.
 */
export function OrgSchoolDetail() {
  const { profile, organization } = useOrgSessionCtx();
  const { tenantId } = useParams();
  const nav = useNavigate();
  const { data: summaries, loading, error } = useAsync(() => fetchOrganizationTenantSummaries(organization.id), [organization.id]);
  const school = summaries?.find((s) => s.tenant_id === tenantId) ?? null;
  const apiBuild = onApi();
  const { data: mySchoolAccess, loading: accessLoading, error: accessError } = useAsync(
    () => apiBuild && school ? apiFetchMySchoolAccess(school.tenant_id) : Promise.resolve([] as string[]),
    [apiBuild, school?.tenant_id],
  );
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // On the API: name, address and status, delegated access, and console entry when tenant.read is held.
  const caps = orgCapabilities();
  const hasTenantRead = !apiBuild || !!mySchoolAccess?.includes("tenant.read");

  useEffect(() => {
    if (tenantId && orgCapabilities().pageViewLog) void logOrganizationAccess(organization.id, profile.id, "viewed_tenant_detail", tenantId);
  }, [organization.id, profile.id, tenantId]);

  async function openConsole() {
    if (!tenantId) return;
    setOpening(true);
    setOpenError(null);
    try {
      if (apiBuild && !(await apiFetchMySchoolAccess(tenantId)).includes("tenant.read")) {
        setOpenError("This school must grant you tenant.read before you can open its console.");
        return;
      }
      const slug = await fetchTenantSlug(tenantId);
      if (caps.pageViewLog) await logOrganizationAccess(organization.id, profile.id, "entered_school_console", tenantId);
      nav(`/s/${slug}/admin`);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : "Could not open this school's console.");
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
        blurb={caps.schoolKind
          ? `${school.institution_type === "higher_ed" ? (school.higher_ed_subtype ? HIGHER_ED_SUBTYPE_LABEL[school.higher_ed_subtype] : "Higher-ed institution") : "K-12 school"}${school.delivery_mode !== "in_person" ? ` · ${DELIVERY_MODE_LABEL[school.delivery_mode]}` : ""} · last updated ${new Date(school.updated_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
          : school.slug ? `schoolmanagement.figbloom.org/s/${school.slug}` : undefined}
        actions={
          <>
            <Button onClick={() => nav("../schools")}>Back to schools</Button>
            {caps.openSchoolConsole && (
              <Button variant="accent" onClick={() => void openConsole()} disabled={opening || accessLoading || !hasTenantRead}>
                {opening ? "Opening…" : "Open school console"}
              </Button>
            )}
          </>
        }
      />

      <div className="px-7 py-6">
        <div className="mb-4 flex items-center gap-2">
          <Badge tone={school.status === "active" ? "ok" : "warn"}>{school.status}</Badge>
        </div>

        {caps.schoolFigures && <StatRow
          stats={[
            { label: "Active students", value: school.active_students.toLocaleString() },
            { label: "Present today", value: school.present_today.toLocaleString(), sub: school.active_students > 0 ? `${Math.round((school.present_today / school.active_students) * 100)}% of enrolled` : undefined },
            ...((school.present_today_pm ?? 0) > 0
              ? [{ label: "Present this afternoon", value: (school.present_today_pm ?? 0).toLocaleString(), sub: school.active_students > 0 ? `${Math.round(((school.present_today_pm ?? 0) / school.active_students) * 100)}% of enrolled` : undefined }]
              : []),
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
        />}

        {caps.schoolAdmins && (
          <div className="mt-5 max-w-[760px]">
            <SchoolAdmins tenantId={school.tenant_id} tenantName={school.name} />
          </div>
        )}

        {caps.schoolAccess && (
          <div className="mt-5 max-w-[760px]">
            <SchoolAccessPanel tenantId={school.tenant_id} organizationId={organization.id} schoolName={school.name} />
          </div>
        )}

        {caps.openSchoolConsole ? (
          <p className="mt-5 max-w-[560px] text-[12.5px] leading-relaxed text-ink-faint">
            You can open this school's console after it grants you tenant.read. Inside, you can use only the admin areas
            explicitly delegated to you.
          </p>
        ) : (
          <p className="mt-5 max-w-[560px] text-[12.5px] leading-relaxed text-ink-faint">
            Not on the new system yet: this school's learner numbers, attendance and fees, and its own administrators.
          </p>
        )}
        {caps.openSchoolConsole && accessError && <p role="status" className="mt-3 text-[12.5px] text-danger">Could not check school access: {accessError.message}</p>}
        {openError && <p role="alert" className="mt-3 text-[12.5px] text-danger">{openError}</p>}
      </div>
    </>
  );
}
