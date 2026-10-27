import { useState } from "react";
import {
  COUNTING_LABEL, PAPER_KIND_LABEL, canStartSitting, fetchClassPapers, fetchLearnerExamStates, fetchPaperText, fetchPaperTotals,
  fetchReleasedAttempts, paperWindow, scoreLabel, windowLabel,
  type AttemptRow, type ExamPaperRow, type LearnerExamState,
} from "@figbloom/shared";
import { useStudentData } from "../../lib/studentContext";
import { useAsync } from "../../lib/useAsync";
import { privateDocUrl } from "../../lib/uploads";
import { PageHead } from "../../components/ConsoleShell";
import { Cell, DataTable, EmptyState } from "../../components/ui/DataTable";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { ExamSitting } from "./ExamSitting";

type Tab = "Coming up" | "Done";

interface PaperView {
  paper: ExamPaperRow;
  /** This learner's own terms (extensions, resits) and where they stand: online papers only. */
  state: LearnerExamState | undefined;
  result: AttemptRow | undefined;
  total: number | undefined;
}

/** The window this learner sits in: their own where their teacher gave them one, else the paper's. */
const windowOf = (v: PaperView) => (v.state ? { opensAt: v.state.terms.opensAt, closesAt: v.state.terms.closesAt } : v.paper);

/** Whether this learner can start a sitting now: their first, or a resit. */
function canStart(v: PaperView, now: number): boolean {
  const s = v.state;
  if (!s) return false;
  return canStartSitting({
    terms: { ...s.terms, durationMinutes: v.paper.durationMinutes },
    attemptsUsed: s.attemptsUsed, lastSubmitted: !!s.submittedAt, excused: s.status === "excused", nowMs: now,
  });
}

/** A resit granted and not started yet. */
const resitWaiting = (v: PaperView) => !!v.state && v.state.attemptsUsed > 0 && !!v.state.submittedAt && v.state.attemptsUsed < v.state.terms.attemptsAllowed;

/** Where a paper stands for this learner, in one word. Missed and excused are never shown as a score. */
function stateOf(v: PaperView, now: number): { label: string; tone: Tone; done: boolean } {
  const w = paperWindow(windowOf(v), now);
  if (v.paper.mode === "read") {
    if (v.result) return { label: "Results out", tone: "ok", done: true };
    return w === "upcoming" ? { label: "Coming up", tone: "info", done: false } : w === "open" ? { label: "Open", tone: "warn", done: false } : { label: "Closed", tone: "muted", done: true };
  }
  const status = v.state?.status;
  if (status === "in_progress") return { label: "In progress", tone: "warn", done: false };
  if (resitWaiting(v) && w !== "closed") return canStart(v, now) ? { label: "Resit open", tone: "warn", done: false } : { label: "Resit coming up", tone: "info", done: false };
  if (v.result) return { label: "Results out", tone: "ok", done: true };
  if (status === "excused") return { label: "Excused", tone: "muted", done: true };
  if (status === "submitted" || status === "marked") return { label: "Handed in", tone: "muted", done: true };
  if (status === "missed" || w === "closed") return { label: "Missed", tone: "muted", done: true };
  if (w === "upcoming") return { label: "Coming up", tone: "info", done: false };
  return { label: "Open now", tone: "warn", done: false };
}

/**
 * Exam papers and tests for this learner's class. A read-only paper opens as
 * a PDF or text once it opens; an online one is sat here, against the clock.
 * Scores and feedback appear once the teacher releases them.
 */
