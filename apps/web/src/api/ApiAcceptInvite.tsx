import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiAcceptInvitation, isApiError, userMessage } from "@figbloom/shared";
import { AuthLayout, type Scene } from "../components/AuthLayout";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";

const WELCOME: Scene = {
  art: "/portals/welcome.webp", tint: "#E3F0E8", accent: "#17402A", accentDeep: "#123420",
  headline: "One school, everyone in it.",
  tagline: "Accept your school invitation and set a password only you know.",
};

/**
 * `/accept-invite` (and `/invite`) on API builds (FIG-1890).
 * Reads `?token=...` from the invitation link, lets the invitee set their name and password,
 * calls `POST /v1/invitations/accept`, and sends them to `/signin?invited=1`.
 */
export function ApiAcceptInvite() {
  const [params] = useSearchParams();
  const nav = useNavigate();

  const urlToken = params.get("token")?.trim() ?? "";
  const [token, setToken] = useState(urlToken);
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (token.trim().length < 20) {
      setError("This invitation link is missing or incomplete. Ask your school office for a fresh link.");
      return;
    }
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
      await apiAcceptInvitation({ token: token.trim(), password, fullName });
      nav("/signin?invited=1", { replace: true });
    } catch (err) {
      setError(
        isApiError(err) && err.code === "unauthorized"
          ? "This invitation link is invalid, expired, or has already been used."
          : userMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout scene={WELCOME} subtitle="ACCEPT INVITATION">
      <div className="animate-rise">
        <h2 className="text-[22px] font-semibold tracking-tight">Accept your invitation</h2>
        <p className="mt-1 text-body text-ink-muted">Set a password for your school account to get started.</p>
        <div className="mt-5 rounded-xl border border-line bg-white p-5">
          <form onSubmit={(e) => void submit(e)} className="grid gap-3.5">
            {!urlToken && (
              <TextField
                id="invite-token"
                label="Invitation code"
                mono
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste the code from your invitation"
              />
            )}
            <TextField
              id="invite-name"
              label="Full name (optional)"
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
            <TextField
              id="invite-password"
              label="New password"
              type="password"
              showToggle
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <TextField
              id="invite-again"
              label="New password again"
              type="password"
              showToggle
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              error={error || undefined}
            />
            <Button type="submit" variant="primary" block disabled={busy || !token.trim() || !password || !again}>
              {busy ? "Activating…" : "Accept and continue"}
            </Button>
          </form>
          <p className="mt-4 text-[12px] text-ink-faint">
            Already accepted?{" "}
            <Link to="/signin" className="font-medium text-forest hover:underline">Sign in</Link>
          </p>
        </div>
      </div>
    </AuthLayout>
  );
}
