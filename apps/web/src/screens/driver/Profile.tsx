import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { setMyPassword, supabase } from "@figbloom/shared";
import { MyAccountFields } from "../../components/MyAccountFields";
import { Button } from "../../components/ui/Button";
import { TextField } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";

/** The driver's pages share the trip screen's full-width green header, not ConsoleShell. */
function DriverFrame({ title, back, children }: { title: string; back?: boolean; children: ReactNode }) {
  const { tenant } = useTenantSession();
  return (
    <div className="min-h-[100dvh] bg-page">
      <header className="flex items-center gap-3 bg-forest px-5 py-3.5 text-white">
        {back && (
          <Link to=".." relative="path" className="hit -ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/30 text-[18px] text-white" aria-label="Back to trip">←</Link>
        )}
        <div className="min-w-0">
          <div className="truncate text-lead font-semibold tracking-tight">{title}</div>
          <div className="font-mono text-micro tracking-[0.12em] text-white/70">{tenant.name.toUpperCase()} · DRIVER</div>
        </div>
      </header>
      <div className="mx-auto grid max-w-[480px] gap-4 px-4 py-5">{children}</div>
    </div>
  );
}

/**
 * What a driver can change themselves: their photo (parents see it, so the
 * admin is told when it changes), their phone and their password. Name,
 * title, bus and route belong to the school.
 */
export function DriverProfile() {
  const toast = useToast();
  const navigate = useNavigate();

  return (
    <DriverFrame title="My profile" back>
      <p className="text-small leading-relaxed text-ink-muted">
        Parents see your photo and name on their bus page so they know who's collecting their child. Use a clear photo of your face.
      </p>
      <MyAccountFields nameLocked />
      <section className="rounded-lg border border-line bg-white p-4">
        <h2 className="mb-3 text-[14px] font-semibold">Change password</h2>
        <PasswordForm submitLabel="Change password" onDone={() => toast("Password changed")} />
      </section>
      <button
        onClick={() => void supabase().auth.signOut().then(() => navigate("/signin", { replace: true }))}
        className="hit justify-self-start rounded-lg border border-line px-4 py-2 text-small font-semibold text-ink-muted"
      >
        Sign out
      </button>
    </DriverFrame>
  );
}

/**
 * The password an admin handed over is only for getting in the first time:
 * until the driver chooses their own, that's the only thing on screen.
 */
export function DriverPasswordGate({ children }: { children: ReactNode }) {
  const { profile } = useTenantSession();
  const [done, setDone] = useState(false);
  if (!profile.must_change_password || done) return <>{children}</>;

  return (
    <DriverFrame title={`Welcome, ${profile.full_name.split(" ")[0]}`}>
      <div className="rounded-lg border border-line bg-white p-4">
        <h1 className="text-[16px] font-semibold">Choose your own password</h1>
        <p className="mb-4 mt-1 text-small leading-relaxed text-ink-muted">
          The school gave you a password to get started. Pick one only you know before you drive. You'll use it with your login ID <span className="font-mono">{profile.login_id}</span> from now on.
        </p>
        <PasswordForm submitLabel="Save and continue" onDone={() => setDone(true)} />
      </div>
    </DriverFrame>
  );
}

function PasswordForm({ submitLabel, onDone }: { submitLabel: string; onDone: () => void }) {
  const { profile } = useTenantSession();
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
      await setMyPassword(profile.id, password);
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
