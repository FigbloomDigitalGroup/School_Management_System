import { useMemo, useState } from "react";
import {
  apiFetchPlatformOrganizationAdmins,
  apiFetchPlatformOrganizations,
  apiFetchPlatformSchools,
  formatShortDate,
  tenantPath,
  userMessage,
  type Organization,
  type PlatformOrganizationItem,
} from "@figbloom/shared";
import { AccessibilityButton } from "../../components/ConsoleShell";
import { Icon } from "../../components/Icon";
import { Badge, type Tone } from "../../components/ui/Badge";
import { EmptyState } from "../../components/ui/DataTable";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";
import { useAsync } from "../../lib/useAsync";
import { STATUS_LABEL, STATUS_TONE } from "./Tenants";

type Filter = "All" | "Active" | "Pending" | "Suspended";

const ORG_KIND_LABEL: Record<Organization["kind"], string> = {
  government: "Government",
  county: "County",
  constituency: "Constituency",
  group_owner: "School group",
};

const ORG_STATUS_TONE: Record<Organization["status"], Tone> = {
  active: "ok",
  pending: "info",
  suspended: "warn",
  rejected: "warn",
};

const ORG_STATUS_LABEL: Record<Organization["status"], string> = {
  active: "Active",
  pending: "Pending",
  suspended: "Suspended",
  rejected: "Rejected",
};

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

/**
 * Platform Organizations screen on the new API (slice P3 of apps/api/docs/PLATFORM-CONSOLE.md).
 *
 * Read-only directory: organizations (`GET /v1/platform/organizations`), their org_admin accounts
 * (`GET /v1/platform/organizations/{id}/admins`, read-audited), and their member schools
 * (`GET /v1/platform/schools?organizationId={id}`). Create/approve/suspend wait on owner decision Q1.
 */
