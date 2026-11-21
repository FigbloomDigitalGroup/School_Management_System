import { useState, type FormEvent } from "react";
import { Button } from "./ui/Button";
import { confirmDialog } from "./ui/Confirm";
import { TextField } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { Skeleton } from "./ui/Skeleton";
import { useToast } from "./ui/Toast";
import { TempPasswordCard } from "./TempPasswordCard";
import { useAsync } from "../lib/useAsync";
import { removeSchoolAdminQuestion, schoolAdminTitle } from "../lib/adminAccounts";
import { adminInviteError } from "../lib/slugAvailability";
import { deleteAccount, fetchSchoolAdmins, inviteAdmin, type InviteAdminResult } from "../lib/platformAdmin";

/**
 * Who can sign in as an administrator of one school, with a way to add another
 * and to take one away. For Figbloom staff (a school's page on the platform
 * console) and an organization's admins (a member school's page): the people
 * invite-admin and delete-account let create and remove a school's
 * administrator. A school's own admin adds teachers and other staff from
 * Students & staff, and holds back from making administrators, so this is not
 * shown to them.
 *
 * Until this existed an administrator could only be added in the moment a
 * school was created: a school added without one, or whose only administrator
 * left, had no way to get one.
 */
export function SchoolAdmins({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const { data: admins, loading, error } = useAsync(() => fetchSchoolAdmins(tenantId), [tenantId, reloadKey]);
  // First load only: a reload after adding or removing keeps the list on screen.
  const firstLoad = loading && !admins;

  async function remove(admin: { id: string; full_name: string }) {
    const q = removeSchoolAdminQuestion(admin.full_name, tenantName, (admins ?? []).length <= 1);
    if (!(await confirmDialog({ ...q, danger: true }))) return;
    setRemoving(admin.id);
    try {
      const r = await deleteAccount({ tenant_id: tenantId, profile_id: admin.id });
      toast(r.warning ?? `${admin.full_name} removed.`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not remove ${admin.full_name}: ${err.message}` : `Could not remove ${admin.full_name}.`, "error");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-white" aria-labelledby={`school-admins-${tenantId}`}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 id={`school-admins-${tenantId}`} className="text-body font-semibold">Administrators</h2>
          <p className="mt-0.5 text-[12px] text-ink-faint">Everyone who can sign in to run this school. Add or remove them here any time.</p>
        </div>
        <Button variant="accent" onClick={() => setAdding(true)}>+ Add administrator</Button>
      </header>

      {error ? (
        <p role="alert" className="px-4 py-3 text-[12.5px] text-warn-ink">Could not load the administrators: {error.message}</p>
      ) : firstLoad ? (
        <div className="grid gap-2 p-4"><Skeleton className="h-9 rounded-md" /><Skeleton className="h-9 rounded-md" /></div>
      ) : (admins ?? []).length === 0 ? (
        <p className="px-4 py-4 text-[12.5px] leading-relaxed text-ink-muted">
          No administrator yet, so nobody at this school can sign in to run it. Add the head teacher or principal; they get a one-time password to start with.
        </p>
      ) : (
        <ul>
          {(admins ?? []).map((a) => (
            <li key={a.id} className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-medium">{a.full_name}</div>
                <div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint">
                  {[a.staff_title, a.email].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
              <Button className="!text-warn-ink" disabled={removing === a.id} onClick={() => void remove(a)} aria-label={`Remove ${a.full_name}`}>
                {removing === a.id ? "Removing…" : "Remove"}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddAdministratorModal
          tenantId={tenantId}
          tenantName={tenantName}
          alreadyThere={(admins ?? []).length}
          onClose={() => setAdding(false)}
          // The modal stays open to show the one-time password; only Done closes it.
          onAdded={() => setReloadKey((k) => k + 1)}
        />
      )}
    </section>
  );
}

function AddAdministratorModal({ tenantId, tenantName, alreadyThere, onClose, onAdded }: {
  tenantId: string; tenantName: string; alreadyThere: number; onClose: () => void; onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [result, setResult] = useState<{ name: string; sent: InviteAdminResult } | null>(null);

  async function add() {
    setError("");
    setEmailError("");
    if (!name.trim() || !email.trim()) { setError("Add their name and their email."); return; }
    setSaving(true);
    try {
      const sent = await inviteAdmin({
        tenant_id: tenantId,
        full_name: name.trim(),
        staff_title: schoolAdminTitle(title, alreadyThere),
        email: email.trim(),
      });
      setResult({ name: name.trim(), sent });
      onAdded();
    } catch (err) {
      const reason = adminInviteError(err, email.trim());
      // a clash is about the email field; anything else is about the whole request
      if (/already has a Figbloom login/.test(reason)) setEmailError(reason);
      else setError(reason);
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) { e.preventDefault(); void add(); }

  if (result) {
    return (
      <Modal open onClose={onClose} eyebrow="Administrators" title={`${result.name} is added`}
        actions={<Button variant="accent" onClick={onClose}>Done</Button>}>
        <div className="grid gap-3.5">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            They can sign in to {tenantName} through the Admin portal with their email.
          </p>
          <TempPasswordCard who={result.name} login={result.sent.email} loginLabel="Email" password={result.sent.password} emailed={result.sent.emailed} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Administrators"
      title="Add an administrator"
      blurb={`A full administrator of ${tenantName}: they can manage everything there, including its staff and learners.`}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void add()} disabled={saving}>{saving ? "Adding…" : "Add administrator"}</Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="grid gap-3.5">
        {error && (
          <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>{error}
          </p>
        )}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField id="new-admin-name" label="Their name" value={name} onChange={(e) => setName(e.target.value)} />
          <TextField id="new-admin-email" label="Their email" type="email" error={emailError || undefined} value={email}
            onChange={(e) => { setEmail(e.target.value); setEmailError(""); }} />
        </div>
        <TextField
          id="new-admin-title" label="Their role at this school (optional)" placeholder="e.g. Head teacher, Principal, Deputy"
          value={title} onChange={(e) => setTitle(e.target.value)}
        />
      </form>
    </Modal>
  );
}
