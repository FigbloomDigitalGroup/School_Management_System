import { useState } from "react";
import {
  apiInviteGuardian, apiRevokeGuardianInvitation, guardianInviteMethod, userMessage,
  type GuardianInvitation, type InvitationSent, type LearnerGuardianContact,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import type { ToastFn } from "../ui/Toast";

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** A one-time value (a code or a link) shown to the person who made it, with a copy button. It is not shown again. */
export function OneTimeValue({ label, value, note }: { label: string; value: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Blocked clipboard: the value is selectable, so it can still be copied by hand.
    }
  }
  return (
    <div className="rounded-lg border border-line bg-page p-3">
      <div className="mb-1 text-[11.5px] font-semibold">{label}</div>
      <p data-testid="one-time-value" className="select-all break-all rounded-md border border-line bg-white px-2.5 py-1.5 font-mono text-[12.5px]">{value}</p>
      <div className="mt-2 flex items-center gap-3">
        <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>
        {note && <span className="text-[11.5px] text-ink-faint">{note}</span>}
      </div>
    </div>
  );
}

/**
 * Invite one guardian of one learner to sign in (the new API: an invitation per guardian record and learner, by e-mail or SMS),
 * send it again (a new invitation replaces the open one) or cancel the open one. When the message could not be sent (no provider
 * set up, or it failed) the server gives the single-use code once, and it is shown here for the school to hand over.
 * Nothing is sent from a local API.
 */
export function GuardianInviteControl({ tenantId, learnerId, guardian, pending, onChanged, toast }: {
  tenantId: string;
  learnerId: string;
  /** `profile_id` is the guardian record's id on the API. */
  guardian: LearnerGuardianContact;
  pending: GuardianInvitation | undefined;
  onChanged: () => void;
  toast: ToastFn;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<(InvitationSent & { method: "email" | "sms" }) | null>(null);
  const method = guardianInviteMethod(guardian);

  async function send() {
    if (!method) return;
    setBusy(true);
    try {
      setSent(await apiInviteGuardian({ tenantId, guardianId: guardian.profile_id, learnerId, method }));
      onChanged();
    } catch (err) {
      toast(`Could not invite ${guardian.full_name}: ${userMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!pending) return;
    setBusy(true);
    try {
      await apiRevokeGuardianInvitation(tenantId, pending.id);
      setSent(null);
      toast(`Invitation for ${guardian.full_name} cancelled.`);
      onChanged();
    } catch (err) {
      toast(`Could not cancel: ${userMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!method) return <span className="text-[12px] text-ink-faint">No e-mail or phone to send an invitation to.</span>;

  return (
    <span className="grid gap-1.5">
      <span className="flex flex-wrap items-center gap-2">
        {pending && !sent && (
          <span className="text-[12px] text-ink-muted">Invited ({pending.contactHint}), open until {shortDate(pending.expiresAt)}.</span>
        )}
        <Button disabled={busy} onClick={() => void send()} aria-label={`${pending ? "Send again to" : "Invite"} ${guardian.full_name}`}>
          {busy ? "Sending…" : pending ? "Send again" : `Invite by ${method === "email" ? "e-mail" : "SMS"}`}
        </Button>
        {pending && <Button disabled={busy} onClick={() => void cancel()}>Cancel invitation</Button>}
      </span>
      {sent && (sent.delivery === "sent" ? (
        <span role="status" className="text-[12px] text-ink-muted">
          Sent by {sent.method === "email" ? "e-mail" : "SMS"}. It works once and ends {shortDate(sent.expiresAt)}.
        </span>
      ) : (
        <span className="grid gap-1.5">
          <span role="status" className="text-[12px] text-warn-ink">
            {sent.delivery === "failed" ? "The message could not be sent." : "Messages are not set up on this system, so nothing was sent."} Give them this code yourself.
          </span>
          {sent.token && <OneTimeValue label="Invitation code" value={sent.token} note={`Works once, ends ${shortDate(sent.expiresAt)}. Shown only now.`} />}
        </span>
      ))}
    </span>
  );
}