export function ApiPlatformOrganizations() {
  const { data: organizations, loading: fetching, error } = useAsync(() => apiFetchPlatformOrganizations(), []);
  const loading = fetching && !organizations;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");

  const all = useMemo(() => organizations ?? [], [organizations]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((o) => {
        if (filter === "All") return true;
        if (filter === "Active") return o.status === "active";
        if (filter === "Pending") return o.status === "pending";
        return o.status === "suspended" || o.status === "rejected";
      })
      .filter((o) => !q || o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q));
  }, [all, filter, query]);

  const counts: Record<Filter, number> = {
    All: all.length,
    Active: all.filter((o) => o.status === "active").length,
    Pending: all.filter((o) => o.status === "pending").length,
    Suspended: all.filter((o) => o.status === "suspended" || o.status === "rejected").length,
  };

  const selected = all.find((o) => o.id === selectedId) ?? list[0] ?? all[0] ?? null;

  const stats = [
    { label: "Organizations", value: String(all.length), sub: `${counts.Active} active`, loading },
    { label: "Pending review", value: String(counts.Pending), sub: "awaiting approval", loading },
    { label: "Suspended / rejected", value: String(counts.Suspended), sub: "not active", alarming: counts.Suspended > 0, loading },
    {
      label: "Total schools",
      value: String(all.reduce((sum, o) => sum + o.schoolCount, 0)),
      sub: "across all organizations",
      loading,
    },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div className="shrink-0 border-b border-line bg-white px-7 py-4">
        <StatRow stats={stats} />
      </div>

      {error && (
        <div className="border-b border-warn-ink/30 bg-warn-ink/5 px-7 py-2.5 text-[12.5px] text-warn-ink">
          Could not load organizations: {userMessage(error)}
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex w-[320px] shrink-0 flex-col border-r border-line bg-[#FAFBFA]">
          <div className="border-b border-line px-4 py-4">
            <div className="mb-3 flex items-center justify-between">
              <h1 className="text-[16px] font-semibold">Organizations</h1>
            </div>
            <label className="flex items-center gap-2 rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5">
              <Icon name="search" size={12} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={loading ? "Search organizations" : `Search ${all.length} organizations`}
                aria-label="Search organizations"
                className="w-full bg-transparent text-small outline-none"
              />
            </label>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {(["All", "Active", "Pending", "Suspended"] as Filter[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilter(k)}
                  className="rounded-full px-2.5 py-1 text-[11.5px]"
                  style={
                    filter === k
                      ? { background: "#17402A", color: "#fff" }
                      : k === "Suspended"
                        ? { background: "#FDEBDF", color: "#B8460A" }
                        : { background: "#EEF1EE", color: "#5F6B62" }
                  }
                >
                  {k}{loading ? "" : ` ${counts[k]}`}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <TableSkeleton rows={8} />
            ) : (
              <>
                {list.map((o) => {
                  const active = o.id === selected?.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setSelectedId(o.id)}
                      className="flex w-full items-center gap-3 border-b border-line-soft px-4 py-3 text-left"
                      style={{
                        background: active ? "#F1F5F2" : "transparent",
                        borderLeft: `3px solid ${active ? "#F26A1B" : "transparent"}`,
                      }}
                    >
                      <div
                        className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg text-[11px] font-bold"
                        style={{ background: active ? "#1B4D2E" : "#E3EFE7", color: active ? "#fff" : "#1B4D2E" }}
                      >
                        {initials(o.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body font-medium">{o.name}</div>
                        <div className="truncate font-mono text-[10.5px] text-ink-faint">
                          {ORG_KIND_LABEL[o.kind]} · {o.schoolCount} {o.schoolCount === 1 ? "school" : "schools"}
                        </div>
                      </div>
                      <Badge tone={ORG_STATUS_TONE[o.status]}>{ORG_STATUS_LABEL[o.status]}</Badge>
                    </button>
                  );
                })}

                {list.length === 0 && (
                  <EmptyState
                    title="No organization matches that"
                    body="Try the organization's name or slug."
                  />
                )}
              </>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-auto">
          {selected ? (
            <OrganizationDetail org={selected} />
          ) : (
            !loading && (
              <EmptyState title="No organization selected" body="Choose an organization from the list on the left." />
            )
          )}
        </div>
      </div>
    </div>
  );
}

function OrganizationDetail({ org }: { org: PlatformOrganizationItem }) {
  const { data: admins, loading: adminsLoading, error: adminsError } = useAsync(
    () => apiFetchPlatformOrganizationAdmins(org.id),
    [org.id],
  );
  const { data: schools, loading: schoolsLoading, error: schoolsError } = useAsync(
    () => apiFetchPlatformSchools({ organizationId: org.id }),
    [org.id],
  );

  return (
    <>
      <div className="border-b border-line bg-white px-7 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-xl bg-forest text-[17px] font-bold text-white">
              {initials(org.name)}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-h2 font-semibold tracking-tight">{org.name}</h2>
                <Badge tone={ORG_STATUS_TONE[org.status]}>{ORG_STATUS_LABEL[org.status]}</Badge>
              </div>
              <div className="mt-1 break-words font-mono text-[11.5px] text-ink-muted">
                {org.slug} · {ORG_KIND_LABEL[org.kind]} · created {formatShortDate(org.createdAt)}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <AccessibilityButton />
          </div>
        </div>
      </div>

      <div className="space-y-4 px-7 py-6">
        <section className="rounded-lg border border-line bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-body font-semibold">Organization administrators</h3>
            <span className="font-mono text-[11px] text-ink-faint">
              {adminsLoading ? "…" : `${(admins ?? []).length} assigned`}
            </span>
          </div>
          {adminsError ? (
            <p className="mt-2 text-small text-warn-ink">Could not load administrators: {userMessage(adminsError)}</p>
          ) : adminsLoading ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (admins ?? []).length === 0 ? (
            <p className="mt-2 text-small text-ink-muted">No organization administrators assigned yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line-soft">
              {(admins ?? []).map((a) => (
                <li key={a.userId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="text-body font-medium">{a.fullName}</div>
                    <div className="font-mono text-[11.5px] text-ink-muted">{a.email ?? "No email"}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-ink-faint">since {formatShortDate(a.since)}</span>
                    <Badge tone={a.status === "active" ? "ok" : "muted"}>{a.status}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-line bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-body font-semibold">Member schools</h3>
            <span className="font-mono text-[11px] text-ink-faint">
              {schoolsLoading ? "…" : `${(schools ?? []).length} ${(schools ?? []).length === 1 ? "school" : "schools"}`}
            </span>
          </div>
          {schoolsError ? (
            <p className="mt-2 text-small text-warn-ink">Could not load schools: {userMessage(schoolsError)}</p>
          ) : schoolsLoading ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (schools ?? []).length === 0 ? (
            <p className="mt-2 text-small text-ink-muted">No schools belong to this organization yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line-soft">
              {(schools ?? []).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="text-body font-medium">{s.name}</div>
                    <div className="font-mono text-[11.5px] text-ink-muted">{tenantPath(s.slug)} · {s.timezone}</div>
                  </div>
                  <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
