import { useEffect, useMemo, useState } from "react";
import {
  COUNTING_LABEL, LEARNER_STATUS_LABEL, allowedMinutes, clearExamOverride, countingAttempt, fetchPaperContent,
  fetchPaperOverrides, fetchPaperScripts, formatTimeLeft, fromLocalInput, learnerDeadline, learnerPaperStatus, learnerTerms,
  markExamAttempt, needsHandMarking, notifyExamGrant, overrideSummary, releaseExamResults, scoreLabel,
  sendExamScoresToGradebook, setExamExcusal, setExamOverride, timeLeftMs, toLocalInput, totalPoints, validateOverride,
  type AttemptRow, type CountingRule, type ExamExcusal, type ExamOverride, type ExamPaperRow, type LearnerPaperStatus,
  type StaffQuestion,
} from "@figbloom/shared";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

const TEXTAREA = "w-full resize-y rounded-md border border-[#D3DAD5] px-3 py-2 font-sans text-[13px] outline-none focus:border-forest";
const INPUT = "rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-forest";

type Learner = { id: string; name: string; adm: string };

/** One learner on this paper: their sittings (oldest first), own terms, excusal, and where they stand. */
interface Row {
  learner: Learner;
  attempts: AttemptRow[];
  override: ExamOverride | undefined;
  excusal: ExamExcusal | undefined;
  status: LearnerPaperStatus;
  /** The sitting that goes on the record, once one is handed in. */
  counted: AttemptRow | undefined;
}

const STATUS_TONE: Record<LearnerPaperStatus, Tone> = {
  not_started: "muted", in_progress: "info", submitted: "warn", marked: "ok", missed: "warn", excused: "muted",
};

const fmtTime = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * Who has sat an online paper, and marking their written answers. Choice
 * questions are marked by the system the moment a script is handed in; a
 * blank written answer scores 0. Results reach learners and families only
 * once released, and every script has to be fully marked first.
 *
 * Each learner shows where they stand (20261030100000_exam_extensions): not
 * started, sitting now, to mark, marked, missed (their window closed with
 * nothing handed in) or excused. From here a teacher gives one or more
 * learners extra time, a window of their own or a resit, or excuses a learner
 * from the paper, each with a reason only staff see.
 */
