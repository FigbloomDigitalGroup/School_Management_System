import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSittingQuestions, formatTimeLeft, saveExamAttempt, scoreLabel, startExamAttempt, timeLeftMs, totalPoints,
  type Answers, type AttemptRow, type AttemptSession, type ExamPaperRow,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

const AUTOSAVE_MS = 15_000;
const TEXTAREA = "w-full resize-y rounded-md border border-[#D3DAD5] px-3 py-2.5 font-sans text-body outline-none focus:border-forest";

/**
 * Sitting an online paper, or (`review`) looking back at a marked one.
 * Starting records the start time on the server, which also enforces the
 * time limit: answers are saved every few seconds and when the page is
 * hidden, and handed in automatically when the clock reaches zero.
 */
export function ExamSitting({ paper, review, onExit }: { paper: ExamPaperRow; review?: AttemptRow; onExit: () => void }) {
  return review ? <Review paper={paper} attempt={review} onExit={onExit} /> : <Sitting paper={paper} onExit={onExit} />;
}

function Sitting({ paper, onExit }: { paper: ExamPaperRow; onExit: () => void }) {
  const toast = useToast();
  const [session, setSession] = useState<AttemptSession | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [now, setNow] = useState(Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [saveNote, setSaveNote] = useState("");
  const dirty = useRef(false);
  const answersRef = useRef<Answers>({});
  answersRef.current = answers;
  const finished = useRef(false);

  const { data: questions, loading, error } = useAsync(async () => {
    const s = await startExamAttempt(paper.id);
    setSession(s);
    setAnswers(s.answers);
    finished.current = !!s.submittedAt;
    return fetchSittingQuestions(paper.id);
  }, [paper.id]);

  const save = useCallback(async (submit: boolean) => {
    if (finished.current) return;
    if (!submit && !dirty.current) return;
    dirty.current = false;
    try {
      const s = await saveExamAttempt(paper.id, answersRef.current, submit);
      setSession(s);
      if (s.submittedAt) finished.current = true;
      setSaveNote(`Saved ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`);
    } catch (err) {
      dirty.current = true;
      setSaveNote("Not saved: check your connection");
      if (submit) throw err;
    }
  }, [paper.id]);

  // Autosave, plus once more whenever the tab is hidden (switching apps, closing the laptop).
  useEffect(() => {
    const id = window.setInterval(() => void save(false), AUTOSAVE_MS);
    const onHide = () => { if (document.visibilityState === "hidden") void save(false); };
    document.addEventListener("visibilitychange", onHide);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onHide); };
  }, [save]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const left = session?.deadline ? timeLeftMs(session.deadline, now, session.skewMs) : null;

  const submit = useCallback(async (auto: boolean) => {
    setSubmitting(true);
    try {
      await save(true);
      if (auto) toast("Time is up. Your answers have been handed in.");
    } catch (err) {
      toast(err instanceof Error ? `Could not hand in: ${err.message}` : "Could not hand in.", "error");
    } finally {
      setSubmitting(false);
    }
  }, [save, toast]);

  // The clock reached zero: hand in what's there. Once only; if that fails
  // (no connection) the Hand in button is still there, and the server hands
  // in the last saved answers itself when the teacher opens the scripts.
  const autoTried = useRef(false);
  useEffect(() => {
    if (left === 0 && session && !session.submittedAt && !autoTried.current) {
      autoTried.current = true;
      void submit(true);
    }
  }, [left, session, submit]);

  function answer(id: string, value: number | string) {
    dirty.current = true;
    setAnswers((a) => {
      const next = { ...a };
      if (value === "") delete next[id];
      else next[id] = value;
      return next;
    });
  }

  function confirmSubmit() {
    const blank = (questions ?? []).filter((q) => !(q.id in answers)).length;
    const msg = blank ? `${blank} question${blank === 1 ? " is" : "s are"} unanswered. Hand in anyway? You can't change your answers after.` : "Hand in now? You can't change your answers after.";
    if (window.confirm(msg)) void submit(false);
  }

  const handedIn = !!session?.submittedAt;

  return (
    <>
      <PageHead
        eyebrow={`${paper.subjectName} · ${paper.className}`}
        title={paper.title}
        actions={
          handedIn ? <Button onClick={onExit}>Back to exams</Button> : (
            <div className="flex items-center gap-3">
              {left !== null && (
                <span
                  className="rounded-md px-3 py-1.5 font-mono text-[15px] font-semibold"
                  style={left < 5 * 60_000 ? { background: "#FBE9DF", color: "#B8460A" } : { background: "#EEF1EE", color: "#17402A" }}
                  aria-live="polite"
                >
                  {formatTimeLeft(left)}
                </span>
              )}
              <Button onClick={() => { void save(false); onExit(); }}>Save and leave</Button>
              <Button variant="accent" disabled={submitting || !questions} onClick={confirmSubmit}>{submitting ? "Handing in…" : "Hand in"}</Button>
            </div>
          )
        }
      />

      <div className="mx-auto max-w-[760px] px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>{error.message}
          </p>
        ) : loading || !questions ? (
          <TableSkeleton rows={5} />
        ) : handedIn ? (
          <div className="flex items-center gap-2.5 rounded-lg bg-ok-bg px-3.5 py-3">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok-ink text-[11px] text-white">✓</span>
            <span className="text-small leading-relaxed text-ok-ink">
              {session?.timedOut ? "Time ran out, so your last saved answers were handed in." : "Handed in."} Your score appears on the Exams page once your teacher releases the results.
            </span>
          </div>
        ) : (
          <>
            {paper.instructions && <p className="mb-4 whitespace-pre-line rounded-lg border border-line-soft bg-page px-3.5 py-3 text-[13px] leading-relaxed">{paper.instructions}</p>}
            <ol className="grid gap-4">
              {questions.map((q, i) => (
                <li key={q.id} className="rounded-lg border border-line bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="whitespace-pre-line text-[14px] font-semibold leading-snug">{i + 1}. {q.prompt}</p>
                    <span className="shrink-0 font-mono text-[11px] text-ink-faint">{q.points} mark{q.points === 1 ? "" : "s"}</span>
                  </div>
                  {q.kind === "choice" ? (
                    <div className="mt-3 grid gap-2">
                      {q.options.map((o, k) => (
                        <label key={k} className="flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-[13.5px]"
                          style={answers[q.id] === k ? { borderColor: "#17402A", background: "#F1F6F2" } : { borderColor: "#E3E8E4" }}>
                          <input type="radio" name={q.id} checked={answers[q.id] === k} onChange={() => answer(q.id, k)} />
                          <span className="font-mono text-[11.5px] text-ink-faint">{String.fromCharCode(65 + k)}</span>
                          {o}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <textarea
                      aria-label={`Answer to question ${i + 1}`}
                      className={`${TEXTAREA} mt-3`}
                      rows={q.kind === "long" ? 8 : 2}
                      value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                      onChange={(e) => answer(q.id, e.target.value)}
                      onBlur={() => void save(false)}
                    />
                  )}
                </li>
              ))}
            </ol>
            <div className="mt-5 flex items-center justify-between">
              <span className="text-[12px] text-ink-faint">{saveNote || "Your answers save as you go."}</span>
              <Button variant="accent" disabled={submitting} onClick={confirmSubmit}>{submitting ? "Handing in…" : "Hand in"}</Button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Review({ paper, attempt, onExit }: { paper: ExamPaperRow; attempt: AttemptRow; onExit: () => void }) {
  const { data: questions, loading, error } = useAsync(() => fetchSittingQuestions(paper.id), [paper.id]);
  return (
    <>
      <PageHead
        eyebrow={`${paper.subjectName} · marked`}
        title={paper.title}
        blurb={questions ? `Your score: ${scoreLabel(attempt.finalScore, totalPoints(questions))}` : undefined}
        actions={<Button onClick={onExit}>Back to exams</Button>}
      />
      <div className="mx-auto max-w-[760px] px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the paper: {error.message}
          </p>
        ) : loading || !questions ? (
          <TableSkeleton rows={5} />
        ) : (
          <>
            {attempt.feedback && <p className="mb-4 whitespace-pre-line rounded-lg bg-ok-bg px-3.5 py-3 text-small leading-relaxed text-ok-ink">{attempt.feedback}</p>}
            <ol className="grid gap-3">
              {questions.map((q, i) => {
                const a = attempt.answers[q.id];
                const got = attempt.questionMarks[q.id] ?? 0;
                return (
                  <li key={q.id} className="rounded-lg border border-line bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="whitespace-pre-line text-[13.5px] font-semibold leading-snug">{i + 1}. {q.prompt}</p>
                      <span className="shrink-0 font-mono text-[12px] font-semibold" style={{ color: got === q.points ? "#1F7A4A" : got === 0 ? "#B8460A" : undefined }}>
                        {got} / {q.points}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-ink-muted">
                      {a === undefined ? "No answer" : typeof a === "number" ? q.options[a] ?? "—" : a}
                    </p>
                    {attempt.questionNotes[q.id] && <p className="mt-1.5 text-[12.5px] text-ink">Teacher: {attempt.questionNotes[q.id]}</p>}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </>
  );
}
