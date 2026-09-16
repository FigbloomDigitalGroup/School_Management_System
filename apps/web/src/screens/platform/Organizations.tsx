import { useMemo, useState, type FormEvent } from "react";
import {
  createOrganization, fetchOrganizations, inviteOrgAdmin, type NewOrganizationInput, type OrgAdminInviteResult,
} from "../../lib/platformAdmin";
import { supabase, type Organization, type Tenant } from "@figbloom/shared";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { SelectField, TextField } from "../../components/ui/Field";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { Modal } from "../../components/ui/Modal";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

const KIND_LABEL: Record<Organization["kind"], string> = {
  government: "Government", county: "County", constituency: "Constituency", group_owner: "Group owner",
};

interface OrgAdminRow { id: string; full_name: string; email: string | null }

async function fetchMemberTenants(organizationId: string): Promise<Tenant[]> {
  const { data, error } = await supabase().from("tenants").select("*").eq("organization_id", organizationId).order("name").returns<Tenant[]>();
  if (error) throw error;
  return data ?? [];
}

async function fetchOrgAdmins(organizationId: string): Promise<OrgAdminRow[]> {
  // organization_admins has two FKs into profiles (profile_id, added_by), so
  // the embed is ambiguous without a hint — PostgREST rejects it (PGRST201)
  // rather than guessing, and that rejection was previously going unnoticed
  // (useAsync's caught error left the list silently empty, read as "no admins
  // invited yet" instead of "the query failed").
  const { data, error } = await supabase()
    .from("organization_admins").select("profiles!organization_admins_profile_id_fkey(id, full_name, email)").eq("organization_id", organizationId)
    .returns<{ profiles: OrgAdminRow | null }[]>();
  if (error) throw error;
  return (data ?? []).map((r) => r.profiles).filter((p): p is OrgAdminRow => p !== null);
}

/**
 * Staff-facing: creating organizations, seeing which tenants and admins
 * belong to each. Assigning a *tenant* to an organization lives on
 * TenantDetail.tsx instead — this screen is the organization's own view,
 * not where the linking action happens (staff usually start from the school
 * they already have open, not from the org).
 */
