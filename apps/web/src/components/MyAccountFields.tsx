import { useEffect, useState, type ReactNode } from "react";
import { accountCapabilities, fetchMyProfile, updateMyProfile, type MyProfile } from "@figbloom/shared";
import { Avatar, AvatarEditor } from "./Avatar";
import { RoleBadge } from "./ui/Badge";
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
export function MyAccountFields({ nameLocked = false }: {
  /** Drivers: the school set the name parents know them by, so it isn't theirs to change. */
  nameLocked?: boolean;
} = {}) {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  // a family's second number: the office tries it when the first is off
  const withAltPhone = profile.role === "parent";
  const [reloadKey, setReloadKey] = useState(0);
  // No `loading`: the reload after a save must not swap the form for a skeleton.
  const { data, error } = useAsync(() => fetchMyProfile(profile.id), [profile.id, reloadKey]);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [altPhone, setAltPhone] = useState("");
  const [avatarOverride, setAvatarOverride] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setFullName(data.full_name);
    setPhone(data.phone ?? "");
    setAltPhone(data.alt_phone ?? "");
    setDirty(false);
  }, [data]);

  async function save() {
    if (!fullName.trim()) { toast("A name is required.", "error"); return; }
    setSaving(true);
    try {
      const phones = { phone: phone.trim() || null, ...(withAltPhone ? { alt_phone: altPhone.trim() || null } : {}) };
      await updateMyProfile(profile.id, nameLocked ? phones : { full_name: fullName.trim(), ...phones });
      toast(nameLocked ? "Saved" : "Saved — the sidebar picks it up next time you sign in or reload.");
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
  if (!data) return <TableSkeleton rows={4} />;

  // The new API has no way to change one's own name, phone or photo: show who is signed in, and say so.
  if (!accountCapabilities().editProfile) return <ReadOnlyProfile data={data} />;

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
        id="my-full-name" label="Full name" value={fullName} disabled={nameLocked}
        hint={nameLocked ? "Set by the school. Ask the office if it's wrong." : undefined}
        onChange={(e) => { setFullName(e.target.value); setDirty(true); }}
      />
      <TextField
        id="my-phone" label="Phone" value={phone} placeholder="e.g. 0712 345 678"
        onChange={(e) => { setPhone(e.target.value); setDirty(true); }}
      />
      {withAltPhone && (
        <TextField
          id="my-alt-phone" label="Other phone (optional)" value={altPhone} placeholder="e.g. a work or second line"
          onChange={(e) => { setAltPhone(e.target.value); setDirty(true); }}
        />
      )}
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

/** What the server says about the signed-in person, with no form: used where the backend cannot change it (accountCapabilities().editProfile). */
function ReadOnlyProfile({ data }: { data: MyProfile }) {
  const { profile, tenant } = useTenantSession();
  const rows: [string, ReactNode][] = [
    ["Name", data.full_name],
    ["Email", data.email ?? "—"],
    ["Sign-in ID", data.login_id ? <span className="font-mono">{data.login_id}</span> : "—"],
    ["Role", <RoleBadge key="role" role={profile.role} tenant={tenant} />],
    ["School", tenant.name],
  ];
  return (
    <section aria-label="Your details" className="max-w-[480px] overflow-hidden rounded-lg border border-line bg-white">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Avatar id={profile.id} name={data.full_name} url={null} size={40} />
        <div className="min-w-0">
          <h2 className="truncate text-body font-semibold">{data.full_name}</h2>
          <p className="text-[11.5px] text-ink-faint">Your details at {tenant.name}</p>
        </div>
      </header>
      <dl className="px-4">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center gap-3 border-b border-line-soft py-2.5 text-[13px] last:border-0">
            <dt className="w-24 shrink-0 text-ink-faint">{label}</dt>
            <dd className="min-w-0 flex-1 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="border-t border-line bg-page px-4 py-2.5 text-[12px] leading-relaxed text-ink-muted">
        Changing your own name, phone number or photo is not on the new system yet.
      </p>
    </section>
  );
}
