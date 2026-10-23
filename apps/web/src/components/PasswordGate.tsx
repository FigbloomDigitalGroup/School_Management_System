import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { setMyPassword, supabase, type Profile } from "@figbloom/shared";
import { Button } from "./ui/Button";
import { TextField } from "./ui/Field";

/**
 * The password an admin handed over is only for getting in the first time:
 * until the person chooses their own, that's the only thing on screen. Every
 * account created on someone's behalf starts with must_change_password set
 * (supabase/functions/_shared/tempPassword.ts), whatever the role.
 */
export function PasswordGate({ profile, children }: { profile: Profile; children: ReactNode }) {
  const navigate = useNavigate();
  const [done, setDone] = useState(false);
  if (!profile.must_change_password || done) return <>{children}</>;

  return (
    <div className="grid min-h-screen place-items-center bg-page p-6">
      <div className="w-full max-w-[420px] rounded-xl border border-line bg-white p-5">
        <h1 className="text-[17px] font-semibold">Welcome, {profile.full_name.split(" ")[0]}</h1>
        <p className="mb-4 mt-1 text-small leading-relaxed text-ink-muted">
          The password you were given is only for signing in the first time. Choose one only you know — you'll use it with{" "}
          {profile.login_id
            ? <>your login ID <span className="font-mono">{profile.login_id}</span></>
            : <span className="font-mono">{profile.email}</span>}{" "}
          from now on.
        </p>
        <PasswordForm profileId={profile.id} submitLabel="Save and continue" onDone={() => setDone(true)} />
        <button
          onClick={() => void supabase().auth.signOut().then(() => navigate("/signin", { replace: true }))}
          className="hit mt-3 text-small font-semibold text-ink-muted"
        >
          Not you? Sign out
        </button>
      </div>
    </div>
  );
}

export function PasswordForm({ profileId, submitLabel, onDone }: { profileId: string; submitLabel: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("At least 8 characters."); return; }
    if (password !== confirm) { setError("The passwords don't match."); return; }
    setBusy(true);
    try {
      await setMyPassword(profileId, password);
      setPassword(""); setConfirm("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3.5">
      <TextField id="new-pw" label="New password" type="password" showToggle autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 8 characters." />
      <TextField id="new-pw2" label="Type it again" type="password" autoComplete="new-password" value={confirm} error={error} onChange={(e) => setConfirm(e.target.value)} />
      <Button type="submit" variant="primary" block disabled={busy}>{busy ? "Saving…" : submitLabel}</Button>
    </form>
  );
}
