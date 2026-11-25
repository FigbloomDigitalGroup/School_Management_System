import { useState } from "react";
import { apiFetchPlatformUsage, tenantPath, userMessage } from "@figbloom/shared";
import { useAsync } from "../../lib/useAsync";
import { Badge, Cell, Mono, RecordsPage, type RecordsSpec } from "./RecordsPage";
import { STATUS_LABEL, STATUS_TONE } from "./Tenants";

/**
 * Platform Usage & capacity on the new API (`GET /v1/platform/usage`, slice P4 of PLATFORM-CONSOLE.md).
 *
 * Counts only (active learners, active staff memberships, active guardian links per school); no personal data.
 * Licensed seat caps are omitted until billing ownership (Q2) is decided.
 */
export function ApiPlatformUsage() {
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => apiFetchPlatformUsage(), [reloadKey]);

  const emptySpec: RecordsSpec = {
    eyebrow: "Platform · operations",
    title: "Usage & capacity",
    blurb: "Active learners, staff memberships and guardian links per school (counts only, no personal data).",
    stats: [],
    columns: [],
    rows: [],
  };

  if (loading && !data) return <RecordsPage spec={emptySpec} loading />;
  if (error) return <RecordsPage spec={emptySpec} error={userMessage(error)} />;
  if (!data) return <RecordsPage spec={emptySpec} loading />;

  const activeSchools = data.items.filter((i) => i.status === "active").length;

  const spec: RecordsSpec = {
    eyebrow: "Platform · operations",
    title: "Usage & capacity",
    blurb:
      "Counts-only headcount across every school from GET /v1/platform/usage. " +
      "Licensed seat caps are not shown on this build yet.",
    actions: [{ label: loading ? "Refreshing…" : "Refresh", primary: true, onClick: () => setReloadKey((k) => k + 1) }],
    stats: [
      { label: "Schools", value: String(data.totals.schools), sub: `${activeSchools} active` },
      { label: "Active learners", value: data.totals.activeLearners.toLocaleString(), sub: "enrolled across all schools" },
      { label: "Active staff", value: data.totals.activeStaff.toLocaleString(), sub: "admins, teachers, drivers & staff" },
      { label: "Guardian links", value: data.totals.activeGuardianLinks.toLocaleString(), sub: "linked to active learners" },
    ],
    chips: [
      { label: "All" },
      { label: "Active", match: ["active"] },
      { label: "Onboarding", match: ["onboarding"] },
      { label: "Needs attention", match: ["overdue", "suspended", "setup_stalled"] },
    ],
    columns: [
      { key: "school", header: "School", width: "1.8fr" },
      { key: "status", header: "Status", width: "0.9fr" },
      { key: "learners", header: "Learners", align: "right" },
      { key: "staff", header: "Staff", align: "right" },
      { key: "guardians", header: "Guardian links", align: "right" },
      { key: "total", header: "Learners + staff", align: "right" },
    ],
    minWidth: "740px",
    empty: {
      title: "No schools match this filter",
      body: "Switch back to All to see every school's counts.",
    },
    rows: data.items.map((r) => ({
      id: r.tenantId,
      tags: [r.status],
      cells: [
        <Cell key="s" sub={tenantPath(r.slug)}>{r.name}</Cell>,
        <Badge key="st" tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>,
        <Mono key="l">{r.activeLearners.toLocaleString()}</Mono>,
        <Mono key="sf">{r.activeStaff.toLocaleString()}</Mono>,
        <Mono key="g">{r.activeGuardianLinks.toLocaleString()}</Mono>,
        <Mono key="t">{(r.activeLearners + r.activeStaff).toLocaleString()}</Mono>,
      ],
    })),
  };

  return <RecordsPage spec={spec} />;
}
