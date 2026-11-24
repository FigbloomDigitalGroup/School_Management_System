import { useState } from "react";
import {
  acceptInviteLink, apiInviteStaff, apiIssueMemberReset, apiListGuardianInvitations, apiRevokeStaffInvitation, fetchLearnerGuardians,
  resetPasswordLink, userMessage, type GuardianInvitation, type InvitationSent, type LearnerGuardianContact, type RosterStaff, type StaffInviteRole,
} from "@figbloom/shared";
import { GuardianInviteControl, OneTimeValue } from "../../components/learners/GuardianInvite";
import { Button } from "../../components/ui/Button";
import { TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import type { ToastFn } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const shortTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** How many selected learners the guardian invitations list shows at once (each one is a request for their guardians). */
export const GUARDIAN_INVITE_LEARNER_CAP = 25;

/**
 * "Invite guardians" on the new API. A guardian is a contact record, so an invitation goes to each guardian of each selected learner,
 * by e-mail (or SMS when there is no e-mail). The list says who has one open, and a guardian already holding one can be sent it again
 * or have it cancelled. Families can read nothing on the new system yet, so the page says what an accepted invitation does now.
 */
export function InviteGuardiansApiModal({ tenantId, students, onClose, toast }: {
  tenantId: string; students: { id: string; name: string }[]; onClose: () => void; toast: ToastFn;
}) {
  const shown = students.slice(0, GUARDIAN_INVITE_LEARNER_CAP);
  const key = shown.map((s) => s.id).join(",");
  const guardians = useAsync(async () => {
    const out = new Map<string, LearnerGuardianContact[]>();
    for (let i = 0; i < shown.length; i += 4) {
      const batch = shown.slice(i, i + 4);
      const lists = await Promise.all(batch.map((s) => fetchLearnerGuardians(s.id)));
      batch.forEach((s, j) => out.set(s.id, lists[j]!));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const [reloadKey, setReloadKey] = useState(0);
  const pending = useAsync(() => apiListGuardianInvitations(tenantId, "pending"), [tenantId, reloadKey]);
  const open = (guardianId: string, learnerId: string): GuardianInvitation | undefined =>
    pending.data?.find((i) => i.guardianId === guardianId && i.learnerId === learnerId);

  return (
    <Modal
      open onClose={onClose} eyebrow="Guardians" title="Invite guardians" width={720}
      blurb={`For ${shown.map((s) => s.name).join(", ")}.`}
      actions={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="grid gap-4">
        <p className="rounded-lg border border-line bg-page px-3 py-2 text-[12.5px] leading-relaxed text-ink-muted">
          An invitation lets a guardian make their own sign-in, linked to the child. Families cannot see anything on the new system yet, so for now an
          accepted invitation only joins the sign-in to the child.
        </p>
        {students.length > shown.length && (
          <p className="text-[12px] text-ink-faint">Showing the first {shown.length} of {students.length} selected. Invite the rest in another go.</p>
        )}
        {guardians.error ? (
          <p role="alert" className="text-[12.5px] text-warn-ink">Could not load the guardians: {guardians.error.message}</p>
        ) : !guardians.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          shown.map((s) => {
            const list = guardians.data!.get(s.id) ?? [];
            return (
              <section key={s.id} aria-label={s.name} className="border-b border-line-soft pb-3 last:border-0">
                <h3 className="text-[13px] font-semibold">{s.name}</h3>
                {list.length === 0 ? (
                  <p className="mt-1 text-[12.5px] text-ink-faint">No guardian on file. Add their contact details on the learner's card first.</p>
                ) : (
                  <ul className="mt-1.5 grid gap-2.5">
                    {list.map((g) => (
                      <li key={g.profile_id} className="grid gap-1">
                        <div className="flex flex-wrap items-baseline gap-x-3 text-[13px]">
                          <span className="font-medium">{g.full_name}</span>
                          <span className="text-[12px] capitalize text-ink-muted">{g.relationship}</span>
                          <span className="text-[12.5px] text-ink-muted">{g.email ?? g.phone ?? ""}</span>
                        </div>
                        <GuardianInviteControl
                          tenantId={tenantId} learnerId={s.id} guardian={g} pending={open(g.profile_id, s.id)}
                          onChanged={() => setReloadKey((k) => k + 1)} toast={toast}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>
    </Modal>
  );
}

/**
 * A member of staff's sign-in on the new API, on their card. Staff are directory records there, so a sign-in is made by inviting an e-mail
 * address, not by the school choosing a password. A record that already has a sign-in can have a one-time password-reset link made. Either
 * link is shown once, for the school to hand over, because a local API sends no e-mail.
 *
 * What the API cannot do: list open staff invitations, and join the sign-in someone makes to this record (nothing says which sign-in
 * accepted, so the record's `userId` has to be set by hand). The text below says so.
 */
export function StaffSignInSection({ tenantId, staff, toast }: { tenantId: string; staff: RosterStaff; toast: ToastFn }) {
  const origin = window.location.origin;
  const [email, setEmail] = useState(staff.email ?? "");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<(InvitationSent & { email: string }) | null>(null);
  const [reset, setReset] = useState<{ token: string; expiresAt: string } | null>(null);

  if (staff.role === "school_admin") {
    return (
      <section aria-label="Sign-in" className="mb-5 border-b border-line-soft pb-5">
        <h3 className="text-[13px] font-semibold">Sign-in</h3>
        <p className="mt-1 text-[12.5px] text-ink-muted">An administrator's sign-in is made by the platform, not from here.</p>
      </section>
    );
  }

  async function sendInvite() {
    if (!email.trim()) { toast("An e-mail address is required.", "error"); return; }
    setBusy(true);
    try {
      const r = await apiInviteStaff({ tenantId, email: email.trim(), role: staff.role as StaffInviteRole, fullName: staff.full_name });
      setInvite({ ...r, email: email.trim() });
    } catch (err) {
      toast(`Could not invite ${staff.full_name}: ${userMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancelInvite() {
    if (!invite) return;
    setBusy(true);
    try {
      await apiRevokeStaffInvitation(tenantId, invite.id);
      setInvite(null);
      toast("Invitation cancelled.");
    } catch (err) {
      toast(`Could not cancel: ${userMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function makeReset() {
    if (!staff.user_id) return;
    setBusy(true);
    try {
      setReset(await apiIssueMemberReset(tenantId, staff.user_id));
    } catch (err) {
      toast(`Could not make a reset link: ${userMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Sign-in" className="mb-5 border-b border-line-soft pb-5">
      <h3 className="text-[13px] font-semibold">Sign-in</h3>
      {staff.user_id ? (
        <div className="mt-1 grid gap-2">
          <p className="text-[12.5px] text-ink-muted">{staff.full_name.split(" ")[0]} has a sign-in. If they forgot their password, make a link that lets them choose a new one.</p>
          <div><Button disabled={busy} onClick={() => void makeReset()}>{busy ? "Making…" : "Make a reset link"}</Button></div>
          {reset && (
            <OneTimeValue
              label="Reset link" value={resetPasswordLink(origin, reset.token)}
              note={`Works once, until ${shortTime(reset.expiresAt)}. Shown only now. Nothing was sent.`}
            />
          )}
        </div>
      ) : (
        <div className="mt-1 grid gap-2.5">
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            No sign-in yet. Invite them by e-mail: they follow the link, choose a password and sign in with that address. The invitation works once and ends in 3 days.
          </p>
          <TextField id="staff-invite-email" type="email" label="E-mail address" placeholder="e.g. otieno@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            {!invite && <Button variant="primary" disabled={busy || !email.trim()} onClick={() => void sendInvite()}>{busy ? "Sending…" : "Invite to sign in"}</Button>}
            {invite && <Button disabled={busy} onClick={() => void cancelInvite()}>Cancel invitation</Button>}
          </div>
          {invite && (invite.delivery === "sent" ? (
            <p role="status" className="text-[12.5px] text-ink-muted">Invitation sent to {invite.email}. It ends on {shortDate(invite.expiresAt)}.</p>
          ) : (
            <div className="grid gap-1.5">
              <p role="status" className="text-[12.5px] text-warn-ink">
                {invite.delivery === "failed" ? "The e-mail could not be sent." : "E-mail is not set up on this system, so nothing was sent."} Give them this link yourself.
              </p>
              {invite.token && <OneTimeValue label="Invitation link" value={acceptInviteLink(origin, invite.token)} note={`Works once, ends ${shortDate(invite.expiresAt)}. Shown only now.`} />}
            </div>
          ))}
          <p className="text-[12px] leading-relaxed text-ink-faint">
            Once they have accepted, their sign-in is not joined to this record automatically: nothing tells us which sign-in is theirs. Until it is joined, what follows the person
            (their classes, their leave) stays empty for them.
          </p>
        </div>
      )}
    </section>
  );
}
