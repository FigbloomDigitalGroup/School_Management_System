import { useEffect, useMemo, useState } from "react";
import {
  fetchPaperContent, fetchPaperScripts, markExamAttempt, needsHandMarking, releaseExamResults, scoreLabel,
  sendExamScoresToGradebook, totalPoints,
  type AttemptRow, type ExamPaperRow, type StaffQuestion,
} from "@figbloom/shared";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

const TEXTAREA = "w-full resize-y rounded-md border border-[#D3DAD5] px-3 py-2 font-sans text-[13px] outline-none focus:border-forest";

type Learner = { id: string; name: string; adm: string };

function scriptState(a: AttemptRow | undefined): { label: string; tone: "ok" | "warn" | "info" | "muted" } {
  if (!a) return { label: "Not started", tone: "muted" };
  if (!a.submittedAt) return { label: "Sitting now", tone: "info" };
  if (a.finalScore === null) return { label: "To mark", tone: "warn" };
  return { label: "Marked", tone: "ok" };
}

/**
 * Who has sat an online paper, and marking their written answers. Choice
 * questions are marked by the system the moment a script is handed in; a
 * blank written answer scores 0. Results reach learners and families only
 * once released, and every script has to be fully marked first.
 */
export function ExamScripts({ paper, onClose, onChanged }: { paper: ExamPaperRow; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [released, setReleased] = useState(!!paper.resultsReleasedAt);
  const [busy, setBusy] = useState(false);

  const { data, loading, error } = useAsync(async () => {
    const [scripts, content] = await Promise.all([fetchPaperScripts(paper), fetchPaperContent(paper.id)]);
    return { ...scripts, questions: content.questions };
  }, [paper.id, reloadKey]);

  const attempts = useMemo(() => new Map((data?.attempts ?? []).map((a) => [a.studentId, a])), [data]);
  const total = totalPoints(data?.questions ?? []);
  // Learners who have left the class but sat the paper still show, after the class list.
  const learners: Learner[] = useMemo(() => {
    const list = data?.learners ?? [];
    const known = new Set(list.map((l) => l.id));
    const gone = (data?.attempts ?? []).filter((a) => !known.has(a.studentId)).map((a) => ({ id: a.studentId, name: "Learner no longer in the class", adm: "—" }));
    return [...list, ...gone];
  }, [data]);

  const submitted = (data?.attempts ?? []).filter((a) => a.submittedAt);
  const toMark = submitted.filter((a) => a.finalScore === null).length;
  const selected = learners.find((l) => l.id === selectedId) ?? null;

  async function release(next: boolean) {
    if (!next && !window.confirm("Take the results back? Learners and parents won't see them until you release them again.")) return;
    setBusy(true);
    try {
      await releaseExamResults(paper.id, next);
      setReleased(next);
      toast(next ? "Results released. Learners and parents can see them now." : "Results taken back");
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not change that.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function sendToGradebook() {
    if (!window.confirm(`Put these scores into ${paper.examName} marks for ${paper.subjectName}, ${paper.className}? Scores are scaled to that exam's total and replace any already typed for learners who sat this paper.`)) return;
    setBusy(true);
    try {
      const n = await sendExamScoresToGradebook(paper.id);
      toast(`${n} score${n === 1 ? "" : "s"} sent to the Gradebook.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not send the scores.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${paper.className} · ${paper.subjectName}`}
      title={`Scripts: ${paper.title}`}
      footNote={data ? `${submitted.length} of ${learners.length} handed in${toMark ? ` · ${toMark} to mark` : ""} · out of ${total}` : undefined}
      width={960}
      actions={
        <>
          {paper.examId && <Button disabled={busy || !submitted.length || toMark > 0} onClick={() => void sendToGradebook()}>Send to Gradebook</Button>}
          {released
            ? <Button disabled={busy} onClick={() => void release(false)}>Take results back</Button>
            : <Button variant="accent" disabled={busy || !submitted.length} onClick={() => void release(true)}>Release results</Button>}
        </>
      }
    >
      {error ? (
        <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
          <span aria-hidden>✕</span>Could not load the scripts: {error.message}
        </p>
      ) : loading && !data ? (
        <TableSkeleton rows={5} />
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,0.9fr) minmax(0,1.6fr)" }}>
          <ul className="h-fit divide-y divide-line-soft rounded-lg border border-line">
            {learners.map((l) => {
              const a = attempts.get(l.id);
              const s = scriptState(a);
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    disabled={!a?.submittedAt}
                    onClick={() => setSelectedId(l.id)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left disabled:cursor-default"
                    style={selectedId === l.id ? { background: "#F1F6F2" } : undefined}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold">{l.name}</span>
                      <span className="block font-mono text-[11px] text-ink-faint">
                        {a?.finalScore !== null && a?.finalScore !== undefined ? `${a.finalScore} / ${total}` : `ADM ${l.adm}`}
                      </span>
                    </span>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>

          <section className="rounded-lg border border-line bg-white p-4">
            {!selected || !attempts.get(selected.id)?.submittedAt ? (
              <p className="py-10 text-center text-small text-ink-faint">Pick a learner who has handed in to see and mark their answers.</p>
            ) : (
              <MarkScript
                key={selected.id}
                learner={selected}
                attempt={attempts.get(selected.id)!}
                questions={data?.questions ?? []}
                onSaved={() => { setReloadKey((k) => k + 1); onChanged(); }}
              />
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

function MarkScript({ learner, attempt, questions, onSaved }: {
  learner: Learner;
  attempt: AttemptRow;
  questions: StaffQuestion[];
  onSaved: () => void;
}) {
  const toast = useToast();
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState(attempt.feedback ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setMarks(Object.fromEntries(Object.entries(attempt.questionMarks).map(([k, v]) => [k, String(v)])));
    setNotes(attempt.questionNotes);
    setFeedback(attempt.feedback ?? "");
  }, [attempt]);

  async function save() {
    const out: Record<string, number | null> = {};
    for (const [i, q] of questions.entries()) {
      if (!needsHandMarking(q)) continue;
      const raw = (marks[q.id] ?? "").trim();
      if (!raw) { out[q.id] = null; continue; }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > q.points) { setError(`Question ${i + 1}: give a whole number from 0 to ${q.points}.`); return; }
      out[q.id] = n;
    }
    setSaving(true);
    setError("");
    try {
      await markExamAttempt(attempt.id, out, notes, feedback);
      toast(`Marks saved for ${learner.name}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the marks.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[15px] font-semibold">{learner.name}</h3>
        <span className="font-mono text-[12px] text-ink-muted">{scoreLabel(attempt.finalScore, totalPoints(questions))}</span>
      </div>
      <ol className="mt-3 grid gap-3">
        {questions.map((q, i) => {
          const answer = attempt.answers[q.id];
          const auto = !needsHandMarking(q);
          return (
            <li key={q.id} className="rounded-lg border border-line-soft p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="whitespace-pre-line text-[13px] font-semibold leading-snug">{i + 1}. {q.prompt}</p>
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">{q.points} mark{q.points === 1 ? "" : "s"}</span>
              </div>
              {q.kind === "choice" ? (
                <p className="mt-1.5 text-[12.5px]">
                  {typeof answer === "number" ? q.options[answer] ?? "—" : <span className="text-ink-faint">No answer</span>}
                  {q.correctOption !== null && (
                    <span className="ml-2 text-ink-faint">
                      {answer === q.correctOption ? "✓ correct" : `✕ correct: ${q.options[q.correctOption] ?? "—"}`}
                    </span>
                  )}
                </p>
              ) : (
                <>
                  <p className="mt-1.5 whitespace-pre-line rounded-md bg-page px-2.5 py-2 text-[12.5px] leading-relaxed">
                    {typeof answer === "string" ? answer : <span className="text-ink-faint">No answer</span>}
                  </p>
                  {q.modelAnswer && <p className="mt-1.5 text-[11.5px] text-ink-faint">Model answer: {q.modelAnswer}</p>}
                </>
              )}
              <div className="mt-2 flex items-center gap-2">
                {auto ? (
                  <span className="text-[12px] text-ink-muted">{attempt.questionMarks[q.id] ?? 0} / {q.points} · marked automatically</span>
                ) : (
                  <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                    <input
                      type="number" min={0} max={q.points} aria-label={`Question ${i + 1} mark`}
                      className="w-16 rounded-md border border-[#D3DAD5] px-2 py-1 text-[12.5px]"
                      value={marks[q.id] ?? ""}
                      onChange={(e) => setMarks((m) => ({ ...m, [q.id]: e.target.value }))}
                    />
                    / {q.points}
                  </label>
                )}
                <input
                  aria-label={`Question ${i + 1} note`}
                  className="flex-1 rounded-md border border-[#D3DAD5] px-2.5 py-1 text-[12px]"
                  placeholder="Note for the learner (optional)"
                  value={notes[q.id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [q.id]: e.target.value }))}
                />
              </div>
            </li>
          );
        })}
      </ol>
      <label className="mt-3 block text-small font-semibold" htmlFor="script-feedback">Feedback (optional)</label>
      <textarea id="script-feedback" className={`${TEXTAREA} mt-1.5`} rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="A line or two the learner and their parents will see." />
      {error && <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{error}</p>}
      <div className="mt-3 flex justify-end">
        <Button variant="accent" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save marks"}</Button>
      </div>
    </>
  );
}
