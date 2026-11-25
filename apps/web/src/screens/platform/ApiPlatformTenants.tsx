import { useMemo, useState, type FormEvent } from "react";
import {
  acceptInviteLink,
  apiFetchPlatformSchoolAdmins,
  apiFetchPlatformSchools,
  apiProvisionSchool,
  formatShortDate,
  normalizeSlug,
  suggestSlug,
  tenantPath,
  userMessage,
  validateSlug,
  type Organization,
  type PlatformSchoolItem,
  type ProvisionSchoolResult,
  type TenantStatus,
} from "@figbloom/shared";
import { AccessibilityButton } from "../../components/ConsoleShell";
import { Icon } from "../../components/Icon";
import { OneTimeValue } from "../../components/learners/GuardianInvite";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/DataTable";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { STATUS_LABEL, STATUS_TONE } from "./Tenants";

type Filter = "All" | "Attention" | "Onboarding" | "Trial" | "HR asked";

const FILTERS: Filter[] = ["All", "Attention", "Onboarding", "Trial", "HR asked"];

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

function schoolNeedsAttention(status: TenantStatus): boolean {
  return status === "overdue" || status === "suspended" || status === "setup_stalled";
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

/**
 * Platform Tenants screen on the new API (slice P2 of apps/api/docs/PLATFORM-CONSOLE.md).
 *
 * Shows only real directory data from `GET /v1/platform/schools` (no invented MRR, seats, DAU or adoption charts)
 * and onboards new schools through `POST /v1/platform/schools` (re-auth prompted automatically by ApiSessionGuard).
 */
export function ApiPlatformTenants() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data: schools, loading: fetching, error } = useAsync(() => apiFetchPlatformSchools(), [refreshKey]);
  const loading = fetching && !schools;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");
  const [onboardOpen, setOnboardOpen] = useState(false);

  const all = useMemo(() => schools ?? [], [schools]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((s) => {
        if (filter === "All") return true;
        if (filter === "Attention") return schoolNeedsAttention(s.status);
        if (filter === "Onboarding") return s.status === "onboarding";
        if (filter === "HR asked") return s.hrRequestedAt !== null;
        return s.status === "trial";
      })
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.slug.toLowerCase().includes(q) ||
          s.organization.name.toLowerCase().includes(q),
      );
  }, [all, filter, query]);

  const counts: Record<Filter, number> = {
    All: all.length,
    Attention: all.filter((s) => schoolNeedsAttention(s.status)).length,
    Onboarding: all.filter((s) => s.status === "onboarding").length,
    Trial: all.filter((s) => s.status === "trial").length,
    "HR asked": all.filter((s) => s.hrRequestedAt !== null).length,
  };

  const selected = all.find((s) => s.id === selectedId) ?? list[0] ?? all[0] ?? null;

  const knownOrganizations = useMemo(() => {
    const byId = new Map<string, { id: string; name: string }>();
    for (const s of all) byId.set(s.organization.id, { id: s.organization.id, name: s.organization.name });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [all]);

  const activeCount = all.filter((s) => s.status === "active").length;
  const stats = [
    { label: "Schools", value: String(all.length), sub: `${activeCount} active`, loading },
    { label: "Onboarding", value: String(counts.Onboarding), sub: "awaiting first admin", loading },
    { label: "Trial", value: String(counts.Trial), sub: "in evaluation", loading },
    {
      label: "Needs attention",
      value: String(counts.Attention),
      sub: `${all.filter((s) => s.status === "overdue").length} overdue · ${all.filter((s) => s.status === "suspended").length} suspended`,
      alarming: counts.Attention > 0,
      loading,
    },
  ];

  return (
    <>
      <div className="flex h-screen flex-col overflow-hidden">
        <div className="shrink-0 border-b border-line bg-white px-7 py-4">
          <StatRow stats={stats} />
        </div>

        {error && (
          <div className="border-b border-warn-ink/30 bg-warn-ink/5 px-7 py-2.5 text-[12.5px] text-warn-ink">
            Could not load schools: {userMessage(error)}
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex w-[320px] shrink-0 flex-col border-r border-line bg-[#FAFBFA]">
            <div className="border-b border-line px-4 py-4">
              <div className="mb-3 flex items-center justify-between">
                <h1 className="text-[16px] font-semibold">Tenants</h1>
                <Button variant="accent" onClick={() => setOnboardOpen(true)}>+ Onboard</Button>
              </div>
              <label className="flex items-center gap-2 rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5">
                <Icon name="search" size={12} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={loading ? "Search schools" : `Search ${all.length} schools`}
                  aria-label="Search schools"
                  className="w-full bg-transparent text-small outline-none"
                />
              </label>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {FILTERS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setFilter(k)}
                    className="rounded-full px-2.5 py-1 text-[11.5px]"
                    style={
                      filter === k
                        ? { background: "#17402A", color: "#fff" }
                        : k === "Attention"
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
                  {list.map((s) => {
                    const active = s.id === selected?.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedId(s.id)}
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
                          {initials(s.name)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-body font-medium">{s.name}</div>
                          <div className="truncate font-mono text-[10.5px] text-ink-faint">
                            {s.slug} · {s.organization.name}
                          </div>
                        </div>
                        {s.hrRequestedAt && <Badge tone="info">HR asked</Badge>}
                        <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                      </button>
                    );
                  })}

                  {list.length === 0 && (
                    <EmptyState
                      title="No school matches that"
                      body="Try the school's name, address or organisation."
                    />
                  )}
                </>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1 overflow-auto">
            {selected ? (
              <SchoolDetail school={selected} />
            ) : (
              !loading && (
                <EmptyState
                  title="No school selected"
                  body="Choose a school from the list on the left, or onboard the first one."
                />
              )
            )}
          </div>
        </div>
      </div>

      <ProvisionSchoolModal
        open={onboardOpen}
        onClose={() => setOnboardOpen(false)}
        existingSlugs={all.map((s) => s.slug)}
        organizations={knownOrganizations}
        onProvisioned={(tenantId) => {
          setRefreshKey((k) => k + 1);
          setSelectedId(tenantId);
        }}
      />
    </>
  );
}

function SchoolDetail({ school }: { school: PlatformSchoolItem }) {
  const { data: admins, loading: adminsLoading, error: adminsError } = useAsync(
    () => apiFetchPlatformSchoolAdmins(school.id),
    [school.id],
  );
  return (
    <>
      <div className="border-b border-line bg-white px-7 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-xl bg-forest text-[17px] font-bold text-white">
              {initials(school.name)}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-h2 font-semibold tracking-tight">{school.name}</h2>
                <Badge tone={STATUS_TONE[school.status]}>{STATUS_LABEL[school.status]}</Badge>
              </div>
              <div className="mt-1 break-words font-mono text-[11.5px] text-ink-muted">
                {tenantPath(school.slug)} · {school.timezone} · created {formatShortDate(school.createdAt)}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <AccessibilityButton />
          </div>
        </div>
      </div>

      <div className="space-y-4 px-7 py-6">
        {school.status === "onboarding" && (
          <div className="rounded-xl border border-line bg-sunken/60 px-4 py-3.5">
            <div className="text-body font-semibold">Awaiting first administrator</div>
            <p className="mt-1 text-small leading-relaxed text-ink-muted">
              This school becomes active automatically once its invited school administrator accepts their invitation and sets a password.
            </p>
          </div>
        )}

        <section className="rounded-lg border border-line bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-mono text-micro uppercase tracking-[0.1em] text-ink-faint">Organization</div>
              <div className="mt-1 text-[15px] font-semibold">{school.organization.name}</div>
              <div className="mt-0.5 font-mono text-[11.5px] text-ink-muted">
                {school.organization.slug} · {ORG_KIND_LABEL[school.organization.kind] ?? school.organization.kind}
              </div>
            </div>
            <Badge tone={ORG_STATUS_TONE[school.organization.status]}>{school.organization.status}</Badge>
          </div>
        </section>

        <section className="rounded-lg border border-line bg-white p-4">
          <div className="font-mono text-micro uppercase tracking-[0.1em] text-ink-faint">Directory record</div>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-[11.5px] text-ink-faint">School ID</dt>
              <dd className="mt-0.5 break-all font-mono text-[12px] text-ink">{school.id}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-faint">Web address</dt>
              <dd className="mt-0.5 font-mono text-[12px] text-ink">{tenantPath(school.slug)}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-faint">Time zone</dt>
              <dd className="mt-0.5 font-mono text-[12px] text-ink">{school.timezone}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-ink-faint">Created</dt>
              <dd className="mt-0.5 font-mono text-[12px] text-ink">{formatShortDate(school.createdAt)}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-lg border border-line bg-white p-4" aria-label="HR & Payroll">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-mono text-micro uppercase tracking-[0.1em] text-ink-faint">HR &amp; Payroll</div>
            <Badge tone={school.hrRequestedAt ? "info" : "muted"}>{school.hrRequestedAt ? "Asked for HR" : "Not asked"}</Badge>
          </div>
          {school.hrRequestedAt ? (
            <>
              <p className="mt-2 text-small text-ink">
                This school asked Figbloom for HR &amp; Payroll on {formatShortDate(school.hrRequestedAt)}. Switch HR on for it in the platform, then it can open HR from its menu.
              </p>
              {school.hrRequestedBy && (
                <p className="mt-1 font-mono text-[11.5px] text-ink-muted">Asked by account {school.hrRequestedBy}</p>
              )}
            </>
          ) : (
            <p className="mt-2 text-small text-ink-muted">This school has not asked for HR &amp; Payroll.</p>
          )}
        </section>

        <section className="rounded-lg border border-line bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="font-mono text-micro uppercase tracking-[0.1em] text-ink-faint">School administrators</div>
            <span className="font-mono text-[11px] text-ink-faint">
              {adminsLoading ? "…" : `${(admins ?? []).length} active`}
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
            <p className="mt-2 text-small text-ink-muted">No active school administrators yet.</p>
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
      </div>
    </>
  );
}

function ProvisionSchoolModal({
  open,
  onClose,
  existingSlugs,
  organizations,
  onProvisioned,
}: {
  open: boolean;
  onClose: () => void;
  existingSlugs: string[];
  organizations: { id: string; name: string }[];
  onProvisioned: (tenantId: string) => void;
}) {
  const toast = useToast();
  const [schoolName, setSchoolName] = useState("");
  const [slugInput, setSlugInput] = useState("");
  const [orgMode, setOrgMode] = useState<"own" | "existing" | "new">("own");
  const [organizationId, setOrganizationId] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ res: ProvisionSchoolResult; schoolName: string; slug: string; adminEmail: string } | null>(null);

  const slugValue = normalizeSlug(slugInput || (schoolName ? suggestSlug(schoolName) : ""));
  const slugCheck = slugValue ? validateSlug(slugValue) : { ok: false, message: "Suggested from the school name." };
  const slugTaken = !!slugValue && existingSlugs.includes(slugValue);

  function resetAndClose() {
    setSchoolName("");
    setSlugInput("");
    setOrgMode("own");
    setOrganizationId("");
    setOrganizationName("");
    setAdminEmail("");
    setAdminName("");
    setSubmitting(false);
    setError("");
    setResult(null);
    onClose();
  }

  const canSubmit =
    !submitting &&
    schoolName.trim().length >= 2 &&
    slugCheck.ok &&
    !slugTaken &&
    adminEmail.trim().includes("@") &&
    (orgMode !== "existing" || Boolean(organizationId)) &&
    (orgMode !== "new" || organizationName.trim().length >= 2);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await apiProvisionSchool({
        schoolName,
        slug: slugValue,
        adminEmail,
        adminName: adminName.trim() || undefined,
        organizationId: orgMode === "existing" ? organizationId : undefined,
        organizationName: orgMode === "new" ? organizationName : undefined,
      });
      setResult({ res, schoolName: schoolName.trim(), slug: slugValue, adminEmail: adminEmail.trim() });
      onProvisioned(res.school.tenantId);
      toast(`${schoolName.trim()} provisioned.`);
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      eyebrow="Platform · provisioning"
      title={result ? `${result.schoolName} is ready for its first admin` : "Onboard a school"}
      blurb={
        result
          ? "The school starts in onboarding and turns active once its first administrator accepts the invitation."
          : "Creates the school and sends a one-time invitation to its first school administrator. You may be asked to confirm your password."
      }
      width={560}
    >
      {result ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-sunken/50 px-4 py-3 text-small">
            <div>
              <span className="font-medium">Web address:</span>{" "}
              <span className="font-mono">{tenantPath(result.slug)}</span>
            </div>
            <div className="mt-1">
              <span className="font-medium">Administrator email:</span>{" "}
              <span className="font-mono">{result.adminEmail}</span>
            </div>
            <div className="mt-1">
              <span className="font-medium">Invitation delivery:</span>{" "}
              {result.res.invitation.delivery === "sent"
                ? `Emailed (expires ${formatShortDate(result.res.invitation.expiresAt)}).`
                : "Email delivery is not configured on this server — share the one-time link below."}
            </div>
          </div>

          {result.res.invitation.token && (
            <OneTimeValue
              label="Invitation link"
              value={acceptInviteLink(window.location.origin, result.res.invitation.token)}
              note={`Works once, expires ${formatShortDate(result.res.invitation.expiresAt)}. Shown only now.`}
            />
          )}

          <div className="flex justify-end">
            <Button variant="primary" onClick={resetAndClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="grid gap-3.5">
          {error && (
            <p role="alert" className="rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2 text-[12.5px] text-warn-ink">
              {error}
            </p>
          )}
          <TextField
            id="platform-school-name"
            label="School name"
            autoFocus
            value={schoolName}
            onChange={(e) => setSchoolName(e.target.value)}
            placeholder="e.g. Kijani Ridge Academy"
          />
          <TextField
            id="platform-school-slug"
            label="Web address (slug)"
            mono
            value={slugInput}
            onChange={(e) => setSlugInput(e.target.value)}
            placeholder={slugValue || "kijani-ridge"}
            hint={slugTaken ? "That web address is already in use." : slugValue ? `${tenantPath(slugValue)}` : slugCheck.message}
            error={slugTaken ? "Choose another web address." : slugInput && !slugCheck.ok ? slugCheck.message : undefined}
          />
          <SelectField
            id="platform-school-org-mode"
            label="Organization"
            value={orgMode}
            onChange={(e) => setOrgMode(e.target.value as "own" | "existing" | "new")}
            options={[
              { value: "own", label: "Single-school organization (named after the school)" },
              ...(organizations.length > 0 ? [{ value: "existing", label: "Existing organization" }] : []),
              { value: "new", label: "New organization with a custom name" },
            ]}
          />
          {orgMode === "existing" && (
            <SelectField
              id="platform-school-org-id"
              label="Choose organization"
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              options={[
                { value: "", label: "Select an organization…" },
                ...organizations.map((o) => ({ value: o.id, label: o.name })),
              ]}
            />
          )}
          {orgMode === "new" && (
            <TextField
              id="platform-school-org-name"
              label="New organization name"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              placeholder="e.g. Rift Valley Schools Group"
            />
          )}
          <TextField
            id="platform-school-admin-email"
            label="First school administrator email"
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            placeholder="principal@school.ac.ke"
          />
          <TextField
            id="platform-school-admin-name"
            label="Administrator name (optional)"
            value={adminName}
            onChange={(e) => setAdminName(e.target.value)}
            placeholder="e.g. Grace Wanjiru"
          />
          <div className="mt-1 flex justify-end gap-2">
            <Button type="button" onClick={resetAndClose} disabled={submitting}>Cancel</Button>
            <Button type="submit" variant="accent" disabled={!canSubmit}>
              {submitting ? "Provisioning…" : "Provision school"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
