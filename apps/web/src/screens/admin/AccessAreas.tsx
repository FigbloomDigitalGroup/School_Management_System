import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  DIRECTOR_NOTE, accessLockedReason, apiFetchAccessPeople, apiFetchGuardianAccess, apiFetchOrgDelegations, apiFetchStaffAreas, apiRevokeOrgDelegations,
  apiSetGuardianAccess, apiSetStaffAreas, describeAreas, describeDelegatedCode, isApiError, sortAreas, userMessage,
  type AccessPerson, type AdminArea, type GuardianAccess, type OrgDelegation,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { AreaCheckboxes, PresetChips } from "../../components/AdminAccess";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { confirmDialog } from "../../components/ui/Confirm";
import { Cell, DataTable } from "../../components/ui/DataTable";
import { Modal } from "../../components/ui/Modal";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

interface AccessData {
  people: AccessPerson[];
  areas: Map<string, AdminArea[]>;
  delegations: OrgDelegation[];
}

async function fetchAccess(tenantId: string): Promise<AccessData> {
  const [people, areas, delegations] = await Promise.all([apiFetchAccessPeople(tenantId), apiFetchStaffAreas(), apiFetchOrgDelegations()]);
  return { people, areas, delegations };
}

const CLASSIFICATION_LABEL: Record<AccessPerson["classification"], string> = {
  school_admin: "Admin", teacher: "Teacher", staff: "Other staff", driver: "Driver",
};

/**
 * Access & roles on the new API (full admins only): which admin areas each teacher or other staff member holds, and who may read
 * or change the parents' records. The API has no school roles to hand out ("Exams officer"), so access is given one person at a
 * time, and the roles table of the Supabase build is not shown. Every change asks for the password again, which the app does
 * itself before the call goes through.
 */
