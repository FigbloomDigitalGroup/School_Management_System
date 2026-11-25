import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  apiClient,
  apiLogout,
  apiMfaChallenge,
  apiReauth,
  buildSignInRedirect,
  IDLE_TIMEOUT_MS,
  isApiError,
  sessionExpiryWarningMinutes,
  userMessage,
} from "@figbloom/shared";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";
import { Modal } from "../components/ui/Modal";

/**
 * Global session lifecycle & step-up auth guard for API builds (FIG-1890):
 * - Registers `onReauthRequired` and `onMfaRequired` on `apiClient()` so sensitive actions
 *   prompt cleanly in a modal and retry once on success.
 * - Shows a countdown banner during the final 10 minutes of the 8-hour session.
 * - Signs out after 15 minutes of inactivity without clearing form drafts, redirecting to
 *   `/signin?reason=idle&next=...` so signing back in returns to the exact page.
 */
/** A signed-in console page: a school's (`/s/...`), an organisation's (`/org/...`, `/org-picker`, S11) or the platform console (`/platform/...`, P2). */
function inConsole(path: string): boolean {
  return (
    path.startsWith("/s/") ||
    path.startsWith("/org/") ||
    path.startsWith("/org-picker") ||
    path === "/platform" ||
    path.startsWith("/platform/")
  );
}

export function ApiSessionGuard({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const loc = useLocation();
  const locRef = useRef(loc);
  locRef.current = loc;

  const [reauthOpen, setReauthOpen] = useState(false);
  const reauthResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const [mfaOpen, setMfaOpen] = useState(false);
  const mfaResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const [warnMinutes, setWarnMinutes] = useState<number | null>(null);
  const lastActiveRef = useRef(Date.now());
  const idleSigningOutRef = useRef(false);

  // Register global API auth handlers once.
  useEffect(() => {
    const client = apiClient();
    client.setAuthHandlers({
      onSignedOut(reason) {
        const currentPath = `${locRef.current.pathname}${locRef.current.search}`;
        if (inConsole(currentPath)) {
          nav(buildSignInRedirect({ reason, next: currentPath }), { replace: true });
        }
      },
      onReauthRequired() {
        return new Promise<boolean>((resolve) => {
          reauthResolveRef.current = resolve;
          setReauthOpen(true);
        });
      },
      onMfaRequired() {
        return new Promise<boolean>((resolve) => {
          mfaResolveRef.current = resolve;
          setMfaOpen(true);
        });
      },
    });
    return () => {
      client.setAuthHandlers({});
      reauthResolveRef.current?.(false);
      reauthResolveRef.current = null;
      mfaResolveRef.current?.(false);
      mfaResolveRef.current = null;
    };
  }, [nav]);

  // Track user activity (throttled) + check 15-min idle sign-out and 8-hour expiry warning.
  useEffect(() => {
    let lastEventMark = 0;
    const markActive = () => {
      const now = Date.now();
      if (now - lastEventMark < 5_000) return;
      lastEventMark = now;
      lastActiveRef.current = now;
    };

    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    for (const ev of events) window.addEventListener(ev, markActive, { passive: true });

    const check = () => {
      const client = apiClient();
      const session = client.session();
      if (!session) {
        setWarnMinutes(null);
        return;
      }

      setWarnMinutes(sessionExpiryWarningMinutes(session.expiresAt));

      const currentPath = `${locRef.current.pathname}${locRef.current.search}`;
      if (inConsole(currentPath) && !idleSigningOutRef.current && Date.now() - lastActiveRef.current >= IDLE_TIMEOUT_MS) {
        idleSigningOutRef.current = true;
        void apiLogout().finally(() => {
          idleSigningOutRef.current = false;
          nav(buildSignInRedirect({ reason: "idle", next: currentPath }), { replace: true });
        });
      }
    };

    check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      window.clearInterval(timer);
      for (const ev of events) window.removeEventListener(ev, markActive);
    };
  }, [nav]);

  function finishReauth(ok: boolean) {
    setReauthOpen(false);
    const resolve = reauthResolveRef.current;
    reauthResolveRef.current = null;
    resolve?.(ok);
  }

  function finishMfa(ok: boolean) {
    setMfaOpen(false);
    const resolve = mfaResolveRef.current;
    mfaResolveRef.current = null;
    resolve?.(ok);
  }

  async function signInAgainNow() {
    const currentPath = `${loc.pathname}${loc.search}`;
    await apiLogout();
    nav(buildSignInRedirect({ reason: "expired", next: currentPath }), { replace: true });
  }

  return (
    <>
      {warnMinutes !== null && inConsole(loc.pathname) && (
        <div
          role="status"
          data-testid="session-expiry-banner"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-orange-line bg-warn-bg px-4 py-2 text-[13px] text-warn-ink"
        >
          <span>
            Your session ends in {warnMinutes} {warnMinutes === 1 ? "minute" : "minutes"}. Save your work — you&apos;ll need to sign in again to continue.
          </span>
          <Button onClick={() => void signInAgainNow()}>Sign in again</Button>
        </div>
      )}

      {children}

      {reauthOpen && <ReauthModal onDone={finishReauth} />}
      {mfaOpen && <MfaStepUpModal onDone={finishMfa} />}
    </>
  );
}

function ReauthModal({ onDone }: { onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    setError("");
    setBusy(true);
    try {
      await apiReauth(password);
      setPassword("");
      onDone(true);
    } catch (err) {
      setError(isApiError(err) && err.code === "unauthorized" ? "That password is not right." : userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => onDone(false)}
      eyebrow="Security check"
      title="Confirm your password"
      blurb="This action needs your password confirmed again before continuing."
      width={420}
    >
      <form onSubmit={(e) => void submit(e)} className="grid gap-3.5">
        <TextField
          id="reauth-modal-password"
          label="Password"
          type="password"
          showToggle
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error || undefined}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={() => onDone(false)} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !password}>
            {busy ? "Checking…" : "Confirm"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function MfaStepUpModal({ onDone }: { onDone: (ok: boolean) => void }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await apiMfaChallenge(useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() });
      onDone(true);
    } catch (err) {
      setError(
        isApiError(err) && err.code === "unauthorized"
          ? useRecovery
            ? "That recovery code is not right, or was used already."
            : "That code is not right. Wait for the next one and try again."
          : userMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => onDone(false)}
      eyebrow="Security check"
      title="Two-step verification"
      blurb={useRecovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app."}
      width={420}
    >
      <form onSubmit={(e) => void submit(e)} className="grid gap-3.5">
        <TextField
          id="mfa-modal-code"
          label={useRecovery ? "Recovery code" : "6-digit code"}
          mono
          autoFocus
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          maxLength={useRecovery ? 64 : 6}
          value={code}
          onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ""))}
          error={error || undefined}
        />
        <button
          type="button"
          onClick={() => { setUseRecovery((v) => !v); setCode(""); setError(""); }}
          className="text-left text-[12px] font-medium text-forest hover:underline"
        >
          {useRecovery ? "Use the code from my app instead" : "Use a recovery code instead"}
        </button>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={() => onDone(false)} disabled={busy}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || (useRecovery ? code.trim().length < 6 : code.length !== 6)}
          >
            {busy ? "Checking…" : "Continue"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
