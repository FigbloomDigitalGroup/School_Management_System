import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiCompletePasswordReset, apiRequestPasswordReset, isApiError, userMessage } from "@figbloom/shared";
import { AuthLayout, type Scene } from "../components/AuthLayout";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";

const SCENE: Scene = {
  art: "/portals/welcome.webp", tint: "#E3F0E8", accent: "#17402A", accentDeep: "#123420",
  headline: "Back in, safely.",
  tagline: "Reset links work once and only for a short while.",
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * `/forgot-password` on API builds: asks for a reset e-mail. The server answers the same whether or not the address
 * has an account, so the page does too.
 */
export function ApiForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL.test(email.trim())) {
      setError("Enter the email address you sign in with.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await apiRequestPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout scene={SCENE} subtitle="RESET PASSWORD">
      <div className="animate-rise">
        <h2 className="text-[22px] font-semibold tracking-tight">Forgot your password?</h2>
        <div className="mt-5 rounded-xl border border-line bg-white p-5">
          {sent ? (
            <p className="text-body" role="status">
              If <span className="font-medium">{email.trim()}</span> has an account, we have sent it a link to choose a new
              password. The link works once and expires in 30 minutes. Check your spam folder if it does not arrive.
            </p>
          ) : (
            <form onSubmit={(e) => void submit(e)} className="grid gap-3.5">
              <p className="text-body text-ink-muted">We will email you a link to choose a new password.</p>
              <TextField
                id="forgot-email"
                label="Email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={error || undefined}
              />
              <Button type="submit" variant="primary" block disabled={busy || !email.trim()}>
                {busy ? "Sending…" : "Send reset link"}
              </Button>
            </form>
          )}
          <p className="mt-4 text-[12px] text-ink-faint">
            Remembered it?{" "}
            <Link to="/signin" className="font-medium text-forest hover:underline">Sign in</Link>
          </p>
        </div>
      </div>
    </AuthLayout>
  );
}

/**
 * `/reset-password?token=...` on API builds: the link in a reset e-mail. Sets the new password and sends the person
 * to sign in (the server has signed that account out everywhere).
 */
export function ApiResetPassword() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get("token")?.trim() ?? "";
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Choose a password of at least 8 characters.");
      return;
    }
    if (password !== again) {
      setError("The two passwords do not match.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await apiCompletePasswordReset({ token, password });
      nav("/signin?reason=password_reset", { replace: true });
    } catch (err) {
      setError(
        isApiError(err) && err.code === "unauthorized"
          ? "This reset link is invalid, expired or already used. Ask for a new one."
          : userMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout scene={SCENE} subtitle="RESET PASSWORD">
      <div className="animate-rise">
        <h2 className="text-[22px] font-semibold tracking-tight">Choose a new password</h2>
        <div className="mt-5 rounded-xl border border-line bg-white p-5">
          {token.length < 20 ? (
            <p className="text-body" role="alert">
              This reset link is missing or incomplete. Open the link from your email again, or{" "}
              <Link to="/forgot-password" className="font-medium text-forest hover:underline">ask for a new one</Link>.
            </p>
          ) : (
            <form onSubmit={(e) => void submit(e)} className="grid gap-3.5">
              <TextField
                id="reset-password"
                label="New password"
                type="password"
                showToggle
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <TextField
                id="reset-again"
                label="New password again"
                type="password"
                showToggle
                autoComplete="new-password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                error={error || undefined}
              />
              <Button type="submit" variant="primary" block disabled={busy || !password || !again}>
                {busy ? "Saving…" : "Save new password"}
              </Button>
            </form>
          )}
          <p className="mt-4 text-[12px] text-ink-faint">
            <Link to="/forgot-password" className="font-medium text-forest hover:underline">Ask for a new link</Link>
            {" · "}
            <Link to="/signin" className="font-medium text-forest hover:underline">Sign in</Link>
          </p>
        </div>
      </div>
    </AuthLayout>
  );
}