export function StudentExams() {
  const { data: student, loading: studentLoading, error: studentError } = useStudentData();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("Coming up");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sitting, setSitting] = useState<{ paper: ExamPaperRow; review?: AttemptRow } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const { data, loading, error } = useAsync(async () => {
    if (!student?.classId) return null;
    const [papers, states, results] = await Promise.all([
      fetchClassPapers(student.classId), fetchLearnerExamStates(student.studentId), fetchReleasedAttempts(student.studentId),
    ]);
    const totals = await fetchPaperTotals(papers.filter((p) => results.has(p.id)).map((p) => p.id));
    return papers.map((paper): PaperView => ({ paper, state: states.get(paper.id), result: results.get(paper.id), total: totals.get(paper.id) }));
  }, [student?.classId, student?.studentId, reloadKey]);

  const fail = studentError ?? error;
  if (sitting) {
    return (
      <ExamSitting
        paper={sitting.paper}
        review={sitting.review}
        onExit={() => { setSitting(null); setReloadKey((k) => k + 1); }}
      />
    );
  }

  const now = Date.now();
  const views = data ?? [];
  const states = new Map(views.map((v) => [v.paper.id, stateOf(v, now)]));
  const coming = views.filter((v) => !states.get(v.paper.id)!.done).sort((a, b) => a.paper.opensAt.localeCompare(b.paper.opensAt));
  const done = views.filter((v) => states.get(v.paper.id)!.done);
  const rows = tab === "Done" ? done : coming;
  const selected = rows.find((v) => v.paper.id === selectedId) ?? rows[0] ?? null;

  async function openFile(p: ExamPaperRow) {
    if (!p.filePath) return;
    try { window.open(await privateDocUrl(p.filePath), "_blank", "noopener"); }
    catch (err) { toast(err instanceof Error ? `Could not open the paper: ${err.message}` : "Could not open the paper.", "error"); }
  }

  return (
    <>
      <PageHead eyebrow="Exams & tests" title="Exams & tests" blurb={data ? `${coming.length} coming up or open.` : undefined} />

      <div className="px-7 py-6">
        {fail ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load your exams: {fail.message}
          </p>
        ) : studentLoading || (loading && !data) ? (
          <TableSkeleton rows={6} />
        ) : !student?.classId ? (
          <EmptyState title="No class yet" body="This login is not yet linked to a class. Contact the school office." />
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)" }}>
            <DataTable
              filters={
                <div className="flex gap-1.5">
                  {(["Coming up", "Done"] as Tab[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => { setTab(t); setSelectedId(null); }}
                      className="rounded-full px-2.5 py-1 text-[11.5px]"
                      style={tab === t ? { background: "#17402A", color: "#fff", fontWeight: 600 } : { background: "#EEF1EE", color: "#5F6B62" }}
                    >
                      {t} {t === "Done" ? done.length : coming.length}
                    </button>
                  ))}
                </div>
              }
              columns={[
                { key: "title", header: "Paper", width: "1.8fr", render: (v: PaperView) => <Cell sub={`${PAPER_KIND_LABEL[v.paper.kind]} · ${v.paper.subjectName}`}>{v.paper.title}</Cell> },
                { key: "when", header: "When", width: "1.4fr", render: (v: PaperView) => <span className="text-[12px] text-ink-muted">{windowLabel(windowOf(v), now)}</span> },
                { key: "state", header: "", align: "right", width: "0.8fr", render: (v: PaperView) => <Badge tone={states.get(v.paper.id)!.tone}>{states.get(v.paper.id)!.label}</Badge> },
              ]}
              rows={rows}
              rowKey={(v) => v.paper.id}
              onRowClick={(v) => setSelectedId(v.paper.id)}
              minWidth="520px"
              empty={
                tab === "Done"
                  ? { title: "Nothing here yet", body: "Papers you've handed in, and results once they're out, appear here." }
                  : { title: "No exams coming up", body: "When a teacher posts an exam or a test for your class, it appears here." }
              }
            />

            <section className="h-fit rounded-lg border border-line bg-white p-5">
              {!selected ? (
                <p className="py-8 text-center text-small text-ink-faint">Select a paper to see the details.</p>
              ) : (
                <PaperDetail
                  key={selected.paper.id}
                  view={selected}
                  now={now}
                  onOpenFile={() => void openFile(selected.paper)}
                  onSit={() => setSitting({ paper: selected.paper })}
                  onReview={() => setSitting({ paper: selected.paper, review: selected.result })}
                />
              )}
            </section>
          </div>
        )}
      </div>
    </>
  );
}

