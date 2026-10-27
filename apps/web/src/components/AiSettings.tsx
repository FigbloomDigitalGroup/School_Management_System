import { useEffect, useState } from "react";
import { fetchAiStatus, saveAiSettings } from "@figbloom/shared";
import { Button } from "./ui/Button";
import { useToast } from "./ui/Toast";
import { useAsync } from "../lib/useAsync";

/**
 * The office's AI switches for its school: drafting for staff (report card
 * comments, questions, homework, messages, and Bloom chat), web search in
 * Bloom chat, and the study helper for learners, plus how much of the month's
 * allowance is used. The allowance itself is set by Figbloom with the
 * school's plan.
 */
export function AiSettings({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: status, loading } = useAsync(() => fetchAiStatus(tenantId), [tenantId, reloadKey]);
  const [enabled, setEnabled] = useState(true);
  const [tutor, setTutor] = useState(false);
  const [webSearch, setWebSearch] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!status) return;
    setEnabled(status.aiEnabled);
    setTutor(status.tutorEnabled);
    setWebSearch(status.webSearchEnabled);
  }, [status]);

  if (loading && !status) return null;
  if (!status) return null;

  const changed = enabled !== status.aiEnabled || tutor !== status.tutorEnabled || webSearch !== status.webSearchEnabled;
  const pct = status.monthlyTokens > 0 ? Math.min(100, Math.round((status.usedTokens / status.monthlyTokens) * 100)) : 100;

  async function save() {
    setSaving(true);
    try {
      await saveAiSettings(tenantId, enabled, enabled && tutor, webSearch);
      toast(tutor && enabled ? "Saved. Learners see Ask Bloom the next time they open the app." : "Saved.");
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
          <Button variant="accent" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save AI settings"}</Button>
        </div>
      )}
    </div>
  );
}
