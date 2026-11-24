import { fetchOrganizationAccessLog, orgCapabilities, type OrganizationAccessLog } from "@figbloom/shared";
import { Cell, Mono } from "../../components/ui/DataTable";
import { RecordsPage, type RecordsSpec } from "../platform/RecordsPage";
import { useAsync } from "../../lib/useAsync";
import { useOrgSessionCtx } from "../../lib/orgSessionContext";

const ACTION_LABEL: Record<string, string> = {
  viewed_dashboard: "Viewed dashboard",
  viewed_schools_list: "Viewed schools list",
  viewed_tenant_detail: "Viewed a school",
  // On the new API the log is the person's own recorded actions (audit event types, S11).
  "rbac.org_delegation.granted": "Gave an admin access in a school",
  "rbac.org_delegation.revoked": "Took away an admin's access in a school",
  "rbac.org_delegation.denied": "Was refused giving access in a school",
  "rbac.permission.denied": "Was refused something",
  "rbac.staff_areas.changed": "Changed a staff member's admin areas",
  "rbac.staff_areas.denied": "Was refused changing a staff member's admin areas",
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
  // Supabase logs every console page view; the new API lists what the person did (orgCapabilities().pageViewLog).
  const views = orgCapabilities().pageViewLog;
  const { data, loading, error } = useAsync(() => fetchOrganizationAccessLog(organization.id), [organization.id]);

  if (loading || !data || error) {
    return (
      <RecordsPage
        spec={{ eyebrow: organization.name, title: "Audit log", blurb: "", stats: [], columns: [], rows: [] }}
        loading={!error}
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
    blurb: views
      ? "Every time you've looked at your organization's data. Each member school can see the entries about itself — the same visibility Figbloom gives a school into its own impersonation log."
      : "What you have done in this organization and its schools, newest first (the latest 200). Other admins' actions and page views are not listed on the new system.",
    stats: [
      { label: views ? "Views this month" : "This month", value: String(thisMonth.length) },
      { label: views ? "Total logged views" : "Logged", value: String(data.length) },
      { label: views ? "Individual schools viewed" : "About a school", value: String(schoolViews) },
    ],
    columns: [
      { key: "when", header: "When", width: "1.2fr" },
      { key: "action", header: "Action", width: "1.6fr" },
      ...(views ? [] : [{ key: "school", header: "School", width: "1.2fr" }]),
    ],
    minWidth: "560px",
    rows: data.map((r: OrganizationAccessLog) => ({
      id: r.id,
      tags: [],
      cells: [
        <Mono>{fmtWhen(r.accessed_at)}</Mono>,
        <Cell>{ACTION_LABEL[r.action] ?? r.action}</Cell>,
        ...(views ? [] : [<Cell>{r.school_name ?? "—"}</Cell>]),
      ],
    })),
    empty: views
      ? { title: "No views logged yet", body: "Your dashboard and school views will appear here as you use the console." }
      : { title: "Nothing logged yet", body: "What you do in this organization's schools (for example giving an admin access) appears here." },
  };

  return <RecordsPage spec={spec} />;
}
