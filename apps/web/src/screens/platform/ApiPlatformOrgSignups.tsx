import { useMemo, useState } from "react";
import {
  apiApprovePlatformOrgSignup,
  apiRejectPlatformOrgSignup,
  apiReissuePlatformOrgSetup,
  ORG_SIGNUP_STATUS_LABEL,
  orgSignupAwaitsReview,
  resetPasswordLink,
  userMessage,
  type OrgSignupKind,
  type OrgSignupSetup,
  type OrgSignupStatus,
  type PlatformOrgSignup,
} from "@figbloom/shared";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { confirmDialog, promptDialog } from "../../components/ui/Confirm";
import { EmptyState } from "../../components/ui/DataTable";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";

const KIND_LABEL: Record<OrgSignupKind, string> = {
  government: "Government",
  county: "County",
  constituency: "Constituency",
  group_owner: "School group",
};

const STATUS_TONE: Record<OrgSignupStatus, Tone> = {
  pending_email: "muted",
  pending_review: "info",
  approved: "ok",
  rejected: "warn",
  expired: "muted",
};

const SHORT_LABEL: Record<OrgSignupStatus, string> = {
  pending_email: "Email not confirmed",
  pending_review: "Needs review",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Link expired",
};

/** "26 Nov 2026, 10:05" (the date alone when `time` is false). The times come from the server in UTC; the reviewer reads them in their own zone. */
function when(iso: string, time = true): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", time ? { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" });
}

type Filter = "Review" | "Email" | "Decided" | "All";
const FILTERS: Filter[] = ["Review", "Email", "Decided", "All"];
const FILTER_LABEL: Record<Filter, string> = { Review: "Needs review", Email: "Email not confirmed", Decided: "Decided", All: "All" };

function matches(f: Filter, s: PlatformOrgSignup): boolean {
  if (f === "All") return true;
  if (f === "Review") return s.status === "pending_review";
  if (f === "Email") return s.status === "pending_email";
  return s.status === "approved" || s.status === "rejected" || s.status === "expired";
}

/**
 * Organization sign-up requests, in the platform console (apps/api/docs/ORG-SIGNUP.md; owner decisions D2 and D8).
 *
 * A stranger asks for an organization on the sign-up page; once they confirm their e-mail the request waits here. Approving
 * creates the organization and its first administrator and e-mails that person a link to choose a password; rejecting keeps the
 * reason with the platform. Both need a recent sign-in (the app asks for the password by itself). The list shows names, addresses
 * and phone numbers, and the server records each read.
 */