export function AccessAreas() {
  const { tenant, profile } = useTenantSession();
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchAccess(tenant.id), [tenant.id, reloadKey]);
  const [editing, setEditing] = useState<AccessPerson | null>(null);
  const reload = () => setReloadKey((k) => k + 1);

  async function revoke(d: OrgDelegation) {
    const ok = await confirmDialog({
      title: "Take back this access?",
      body: "That organization administrator loses everything they were given in this school. They can be given it again.",
      confirmLabel: "Take back", danger: true,
    });
    if (!ok) return;
    try {
      await apiRevokeOrgDelegations(d.delegateUserId);
      toast("Access taken back.");
      reload();
    } catch (err) {
      toast(isApiError(err) && err.code === "reauth_required" ? "Your password was not confirmed, so nothing changed." : `Could not take it back: ${userMessage(err)}`, "error");
    }
  }

  return (
    <>
      <PageHead
        eyebrow="School settings"
        title="Access & roles"
        blurb="Full admins (the principal, the school's director, your organization's admins) see everything. Everyone else gets only the admin areas their job needs: give them here, one person at a time. Naming your own roles, like Exams officer, is not on the new system yet."
      />
      <div className="grid gap-6 px-7 py-6">
        {error ? (
          <p role="alert" className="text-[12.5px] text-warn-ink">Could not load access: {error.message}</p>
        ) : loading || !data ? (
          <TableSkeleton rows={5} />
        ) : (
          <>
            <DataTable
              title="Admin areas"
              columns={[
                { key: "name", header: "Person", width: "1.4fr", render: (p: AccessPerson) => (
                  <Cell>{p.name}{p.title && <span className="ml-2 text-[11.5px] text-ink-faint">{p.title}</span>}</Cell>
                ) },
                { key: "role", header: "Role", width: "0.8fr", render: (p: AccessPerson) => <span className="text-[13px]">{CLASSIFICATION_LABEL[p.classification]}</span> },
                { key: "areas", header: "Admin areas", width: "2fr", render: (p: AccessPerson) => {
                  const locked = accessLockedReason(p, profile.id);
                  const held = p.userId ? data.areas.get(p.userId) ?? [] : [];
                  if (p.classification === "school_admin") return <Badge tone="info">Everything</Badge>;
                  if (locked && held.length === 0) return <span className="text-[12px] text-ink-faint">{locked}</span>;
                  return <span className="text-[13px]">{describeAreas(held)}</span>;
                } },
                { key: "actions", header: "", align: "right", render: (p: AccessPerson) => (
                  accessLockedReason(p, profile.id) ? null : (
                    <span className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                      <Button onClick={() => setEditing(p)} aria-label={`Change access for ${p.name}`}>Change</Button>
                    </span>
                  )
                ) },
              ]}
              rows={data.people}
              rowKey={(p) => p.staffId}
              onRowClick={(p) => { if (!accessLockedReason(p, profile.id)) setEditing(p); }}
              minWidth="720px"
              empty={{
                title: "No staff yet",
                body: "Add teachers and other staff in Students & staff first. They need a sign-in before they can be given admin areas.",
              }}
            />

            <section aria-label="Organization administrators">
              <h2 className="mb-2 text-body font-semibold">Organization administrators</h2>
              {data.delegations.length === 0 ? (
                <p className="max-w-[640px] text-[12.5px] leading-relaxed text-ink-muted">
                  No organization administrator has been given access to this school's admin areas. Giving it starts from the organization's own
                  console, which is not on the new system yet.
                </p>
              ) : (
                <ul className="grid max-w-[720px] gap-2">
                  {data.delegations.map((d) => (
                    <li key={d.delegateUserId} className="flex items-start gap-3 rounded-lg border border-line bg-white px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold">An organization administrator <span className="font-mono text-[11.5px] font-normal text-ink-faint">({d.delegateUserId.slice(0, 8)})</span></div>
                        <div className="mt-0.5 text-[12.5px] text-ink-muted">{d.codes.map(describeDelegatedCode).join(", ")}</div>
                      </div>
                      <Button variant="danger" onClick={() => void revoke(d)}>Take back…</Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <p className="text-[12px] leading-relaxed text-ink-faint">
              {DIRECTOR_NOTE} To invite someone who has no sign-in yet, open <Link to={`/s/${tenant.slug}/admin/people`} className="font-semibold text-forest">Students & staff</Link>.
            </p>
          </>
        )}
      </div>

      {editing && data && (
        <PersonAccessEditor
          person={editing}
          current={editing.userId ? data.areas.get(editing.userId) ?? [] : []}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); reload(); toast(message); }}
        />
      )}
    </>
  );
}

function PersonAccessEditor({ person, current, onClose, onSaved }: {
  person: AccessPerson;
  current: readonly AdminArea[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const toast = useToast();
  const userId = person.userId!;
  const first = person.name.split(" ")[0] ?? person.name;
  const [areas, setAreas] = useState<AdminArea[]>(sortAreas(current));
  const guardian = useAsync(() => apiFetchGuardianAccess(userId), [userId]);
  const [guard, setGuard] = useState<GuardianAccess | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (guardian.data) setGuard(guardian.data); }, [guardian.data]);

  const areasChanged = sortAreas(current).join() !== areas.join();
  const guardChanged = !!guard && !!guardian.data && (guard.read !== guardian.data.read || guard.write !== guardian.data.write);

  async function save() {
    setSaving(true);
    try {
      let now = sortAreas(current);
      if (areasChanged) now = await apiSetStaffAreas(userId, areas);
      if (guardChanged && guard && guardian.data) await apiSetGuardianAccess(userId, guardian.data, guard);
      onSaved(areasChanged
        ? (now.length ? `${first} now has: ${describeAreas(now)}.` : `${first} no longer has admin access.`)
        : `${first}'s access to parents' records was saved.`);
    } catch (err) {
      const text = isApiError(err) && err.code === "reauth_required" ? "Your password was not confirmed, so nothing changed." : `Could not save: ${userMessage(err)}`;
      toast(text, "error");
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Access & roles"
      title={`Access for ${person.name}`}
      blurb={`${first} keeps their own login and console, and switches to Admin for these areas. School settings, the overview and this page stay with full admins.`}
      width={680}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving || (!areasChanged && !guardChanged)} onClick={() => void save()}>{saving ? "Saving…" : "Save access"}</Button>
        </>
      }
    >
      <div className="grid gap-5">
        <section>
          <div className="mb-1.5 text-[11.5px] font-semibold">Quick picks</div>
          <PresetChips value={areas} onChange={setAreas} />
        </section>
        <section>
          <div className="mb-1.5 text-[11.5px] font-semibold">Admin areas</div>
          <AreaCheckboxes idPrefix={`access-${person.staffId}`} value={areas} onChange={setAreas} />
        </section>
        <section>
          <div className="mb-1.5 text-[11.5px] font-semibold">Parents' records</div>
          <p className="mb-2 text-[12px] leading-relaxed text-ink-muted">The People area does not include parents' contact details. Give that here, to this person only.</p>
          {guardian.error ? (
            <p role="alert" className="text-[12.5px] text-warn-ink">Could not load this: {guardian.error.message}</p>
          ) : !guard ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="grid gap-1.5">
              {([["read", "Read parents' records"], ["write", "Add and change parents' records"]] as const).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={guard[key]} onChange={(e) => setGuard({ ...guard, [key]: e.target.checked })} style={{ accentColor: "#17402A" }} />
                  {label}
                </label>
              ))}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
