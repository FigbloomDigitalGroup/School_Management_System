import { fetchOrganizationAccessLog, type OrganizationAccessLog } from "@figbloom/shared";
import { Cell, Mono } from "../../components/ui/DataTable";
import { RecordsPage, type RecordsSpec } from "../platform/RecordsPage";
import { useAsync } from "../../lib/useAsync";
import { useOrgSessionCtx } from "../../lib/orgSessionContext";

const ACTION_LABEL: Record<string, string> = {
  viewed_dashboard: "Viewed dashboard",
  viewed_schools_list: "Viewed schools list",
  viewed_tenant_detail: "Viewed a school",
};

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * The org-admin's own accountability record — the same idea as
 * platform/Impersonation() but one layer up: every /org/* page they've
 * loaded, logged here. A member school can see the same rows filtered to
 * itself (organization_access_log RLS grants that independently).
 */
export function OrgAudit() {
  const { organization } = useOrgSessionCtx();
  const { data, loading, error } = useAsync(() => fetchOrganizationAccessLog(organization.id), [organization.id]);

  if (loading || !data || error) {
    return (
      <RecordsPage
        spec={{ eyebrow: organization.name, title: "Audit log", blurb: "", stats: [], columns: [], rows: [] }}
        loading={loading || !data}
        error={error?.message}
      />
    );
  }

  const now = new Date();
  const thisMonth = data.filter((r) => { const d = new Date(r.accessed_at); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
  const schoolViews = data.filter((r) => r.tenant_id !== null).length;

  const spec: RecordsSpec = {
    eyebrow: organization.name,
    title: "Audit log",
    blurb: "Every time you've looked at your organization's data. Each member school can see the entries about itself — the same visibility Figbloom gives a school into its own impersonation log.",
    stats: [
      { label: "Views this month", value: String(thisMonth.length) },
      { label: "Total logged views", value: String(data.length) },
      { label: "Individual schools viewed", value: String(schoolViews) },
    ],
    columns: [
      { key: "when", header: "When", width: "1.2fr" },
      { key: "action", header: "Action", width: "1.6fr" },
    ],
    minWidth: "560px",
    rows: data.map((r: OrganizationAccessLog) => ({
      id: r.id,
      tags: [],
      cells: [
        <Mono>{fmtWhen(r.accessed_at)}</Mono>,
        <Cell>{ACTION_LABEL[r.action] ?? r.action}</Cell>,
      ],
    })),
    empty: { title: "No views logged yet", body: "Your dashboard and school views will appear here as you use the console." },
  };

  return <RecordsPage spec={spec} />;
}