function PaperDetail({ view, now, onOpenFile, onSit, onReview }: {
  view: PaperView;
  now: number;
  onOpenFile: () => void;
  onSit: () => void;
  onReview: () => void;
}) {
  const { paper, state, result, total } = view;
  const win = windowOf(view);
  const w = paperWindow(win, now);
  const ownWindow = win.opensAt !== paper.opensAt || win.closesAt !== paper.closesAt;
  const extra = state?.terms.extraMinutes ?? 0;
  const minutes = paper.durationMinutes ? paper.durationMinutes + extra : null;
  const startable = canStart(view, now);
  const resit = (state?.attemptsUsed ?? 0) > 0;
  const isOpen = w !== "upcoming";
  const { data: text } = useAsync(
    () => (paper.mode === "read" && isOpen ? fetchPaperText(paper.id) : Promise.resolve("")),
    [paper.id, paper.mode, isOpen],
  );

  return (
    <>
      <h2 className="text-[16px] font-semibold leading-snug tracking-tight">{paper.title}</h2>
      <div className="mt-1 text-[12.5px] text-ink-faint">{PAPER_KIND_LABEL[paper.kind]} · {paper.subjectName}</div>

      <div className="mt-4 flex gap-4 rounded-lg border border-line-soft bg-page px-3.5 py-3">
        <div className="flex-1">
          <div className="font-mono text-micro tracking-[0.1em] text-ink-faint">WHEN</div>
          <div className="mt-1 text-[12.5px] font-semibold">{windowLabel(win, now)}</div>
          {ownWindow && <div className="mt-0.5 text-[11.5px] text-ink-faint">Your own time, set by your teacher</div>}
        </div>
        <div className="flex-1">
          <div className="font-mono text-micro tracking-[0.1em] text-ink-faint">{paper.mode === "online" ? "TIME ALLOWED" : "HOW"}</div>
          <div className="mt-1 text-[12.5px] font-semibold">
            {paper.mode === "online"
              ? (minutes ? `${minutes} minutes${extra ? ` (${extra} extra)` : ""}` : extra ? `No time limit, ${extra} extra minutes after closing` : "No time limit")
              : "Read it, answer on paper"}
          </div>
        </div>
      </div>

      {paper.instructions && <p className="mt-4 whitespace-pre-line text-[13.5px] leading-relaxed text-ink">{paper.instructions}</p>}

      {result && !startable && state?.status !== "in_progress" ? (
        <div className="mt-5 rounded-lg bg-ok-bg px-3.5 py-3">
          <div className="font-mono text-micro tracking-[0.1em] text-ok-ink">YOUR SCORE</div>
          <div className="mt-1 text-[18px] font-bold text-ok-ink">{scoreLabel(result.finalScore, total ?? 0)}</div>
          {result.feedback && <p className="mt-1.5 whitespace-pre-line text-small leading-relaxed text-ok-ink">{result.feedback}</p>}
          <Button block variant="secondary" className="mt-3" onClick={onReview}>See your marked paper</Button>
        </div>
      ) : paper.mode === "read" ? (
        !isOpen ? (
          <p className="mt-5 text-small text-ink-faint">The paper opens here at the time above.</p>
        ) : (
          <>
            {paper.filePath && <Button block variant="accent" className="mt-5" onClick={onOpenFile}>Open the paper</Button>}
            {text && <div className="mt-4 max-h-[420px] overflow-auto whitespace-pre-line rounded-lg border border-line-soft px-3.5 py-3 text-[13.5px] leading-relaxed">{text}</div>}
          </>
        )
      ) : state?.status === "in_progress" ? (
        <Button block variant="accent" className="mt-5" onClick={onSit}>Carry on</Button>
      ) : startable ? (
        <>
          <p className="mt-4 text-small leading-relaxed text-ink-muted">
            {resit && state ? `This is a resit. Your earlier sitting stays on the record; ${COUNTING_LABEL[state.terms.counting].toLowerCase()}. ` : ""}
            {minutes
              ? `Once you start, you have ${minutes} minutes and the clock keeps running even if you leave. Your answers save as you go.`
              : "Your answers save as you go. Hand in when you're done."}
          </p>
          <Button
            block variant="accent" className="mt-3"
            onClick={() => { if (!minutes || window.confirm(`Start now? You'll have ${minutes} minutes.`)) onSit(); }}
          >
            {resit ? "Start your resit" : "Start"}
          </Button>
        </>
      ) : state?.status === "excused" ? (
        <p className="mt-5 text-small leading-relaxed text-ink-muted">Your teacher has excused you from this paper. It has no mark, and it doesn't count against you.</p>
      ) : state?.submittedAt ? (
        <div className="mt-5 flex items-center gap-2.5 rounded-lg bg-ok-bg px-3.5 py-3">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok-ink text-[11px] text-white">✓</span>
          <span className="text-small leading-relaxed text-ok-ink">
            Handed in. {resitWaiting(view) && w === "upcoming" ? "Your resit opens at the time above. " : ""}Your score appears here once your teacher releases the results.
          </span>
        </div>
      ) : w === "upcoming" ? (
        <p className="mt-5 text-small text-ink-faint">You can start at the time above.</p>
      ) : (
        <p className="mt-5 text-small leading-relaxed text-ink-muted">
          You missed this paper. It's recorded as missed, not as a 0. If you were away for a reason, tell your teacher: they can give you a time to sit it.
        </p>
      )}

      {paper.mode === "online" && paper.filePath && isOpen && !result && (
        <Button block variant="secondary" className="mt-2" onClick={onOpenFile}>Open the reference sheet</Button>
      )}
    </>
  );
}