export function ExamScripts({ paper, onClose, onChanged }: { paper: ExamPaperRow; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [granting, setGranting] = useState<string[] | null>(null);
  const [released, setReleased] = useState(!!paper.resultsReleasedAt);
  const [busy, setBusy] = useState(false);
  const reload = () => { setReloadKey((k) => k + 1); onChanged(); };

  const { data, loading, error } = useAsync(async () => {
    const [scripts, content, terms] = await Promise.all([fetchPaperScripts(paper), fetchPaperContent(paper.id), fetchPaperOverrides(paper.id)]);
    return { ...scripts, ...terms, questions: content.questions, loadedAt: Date.now() };
  }, [paper.id, reloadKey]);

  const total = totalPoints(data?.questions ?? []);
  // Learners who have left the class but sat the paper still show, after the class list.
  const rows: Row[] = useMemo(() => {
    if (!data) return [];
    const byStudent = new Map<string, AttemptRow[]>();
    for (const a of [...data.attempts].sort((x, y) => x.attemptNo - y.attemptNo)) byStudent.set(a.studentId, [...(byStudent.get(a.studentId) ?? []), a]);
    const known = new Set(data.learners.map((l) => l.id));
    const gone = [...byStudent.keys()].filter((id) => !known.has(id)).map((id) => ({ id, name: "Learner no longer in the class", adm: "—" }));
    return [...data.learners, ...gone].map((learner) => {
      const attempts = byStudent.get(learner.id) ?? [];
      const override = data.overrides.get(learner.id);
      const excusal = data.excusals.get(learner.id);
      const terms = learnerTerms(paper, override);
      const status = learnerPaperStatus({ mode: "online", terms, attempts, excused: !!excusal, nowMs: data.loadedAt }) ?? "not_started";
      return { learner, attempts, override, excusal, status, counted: countingAttempt(attempts, terms.counting) };
    });
  }, [data, paper]);

  const count = (s: LearnerPaperStatus) => rows.filter((r) => r.status === s).length;
  const handedIn = count("submitted") + count("marked");
  const toMark = (data?.attempts ?? []).filter((a) => a.submittedAt && a.finalScore === null).length;
  const selected = rows.find((r) => r.learner.id === selectedId) ?? null;
  const inClass = new Set((data?.learners ?? []).map((l) => l.id));

  function toggle(id: string) {
    setChecked((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

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
    if (!window.confirm(`Put these scores into ${paper.examName} marks for ${paper.subjectName}, ${paper.className}? Scores are scaled to that exam's total and replace any already typed for learners who sat this paper. Learners who missed it or were excused go in as Missed or Excused, never as 0, unless a mark is already typed for them.`)) return;
    setBusy(true);
    try {
      const n = await sendExamScoresToGradebook(paper.id);
      toast(`${n} learner${n === 1 ? "" : "s"} sent to the Gradebook.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not send the scores.", "error");
    } finally {
      setBusy(false);
    }
  }

  const notes = [
    `${handedIn} of ${rows.length} handed in`,
    toMark ? `${toMark} to mark` : "",
    count("missed") ? `${count("missed")} missed` : "",
    count("excused") ? `${count("excused")} excused` : "",
    `out of ${total}`,
  ].filter(Boolean).join(" · ");

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${paper.className} · ${paper.subjectName}`}
      title={`Scripts: ${paper.title}`}
      footNote={data ? notes : undefined}
      width={1040}
      actions={
        <>
          <Button disabled={busy || loading} onClick={() => setReloadKey((k) => k + 1)}>Refresh</Button>
          {checked.size > 0 && <Button disabled={busy} onClick={() => setGranting([...checked])}>Extra time or resit for {checked.size}</Button>}
          {paper.examId && <Button disabled={busy || !handedIn || toMark > 0} onClick={() => void sendToGradebook()}>Send to Gradebook</Button>}
          {released
            ? <Button disabled={busy} onClick={() => void release(false)}>Take results back</Button>
            : <Button variant="accent" disabled={busy || !handedIn} onClick={() => void release(true)}>Release results</Button>}
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
            {rows.map((r) => {
              const l = r.learner;
              return (
                <li key={l.id} className="flex items-center gap-2 pl-3" style={selectedId === l.id ? { background: "#F1F6F2" } : undefined}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${l.name}`}
                    disabled={!inClass.has(l.id)}
                    checked={checked.has(l.id)}
                    onChange={() => toggle(l.id)}
                  />
                  <button
                    type="button"
                    onClick={() => { setSelectedId(l.id); setGranting(null); }}
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 py-2.5 pr-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold">{l.name}</span>
                      <span className="block truncate font-mono text-[11px] text-ink-faint">
                        {r.counted?.finalScore !== null && r.counted?.finalScore !== undefined ? `${r.counted.finalScore} / ${total}` : `ADM ${l.adm}`}
                        {r.attempts.length > 1 ? ` · ${r.attempts.length} sittings` : ""}
                        {r.override ? ` · ${overrideSummary(r.override)}` : ""}
                      </span>
                    </span>
                    <Badge tone={STATUS_TONE[r.status]}>{LEARNER_STATUS_LABEL[r.status]}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>

          <section className="rounded-lg border border-line bg-white p-4">
            {granting ? (
              <GrantForm
                paper={paper}
                rows={rows.filter((r) => granting.includes(r.learner.id))}
                onCancel={() => setGranting(null)}
                onSaved={() => { setGranting(null); setChecked(new Set()); reload(); }}
              />
            ) : !selected ? (
              <p className="py-10 text-center text-small text-ink-faint">
                Pick a learner to see where they stand, mark their answers, or give them extra time, their own window or a resit.
              </p>
            ) : (
              <LearnerPanel
                key={selected.learner.id}
                paper={paper}
                row={selected}
                inClass={inClass.has(selected.learner.id)}
                questions={data?.questions ?? []}
                onGrant={() => setGranting([selected.learner.id])}
                onChanged={reload}
              />
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

/**
 * One learner: where they stand, the terms they've been given and why, and
 * their scripts. With a resit there is a script per sitting; the one that
 * counts is marked as such, and the others stay for the record.
 */
function LearnerPanel({ paper, row, inClass, questions, onGrant, onChanged }: {
  paper: ExamPaperRow;
  row: Row;
  inClass: boolean;
  questions: StaffQuestion[];
  onGrant: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { learner, attempts, override, excusal, status, counted } = row;
  const submitted = attempts.filter((a) => a.submittedAt);
  const [shownId, setShownId] = useState<string | null>(counted?.id ?? submitted[submitted.length - 1]?.id ?? null);
  const shown = submitted.find((a) => a.id === shownId) ?? null;
  const [excusing, setExcusing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const terms = learnerTerms(paper, override);
  const sitting = attempts.find((a) => !a.submittedAt);
  const deadline = sitting ? learnerDeadline(sitting.startedAt, terms) : null;
  const [now, setNow] = useState(Date.now());

  // The live view: a learner sitting now shows their own deadline, extensions included.
  useEffect(() => {
    if (!sitting) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [sitting]);

  async function run(work: () => Promise<void>, done: string) {
    setBusy(true);
    try {
      await work();
      toast(done);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not change that.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[15px] font-semibold">{learner.name}</h3>
        <Badge tone={STATUS_TONE[status]}>{LEARNER_STATUS_LABEL[status]}</Badge>
      </div>

      {sitting && (
        <p className="mt-2 text-[12.5px] text-ink-muted">
          {attempts.length > 1 ? `Sitting ${sitting.attemptNo} (a resit)` : "Sitting now"}, started {fmtTime(new Date(sitting.startedAt))}
          {deadline ? ` · has until ${fmtTime(deadline)} (${formatTimeLeft(timeLeftMs(deadline, now))} left)` : " · no time limit"}
        </p>
      )}
      {status === "missed" && (
        <p className="mt-2 text-[12.5px] text-ink-muted">
          Their window closed with nothing handed in. This is not a zero: it goes to the Gradebook as Missed. Give them their own window to sit it, or excuse them.
        </p>
      )}

      {(override || excusal) && (
        <div className="mt-3 rounded-lg border border-line-soft bg-page px-3 py-2.5 text-[12.5px] leading-relaxed">
          {override && (
            <p>
              <span className="font-semibold">Given: {overrideSummary(override)}</span>
              {allowedMinutes(terms) !== null && override.extraMinutes > 0 ? ` (${allowedMinutes(terms)} minutes in all)` : ""}.
              {override.attemptsAllowed > 1 ? ` ${COUNTING_LABEL[override.counting]}.` : ""} Why: {override.reason}
            </p>
          )}
          {excusal && <p><span className="font-semibold">Excused.</span> Why: {excusal.reason}</p>}
        </div>
      )}

      {inClass && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!excusal && <Button disabled={busy} onClick={onGrant}>{override ? "Change extra time / window / resit" : "Extra time, own window or resit"}</Button>}
          {override && attempts.length <= 1 && (
            <Button disabled={busy} onClick={() => { if (window.confirm(`Take back ${learner.name}'s extra time, own window and resit?`)) void run(() => clearExamOverride(paper.id, learner.id), "Extension removed"); }}>
              Remove extension
            </Button>
          )}
          {!attempts.length && !excusal && <Button disabled={busy} onClick={() => setExcusing(true)}>Excuse</Button>}
          {excusal && <Button disabled={busy} onClick={() => void run(() => setExamExcusal(paper.id, learner.id, false, ""), "Excusal removed")}>Remove excusal</Button>}
        </div>
      )}

      {excusing && (
        <div className="mt-3 rounded-lg border border-line-soft p-3">
          <label className="block text-small font-semibold" htmlFor="excuse-reason">Why is {learner.name} excused?</label>
          <p className="mt-0.5 text-[11.5px] text-ink-faint">Only staff see this. An excused learner has no mark for this paper: not missed, and not 0.</p>
          <input id="excuse-reason" className={`${INPUT} mt-1.5 w-full`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Representing the school at games" />
          <div className="mt-2 flex justify-end gap-2">
            <Button onClick={() => setExcusing(false)}>Cancel</Button>
            <Button
              variant="accent"
              disabled={busy || !reason.trim()}
              onClick={() => void run(async () => { await setExamExcusal(paper.id, learner.id, true, reason); setExcusing(false); }, `${learner.name} excused`)}
            >
              Excuse
            </Button>
          </div>
        </div>
      )}

      {submitted.length > 1 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {submitted.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setShownId(a.id)}
              className="rounded-full px-2.5 py-1 text-[11.5px]"
              style={shown?.id === a.id ? { background: "#17402A", color: "#fff", fontWeight: 600 } : { background: "#EEF1EE", color: "#5F6B62" }}
            >
              Sitting {a.attemptNo}{a.id === counted?.id ? " · counts" : ""}
            </button>
          ))}
        </div>
      )}

      {shown ? (
        <div className="mt-4 border-t border-line-soft pt-4">
          <MarkScript
            key={shown.id}
            learner={learner}
            attempt={shown}
            counts={submitted.length > 1 ? shown.id === counted?.id : null}
            questions={questions}
            onSaved={onChanged}
          />
        </div>
      ) : !sitting && status !== "missed" && status !== "excused" && (
        <p className="mt-6 text-center text-small text-ink-faint">Nothing handed in yet.</p>
      )}
    </>
  );
}

/**
 * Extra minutes, a window of their own and/or a resit, for one learner or
 * several at once. Extra minutes go on the time limit and the closing time.
 * The learners are told in the app.
 */
function GrantForm({ paper, rows, onCancel, onSaved }: {
  paper: ExamPaperRow;
  rows: Row[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { tenant, profile } = useTenantSession();
  // Editing one learner's existing terms starts from them.
  const existing = rows.length === 1 ? rows[0]!.override : undefined;
  const [extra, setExtra] = useState(String(existing?.extraMinutes ?? 0));
  const [opensAt, setOpensAt] = useState(toLocalInput(existing?.opensAt ?? null));
  const [closesAt, setClosesAt] = useState(toLocalInput(existing?.closesAt ?? null));
  const [resit, setResit] = useState(false);
  const [counting, setCounting] = useState<CountingRule>(existing?.counting ?? "latest");
  const [reason, setReason] = useState(existing?.reason ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const allHandedIn = rows.every((r) => r.attempts.length > 0 && r.attempts.every((a) => a.submittedAt));
  const hasResitAlready = rows.every((r) => (r.override?.attemptsAllowed ?? 1) > 1);
  const names = rows.map((r) => r.learner.name).join(", ");

  async function save() {
    const minutes = extra.trim() === "" ? 0 : Number(extra);
    const checkedInput = validateOverride(
      { opensAt: fromLocalInput(opensAt), closesAt: fromLocalInput(closesAt), extraMinutes: minutes, resit, counting, reason },
      paper,
      { hasResitAlready },
    );
    if (!checkedInput.ok) { setError(checkedInput.message); return; }
    setSaving(true);
    setError("");
    try {
      const logins = await setExamOverride(paper.id, rows.map((r) => r.learner.id), checkedInput.value);
      try {
        const { pushError } = await notifyExamGrant({ tenantId: tenant.id, authorId: profile.id, profileIds: logins, paper, grant: checkedInput.value });
        if (pushError) toast(`Saved. The phone notification didn't go out: ${pushError}`, "error");
      } catch (err) {
        toast(`Saved, but the learner${rows.length === 1 ? " wasn't" : "s weren't"} told in the app: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
      toast(resit ? `Resit given to ${names}` : `Saved for ${names}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h3 className="text-[15px] font-semibold">Extra time, own window or resit</h3>
      <p className="mt-1 text-[12.5px] text-ink-muted">For {names}.</p>

      <div className="mt-4 grid gap-3">
        <label className="grid gap-1 text-small font-semibold">
          Extra minutes
          <input type="number" min={0} max={600} className={`${INPUT} w-28`} value={extra} onChange={(e) => setExtra(e.target.value)} />
          <span className="text-[11.5px] font-normal text-ink-faint">
            Added to the time allowed{paper.durationMinutes ? ` (${paper.durationMinutes} minutes)` : ""} and to the closing time, so they get it even starting late.
          </span>
        </label>

        <div>
          <div className="text-small font-semibold">Their own window <span className="font-normal text-ink-faint">(optional)</span></div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-muted">
            <label className="flex items-center gap-1.5">Opens <input type="datetime-local" className={INPUT} value={opensAt} onChange={(e) => setOpensAt(e.target.value)} /></label>
            <label className="flex items-center gap-1.5">Closes <input type="datetime-local" className={INPUT} value={closesAt} onChange={(e) => setClosesAt(e.target.value)} /></label>
          </div>
          <span className="text-[11.5px] text-ink-faint">Leave blank to keep the paper's. They can start inside their window only, even after the paper has closed for everyone else.</span>
        </div>

        <label className="flex items-start gap-2 text-small">
          <input type="checkbox" className="mt-0.5" checked={resit} disabled={!allHandedIn} onChange={(e) => setResit(e.target.checked)} />
          <span>
            <span className="font-semibold">Let them sit it again (a resit)</span>
            <span className="block text-[11.5px] text-ink-faint">
              {allHandedIn
                ? `Their ${rows.length === 1 && rows[0]!.attempts.length > 1 ? "earlier sittings stay" : "first sitting stays"} on the record.${paper.resultsReleasedAt ? " Results are already out, so they have seen the marked paper." : ""}`
                : "Only for learners who have handed the paper in. For a learner who missed it, give them their own window instead."}
            </span>
          </span>
        </label>

        {(resit || hasResitAlready) && (
          <label className="grid gap-1 text-small font-semibold">
            Which sitting counts
            <select className={`${INPUT} w-64 bg-white`} value={counting} onChange={(e) => setCounting(e.target.value as CountingRule)}>
              {(Object.keys(COUNTING_LABEL) as CountingRule[]).map((c) => <option key={c} value={c}>{COUNTING_LABEL[c]}</option>)}
            </select>
            <span className="text-[11.5px] font-normal text-ink-faint">
              This is what goes on the record: results, the Gradebook and report cards. Until a resit is handed in, the earlier sitting counts.
            </span>
          </label>
        )}

        <label className="grid gap-1 text-small font-semibold">
          Why
          <textarea className={TEXTAREA} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sick on the day; arrived late (bus broke down)" />
          <span className="text-[11.5px] font-normal text-ink-faint">Only staff see this. The learner is told what they've been given, not why.</span>
        </label>
      </div>

      {error && <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="accent" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save and tell them"}</Button>
      </div>
    </>
  );
}

function MarkScript({ learner, attempt, counts, questions, onSaved }: {
  learner: Learner;
  attempt: AttemptRow;
  /** With more than one sitting: whether this one goes on the record. Null with just the one. */
  counts: boolean | null;
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
        <h3 className="text-[14px] font-semibold">
          {counts === null ? "Script" : `Sitting ${attempt.attemptNo}`}
          {counts !== null && <span className="ml-2 font-normal text-ink-faint">{counts ? "counts" : "kept for the record, doesn't count"}</span>}
        </h3>
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
