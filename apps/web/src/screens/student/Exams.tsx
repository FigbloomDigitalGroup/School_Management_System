import { useState } from "react";
import {
  COUNTING_LABEL, PAPER_KIND_LABEL, canStartPaper, fetchPaperText, loadStudentPapers, paperResitWaiting, paperStanding, paperWindow,
  scoreLabel, studentWindow, windowLabel,
  type AttemptRow, type ExamPaperRow, type StudentPaper,
} from "@figbloom/shared";
import { useStudentData } from "../../lib/studentContext";
import { useAsync } from "../../lib/useAsync";
import { privateDocUrl } from "../../lib/uploads";
import { PageHead } from "../../components/ConsoleShell";
import { Cell, DataTable, EmptyState } from "../../components/ui/DataTable";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { ExamSitting } from "./ExamSitting";
import { confirmDialog } from "../../components/ui/Confirm";

type Tab = "Coming up" | "Done";

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
    return loadStudentPapers(student.classId, student.studentId);
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
  const states = new Map(views.map((v) => [v.paper.id, paperStanding(v, now)]));
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
                { key: "title", header: "Paper", width: "1.8fr", render: (v: StudentPaper) => <Cell sub={`${PAPER_KIND_LABEL[v.paper.kind]} · ${v.paper.subjectName}`}>{v.paper.title}</Cell> },
                { key: "when", header: "When", width: "1.4fr", render: (v: StudentPaper) => <span className="text-[12px] text-ink-muted">{windowLabel(studentWindow(v), now)}</span> },
                { key: "state", header: "", align: "right", width: "0.8fr", render: (v: StudentPaper) => <Badge tone={states.get(v.paper.id)!.tone}>{states.get(v.paper.id)!.label}</Badge> },
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
  view: StudentPaper;
  now: number;
  onOpenFile: () => void;
  onSit: () => void;
  onReview: () => void;
}) {
  const { paper, state, result, total } = view;
  const win = studentWindow(view);
  const w = paperWindow(win, now);
  const ownWindow = win.opensAt !== paper.opensAt || win.closesAt !== paper.closesAt;
  const extra = state?.terms.extraMinutes ?? 0;
  const minutes = paper.durationMinutes ? paper.durationMinutes + extra : null;
  const startable = canStartPaper(view, now);
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
            onClick={async () => { if (!minutes || await confirmDialog({ title: "Start now?", body: `You'll have ${minutes} minutes.`, confirmLabel: "Start" })) onSit(); }}
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
            Handed in. {paperResitWaiting(view) && w === "upcoming" ? "Your resit opens at the time above. " : ""}Your score appears here once your teacher releases the results.
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
