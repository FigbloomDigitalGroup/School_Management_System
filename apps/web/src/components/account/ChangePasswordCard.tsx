import { useState, type FormEvent } from "react";
import { API_PASSWORD_MIN_LENGTH, apiChangePassword, apiPasswordProblem, isApiError, userMessage } from "@figbloom/shared";
import { Button } from "../ui/Button";
import { TextField } from "../ui/Field";
import { useToast } from "../ui/Toast";
import { AccountCard } from "./AccountCard";

/**
 * Change your password on the new API: the current one is asked for, and the server signs you out everywhere else (this
 * session stays). The same call the sidebar's "Change password" makes.
 */
export function ChangePasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const problem = apiPasswordProblem(next);
    if (problem) { setError(problem); return; }
    if (next !== again) { setError("The two new passwords are not the same."); return; }
    if (next === current) { setError("Choose a password different from your current one."); return; }
    setBusy(true);
    try {
      await apiChangePassword(current, next);
      setCurrent(""); setNext(""); setAgain("");
      toast("Password changed. Your other sign-ins were ended.");
    } catch (err) {
      setError(isApiError(err) && err.code === "unauthorized" ? "Your current password is not right." : userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AccountCard title="Password" lead="Pick one only you know. Changing it signs you out on your other devices.">
      <form onSubmit={(e) => void submit(e)} className="grid gap-3.5">
        <TextField id="acct-current-pw" label="Current password" type="password" showToggle autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <TextField id="acct-new-pw" label="New password" type="password" showToggle autoComplete="new-password" hint={`At least ${API_PASSWORD_MIN_LENGTH} characters, with letters and numbers.`} value={next} onChange={(e) => setNext(e.target.value)} />
        <TextField id="acct-new-pw2" label="New password again" type="password" showToggle autoComplete="new-password" value={again} error={error || undefined} onChange={(e) => setAgain(e.target.value)} />
        <div>
          <Button type="submit" variant="primary" disabled={busy || !current || !next || !again}>{busy ? "Saving…" : "Change password"}</Button>
        </div>
      </form>
    </AccountCard>
  );
}
