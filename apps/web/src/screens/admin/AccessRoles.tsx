import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ADMIN_PRESETS, deleteSchoolRole, describeAreas, fetchSchoolAdminAreas, fetchSchoolRoles, saveSchoolRole, supabase,
  type AdminArea, type SchoolRole,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { AreaCheckboxes } from "../../components/AdminAccess";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable } from "../../components/ui/DataTable";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

interface AccessData {
  roles: SchoolRole[];
  names: Map<string, string>;
  /** people with admin areas of their own (not from a role), for the summary */
  direct: Map<string, AdminArea[]>;
}

async function fetchAccess(tenantId: string): Promise<AccessData> {
  const [roles, direct, { data: people, error }] = await Promise.all([
    fetchSchoolRoles(tenantId),
    fetchSchoolAdminAreas(tenantId),
    supabase().from("profiles").select("id, full_name").eq("tenant_id", tenantId).in("role", ["teacher", "staff"])
      .returns<{ id: string; full_name: string }[]>(),
  ]);
  if (error) throw new Error(error.message);
  return { roles, direct, names: new Map((people ?? []).map((p) => [p.id, p.full_name])) };
}

/**
 * Access & roles (full admins only, 20261030000000): the school's own roles,
 * each a name and a set of admin areas ("Exams officer" = academics and
 * attendance), and who has admin access of their own. Roles are given to
 * people on their card in Students & staff. Changing a role's areas changes
 * what everyone holding it can do straight away.
 */
export function AccessRoles() {
  const { tenant } = useTenantSession();
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchAccess(tenant.id), [tenant.id, reloadKey]);
  const [editing, setEditing] = useState<SchoolRole | "new" | null>(null);
  const [deleting, setDeleting] = useState<SchoolRole | null>(null);
  const reload = () => setReloadKey((k) => k + 1);
  const holders = (r: SchoolRole) => r.holderIds.map((id) => data?.names.get(id) ?? "Someone").sort();

  return (
    <>
      <PageHead
        eyebrow="School settings"
        title="Access & roles"
        blurb="Full admins (the principal, the school's director, your organization's admins) see everything. Everyone else gets only the admin areas their job needs: make a role here, then give it to people on their card in Students & staff."
        actions={<Button variant="accent" onClick={() => setEditing("new")}>New role</Button>}
      />
      <div className="px-7 py-6">
        {error ? (
          <p className="text-[12.5px] text-warn-ink">Could not load roles: {error.message}</p>
        ) : loading || !data ? (
          <TableSkeleton rows={4} />
        ) : (
          <>
            <DataTable
              columns={[
                { key: "name", header: "Role", width: "1.2fr", render: (r: SchoolRole) => <Cell>{r.name}</Cell> },
                { key: "areas", header: "Areas", width: "2fr", render: (r: SchoolRole) => <span className="text-[13px]">{describeAreas(r.areas)}</span> },
                { key: "held", header: "Held by", width: "1.6fr", render: (r: SchoolRole) => (
                  <span className="text-[13px]">{r.holderIds.length ? holders(r).join(", ") : <span className="text-ink-faint">Nobody yet</span>}</span>
                ) },
                { key: "actions", header: "", align: "right", render: (r: SchoolRole) => (
                  <span className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                    <Button onClick={() => setEditing(r)}>Edit</Button>
                    <Button variant="danger" onClick={() => setDeleting(r)}>Delete…</Button>
                  </span>
                ) },
              ]}
              rows={data.roles}
              rowKey={(r) => r.id}
              onRowClick={(r) => setEditing(r)}
              minWidth="720px"
              empty={{
                title: "No roles yet",
                body: "Make one for a job your school has, like Exams officer or Boarding master, or start from a ready-made one.",
                action: <Button variant="primary" onClick={() => setEditing("new")}>New role</Button>,
              }}
            />
            {data.direct.size > 0 && (
              <section className="mt-6">
                <h2 className="mb-2 text-body font-semibold">Areas given one by one</h2>
                <ul className="grid gap-1 text-[13px]">
                  {[...data.direct].map(([id, areas]) => (
                    <li key={id}><span className="font-semibold">{data.names.get(id) ?? "Someone"}</span>: {describeAreas(areas)}</li>
                  ))}
                </ul>
              </section>
            )}
            <p className="mt-6 text-[12px] leading-relaxed text-ink-faint">
              To give someone a role or areas, open their card in <Link to={`/s/${tenant.slug}/admin/people`} className="font-semibold text-forest">Students & staff</Link>.
            </p>
          </>
        )}
      </div>

      {editing && (
        <RoleEditor
          tenantId={tenant.id}
          role={editing === "new" ? null : editing}
          holderNames={editing === "new" ? [] : holders(editing)}
          onClose={() => setEditing(null)}
          onSaved={(name) => { setEditing(null); reload(); toast(`${name} saved.`); }}
        />
      )}
      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          eyebrow="Access & roles"
          title={`Delete ${deleting.name}?`}
          actions={
            <>
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const role = deleting;
                  deleteSchoolRole(role.id)
                    .then((n) => { toast(`${role.name} deleted${n ? `; ${n} ${n === 1 ? "person" : "people"} lost its areas` : ""}.`); setDeleting(null); reload(); })
                    .catch((err: unknown) => toast(err instanceof Error ? `Could not delete: ${err.message}` : "Could not delete.", "error"));
                }}
              >
                Delete role
              </Button>
            </>
          }
        >
          {deleting.holderIds.length ? (
            <p className="text-[13px] leading-relaxed">
              {holders(deleting).join(", ")} {deleting.holderIds.length === 1 ? "holds" : "hold"} this role and will lose{" "}
              {describeAreas(deleting.areas)}, unless they have those areas another way.
            </p>
          ) : (
            <p className="text-[13px] leading-relaxed">Nobody holds this role, so nobody's access changes.</p>
          )}
        </Modal>
      )}
    </>
  );
}

