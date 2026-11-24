import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  apiChangePassword, apiLoginWithEmail, apiLogout, apiMfaChallenge, apiMfaEnroll, apiMfaVerify, apiReauth,
  continueSignIn, forgetApiSchools, hasSession, isApiError, safeReturnPath, signOutReasonNotice, userMessage,
  type MfaEnrolment, type SignInStep,
} from "@figbloom/shared";
import { AuthLayout, type Scene } from "../components/AuthLayout";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";
import { QrCodeSvg } from "./QrCodeSvg";

/** The illustrated side of sign-in, the same welcome the Supabase build shows. */
const WELCOME: Scene = {
  art: "/portals/welcome.webp", tint: "#E3F0E8", accent: "#17402A", accentDeep: "#123420",
  headline: "One school, everyone in it.",
  tagline: "Admins, teachers, learners, parents, drivers and every other member of staff each have their own way in.",
};

type Stage = "checking" | "credentials" | SignInStep;

/**
 * Sign-in on the new API: email and password, then whatever the server asks before it lets the session do anything
 * (a new password if an admin handed one out, two-step verification), then the school's page. The school-ID sign-in of
 * the Supabase build is not here: the API has no public school search yet (FIG-1872), so only email accounts sign in.
 *
 * Where the person is comes from the server each time (continueSignIn), so a reload in the middle of a step, or a
 * session kept from earlier, lands on the right step.
 */
export function ApiSignIn() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const nextParam = searchParams.get("next");
  const initialNotice = searchParams.get("invited") === "1"
    ? "Invitation accepted. Sign in with your email and new password."
    : signOutReasonNotice(searchParams.get("reason"));
  const [stage, setStage] = useState<Stage>("checking");
  const [notice, setNotice] = useState(initialNotice);

  const proceed = useCallback(async () => {
    try {
      const out = await continueSignIn();
      if (out.kind === "open") {
        const destination = safeReturnPath(nextParam, out.path) ?? out.path;
        nav(destination, { replace: true });
        return;
      }
      if (out.kind === "refused") { setNotice(out.message); setStage("credentials"); return; }
      setNotice("");
      setStage(out.step);
    } catch (err) {
      // 401: the server dropped the session (the client has forgotten it); anything else is shown, and the person can retry.
      if (!(isApiError(err) && err.code === "unauthorized")) setNotice(userMessage(err));
      setStage("credentials");
    }
  }, [nav, nextParam]);

  // A session kept from earlier: carry on from where it stands. Without one, the form.
  useEffect(() => {
    let alive = true;
    void hasSession().then((has) => {
      if (!alive) return;
      if (has) void proceed(); else setStage("credentials");
    });
    return () => { alive = false; };
  }, [proceed]);

  async function abandon() {
    await apiLogout();
    forgetApiSchools();
    setNotice("");
    setStage("credentials");
  }

  return (
    <AuthLayout scene={WELCOME} subtitle="SIGN IN">
      <div className="animate-rise">
        {notice && (
          <p role="alert" className="mb-4 rounded-lg border border-orange-line bg-warn-bg px-4 py-3 text-body text-warn-ink">{notice}</p>
        )}
        {stage === "checking" && <p role="status" className="text-body text-ink-muted">Checking your sign-in…</p>}
        {stage === "credentials" && <CredentialsStep onSignedIn={proceed} />}
        {stage === "change-password" && <ChangePasswordStep onDone={proceed} onCancel={abandon} />}
        {stage === "mfa-enroll" && <EnrolStep onDone={proceed} onCancel={abandon} />}
        {stage === "mfa-challenge" && <ChallengeStep onDone={proceed} onCancel={abandon} />}
      </div>
    </AuthLayout>
  );
}

function Card({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <>
      <h2 className="text-[22px] font-semibold tracking-tight">{title}</h2>
      {lead && <p className="mt-1 text-body text-ink-muted">{lead}</p>}
      <div className="mt-5 rounded-xl border border-line bg-white p-5">{children}</div>
    </>
  );
}

function CancelLink({ onCancel }: { onCancel: () => void }) {
  return (
    <button type="button" onClick={onCancel} className="mt-4 text-[12px] font-medium text-forest hover:underline">
      Sign out and start again
    </button>
  );
}

