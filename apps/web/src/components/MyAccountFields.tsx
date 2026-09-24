import { useEffect, useState } from "react";
import { fetchMyProfile, updateMyProfile } from "@figbloom/shared";
import { AvatarEditor } from "./Avatar";
import { Button } from "./ui/Button";
import { TextField } from "./ui/Field";
import { TableSkeleton } from "./ui/Skeleton";
import { useToast } from "./ui/Toast";
import { useAsync } from "../lib/useAsync";
import { useTenantSession } from "../lib/sessionContext";

/**
 * Every role except super_admin/org_admin lands in the same ConsoleShell, so
 * this is the one place "edit my own name/phone/photo" needs to exist —
 * mounted per role (teacher/account, admin/account, folded into
 * parent/Settings.tsx) rather than duplicated per screen. Editing your own
 * profiles row is already allowed by RLS (profile_update_self) regardless
 * of role — login_id/email/role stay read-only here since those are the
 * sign-in credential, not descriptive info.
 */
export function MyAccountFields() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchMyProfile(profile.id), [profile.id, reloadKey]);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [avatarOverride, setAvatarOverride] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setFullName(data.full_name);
    setPhone(data.phone ?? "");
    setDirty(false);
  }, [data]);

  async function save() {
    if (!fullName.trim()) { toast("A name is required.", "error"); return; }
    setSaving(true);
    try {
      await updateMyProfile(profile.id, { full_name: fullName.trim(), phone: phone.trim() || null });
      toast("Saved — the sidebar picks it up next time you sign in or reload.");
      setDirty(false);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
        <span aria-hidden>✕</span>Could not load your account: {error.message}
      </p>
    );
  }
  if (loading || !data) return <TableSkeleton rows={4} />;

  return (
    <div className="grid max-w-[480px] gap-3.5 rounded-lg border border-line bg-white p-4">
      <AvatarEditor
        id={profile.id}
        name={fullName}
        kind="staff"
        tenantId={tenant.id}
        url={avatarOverride ?? data.avatar_url}
        onUploaded={setAvatarOverride}
        toast={toast}
      />
      <TextField
        id="my-full-name" label="Full name" value={fullName}
        onChange={(e) => { setFullName(e.target.value); setDirty(true); }}
      />
      <TextField
        id="my-phone" label="Phone" value={phone} placeholder="e.g. 0712 345 678"
        onChange={(e) => { setPhone(e.target.value); setDirty(true); }}
      />
      <div className="flex items-center gap-2 text-[12.5px] text-ink-faint">
        <span>Login:</span>
        <span className="font-mono text-ink-muted">{data.login_id ?? data.email ?? "—"}</span>
      </div>
      <Button variant="accent" disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}
