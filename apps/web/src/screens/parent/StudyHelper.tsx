import { useState } from "react";
import {
  AI_HELPER_BILLING_AVAILABLE, fetchAiHelperStatus, formatMoney, optInOutcomeText, setAiHelperOptIn, type AiHelperStatus,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useParentData } from "../../lib/parentContext";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { ChildSwitcher } from "./ChildSwitcher";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";

/**
 * The Bloom study helper for one child: what it is, what it can't do, what
 * is kept, and (at a school that asks parents) a switch to turn it on or off
 * for this child. Either guardian may change it; the page says who did. The
 * price shows only once the school bills for it (AI_HELPER_BILLING_AVAILABLE
 * and the school's own switch); until then nothing here costs anything.
 */
export function ParentStudyHelper() {
  const { child } = useParentData();
  const { tenant } = useTenantSession();
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const { data: s, loading, error } = useAsync(
    () => (child ? fetchAiHelperStatus(child.id) : Promise.resolve(null)), [child?.id, reloadKey]);
  const first = child?.first ?? "your child";

  async function change(on: boolean) {
    if (!child) return;
    setSaving(true);
    try {
      const outcome = await setAiHelperOptIn(child.id, on);
      toast(optInOutcomeText(outcome, first));
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Bloom study helper"}
        title="Bloom study helper"
        blurb={`An AI tutor ${first} can ask about their schoolwork, in their Figbloom learner app.`}
        actions={<ChildSwitcher />}
      />
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-7 py-6">
        {loading && !s ? <Skeleton className="h-28 rounded-xl" />
          : error ? <p className="text-[13px] text-warn-ink">{error.message}</p>
          : s ? <Choice s={s} first={first} saving={saving} onChange={(on) => void change(on)} country={tenant.country} />
          : <p className="text-[13px] text-ink-muted">There's nothing to show for this child.</p>}

        <section className="rounded-xl border border-line bg-white px-5 py-4">
          <h2 className="text-[13.5px] font-semibold">What it is</h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
            Bloom is an AI tutor. {first} types a question about something they're learning, and Bloom explains it and asks
            questions back, so they work the answer out themselves instead of copying one. It's written for their class
            level and the curriculum they follow.
          </p>
        </section>

        <section className="rounded-xl border border-line bg-white px-5 py-4">
          <h2 className="text-[13.5px] font-semibold">What it can and can't do</h2>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-muted">
            <li>It helps with schoolwork: explaining a topic, working through an example, quizzing for revision.</li>
            <li>It guides rather than handing over answers, and keeps conversations age-appropriate.</li>
            <li>It switches itself off while {first} has an exam open or in progress, and comes back once it's handed in or closed.</li>
            <li>It doesn't search the internet, and it's an AI, not a teacher: it can get things wrong.</li>
            <li>There's a daily limit on questions, and the school can turn it off at any time.</li>
          </ul>
        </section>

        <section className="rounded-xl border border-line bg-white px-5 py-4">
          <h2 className="text-[13.5px] font-semibold">Privacy</h2>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-muted">
            <li>Conversations aren't stored. Leaving the page starts afresh, and neither the school nor Figbloom can read them later.</li>
            <li>What is kept is a count: when {first} asked a question and how long the answer was. The school can see how much each learner uses it, and so can you, below.</li>
            <li>Questions are answered by an AI service the school uses through Figbloom, with no name or admission number attached.</li>
            <li>Bloom reminds learners not to share their full name, phone number or address, and points them to Childline Kenya on 116 if something is worrying them.</li>
          </ul>
        </section>
      </div>
    </>
  );
}

function Choice({ s, first, saving, onChange, country }: {
  s: AiHelperStatus; first: string; saving: boolean; onChange: (on: boolean) => void; country: string;
}) {
  const priced = AI_HELPER_BILLING_AVAILABLE && s.billingEnabled && s.priceCents > 0 && s.access === "opt_in";
  const who = s.status === "on"
    ? s.turnedOnBy ? `Turned on by ${s.turnedOnBy}${s.turnedOnAt ? ` on ${when(s.turnedOnAt)}` : ""}.` : ""
    : s.status === "off" && s.changedBy ? `Turned off by ${s.changedBy}${s.changedAt ? ` on ${when(s.changedAt)}` : ""}.` : "";

  let state: string;
  let action: { label: string; on: boolean } | null = null;
  if (!s.schoolOn) {
    state = "The school hasn't turned on the study helper.";
    if (s.status === "on") action = { label: "Turn off", on: false };
  } else if (s.access === "all") {
    state = `The school has the study helper on for every learner, so ${first} can already use it.`;
  } else if (s.optInActive) {
    state = `On for ${first}.`;
    action = { label: "Turn off", on: false };
  } else {
    state = s.status === "on" && priced
      ? `Off for ${first} this term. Turn it on again to use it this term.`
      : `Off for ${first}. The school asks a parent or guardian to turn it on.`;
    action = { label: priced ? `Turn on (${formatMoney(s.priceCents, country)} this term)` : "Turn on", on: true };
  }

  return (
    <section className="rounded-xl border border-line bg-white px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${s.schoolOn && (s.access === "all" || s.optInActive) ? "bg-ok-dot" : "bg-line"}`}
              aria-hidden
            />
            <h2 className="text-[14px] font-semibold">{state}</h2>
          </div>
          {who && <p className="mt-1 text-[12px] text-ink-faint">{who} Either parent or guardian can change this.</p>}
        </div>
        {action && (
          <Button variant={action.on ? "accent" : "secondary"} disabled={saving} onClick={() => onChange(action.on)}>
            {saving ? "Saving…" : action.label}
          </Button>
        )}
      </div>

      {priced && (
        <p className="mt-3 rounded-lg bg-sunken px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
          {formatMoney(s.priceCents, country)} per term, added to {first}'s fee invoice as "Bloom study helper" for the term it's turned on.
          Turn it off within {s.cancelDays} {s.cancelDays === 1 ? "day" : "days"} of being charged and the charge is taken off;
          after that it stays for the term.
          {s.chargeCents != null && ` This term's ${formatMoney(s.chargeCents, country)} is on the invoice.`}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-line-soft pt-3 text-[12.5px]">
        <div>
          <dt className="text-ink-faint">Questions this month</dt>
          <dd className="font-mono text-[15px] font-semibold">{s.questionsThisMonth.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">Last used</dt>
          <dd className="text-[13px]">{s.lastUsedAt ? when(s.lastUsedAt) : "Not yet"}</dd>
        </div>
      </dl>
    </section>
  );
}