// ---------------------------------------------------------------- email and password

function CredentialsStep({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError("");
    setBusy(true);
    try {
      await apiLoginWithEmail(email.trim(), password);
    } catch (err) {
      // A wrong email or password is the same answer either way; throttling and outages say what they are.
      setError(isApiError(err) && err.code === "unauthorized" ? "Check the email and password." : userMessage(err));
      setBusy(false);
      return;
    }
    setPassword("");
    try { await onSignedIn(); } finally { setBusy(false); }
  }

  return (
    <Card title="Sign in" lead="Use the email and password you were given.">
      <form onSubmit={(e) => void submit(e)} className="grid gap-3.5">
        <TextField id="api-email" label="Email" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField
          id="api-password" label="Password" type="password" showToggle autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} error={error || undefined}
        />
        <Button type="submit" variant="primary" block disabled={busy || !email.trim() || !password}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <p className="mt-4 text-[12px] leading-relaxed text-ink-faint">
        <Link to="/forgot-password" className="font-medium text-forest hover:underline">Forgot your password?</Link>
        {" "}Signing in with a school ID is not on the new system yet.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------- a password an admin handed out

function ChangePasswordStep({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== again) { setError("The two new passwords are not the same."); return; }
    if (next === current) { setError("Choose a password different from the one you were given."); return; }
    setError("");
    setBusy(true);
    try {
      await apiChangePassword(current, next);
    } catch (err) {
      setError(isApiError(err) && err.code === "unauthorized" ? "The password you were given is not right." : userMessage(err));
      setBusy(false);
      return;
    }
    try { await onDone(); } finally { setBusy(false); }
  }

  return (
    <Card title="Choose your own password" lead="The one you were given was set by someone else. Pick one only you know.">
      <form onSubmit={(e) => void submit(e)} className="grid gap-3.5">
        <TextField id="api-current" label="Password you were given" type="password" showToggle autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <TextField id="api-new" label="New password" type="password" showToggle autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <TextField id="api-again" label="New password again" type="password" showToggle autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} error={error || undefined} />
        <Button type="submit" variant="primary" block disabled={busy || !current || !next || !again}>{busy ? "Saving…" : "Save and continue"}</Button>
      </form>
      <CancelLink onCancel={onCancel} />
    </Card>
  );
}

// ---------------------------------------------------------------- two-step verification: set up

