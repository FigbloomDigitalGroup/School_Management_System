import { useEffect, useState } from "react";
import { fetchOrgAdminsForOwnOrg, logOrganizationAccess } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { Cell, Mono } from "../../components/ui/DataTable";
import { TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../components/ui/Toast";
import { RecordsPage, type RecordsSpec } from "../platform/RecordsPage";
import { useAsync } from "../../lib/useAsync";
import { useOrgSessionCtx } from "../../lib/orgSessionContext";
import { inviteOrgAdmin, type OrgAdminInviteResult } from "../../lib/platformAdmin";

/**
 * An org owner's own view of who else can sign in and administer this
 * organization — the org-facing counterpart to platform/Organizations.tsx's
 * admin list, reachable without staff involvement (FIG-386/389/390).
 */
export function OrgAdmins() {
  const { profile, organization } = useOrgSessionCtx();
  const [inviting, setInviting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchOrgAdminsForOwnOrg(organization.id), [organization.id, reloadKey]);
  const toast = useToast();

  useEffect(() => {
    void logOrganizationAccess(organization.id, profile.id, "viewed_admins_list");
  }, [organization.id, profile.id]);

  const spec: RecordsSpec = {
    eyebrow: organization.name,
    title: "Admins",
    blurb: "Everyone who can sign in and administer this organization — every school in it, not just one.",
    actions: [{ label: "+ Invite admin", primary: true, onClick: () => setInviting(true) }],
    stats: [{ label: "Admins", value: String(data?.length ?? 0) }],
    columns: [
      { key: "name", header: "Name", width: "1.6fr" },
      { key: "email", header: "Email", width: "1.4fr" },
    ],
    minWidth: "480px",
    rows: (data ?? []).map((a) => ({
      id: a.id,
      tags: [],
      cells: [<Cell>{a.full_name}</Cell>, <Mono>{a.email ?? "—"}</Mono>],
    })),
    empty: { title: "No admins yet", body: "Invite someone to help administer this organization." },
  };

  return (
    <>
      <RecordsPage spec={spec} loading={loading} error={error?.message} />
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
      toast(err instanceof Error ? `Could not invite the admin: ${err.message}` : "Could not invite the admin.");
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
