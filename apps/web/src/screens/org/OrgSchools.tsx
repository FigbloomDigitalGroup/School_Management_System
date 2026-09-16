import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { fetchOrganizationTenantSummaries, logOrganizationAccess, KES, type OrganizationTenantSummary } from "@figbloom/shared";
import { Badge, HIGHER_ED_SUBTYPE_LABEL } from "../../components/ui/Badge";
import { Mono } from "../../components/ui/DataTable";
import { RecordsPage, type RecordsSpec } from "../platform/RecordsPage";
import { useAsync } from "../../lib/useAsync";
import { useOrgSessionCtx } from "../../lib/orgSessionContext";

const STATUS_TONE: Record<OrganizationTenantSummary["status"], "ok" | "warn" | "info" | "muted"> = {
  active: "ok", trial: "muted", onboarding: "info", overdue: "warn", suspended: "warn", setup_stalled: "warn",
};

/** The member-schools list — RecordsPage, the same template as platform/Subscriptions(), filtered to this organization. */
export function OrgSchools() {
  const { profile, organization } = useOrgSessionCtx();
  const nav = useNavigate();
  const { data, loading, error } = useAsync(() => fetchOrganizationTenantSummaries(organization.id), [organization.id]);

  useEffect(() => {
    void logOrganizationAccess(organization.id, profile.id, "viewed_schools_list");
  }, [organization.id, profile.id]);

  if (loading || !data) {
    return (
      <RecordsPage spec={{ eyebrow: organization.name, title: "Schools", blurb: "Loading…", stats: [], columns: [], rows: [] }} />
    );
  }
  if (error) {
    return (
      <RecordsPage spec={{ eyebrow: organization.name, title: "Schools", blurb: `Could not load: ${error.message}`, stats: [], columns: [], rows: [] }} />
    );
  }

  const totalBilled = data.reduce((a, s) => a + s.fees_billed_cents, 0);
  const totalCollected = data.reduce((a, s) => a + s.fees_collected_cents, 0);

  const spec: RecordsSpec = {
    eyebrow: organization.name,
    title: "Schools",
    blurb: "Every school in this organization, at a glance — aggregate figures only.",
    stats: [
      { label: "Schools", value: String(data.length) },
      { label: "Active students", value: data.reduce((a, s) => a + s.active_students, 0).toLocaleString() },
      { label: "Fees collected", value: KES(totalCollected), sub: totalBilled > 0 ? `of ${KES(totalBilled)} billed` : "nothing billed yet" },
      { label: "Needs attention", value: String(data.filter((s) => s.status !== "active").length), alarming: data.some((s) => s.status !== "active") },
    ],
    columns: [
      { key: "name", header: "School", width: "1.6fr" },
      { key: "type", header: "Type", width: "1fr" },
      { key: "students", header: "Students", align: "right", width: "1fr" },
      { key: "fees", header: "Fees collected", align: "right", width: "1.4fr" },
      { key: "status", header: "Status", width: "1fr" },
      { key: "view", header: "", align: "right", width: "0.8fr" },
    ],
    chips: [
      { label: "All" },
      { label: "K-12", match: ["k12"] },
      { label: "Higher-ed", match: ["higher_ed"] },
      { label: "Needs attention", match: ["needs_attention"] },
    ],
    minWidth: "920px",
    rows: data.map((s) => ({
      id: s.tenant_id,
      tags: [s.institution_type, ...(s.status !== "active" ? ["needs_attention"] : [])],
      cells: [
        <span className="text-[13px] font-medium">{s.name}</span>,
        <Mono>{s.institution_type === "higher_ed" ? (s.higher_ed_subtype ? HIGHER_ED_SUBTYPE_LABEL[s.higher_ed_subtype] : "Higher-ed") : "K-12"}</Mono>,
        <Mono>{s.active_students.toLocaleString()}</Mono>,
        <span className="text-[13px]">{KES(s.fees_collected_cents)} / {KES(s.fees_billed_cents)}</span>,
        <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>,
        <button type="button" onClick={() => nav(`../schools/${s.tenant_id}`)} className="text-[12px] font-semibold text-leaf hover:underline">
          View
        </button>,
      ],
    })),
  };

  return <RecordsPage spec={spec} />;
}