function groupKey(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

function EnrolStep({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const [enrolment, setEnrolment] = useState<MfaEnrolment | null>(null);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Setting up replaces the key and the recovery codes, so it runs on a click, never on its own (React runs effects twice in dev).
  const starting = useRef(false);

  async function start() {
    if (starting.current) return;
    starting.current = true;
    setError("");
    setBusy(true);
    try {
      setEnrolment(await apiMfaEnroll());
      setNeedPassword(false);
    } catch (err) {
      if (isApiError(err) && err.code === "reauth_required") setNeedPassword(true);
      else setError(userMessage(err));
    } finally {
      starting.current = false;
      setBusy(false);
    }
  }

  async function confirmPassword(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await apiReauth(password);
      setPassword("");
    } catch (err) {
      setError(isApiError(err) && err.code === "unauthorized" ? "That password is not right." : userMessage(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    await start();
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await apiMfaVerify(code.trim());
    } catch (err) {
      setError(isApiError(err) && err.code === "unauthorized" ? "That code is not right. Wait for the next one and try again." : userMessage(err));
      setBusy(false);
      return;
    }
    try { await onDone(); } finally { setBusy(false); }
  }

  if (needPassword) {
    return (
      <Card title="Confirm it's you" lead="Setting up two-step verification needs your password again.">
        <form onSubmit={(e) => void confirmPassword(e)} className="grid gap-3.5">
          <TextField id="api-reauth" label="Password" type="password" showToggle autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={error || undefined} />
          <Button type="submit" variant="primary" block disabled={busy || !password}>Continue</Button>
        </form>
        <CancelLink onCancel={onCancel} />
      </Card>
    );
  }

  if (!enrolment) {
    return (
      <Card title="Set up two-step verification" lead="Your account needs a second step at sign-in: a 6-digit code from an authenticator app on your phone.">
        {error && <p role="alert" className="mb-3 text-[12.5px] text-warn-ink">{error}</p>}
        <Button variant="primary" block disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Start"}</Button>
        <CancelLink onCancel={onCancel} />
      </Card>
    );
  }

  return (
    <Card title="Add this account to your authenticator app" lead="Use any authenticator app (Google Authenticator, Microsoft Authenticator, Authy).">
      <ol className="grid gap-4 text-body">
        <li>
          <p className="font-semibold">1. Scan the QR code or add the key</p>
          <p className="mt-1 text-[12.5px] text-ink-muted">Scan this QR code with your authenticator app, or choose “enter a setup key” (time-based) and type the key below.</p>
          <div className="mt-3 flex justify-center">
            <QrCodeSvg value={enrolment.otpauthUri} />
          </div>
          <p data-testid="mfa-secret" className="mt-2 select-all break-all rounded-md border border-line bg-page px-3 py-2 font-mono text-[14px] tracking-wider">{groupKey(enrolment.secret)}</p>
          <a className="mt-1 inline-block text-[12px] font-medium text-forest underline" href={enrolment.otpauthUri}>On this phone? Open it in your authenticator app</a>
        </li>
        <li>
          <p className="font-semibold">2. Keep your recovery codes</p>
          <p className="mt-1 text-[12.5px] text-ink-muted">Each one works once, if you lose your phone. They are shown only now. Write them down or save them somewhere safe.</p>
          <ul data-testid="mfa-recovery" className="mt-2 grid grid-cols-2 gap-1.5 rounded-md border border-line bg-page p-3 font-mono text-[13px]">
            {enrolment.recoveryCodes.map((c) => <li key={c} className="select-all">{c}</li>)}
          </ul>
          <label className="mt-2 flex items-start gap-2 text-[12.5px]">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5" />
            I have saved my recovery codes.
          </label>
        </li>
        <li>
          <p className="font-semibold">3. Enter the first code</p>
          <form onSubmit={(e) => void verify(e)} className="mt-2 grid gap-3">
            <TextField id="api-mfa-code" label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} mono value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} error={error || undefined} />
            <Button type="submit" variant="primary" block disabled={busy || !saved || code.length !== 6}>{busy ? "Checking…" : "Turn on and continue"}</Button>
          </form>
        </li>
      </ol>
      <CancelLink onCancel={onCancel} />
    </Card>
  );
}

// ---------------------------------------------------------------- two-step verification: answer

function ChallengeStep({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
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
    } catch (err) {
      setError(isApiError(err) && err.code === "unauthorized" ? (useRecovery ? "That recovery code is not right, or was used already." : "That code is not right. Wait for the next one and try again.") : userMessage(err));
      setBusy(false);
      return;
    }
    try { await onDone(); } finally { setBusy(false); }
  }

  return (
    <Card title="Two-step verification" lead={useRecovery ? "Enter one of your recovery codes. It works once." : "Enter the 6-digit code from your authenticator app."}>
      <form onSubmit={(e) => void submit(e)} className="grid gap-3.5">
        <TextField
          id="api-mfa-answer" label={useRecovery ? "Recovery code" : "6-digit code"} mono autoFocus
          inputMode={useRecovery ? "text" : "numeric"} autoComplete="one-time-code" maxLength={useRecovery ? 64 : 6}
          value={code} onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ""))} error={error || undefined}
        />
        <Button type="submit" variant="primary" block disabled={busy || (useRecovery ? code.trim().length < 6 : code.length !== 6)}>{busy ? "Checking…" : "Continue"}</Button>
      </form>
      <button type="button" onClick={() => { setUseRecovery((v) => !v); setCode(""); setError(""); }} className="mt-4 block text-[12px] font-medium text-forest hover:underline">
        {useRecovery ? "Use the code from my app instead" : "I can't use my app: use a recovery code"}
      </button>
      <CancelLink onCancel={onCancel} />
    </Card>
  );
}