export function ApiPlatformOrgSignups({ signups, loading, error, onChanged }: {
  signups: PlatformOrgSignup[];
  loading: boolean;
  error: Error | null;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("Review");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f, signups.filter((s) => matches(f, s)).length])) as Record<Filter, number>, [signups]);
  const list = useMemo(() => signups.filter((s) => matches(filter, s)), [signups, filter]);
  const selected = signups.find((s) => s.id === selectedId) ?? list[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex w-[320px] shrink-0 flex-col border-r border-line bg-[#FAFBFA]">
        <div className="border-b border-line px-4 py-4">
          <h1 className="text-[16px] font-semibold">Sign-up requests</h1>
          <p className="mt-1 text-[11.5px] text-ink-muted">People who asked for an organization on the sign-up page.</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {FILTERS.map((k) => (
              <button
                key={k} type="button" onClick={() => setFilter(k)} className="rounded-full px-2.5 py-1 text-[11.5px]"
                style={filter === k ? { background: "#17402A", color: "#fff" } : { background: "#EEF1EE", color: "#5F6B62" }}
              >
                {FILTER_LABEL[k]}{loading ? "" : ` ${counts[k]}`}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="border-b border-warn-ink/30 bg-warn-ink/5 px-4 py-2.5 text-[12px] text-warn-ink">Could not load requests: {userMessage(error)}</div>}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading && signups.length === 0 ? (
            <TableSkeleton rows={6} />
          ) : list.length === 0 ? (
            <EmptyState title={filter === "Review" ? "Nothing is waiting for review" : "No requests here"} body="New requests appear once the person confirms their e-mail address." />
          ) : (
            list.map((s) => {
              const active = s.id === selected?.id;
              return (
                <button
                  key={s.id} type="button" onClick={() => setSelectedId(s.id)}
                  className="flex w-full items-center gap-3 border-b border-line-soft px-4 py-3 text-left"
                  style={{ background: active ? "#F1F5F2" : "transparent", borderLeft: `3px solid ${active ? "#F26A1B" : "transparent"}` }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body font-medium">{s.name}</div>
                    <div className="truncate font-mono text-[10.5px] text-ink-faint">{KIND_LABEL[s.kind]} · {when(s.createdAt, false)}</div>
                  </div>
                  <Badge tone={STATUS_TONE[s.status]}>{SHORT_LABEL[s.status]}</Badge>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-auto">
        {selected ? (
          <SignupDetail signup={selected} onChanged={onChanged} />
        ) : (
          !loading && <EmptyState title="No request selected" body="Choose a request from the list on the left." />
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-0.5 py-2">
      <dt className="w-40 shrink-0 text-[12px] text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-body">{children}</dd>
    </div>
  );
}

function SignupDetail({ signup, onChanged }: { signup: PlatformOrgSignup; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ setup: OrgSignupSetup; email: string } | null>(null);
  const awaiting = orgSignupAwaitsReview(signup);

  async function approve() {
    const typed = await promptDialog({
      title: `Approve ${signup.name}?`,
      body: `This creates the organization and an account for ${signup.adminFullName} (${signup.adminEmail}), and e-mails them a link to choose a password.`,
      label: "Web address (optional)",
      placeholder: "e.g. kijani-schools",
      confirmLabel: "Approve",
    });
    if (typed === null) return;
    setBusy(true);
    try {
      const res = await apiApprovePlatformOrgSignup(signup.id, typed || undefined);
      toast(`Approved. The organization's address is ${res.organization.slug}.`);
      if (res.setup.delivery === "not_configured" && res.setup.token) setLink({ setup: res.setup, email: signup.adminEmail });
      onChanged();
    } catch (err) {
      toast("Could not approve: " + userMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    const reason = await promptDialog({
      title: `Reject ${signup.name}?`,
      body: signup.status === "pending_review"
        ? "They are told by e-mail that the request was not approved. Your reason is kept here and is never sent to them."
        : "Their address was never confirmed, so nothing is sent to it. Your reason is kept here.",
      label: "Reason (optional)",
      placeholder: "Why, for the record",
      confirmLabel: "Reject",
    });
    if (reason === null) return;
    setBusy(true);
    try {
      const res = await apiRejectPlatformOrgSignup(signup.id, reason || undefined);
      toast(res.notified ? "Rejected. They have been told by e-mail." : "Rejected.");
      onChanged();
    } catch (err) {
      toast("Could not reject: " + userMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    const ok = await confirmDialog({
      title: "Send a new password link?",
      body: `${signup.adminFullName} has not chosen a password yet. A new link goes to ${signup.adminEmail} and the older links stop working.`,
      confirmLabel: "Send link",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const setup = await apiReissuePlatformOrgSetup(signup.id);
      toast(setup.delivery === "sent" ? "A new link was e-mailed." : "E-mail is not set up: copy the link and send it yourself.");
      if (setup.delivery === "not_configured" && setup.token) setLink({ setup, email: signup.adminEmail });
    } catch (err) {
      toast("Could not send a new link: " + userMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="border-b border-line bg-white px-7 py-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-h2 font-semibold tracking-tight">{signup.name}</h2>
          <Badge tone={STATUS_TONE[signup.status]}>{SHORT_LABEL[signup.status]}</Badge>
        </div>
        <p className="mt-1 text-small text-ink-muted">{ORG_SIGNUP_STATUS_LABEL[signup.status]}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {awaiting && <Button variant="primary" disabled={busy} onClick={() => void approve()}>Approve…</Button>}
          {(awaiting || signup.status === "pending_email") && <Button disabled={busy} onClick={() => void reject()}>Reject…</Button>}
          {signup.status === "approved" && <Button disabled={busy} onClick={() => void resend()}>Send a new password link…</Button>}
        </div>
        {signup.status === "pending_email" && (
          <p className="mt-3 text-[12.5px] text-ink-muted">
            The address is not confirmed yet, so this cannot be approved. The person has until the link in their e-mail runs out (24 hours).
          </p>
        )}
      </div>

      <div className="space-y-4 px-7 py-6">
        <section className="rounded-lg border border-line bg-white p-4">
          <h3 className="text-body font-semibold">The request</h3>
          <dl className="mt-1 divide-y divide-line-soft">
            <Row label="Organization">{signup.name}</Row>
            <Row label="What they said they are">{KIND_LABEL[signup.kind]}</Row>
            <Row label="County">{signup.county ?? <span className="text-ink-faint">Not given</span>}</Row>
            <Row label="Contact phone">{signup.contactPhone ?? <span className="text-ink-faint">Not given</span>}</Row>
            <Row label="Administrator">{signup.adminFullName}</Row>
            <Row label="Email"><span className="font-mono text-[12.5px]">{signup.adminEmail}</span></Row>
          </dl>
        </section>

        <section className="rounded-lg border border-line bg-white p-4">
          <h3 className="text-body font-semibold">What happened</h3>
          <dl className="mt-1 divide-y divide-line-soft">
            <Row label="Asked">{when(signup.createdAt)}</Row>
            <Row label="Email confirmed">{signup.verifiedAt ? when(signup.verifiedAt) : <span className="text-ink-faint">Not yet</span>}</Row>
            {signup.decidedAt && <Row label={signup.status === "approved" ? "Approved" : "Rejected"}>{when(signup.decidedAt)}{signup.decidedByName ? ` by ${signup.decidedByName}` : ""}</Row>}
            {signup.status === "approved" && signup.organizationSlug && <Row label="Organization address"><span className="font-mono text-[12.5px]">{signup.organizationSlug}</span></Row>}
            {signup.status === "rejected" && <Row label="Reason">{signup.decisionReason ?? <span className="text-ink-faint">None given</span>}</Row>}
          </dl>
        </section>
      </div>

      <Modal
        open={link !== null}
        onClose={() => setLink(null)}
        eyebrow="Password link"
        title="Send this link yourself"
        blurb={`E-mail is not set up on the server, so ${link?.email ?? "the person"} did not receive it. It is shown only now.`}
        actions={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}
        width={560}
      >
        {link?.setup.token && (
          <div className="grid gap-2">
            <input
              readOnly aria-label="Password link" value={resetPasswordLink(window.location.origin, link.setup.token)}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-md border border-line bg-white px-3 py-2 font-mono text-[12px]"
            />
            <p className="text-[12px] text-ink-muted">It works once and runs out on {when(link.setup.expiresAt)}.</p>
            <div>
              <Button onClick={() => { void navigator.clipboard?.writeText(resetPasswordLink(window.location.origin, link.setup.token!)).then(() => toast("Link copied."), () => toast("Could not copy: select it and copy by hand.", "error")); }}>
                Copy link
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