function RoleEditor({ tenantId, role, holderNames, onClose, onSaved }: {
  tenantId: string;
  role: SchoolRole | null;
  holderNames: string[];
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(role?.name ?? "");
  const [areas, setAreas] = useState<AdminArea[]>(role?.areas ?? []);
  const [saving, setSaving] = useState(false);

  function startFrom(presetId: string) {
    const preset = ADMIN_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setAreas([...preset.areas]);
    if (!name.trim()) setName(preset.label);
  }

  async function save() {
    if (name.trim().length < 2) { toast("Give the role a name.", "error"); return; }
    setSaving(true);
    try {
      await saveSchoolRole(tenantId, role?.id ?? null, name.trim(), areas);
      onSaved(name.trim());
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Access & roles"
      title={role ? `Edit ${role.name}` : "New role"}
      blurb={role && holderNames.length
        ? `${holderNames.join(", ")} ${holderNames.length === 1 ? "holds" : "hold"} this role: what you change here changes their access as soon as you save.`
        : "A name for a job at your school, and the admin areas it needs."}
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="accent" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save role"}</Button></>}
    >
      <div className="grid gap-3.5">
        <TextField id="role-name" label="Name" placeholder="e.g. Exams officer" value={name} onChange={(e) => setName(e.target.value)} />
        {!role && (
          <SelectField
            id="role-start"
            label="Start from (optional)"
            value=""
            onChange={(e) => startFrom(e.target.value)}
            options={[{ value: "", label: "Nothing, I'll tick the areas" }, ...ADMIN_PRESETS.map((p) => ({ value: p.id, label: `${p.label} (${describeAreas(p.areas)})` }))]}
          />
        )}
        <AreaCheckboxes idPrefix="role-area" value={areas} onChange={setAreas} />
      </div>
    </Modal>
  );
}
