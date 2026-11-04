import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchSetupCounts, setupSteps, type SetupStep } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { BACK_TO_ASSISTANT, GuideChat, useGuideHost } from "../../components/GuidePanel";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

/**
 * The School assistant: what's set up and what's left (setupSteps, from the
 * school's own records), beside the guide's chat, which sets up classes,
 * subjects, a term, exams and fee items once the admin confirms the plan,
 * and explains how to do everything else. Full admins only (ADMIN_PAGE_AREA).
 */
export function AdminAssistant() {
  const { tenant } = useTenantSession();
  const host = useGuideHost();
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const [ask, setAsk] = useState<{ text: string; id: number } | null>(null);

  const { data: counts, error } = useAsync(() => fetchSetupCounts(tenant.id), [tenant.id, reloadKey]);
  const steps = counts ? setupSteps(counts) : null;
  const required = steps?.filter((s) => !s.optional) ?? [];
  const done = required.filter((s) => s.done).length;
  const hrefFor = host?.hrefFor ?? ((to: string) => `/s/${tenant.slug}/${to}`);

  return (
    <>
      <PageHead
        eyebrow="School · assistant"
        title="School assistant"
        blurb="Work down the list, or tell the assistant what you want. It sets up classes, subjects, the term, exams and fee items after you check its plan, and shows you how to do the rest."
      />
      <div className="grid gap-5 px-7 py-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <section aria-labelledby="setup-list" className="flex flex-col gap-3">
          <div>
            <h2 id="setup-list" className="text-[13px] font-semibold">Setting up {tenant.name}</h2>
            {steps && (
              <>
                <p className="mt-0.5 text-[12px] text-ink-muted">{done} of {required.length} done</p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${required.length ? (done / required.length) * 100 : 0}%` }} />
                </div>
              </>
            )}
          </div>
          {error && <p className="text-[12.5px] text-warn-ink">Could not load the checklist: {error.message}</p>}
          {!steps && !error && <p className="text-[12.5px] text-ink-muted">Checking what's set up…</p>}
          <ol className="flex flex-col gap-2">
            {steps?.map((s, i) => (
              <Step
                key={s.key}
                step={s}
                number={i + 1}
                onOpen={() => navigate(hrefFor(s.to), { state: BACK_TO_ASSISTANT })}
                onAsk={host && s.ask ? () => setAsk({ text: s.ask!, id: Date.now() }) : null}
              />
            ))}
          </ol>
        </section>

        <section aria-label="Chat with the assistant" className="flex h-[calc(100vh-190px)] min-h-[480px] flex-col overflow-hidden rounded-xl border border-line bg-white">
          {host ? (
            <GuideChat host={host} ask={ask} linkState={BACK_TO_ASSISTANT} onApplied={() => setReloadKey((k) => k + 1)} />
          ) : (
            <p className="m-auto max-w-[360px] p-6 text-center text-[13px] text-ink-soft">
              The assistant uses AI, which is turned off for this school. Turn it on in School settings to chat with it. The checklist works either way.
            </p>
          )}
        </section>
      </div>
    </>
  );
}

function Step({ step, number, onOpen, onAsk }: { step: SetupStep; number: number; onOpen: () => void; onAsk: (() => void) | null }) {
  return (
    <li className={`rounded-lg border px-3 py-2.5 ${step.done ? "border-line bg-[#FAFBFA]" : "border-line bg-white"}`}>
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${step.done ? "bg-accent text-white" : "border border-line text-ink-muted"}`}
        >
          {step.done ? "✓" : number}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">
            {step.title}
            {step.optional && <span className="ml-1.5 text-[11px] font-normal text-ink-faint">optional</span>}
            <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
          </p>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-muted">{step.detail}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button type="button" onClick={onOpen} className="rounded-md border border-line px-2 py-0.5 text-[12px] text-ink-soft hover:bg-page">Open →</button>
            {onAsk && (
              <button type="button" onClick={onAsk} className="rounded-md border border-accent/40 bg-accent/5 px-2 py-0.5 text-[12px] font-semibold text-forest hover:bg-accent/10">
                Ask the assistant
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
