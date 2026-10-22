import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@figbloom/shared";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";

type Status = "checking" | "ready" | "invalid" | "done";

/**
 * Where the email link from SignIn's "Forgot password?" lands. Supabase
 * parses the recovery token out of the URL itself (detectSessionInUrl) and
 * fires PASSWORD_RECOVERY — we just wait for either that or an existing
 * session before letting the new password through.
 */
export function ResetPassword() {
  const nav = useNavigate();
  const [status, setStatus] = useState<Status>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase().auth.getSession().then(({ data }) => {
      if (alive && data.session) setStatus("ready");
      else if (alive) setStatus((s) => (s === "checking" ? "invalid" : s));
    });
    const { data: sub } = supabase().auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setStatus("ready");
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("At least 8 characters."); return; }
    if (password !== confirm) { setError("The passwords don't match."); return; }
    setBusy(true);
    try {
      const { error: err } = await supabase().auth.updateUser({ password });
      if (err) throw err;
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the new password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-page p-6">
      <div className="w-full max-w-[420px] rounded-xl border border-line bg-white p-5">
        <h1 className="text-[17px] font-semibold">Set a new password</h1>

        {status === "checking" && (
          <p className="mt-3 text-small text-ink-muted">Checking your link…</p>
        )}

        {status === "invalid" && (
          <>
            <p className="mt-3 text-small leading-relaxed text-ink-muted">
              This link is invalid or has expired. Request a new one from the sign-in screen.
            </p>
            <Button variant="primary" block className="mt-4" onClick={() => nav("/signin")}>Back to sign in</Button>
          </>
        )}

        {status === "done" && (
          <>
            <p className="mt-3 text-small leading-relaxed text-ink-muted">
              Your password has been changed. Sign in with it from now on.
            </p>
            <Button variant="primary" block className="mt-4" onClick={() => nav("/signin")}>Sign in</Button>
          </>
        )}

        {status === "ready" && (
          <form onSubmit={submit} className="mt-4 grid gap-3.5">
            <TextField id="pw" label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 8 characters." />
            <TextField id="pw2" label="Confirm password" type="password" value={confirm} error={error} onChange={(e) => setConfirm(e.target.value)} />
            <Button type="submit" variant="primary" block disabled={busy}>{busy ? "Saving…" : "Set password"}</Button>
          </form>
        )}
      </div>
    </div>
  );
}