export function Organizations() {
  const toast = useToast();
  const [refreshKey, setRefreshKey] = useState(0);
  const { data: orgs, loading } = useAsync(() => fetchOrganizations(), [refreshKey]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const all = useMemo(() => orgs ?? [], [orgs]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((o) => !q || o.name.toLowerCase().includes(q) || o.slug.includes(q));
  }, [all, query]);

  const selected = all.find((o) => o.id === selectedId) ?? all[0] ?? null;

  return (
    <>
      <div className="flex h-screen flex-col overflow-hidden">
        <div className="shrink-0 border-b border-line bg-white px-7 py-4">
          <StatRow stats={[
            { label: "Organizations", value: String(all.length) },
            { label: "Government/county", value: String(all.filter((o) => o.kind === "government" || o.kind === "county").length) },
            { label: "Constituencies", value: String(all.filter((o) => o.kind === "constituency").length) },
            { label: "Group owners", value: String(all.filter((o) => o.kind === "group_owner").length) },
          ]} />
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex w-[320px] shrink-0 flex-col border-r border-line bg-[#FAFBFA]">
            <div className="border-b border-line px-4 py-4">
              <div className="mb-3 flex items-center justify-between">
                <h1 className="text-[16px] font-semibold">Organizations</h1>
                <Button variant="accent" onClick={() => setCreating(true)}>+ Add</Button>
              </div>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${all.length} organizations`}
                aria-label="Search organizations"
                className="w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small outline-none"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {loading ? <TableSkeleton rows={6} /> : (
                <>
                  {list.map((o) => {
                    const active = o.id === selected?.id;
                    return (
                      <button
                        key={o.id}
                        onClick={() => setSelectedId(o.id)}
                        className="flex w-full items-center gap-3 border-b border-line-soft px-4 py-3 text-left"
                        style={{ background: active ? "#F1F5F2" : "transparent", borderLeft: `3px solid ${active ? "#F26A1B" : "transparent"}` }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-body font-medium">{o.name}</div>
                          <div className="truncate font-mono text-[10.5px] text-ink-faint">{KIND_LABEL[o.kind]}{o.county ? ` · ${o.county}` : ""}</div>
                        </div>
                        <Badge tone={o.status === "active" ? "ok" : "warn"}>{o.status}</Badge>
                      </button>
                    );
                  })}
                  {list.length === 0 && <EmptyState title="No organization matches that" body="Try the organization's name or slug." />}
                </>
              )}
            </div>
          </div>
          <div className="min-w-0 flex-1 overflow-auto">
            {selected ? (
              <OrganizationDetail organization={selected} onChanged={() => setRefreshKey((k) => k + 1)} />
            ) : (
              !loading && <EmptyState title="No organization selected" body="Choose an organization from the list on the left, or add one." />
            )}
          </div>
        </div>
      </div>

      {creating && (
        <AddOrganizationModal onClose={() => setCreating(false)} onCreated={(o) => { setCreating(false); setRefreshKey((k) => k + 1); setSelectedId(o.id); }} toast={toast} />
      )}
    </>
  );
}

function OrganizationDetail({ organization, onChanged }: { organization: Organization; onChanged: () => void }) {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const [approving, setApproving] = useState(false);
  const { data: tenants, loading: tenantsLoading } = useAsync(() => fetchMemberTenants(organization.id), [organization.id, reloadKey]);
  const { data: admins, loading: adminsLoading, error: adminsError } = useAsync(() => fetchOrgAdmins(organization.id), [organization.id, reloadKey]);
  const [invitingAdmin, setInvitingAdmin] = useState(false);

  // One-click approve (FIG-375) — a self-registered org (FIG-370/371) sits
  // 'pending' until this fires; once active, tenant_write_org_admin (FIG-369)
  // lets the org's own admin start self-service-adding schools with no
  // further staff involvement per school.
  async function approve() {
    setApproving(true);
    try {
      const { error } = await supabase().from("organizations").update({ status: "active" }).eq("id", organization.id);
      if (error) throw error;
      toast(`${organization.name} approved.`);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? `Could not approve: ${err.message}` : "Could not approve.");
    } finally {
      setApproving(false);
    }
  }

  return (
    <>
      <div className="border-b border-line bg-white px-7 pt-6">
        {organization.status === "pending" && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-orange-line bg-orange-soft p-4">
            <div className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md bg-orange text-[13px] font-bold text-white">!</div>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold text-orange-ink">Pending approval</div>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-orange-ink">
                Self-registered — nothing is visible to its own admin until you approve it.
              </p>
            </div>
            <Button variant="accent" onClick={() => void approve()} disabled={approving}>
              {approving ? "Approving…" : "Approve organization"}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-h2 font-semibold tracking-tight">{organization.name}</h1>
              <Badge tone={organization.status === "active" ? "ok" : "warn"}>{organization.status}</Badge>
            </div>
            <div className="mt-1 font-mono text-[11.5px] text-ink-muted">
              {KIND_LABEL[organization.kind]}{organization.county ? ` · ${organization.county}` : ""} · {organization.slug}
            </div>
          </div>
          <Button variant="accent" onClick={() => setInvitingAdmin(true)}>Invite org admin</Button>
        </div>
      </div>

      <div className="px-7 py-6">
        <StatRow stats={[
          { label: "Member schools", value: String(tenants?.length ?? 0) },
          { label: "Org admins", value: String(admins?.length ?? 0) },
        ]} />

        <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
          <section>
            <h2 className="mb-2 text-body font-semibold">Member schools</h2>
            {tenantsLoading ? <TableSkeleton rows={4} /> : (
              <DataTable
                columns={[
                  { key: "name", header: "School", width: "1.6fr", render: (t: Tenant) => <Cell sub={t.county}>{t.name}</Cell> },
                  { key: "type", header: "Type", render: (t: Tenant) => <Mono>{t.institution_type === "higher_ed" ? "Higher-ed" : "K-12"}</Mono> },
                  { key: "status", header: "Status", render: (t: Tenant) => <Badge tone={t.status === "active" ? "ok" : "warn"}>{t.status}</Badge> },
                ]}
                rows={tenants ?? []}
                rowKey={(t) => t.id}
                minWidth="0"
                empty={{ title: "No schools assigned yet", body: "Assign a school to this organization from the school's own detail page." }}
              />
            )}
          </section>

          <section>
            <h2 className="mb-2 text-body font-semibold">Org admins</h2>
            {adminsError ? (
              <p className="text-[12.5px] text-warn-ink">Could not load org admins: {adminsError.message}</p>
            ) : adminsLoading ? <TableSkeleton rows={3} /> : (admins ?? []).length === 0 ? (
              <p className="text-[12.5px] text-ink-faint">No org admins invited yet.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-line">
                {(admins ?? []).map((a) => (
                  <div key={a.id} className="border-b border-line-soft px-3.5 py-2.5 last:border-0">
                    <Cell sub={a.email ?? undefined}>{a.full_name}</Cell>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {invitingAdmin && (
        <InviteOrgAdminModal
          organizationId={organization.id}
          onClose={() => setInvitingAdmin(false)}
          // Deliberately does NOT close the modal — it must stay open so its
          // own result view (the auto-generated password, since no real
          // email delivery is configured) is actually shown. Only "Done"
          // (which calls onClose) dismisses it.
          onInvited={() => { setReloadKey((k) => k + 1); onChanged(); }}
          toast={toast}
        />
      )}
    </>
  );
}

function AddOrganizationModal({ onClose, onCreated, toast }: { onClose: () => void; onCreated: (o: Organization) => void; toast: (m: string) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [kind, setKind] = useState<Organization["kind"]>("county");
  const [county, setCounty] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!name.trim() || !slug.trim()) { toast("Name and a slug are required."); return; }
    setSaving(true);
    try {
      const input: NewOrganizationInput = {
        name: name.trim(), slug: slug.trim().toLowerCase(), kind,
        county: county.trim() || null, contact_name: contactName.trim() || null,
        contact_email: contactEmail.trim() || null, contact_phone: null,
      };
      const o = await createOrganization(input);
      toast(`${name.trim()} created.`);
      onCreated(o);
    } catch (err) {
      toast(err instanceof Error ? `Could not create the organization: ${err.message}` : "Could not create the organization.");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) { e.preventDefault(); void create(); }

  return (
    <Modal open onClose={onClose} eyebrow="Organizations" title="Add an organization"
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void create()} disabled={saving}>{saving ? "Creating…" : "Create organization"}</Button></>}>
      <form onSubmit={handleSubmit} className="grid gap-3.5">
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField id="org-name" label="Name" placeholder="e.g. Nakuru County Education Office" value={name} onChange={(e) => setName(e.target.value)} />
          <TextField id="org-slug" label="Slug" mono placeholder="nakuru-county" value={slug} onChange={(e) => setSlug(e.target.value)} />
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField id="org-kind" label="Kind" value={kind} onChange={(e) => setKind(e.target.value as Organization["kind"])}
            options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} />
          <TextField id="org-county" label="County (optional)" placeholder="e.g. Nakuru" value={county} onChange={(e) => setCounty(e.target.value)} />
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField id="org-contact-name" label="Contact name (optional)" value={contactName} onChange={(e) => setContactName(e.target.value)} />
          <TextField id="org-contact-email" label="Contact email (optional)" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
        </div>
      </form>
    </Modal>
  );
}

function InviteOrgAdminModal({ organizationId, onClose, onInvited, toast }: {
  organizationId: string; onClose: () => void; onInvited: () => void; toast: (m: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<OrgAdminInviteResult | null>(null);

  async function invite() {
    if (!fullName.trim() || !email.trim()) { toast("Name and email are required."); return; }
    setSaving(true);
    try {
      const r = await inviteOrgAdmin({ organization_id: organizationId, full_name: fullName.trim(), email: email.trim() });
      setResult(r);
      onInvited();
    } catch (err) {
      toast(err instanceof Error ? `Could not invite the org admin: ${err.message}` : "Could not invite the org admin.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} eyebrow="Organizations" title={result ? (result.linkedExisting ? "Admin added" : "Org admin created") : "Invite an org admin"}
      actions={result ? <Button variant="accent" onClick={onClose}>Done</Button> : (
        <><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void invite()} disabled={saving}>{saving ? "Creating…" : "Create account"}</Button></>
      )}>
      {result ? result.linkedExisting ? (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">{result.email}</span> already has a Figbloom login as an organization
          admin elsewhere — they've been added here too, with their existing sign-in.
        </p>
      ) : (
        <div>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
            No email/SMS provider is configured locally, so nothing was sent — hand these credentials to them directly.
          </p>
          <div className="rounded-lg border border-line bg-page p-3.5">
            {[["Email", result.email], ["Password", result.password]].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-line-soft py-2 text-[12.5px] last:border-0">
                <span className="text-ink-muted">{k}</span><span className="font-mono font-medium">{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-3.5">
          <TextField id="admin-name" label="Full name" placeholder="e.g. Grace Wambui" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          <TextField id="admin-email" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      )}
    </Modal>
  );
}
