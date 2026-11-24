import { useState, type FormEvent } from "react";
import { apiMfaDisable, apiMfaRegenerateRecoveryCodes, apiMfaStatus, isApiError, userMessage, type MfaStatus } from "@figbloom/shared";
import { useAsync } from "../../lib/useAsync";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { TextField } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { Skeleton } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { AccountCard } from "./AccountCard";

/**
 * Two-step verification on the account page, from `GET /v1/auth/mfa/status`.
 *
 * Setting it up happens at sign-in, when the server asks for it (admins, org admins and anyone holding the Fees area): the
 * server only ever asks for the code from people it requires it of, so this page does not offer a set-up to anyone else.
 * What it offers is what the server allows afterwards: new recovery codes, and turning it off where it is not required.
 * Both need a fresh code from the app and the password confirmed again; the password prompt is the app's own
 * (ApiSessionGuard) and the call is retried once it is confirmed.
 */
export function TwoStepCard() {
  const [reloadKey, setReloadKey] = useState(0);
  const { data: status, error } = useAsync(() => apiMfaStatus(), [reloadKey]);
  const [action, setAction] = useState<"codes" | "off" | null>(null);
  const reload = () => setReloadKey((k) => k + 1);

  return (
    <AccountCard title="Two-step verification" lead="A 6-digit code from an authenticator app, asked for when you sign in.">
      {error ? (
        <p role="alert" className="text-[12.5px] text-warn-ink">Could not load this: {error.message}</p>
      ) : !status ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <Body status={status} onCodes={() => setAction("codes")} onOff={() => setAction("off")} />
      )}
      {action === "codes" && <NewCodesModal onClose={() => setAction(null)} />}
      {action === "off" && <TurnOffModal onClose={() => setAction(null)} onDone={() => { setAction(null); reload(); }} />}
    </AccountCard>
  );
}

function Body({ status, onCodes, onOff }: { status: MfaStatus; onCodes: () => void; onOff: () => void }) {
  if (!status.enrolled) {
    return (
      <div className="grid gap-2">
        <div><Badge tone="muted">Not set up</Badge></div>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          {status.required
            ? "Your role needs it. You will be asked to set it up the next time you sign in."
            : "Your role is not asked for a second step, so there is nothing to set up. If you are given an admin area that handles money (Fees), you will be asked to set it up when you next sign in."}
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <div><Badge tone="ok">On</Badge></div>
      <p className="text-[12.5px] leading-relaxed text-ink-muted">
        {status.required
          ? "Your role needs it, so it cannot be turned off. If you lose your phone, use a recovery code, then make new codes here."
          : "You have it set up, but your role is not asked for the code when you sign in."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onCodes}>New recovery codes</Button>
        {!status.required && <Button variant="danger" onClick={onOff}>Turn off…</Button>}
      </div>
    </div>
  );
}

function CodeForm({ id, busy, error, submitLabel, onSubmit, onCancel }: {
  id: string; busy: boolean; error: string; submitLabel: string; onSubmit: (code: string) => void; onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(code); }} className="grid gap-3.5">
      <TextField
        id={id} label="6-digit code from your app" mono autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6}
        value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} error={error || undefined}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || code.length !== 6}>{busy ? "Checking…" : submitLabel}</Button>
      </div>
    </form>
  );
}

function wrongCodeText(err: unknown): string {
  return isApiError(err) && err.code === "unauthorized" ? "That code is not right. Wait for the next one and try again." : userMessage(err);
}

function NewCodesModal({ onClose }: { onClose: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function submit(code: string) {
    setBusy(true);
    setError("");
    try {
      setCodes(await apiMfaRegenerateRecoveryCodes(code));
    } catch (err) {
      // A refused password prompt (cancelled) comes back as the original reauth_required.
      setError(isApiError(err) && err.code === "reauth_required" ? "Your password was not confirmed, so nothing changed." : wrongCodeText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open onClose={() => { if (!codes || saved) onClose(); }} eyebrow="Two-step verification" title="New recovery codes" width={440}
      blurb={codes ? "The old codes no longer work. Each new one works once, and they are shown only now." : "The old codes stop working. Enter a code from your app to make new ones."}
    >
      {codes ? (
        <div className="grid gap-3">
          <ul data-testid="new-recovery-codes" className="grid grid-cols-2 gap-1.5 rounded-md border border-line bg-page p-3 font-mono text-[13px]">
            {codes.map((c) => <li key={c} className="select-all">{c}</li>)}
          </ul>
          <label className="flex items-start gap-2 text-[12.5px]">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5" />
            I have saved my recovery codes.
          </label>
          <div className="flex justify-end"><Button variant="primary" disabled={!saved} onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <CodeForm id="acct-codes-code" busy={busy} error={error} submitLabel="Make new codes" onSubmit={(c) => void submit(c)} onCancel={onClose} />
      )}
    </Modal>
  );
}

function TurnOffModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(code: string) {
    setBusy(true);
    setError("");
    try {
      await apiMfaDisable(code);
      toast("Two-step verification is off.");
      onDone();
    } catch (err) {
      setError(isApiError(err) && err.code === "reauth_required" ? "Your password was not confirmed, so nothing changed." : wrongCodeText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} eyebrow="Two-step verification" title="Turn it off?" width={440}
      blurb="Your recovery codes stop working too. Enter a code from your app to confirm.">
      <CodeForm id="acct-off-code" busy={busy} error={error} submitLabel="Turn off" onSubmit={(c) => void submit(c)} onCancel={onClose} />
    </Modal>
  );
}
