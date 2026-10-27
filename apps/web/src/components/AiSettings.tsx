import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AI_HELPER_BILLING_AVAILABLE, fetchAiHelperSettings, fetchAiStatus, priceCentsFromKes, saveAiHelperSettings, saveAiSettings,
  type AiHelperAccess,
} from "@figbloom/shared";
import { Button } from "./ui/Button";
import { useToast } from "./ui/Toast";
import { useAsync } from "../lib/useAsync";

/**
 * The office's AI switches for its school: drafting for staff (report card
 * comments, questions, homework, messages, and Bloom chat), web search in
 * Bloom chat, and the study helper for learners, plus how much of the month's
 * allowance is used. The allowance itself is set by Figbloom with the
 * school's plan.
 *
 * The study helper is for every learner, or only for those whose parent or
 * guardian turned it on (20261101100000_ai_helper_optin.sql). The price per
 * term is stored for when the helper can be billed to the fee invoice; the
 * billing switch stays hidden until AI_HELPER_BILLING_AVAILABLE.
 */
export function AiSettings({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const { slug } = useParams();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: status, loading } = useAsync(() => fetchAiStatus(tenantId), [tenantId, reloadKey]);
  const { data: helper } = useAsync(() => fetchAiHelperSettings(tenantId), [tenantId, reloadKey]);
  const [enabled, setEnabled] = useState(true);
  const [tutor, setTutor] = useState(false);
  const [webSearch, setWebSearch] = useState(true);
  const [access, setAccess] = useState<AiHelperAccess>("all");
  const [priceKes, setPriceKes] = useState("0");
  const [billing, setBilling] = useState(false);
  const [cancelDays, setCancelDays] = useState("7");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!status) return;
    setEnabled(status.aiEnabled);
    setTutor(status.tutorEnabled);
    setWebSearch(status.webSearchEnabled);
  }, [status]);

  useEffect(() => {
    if (!helper) return;
    setAccess(helper.access);
    setPriceKes(String(helper.priceCents / 100));
    setBilling(helper.billingEnabled);
    setCancelDays(String(helper.cancelDays));
  }, [helper]);

  if (loading && !status) return null;
  if (!status) return null;

  const priceCents = priceCentsFromKes(priceKes);
  const days = /^\d{1,2}$/.test(cancelDays.trim()) ? Number(cancelDays.trim()) : null;
  const helperChanged = !!helper && (access !== helper.access || priceCents !== helper.priceCents
    || billing !== helper.billingEnabled || days !== helper.cancelDays);
  const helperInvalid = helperChanged && (priceCents === null || days === null || days > 60);
  const changed = enabled !== status.aiEnabled || tutor !== status.tutorEnabled || webSearch !== status.webSearchEnabled || helperChanged;
  const pct = status.monthlyTokens > 0 ? Math.min(100, Math.round((status.usedTokens / status.monthlyTokens) * 100)) : 100;

  async function save() {
    setSaving(true);
    try {
      await saveAiSettings(tenantId, enabled, enabled && tutor, webSearch);
      if (helperChanged && priceCents !== null && days !== null) {
        await saveAiHelperSettings(tenantId, { access, priceCents, billingEnabled: AI_HELPER_BILLING_AVAILABLE && billing, cancelDays: days });
      }
      toast(tutor && enabled
        ? access === "opt_in"
          ? "Saved. Parents can turn on the study helper for their children in their Figbloom app."
          : "Saved. Learners see Ask Bloom the next time they open the app."
        : "Saved.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  const row = (checked: boolean, onChange: (v: boolean) => void, title: string, note: string, disabled = false) => (
    <label className={`flex items-start gap-2.5 py-2.5 ${disabled ? "opacity-50" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: "#17402A", marginTop: 3 }} />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="block text-[11.5px] leading-snug text-ink-faint">{note}</span>
      </span>
    </label>
  );

  const choice = (value: AiHelperAccess, title: string, note: string) => (
    <label className="flex items-start gap-2.5 py-1.5">
      <input type="radio" name="ai-helper-access" checked={access === value} onChange={() => setAccess(value)} style={{ accentColor: "#17402A", marginTop: 3 }} />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium">{title}</span>
        <span className="block text-[11.5px] leading-snug text-ink-faint">{note}</span>
      </span>
    </label>
  );

  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-line">
      <header className="border-b border-line-soft px-4 py-3">
        <h2 className="text-[13px] font-semibold">Bloom (AI assist)</h2>
      </header>
      <div className="divide-y divide-line-soft px-4">
        {row(enabled, setEnabled, "Bloom for staff",
          "Teachers and the office can draft report card comments, exam questions, homework and messages, and translate messages into Kiswahili. Every draft is read and edited by a person before it's saved or sent. They also get Bloom chat, a general AI assistant behind the Ask Bloom button on every page; each person's chats are saved for them alone.")}
        {row(webSearch, setWebSearch, "Web search in Bloom chat",
          "Bloom chat can search the web for current facts, such as KNEC, KICD, TSC and Ministry circulars, term dates and fees guidelines, and lists the sources it used. Staff can turn it off for any chat. Each search counts as 2,500 tokens of the allowance. Never used by the study helper.",
          !enabled)}
        {row(tutor, setTutor, "Ask Bloom, the study helper for learners",
          "Bloom as an AI tutor learners can ask about their schoolwork. It guides them to the answer instead of giving it, keeps conversations age-appropriate, and is switched off while an exam is open. Conversations aren't stored.",
          !enabled)}
        {enabled && tutor && helper && (
          <fieldset className="py-2.5 pl-6">
            <legend className="text-[12px] font-semibold text-ink-muted">Which learners may use it</legend>
            {choice("all", "Every learner", "Every learner at the school sees Ask Bloom.")}
            {choice("opt_in", "Only learners whose parent has turned it on",
              "Each parent or guardian decides for their own child, under Bloom study helper in their Figbloom app. Learners without it see a note asking them to ask at home.")}
            {access === "opt_in" && (
              <div className="mt-2 flex flex-col gap-2 rounded-lg bg-sunken px-3 py-2.5">
                <label className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span className="font-medium">Price per term (KES)</span>
                  <input
                    inputMode="decimal" value={priceKes} onChange={(e) => setPriceKes(e.target.value)}
                    aria-invalid={priceCents === null}
                    className="w-28 rounded-md border border-[#D3DAD5] bg-white px-2 py-1 font-mono text-[12.5px] outline-none focus:border-accent"
                  />
                </label>
                {priceCents === null && <p className="text-[11.5px] text-warn-ink">Enter a price in shillings, up to KES 100,000.</p>}
                {AI_HELPER_BILLING_AVAILABLE ? (
                  <>
                    {row(billing, setBilling, "Add it to the fee invoice",
                      "Each learner whose parent turns it on is charged the price once a term, as \"Bloom study helper, Term N\" on their invoice.")}
                    <label className="flex flex-wrap items-center gap-2 text-[12.5px]">
                      <span>A parent who turns it off within</span>
                      <input inputMode="numeric" value={cancelDays} onChange={(e) => setCancelDays(e.target.value)} aria-invalid={days === null || days > 60}
                        className="w-14 rounded-md border border-[#D3DAD5] bg-white px-2 py-1 font-mono text-[12.5px] outline-none focus:border-accent" />
                      <span>days of being charged has the charge taken off (0 to 60).</span>
                    </label>
                  </>
                ) : (
                  <p className="text-[11.5px] leading-snug text-ink-faint">
                    For later: the study helper can't be charged for yet, so nobody is charged and parents don't see a price.
                    When billing through school fees is available, this is what it will add to each opted-in learner's invoice per term.
                  </p>
                )}
              </div>
            )}
            <p className="mt-2 text-[11.5px]">
              <Link to={`/s/${slug}/admin/study-helper`} className="font-medium text-forest">See which learners use it →</Link>
            </p>
          </fieldset>
        )}
      </div>
      <div className="border-t border-line-soft px-4 py-3">
        <div className="flex items-baseline justify-between text-[12px]">
          <span className="text-ink-muted">Used this month</span>
          <span className="font-mono text-ink-muted">{status.usedTokens.toLocaleString()} of {status.monthlyTokens.toLocaleString()} tokens</span>
        </div>
        <div className="mt-1.5 h-2 rounded bg-sunken">
          <div className={`h-2 rounded ${pct >= 90 ? "bg-warn-ink" : "bg-ok-dot"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1.5 text-[11.5px] text-ink-faint">
          {status.usedSearches > 0 && `Includes ${status.usedSearches.toLocaleString()} web ${status.usedSearches === 1 ? "search" : "searches"}. `}
          Resets on the 1st. To raise the allowance, contact Figbloom. Only what a task needs is sent: report card drafting gets a first name and results, never admission numbers.
        </p>
      </div>
      {changed && (
        <div className="border-t border-line-soft px-4 py-3">
          <Button variant="accent" disabled={saving || helperInvalid} onClick={() => void save()}>{saving ? "Saving…" : "Save AI settings"}</Button>
        </div>
      )}
    </div>
  );
}
