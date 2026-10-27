import { useEffect, useRef, useState } from "react";
import { askTutor, EdgeError, type TutorTurn } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { useTenantSession } from "../../lib/sessionContext";

const STARTERS = [
  "Explain fractions with an example",
  "How do I find the area of a triangle?",
  "Help me plan a composition about my village",
  "Quiz me on the parts of a flower",
];

/**
 * The study helper: an AI tutor for learners, at schools that have turned it
 * on. It explains and asks questions back rather than handing over answers,
 * and it's switched off while an exam is open (the edge function decides;
 * see supabase/functions/ai-assist). The conversation lives only on this
 * page: nothing is stored, and leaving the page starts afresh.
 */
export function StudyHelper() {
  const { tenant } = useTenantSession();
  const [turns, setTurns] = useState<TutorTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns, busy]);

  if (!tenant.ai_enabled || !tenant.ai_tutor_enabled) {
    return (
      <>
        <PageHead eyebrow="Ask Bloom" title="Ask Bloom" />
        <p className="mx-7 my-6 max-w-[560px] rounded-lg border border-line bg-white px-4 py-4 text-[13px] text-ink-muted">
          Your school hasn't turned on Bloom yet.
        </p>
      </>
    );
  }

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const next: TutorTurn[] = [...turns, { role: "user", content: question.slice(0, 2000) }];
    setTurns(next);
    setDraft("");
    setBusy(true);
    setError("");
    try {
      const reply = await askTutor(next);
      setTurns([...next, { role: "assistant", content: reply }]);
      setBlocked("");
    } catch (err) {
      // Leave the question out of the history, so asking again doesn't send it twice.
      setTurns(turns);
      setDraft(question);
      if (err instanceof EdgeError && err.status === 423) setBlocked(err.message);
      else setError(err instanceof Error ? err.message : "Bloom didn't answer. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        eyebrow="Study helper"
        title="Ask Bloom"
        blurb="Ask Bloom about anything you're learning. Bloom explains and asks you questions back, so you work it out yourself."
      />
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-7 py-6">
        <p className="rounded-lg bg-sunken px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-muted">
          Bloom is an AI, not a person, and can get things wrong. Check with your teacher if you're unsure.
          Don't share your full name, phone number or address. If something is worrying you, talk to a trusted
          adult or call Childline Kenya on <strong>116</strong> (free, any time).
        </p>

        {blocked && (
          <p className="rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3.5 py-2.5 text-[12.5px] text-warn-ink">{blocked}</p>
        )}

        {turns.length === 0 && !blocked && (
          <div className="flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <button key={s} type="button" onClick={() => void send(s)} disabled={busy}
                className="rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] text-ink-soft hover:border-accent">
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-3" aria-live="polite">
          {turns.map((t, i) => (
            <div key={i} className={t.role === "user" ? "self-end max-w-[85%]" : "self-start max-w-[85%]"}>
              <div className={`whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed ${
                t.role === "user" ? "bg-accent text-white" : "border border-line bg-white text-ink"
              }`}>
                {t.content}
              </div>
            </div>
          ))}
          {busy && <div className="self-start rounded-2xl border border-line bg-white px-3.5 py-2.5 text-[13px] text-ink-faint">Thinking…</div>}
          <div ref={end} />
        </div>

        {error && <p className="text-[12.5px] text-warn-ink">{error}</p>}

        <form
          className="sticky bottom-0 flex items-end gap-2 border-t border-line bg-page py-3"
          onSubmit={(e) => { e.preventDefault(); void send(draft); }}
        >
          <label htmlFor="tutor-input" className="sr-only">Your question</label>
          <textarea
            id="tutor-input"
            rows={2}
            maxLength={2000}
            value={draft}
            disabled={!!blocked}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
            placeholder={blocked ? "Bloom is off during the exam." : "Ask Bloom a question…"}
            className="min-w-0 flex-1 resize-none rounded-lg border border-[#D3DAD5] bg-white px-3 py-2 text-[13.5px] outline-none focus:border-accent"
          />
          <Button variant="accent" disabled={busy || !draft.trim() || !!blocked}>Ask</Button>
          {turns.length > 0 && <Button type="button" onClick={() => { setTurns([]); setError(""); }} disabled={busy}>New chat</Button>}
        </form>
      </div>
    </>
  );
}
