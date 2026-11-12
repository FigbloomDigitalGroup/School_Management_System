import { useEffect, useState } from "react";
import { fetchOrgAdminsForOwnOrg, logOrganizationAccess } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { confirmDialog } from "../../components/ui/Confirm";
import { Cell, Mono } from "../../components/ui/DataTable";
import { TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { useToast, type ToastFn } from "../../components/ui/Toast";
import { RecordsPage, type RecordsSpec } from "../platform/RecordsPage";
import { useAsync } from "../../lib/useAsync";
import { useOrgSessionCtx } from "../../lib/orgSessionContext";
import { inviteOrgAdmin, removeOrgAdmin, type OrgAdminInviteResult } from "../../lib/platformAdmin";
import { orgAdminRemovedNote, removeOrgAdminQuestion } from "../../lib/adminAccounts";
import { handOverNote } from "../../components/TempPasswordCard";

/**
 * An org owner's own view of who else can sign in and administer this
 * organization — the org-facing counterpart to platform/Organizations.tsx's
 * admin list, reachable without staff involvement (FIG-386/389/390). An admin
 * can also take a co-admin out here; nobody removes themselves (so an
 * organization is never left with nobody to run it).
 */
export function OrgAdmins() {
  const { profile, organization } = useOrgSessionCtx();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchOrgAdminsForOwnOrg(organization.id), [organization.id, reloadKey]);
  const toast = useToast();

  useEffect(() => {
    void logOrganizationAccess(organization.id, profile.id, "viewed_admins_list");
  }, [organization.id, profile.id]);

  async function remove(admin: { id: string; full_name: string }) {
    if (!(await confirmDialog({ ...removeOrgAdminQuestion(admin.full_name, organization.name), danger: true }))) return;
    setRemoving(admin.id);
    try {
      const r = await removeOrgAdmin({ organization_id: organization.id, profile_id: admin.id });
      toast(orgAdminRemovedNote(r, admin.full_name, organization.name));
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not remove ${admin.full_name}: ${err.message}` : `Could not remove ${admin.full_name}.`, "error");
    } finally {
      setRemoving(null);
    }
  }

  const spec: RecordsSpec = {
    eyebrow: organization.name,
    title: "Admins",
    blurb: "Everyone who can sign in and administer this organization — every school in it, not just one.",
    actions: [{ label: "+ Invite admin", primary: true, onClick: () => setInviting(true) }],
    stats: [{ label: "Admins", value: String(data?.length ?? 0) }],
    columns: [
      { key: "name", header: "Name", width: "1.6fr" },
      { key: "email", header: "Email", width: "1.4fr" },
      { key: "actions", header: "", width: "110px", align: "right" },
    ],
    minWidth: "480px",
    rows: (data ?? []).map((a) => ({
      id: a.id,
      tags: [],
      cells: [
        <Cell>{a.full_name}</Cell>,
        <Mono>{a.email ?? "—"}</Mono>,
        a.id === profile.id
          ? <span className="text-[12px] text-ink-faint">You</span>
          : <Button className="!text-warn-ink" disabled={removing === a.id} onClick={() => void remove(a)} aria-label={`Remove ${a.full_name}`}>{removing === a.id ? "Removing…" : "Remove"}</Button>,
      ],
    })),
    empty: { title: "No admins yet", body: "Invite someone to help administer this organization." },
  };

  return (
    <>
      {/* First load only — a reload after inviting keeps the list on screen. */}
      <RecordsPage spec={spec} loading={loading && !data} error={error?.message} />
      {inviting && (
        <InviteAdminModal
          organizationId={organization.id}
          onClose={() => setInviting(false)}
          onInvited={() => setReloadKey((k) => k + 1)}
          toast={toast}
        />
      )}
    </>
  );
}

function InviteAdminModal({ organizationId, onClose, onInvited, toast }: {
  organizationId: string; onClose: () => void; onInvited: () => void; toast: ToastFn;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<OrgAdminInviteResult | null>(null);

  async function invite() {
    if (!fullName.trim() || !email.trim()) { toast("Name and email are required.", "error"); return; }
    setSaving(true);
    try {
      const r = await inviteOrgAdmin({ organization_id: organizationId, full_name: fullName.trim(), email: email.trim() });
      setResult(r);
      onInvited();
    } catch (err) {
      toast(err instanceof Error ? `Could not invite the admin: ${err.message}` : "Could not invite the admin.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Admins"
      title={result ? (result.linkedExisting ? "Admin added" : "Admin created") : "Invite an admin"}
      actions={result ? <Button variant="accent" onClick={onClose}>Done</Button> : (
        <><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void invite()} disabled={saving}>{saving ? "Creating…" : "Invite"}</Button></>
      )}
    >
      {result ? result.linkedExisting ? (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">{result.email}</span> already has a Figbloom login as an organization
          admin elsewhere — they've been added here too, with their existing sign-in.
        </p>
      ) : (
        <div>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
            {handOverNote(result.emailed)}
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
