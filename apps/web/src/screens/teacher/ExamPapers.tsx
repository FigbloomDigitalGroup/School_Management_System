import { useEffect, useMemo, useRef, useState } from "react";
import {
  PAPER_KIND_LABEL, PAPER_MODE_LABEL, QUESTION_KIND_LABEL, blankQuestion, createExamPaper, deleteExamPaper,
  fetchClassSizes, fetchCurrentTermExams, fetchExamPapers, fetchMyTeachingPairs, fetchPaperContent, fetchTeacherClasses,
  fetchTeacherSubjectsForClass, fromLocalInput, paperWindow, publishProblem, questionsToCheck, saveExamQuestions, savePaperBody,
  setPaperFile, setPaperPublished, supabase, toLocalInput, totalPoints, updateExamPaper, validatePaper,
  validateQuestions, windowLabel,
  type ExamPaperRow, type PaperImportDraft, type PaperKind, type PaperMode, type QuestionDraft, type QuestionKind, type ReviewQuestion,
} from "@figbloom/shared";
import { AiPaperImportModal } from "../../components/AiPaperImport";
import { AiQuestionsModal } from "../../components/AiQuestions";
import { useAiStatus } from "../../lib/useAi";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { privateDocUrl, uploadExamPaperFile } from "../../lib/uploads";
import { useAsync } from "../../lib/useAsync";
import { ExamScripts } from "./ExamScripts";
import { confirmDialog } from "../../components/ui/Confirm";

type Option = { id: string; name: string };

/** Where the class and subject pickers come from: a teacher's own assignments, or the whole school for the office. */
interface Scope {
  classes: () => Promise<Option[]>;
  subjectsFor: (classId: string) => Promise<Option[]>;
}

const TEXTAREA = "w-full resize-y rounded-md border border-[#D3DAD5] px-3 py-2.5 font-sans text-body outline-none focus:border-forest";

/**
 * Exam papers and tests (CATs, quizzes) a teacher posts for a class and
 * subject they teach; the school admin sees and can post for every class.
 * Learners either read the paper (a PDF or typed text, answered on paper in
 * the exam room) or sit it online: timed, choice questions marked straight
 * away, written answers marked here under "Scripts".
 */
export function ExamPapers({ admin = false }: { admin?: boolean }) {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  // importing: open the editor straight onto "Import a paper with Bloom"
  const [editing, setEditing] = useState<{ paper?: ExamPaperRow; importing?: boolean } | null>(null);
  const [scripts, setScripts] = useState<ExamPaperRow | null>(null);
  const reload = () => setReloadKey((k) => k + 1);
  const aiStatus = useAiStatus();

  const scope: Scope = useMemo(() => admin
    ? {
        classes: async () => {
          const { data, error } = await supabase().from("classes").select("id, name").eq("tenant_id", tenant.id).order("name");
          if (error) throw new Error(error.message);
          return (data ?? []) as Option[];
        },
        subjectsFor: async () => {
          const { data, error } = await supabase().from("subjects").select("id, name").eq("tenant_id", tenant.id).order("name");
          if (error) throw new Error(error.message);
          return (data ?? []) as Option[];
        },
      }
    : {
        classes: () => fetchTeacherClasses(profile.id),
        subjectsFor: (classId: string) => fetchTeacherSubjectsForClass(profile.id, classId),
      }, [admin, tenant.id, profile.id]);

  const { data: classes } = useAsync(() => scope.classes(), [scope]);
  const { data, loading, error } = useAsync(async () => {
    const [all, pairs] = await Promise.all([fetchExamPapers(tenant.id), admin ? Promise.resolve(null) : fetchMyTeachingPairs(profile.id)]);
    const papers = pairs ? all.filter((p) => pairs.has(`${p.classId}:${p.subjectId}`)) : all;
    const sizes = await fetchClassSizes([...new Set(papers.map((p) => p.classId))]);
    return { papers, sizes };
  }, [tenant.id, profile.id, admin, reloadKey]);

  const papers = data?.papers ?? [];
  const sizes = data?.sizes ?? {};
  const now = Date.now();

  async function togglePublish(p: ExamPaperRow) {
    try {
      if (!p.publishedAt) {
        // The typed text isn't in the list row; only look it up when there's no file.
        const hasContent = !!p.filePath || (p.mode === "read" && !!(await fetchPaperContent(p.id)).body);
        const problem = publishProblem({ mode: p.mode, hasContent, questionCount: p.questionCount });
        if (problem) { toast(problem, "error"); return; }
      } else if (!(await confirmDialog({ title: `Unpublish "${p.title}"?`, body: `${p.className} won't see it any more.`, confirmLabel: "Unpublish" }))) return;
      await setPaperPublished(p.id, !p.publishedAt);
      toast(p.publishedAt ? "Paper unpublished" : `Published. ${p.className} can see it now.`);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not change that.", "error");
    }
  }

  async function remove(p: ExamPaperRow) {
    if (!(await confirmDialog({ title: `Delete "${p.title}" for ${p.className}?`, confirmLabel: "Delete", danger: true }))) return;
    try {
      await deleteExamPaper(p.id);
      toast("Paper deleted");
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete the paper.", "error");
    }
  }

  return (
    <>
      <PageHead
        eyebrow="Exams & tests"
        title="Exams & tests"
        blurb={admin
          ? "Every exam paper and test posted in the school. Learners read a paper, or sit it online and get it marked here."
          : "Post an exam paper or a test for a class and subject you teach. Learners read it, or sit it online and you mark it here."}
        actions={
          <>
            {aiStatus?.aiEnabled && <Button disabled={!classes?.length} onClick={() => setEditing({ importing: true })}>Import a paper</Button>}
            <Button variant="accent" disabled={!classes?.length} onClick={() => setEditing({})}>New paper</Button>
          </>
        }
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the papers: {error.message}
          </p>
        ) : loading && !data ? (
          <TableSkeleton rows={4} />
        ) : classes && classes.length === 0 ? (
          <div className="rounded-lg border border-line bg-white">
            <EmptyState title="No classes yet" body={admin ? "Add classes first under Classes." : "You aren't assigned to any classes yet. Ask the school admin to add you to a class."} />
          </div>
        ) : papers.length === 0 ? (
          <div className="rounded-lg border border-line bg-white">
            <EmptyState
              title="No papers yet"
              body="Post an exam paper or a test. It stays a draft, seen only by staff, until you publish it."
              action={<Button variant="accent" onClick={() => setEditing({})}>New paper</Button>}
            />
          </div>
        ) : (
          <DataTable
            title="Papers"
            columns={[
              { key: "title", header: "Paper", width: "1.8fr", render: (p: ExamPaperRow) => (
                <Cell sub={`${PAPER_KIND_LABEL[p.kind]} · ${PAPER_MODE_LABEL[p.mode]}${p.durationMinutes ? ` · ${p.durationMinutes} min` : ""}`}>{p.title}</Cell>
              ) },
              { key: "class", header: "Class · subject", width: "1.1fr", render: (p: ExamPaperRow) => <Cell sub={p.subjectName}>{p.className}</Cell> },
              { key: "when", header: "When", width: "1.6fr", render: (p: ExamPaperRow) => <span className="text-[12.5px] text-ink-muted">{windowLabel(p, now)}</span> },
              { key: "state", header: "Status", width: "0.9fr", render: (p: ExamPaperRow) => <PaperBadge paper={p} now={now} /> },
              { key: "sat", header: "Sat", align: "right", width: "0.6fr", render: (p: ExamPaperRow) => (
                <Mono>{p.mode === "online" ? `${Math.min(p.attemptCount, sizes[p.classId] ?? p.attemptCount)} of ${sizes[p.classId] ?? "?"}` : "—"}</Mono>
              ) },
              { key: "actions", header: "", align: "right", width: "2fr", render: (p: ExamPaperRow) => (
                <div className="flex flex-wrap justify-end gap-2">
                  {p.mode === "online" && p.publishedAt && <Button onClick={() => setScripts(p)}>Scripts</Button>}
                  <Button onClick={() => setEditing({ paper: p })}>Edit</Button>
                  <Button onClick={() => void togglePublish(p)}>{p.publishedAt ? "Unpublish" : "Publish"}</Button>
                  {p.attemptCount === 0 && <Button onClick={() => void remove(p)}>Delete</Button>}
                </div>
              ) },
            ]}
            rows={papers}
            rowKey={(p) => p.id}
            minWidth="980px"
            empty={{ title: "No papers yet", body: "Post the first one." }}
          />
        )}
      </div>

      {editing && (
        <PaperEditor
          paper={editing.paper}
          startImport={editing.importing}
          classes={classes ?? []}
          scope={scope}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { toast(msg); setEditing(null); reload(); }}
        />
      )}
      {scripts && <ExamScripts paper={scripts} onClose={() => setScripts(null)} onChanged={reload} />}
    </>
  );
}

function PaperBadge({ paper, now }: { paper: ExamPaperRow; now: number }) {
  if (!paper.publishedAt) return <Badge tone="muted">Draft</Badge>;
  if (paper.resultsReleasedAt) return <Badge tone="ok">Results out</Badge>;
  const w = paperWindow(paper, now);
  return w === "upcoming" ? <Badge tone="info">Published</Badge> : w === "open" ? <Badge tone="warn">Open now</Badge> : <Badge tone="muted">Closed</Badge>;
}

/** Tomorrow 08:00 on this device, as a `datetime-local` value: a sensible default opening time. */
function tomorrowMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return toLocalInput(d.toISOString());
}

function PaperEditor({ paper, startImport = false, classes, scope, onClose, onSaved }: {
  paper?: ExamPaperRow;
  startImport?: boolean;
  classes: Option[];
  scope: Scope;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { tenant } = useTenantSession();
  const locked = (paper?.attemptCount ?? 0) > 0;
  const [kind, setKind] = useState<PaperKind>(paper?.kind ?? "exam");
  const [title, setTitle] = useState(paper?.title ?? "");
  const [instructions, setInstructions] = useState(paper?.instructions ?? "");
  const [classId, setClassId] = useState(paper?.classId ?? classes[0]?.id ?? "");
  const [subjectId, setSubjectId] = useState(paper?.subjectId ?? "");
  const [examId, setExamId] = useState(paper?.examId ?? "");
  const [mode, setMode] = useState<PaperMode>(paper?.mode ?? "online");
  const [body, setBody] = useState("");
  const [opensAt, setOpensAt] = useState(paper ? toLocalInput(paper.opensAt) : tomorrowMorning());
  const [closesAt, setClosesAt] = useState(toLocalInput(paper?.closesAt ?? null));
  const [duration, setDuration] = useState(paper?.durationMinutes ? String(paper.durationMinutes) : paper ? "" : "60");
  const [file, setFile] = useState<File | null>(null);
  const [removeFile, setRemoveFile] = useState(false);
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);
  // What Bloom said about an imported paper as a whole (missing pages, totals that don't add up).
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // Set once a new paper is created, so a retry after a later step fails updates it rather than creating a second one.
  const createdId = useRef<string | null>(null);

  const { data: content, loading: contentLoading } = useAsync(
    () => (paper ? fetchPaperContent(paper.id) : Promise.resolve({ body: "", questions: [] })),
    [paper?.id],
  );
  useEffect(() => {
    if (!content) return;
    setBody(content.body);
    setQuestions(content.questions);
  }, [content]);

  const { data: exams } = useAsync(() => fetchCurrentTermExams(tenant.id), [tenant.id]);

  const { data: subjectList } = useAsync(
    async () => ({ classId, list: classId ? await scope.subjectsFor(classId) : [] }),
    [classId, scope],
  );
  const subjects = useMemo(() => (subjectList?.classId === classId ? subjectList.list : null), [subjectList, classId]);
  useEffect(() => {
    if (!subjects) return;
    if (!subjects.some((s) => s.id === subjectId)) setSubjectId(subjects[0]?.id ?? "");
  }, [subjects, subjectId]);

  const hasFile = !!file || (!!paper?.fileName && !removeFile);
  const toCheck = questionsToCheck(questions);

  /** Bloom's paper into the editor: its questions, and its title, instructions and time where these are still empty. */
  function applyImport(draft: PaperImportDraft, replace: boolean) {
    setQuestions((qs) => (replace ? draft.questions : [...qs, ...draft.questions]));
    if (!title.trim() && draft.title) setTitle(draft.title);
    if (!instructions.trim() && draft.instructions) setInstructions(draft.instructions);
    // A new paper's 60 minutes is only a default; the paper's own time wins.
    if (draft.durationMinutes && (!paper || !duration.trim())) setDuration(String(draft.durationMinutes));
    setImportWarnings(draft.warnings);
  }

  async function save(publish: boolean) {
    const checked = validatePaper({
      kind, title, instructions, classId, subjectId, examId: examId || null, mode, body,
      opensAt: fromLocalInput(opensAt) ?? "", closesAt: fromLocalInput(closesAt),
      durationMinutes: mode === "online" && duration.trim() ? Number(duration) : null,
    }, { hasFile });
    if (!checked.ok) { setError(checked.message); return; }
    let qs: QuestionDraft[] = questions;
    if (mode === "online" && !locked) {
      const q = validateQuestions(questions);
      if (!q.ok) { setError(q.message); return; }
      qs = q.value;
    }
    if (publish && mode === "online" && toCheck) {
      setError(`${toCheck} question${toCheck === 1 ? " is" : "s are"} flagged for checking. Look at each one and press "Looks right", or save a draft for now.`);
      return;
    }
    if (publish) {
      const problem = publishProblem({ mode, hasContent: hasFile || !!checked.value.body, questionCount: qs.length });
      if (problem) { setError(problem); return; }
    }

    setSaving(true);
    setError("");
    try {
      let id = paper?.id ?? createdId.current;
      if (id) await updateExamPaper(id, checked.value);
      else id = createdId.current = await createExamPaper(tenant.id, checked.value);
      await savePaperBody(id, checked.value.body);
      if (file) await setPaperFile(id, await uploadExamPaperFile({ tenantId: tenant.id, paperId: id, file }));
      else if (removeFile) await setPaperFile(id, null);
      if (mode === "online" && !locked) await saveExamQuestions(id, qs);
      if (publish && !paper?.publishedAt) await setPaperPublished(id, true);
      onSaved(publish ? `Published. Learners in the class can see it${paperWindow(checked.value, Date.now()) === "upcoming" ? " and when it opens" : ""}.` : "Paper saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }

  async function openFile() {
    if (!paper?.filePath) return;
    try { window.open(await privateDocUrl(paper.filePath), "_blank", "noopener"); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not open the file."); }
  }

  const noSubjects = subjects !== null && subjects.length === 0;
  const published = !!paper?.publishedAt;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={PAPER_KIND_LABEL[kind]}
      title={paper ? "Edit paper" : "New paper"}
      blurb={locked ? "Learners have already started this paper, so its class, subject, type and questions are fixed. You can still change the title, instructions and times." : undefined}
      footNote={mode === "online" && questions.length ? `${questions.length} question${questions.length === 1 ? "" : "s"} · ${totalPoints(questions)} marks` : undefined}
      width={820}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={saving || noSubjects || contentLoading} onClick={() => void save(false)}>{saving ? "Saving…" : published ? "Save changes" : "Save draft"}</Button>
          {!published && <Button variant="accent" disabled={saving || noSubjects || contentLoading} onClick={() => void save(true)}>Save and publish</Button>}
        </>
      }
    >
      <div className="grid gap-3.5">
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <SelectField id="ep-kind" label="Type" value={kind} onChange={(e) => setKind(e.target.value as PaperKind)}
            options={(Object.keys(PAPER_KIND_LABEL) as PaperKind[]).map((k) => ({ value: k, label: PAPER_KIND_LABEL[k] }))} />
          <SelectField id="ep-class" label="Class" value={classId} disabled={locked} onChange={(e) => setClassId(e.target.value)}
            options={classes.map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField id="ep-subject" label="Subject" value={subjectId} disabled={locked} onChange={(e) => setSubjectId(e.target.value)}
            options={(subjects ?? []).map((s) => ({ value: s.id, label: s.name }))}
            hint={noSubjects ? "You aren't assigned a subject in this class. Ask the school admin." : undefined} />
        </div>
        <TextField id="ep-title" label="Title" placeholder="e.g. Mid-term Mathematics Paper 1" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextArea id="ep-instructions" label="Instructions (optional)" placeholder="e.g. Answer all questions in Section A and any two in Section B." value={instructions} onChange={(e) => setInstructions(e.target.value)} />

        <div>
          <div className="mb-1.5 text-small font-semibold">How learners take it</div>
          <div className="flex gap-2">
            {(["online", "read"] as PaperMode[]).map((m) => (
              <button
                key={m}
                type="button"
                disabled={locked}
                onClick={() => setMode(m)}
                className="flex-1 rounded-lg border px-3.5 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
                style={mode === m ? { borderColor: "#17402A", background: "#F1F6F2" } : { borderColor: "#D3DAD5" }}
              >
                <div className="text-[13px] font-semibold">{m === "online" ? "Sit it online" : "Read only"}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-faint">
                  {m === "online" ? "Timed questions in the app. Multiple choice is marked for you." : "Learners open the paper and answer on paper, in class or at home."}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3.5" style={{ gridTemplateColumns: mode === "online" ? "1fr 1fr 0.7fr" : "1fr 1fr" }}>
          <TextField id="ep-opens" label="Opens" type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
          <TextField id="ep-closes" label="Closes (optional)" type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} hint="Leave empty to keep it open." />
          {mode === "online" && (
            <TextField id="ep-duration" label="Time allowed (min)" type="number" min={1} max={600} value={duration} onChange={(e) => setDuration(e.target.value)} hint="Empty for no limit." />
          )}
        </div>

        <SelectField
          id="ep-exam" label="Counts towards" value={examId} onChange={(e) => setExamId(e.target.value)}
          options={[{ value: "", label: "Nothing: practice only" }, ...(exams ?? []).map((x) => ({ value: x.id, label: `${x.name} (this term)` }))]}
          hint={mode === "online" ? "Pick a term exam to send the marked scores into the Gradebook from Scripts." : "Read-only papers are marked by hand: type the marks into the Gradebook as usual."}
        />

        <div className="rounded-lg border border-line-soft bg-page px-3.5 py-3">
          <div className="text-small font-semibold">{mode === "read" ? "The paper" : "Reference sheet (optional)"}</div>
          <p className="mt-0.5 text-[11.5px] text-ink-faint">
            {mode === "read" ? "Upload it as a PDF, type it in below, or both. Learners can open it from when the paper opens." : "A formula sheet, map or passage learners can open while they sit the paper."}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            <input type="file" accept="application/pdf,image/*" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRemoveFile(false); }} className="text-[12.5px]" />
            {paper?.fileName && !file && !removeFile && (
              <>
                <button type="button" className="text-[12.5px] font-semibold text-forest underline" onClick={() => void openFile()}>{paper.fileName}</button>
                <Button onClick={() => setRemoveFile(true)}>Remove</Button>
              </>
            )}
          </div>
          {mode === "read" && (
            <textarea
              aria-label="Type the paper"
              className={`${TEXTAREA} mt-3`}
              rows={8}
              placeholder="Or type the paper here."
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
        </div>

        {mode === "online" && (
          contentLoading ? <TableSkeleton rows={2} /> : (
            <QuestionBuilder
              questions={questions}
              onChange={setQuestions}
              locked={locked}
              startImport={startImport}
              onImport={applyImport}
              importWarnings={importWarnings}
              ai={{
                subject: subjects?.find((s) => s.id === subjectId)?.name ?? "",
                className: classes.find((c) => c.id === classId)?.name ?? "",
                kind,
              }}
            />
          )
        )}

        {error && (
          <p className="flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{error}</p>
        )}
      </div>
    </Modal>
  );
}

function QuestionBuilder({ questions, onChange, locked, ai, startImport, onImport, importWarnings }: {
  questions: ReviewQuestion[];
  onChange: (q: ReviewQuestion[]) => void;
  locked: boolean;
  /** What the AI needs to draft questions for this paper. */
  ai: { subject: string; className: string; kind: PaperKind };
  startImport: boolean;
  onImport: (draft: PaperImportDraft, replace: boolean) => void;
  importWarnings: string[];
}) {
  const aiStatus = useAiStatus();
  const [drafting, setDrafting] = useState(false);
  const [importing, setImporting] = useState(startImport && !locked);
  const toCheck = questionsToCheck(questions);
  const set = (i: number, patch: Partial<ReviewQuestion>) => onChange(questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i: number, by: number) => {
    const next = [...questions];
    const [q] = next.splice(i, 1);
    next.splice(i + by, 0, q!);
    onChange(next);
  };
  const changeKind = (i: number, kind: QuestionKind) => {
    const q = questions[i]!;
    set(i, { kind, options: kind === "choice" ? (q.options.length >= 2 ? q.options : ["", ""]) : [], correctOption: kind === "choice" ? q.correctOption : null });
  };

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-small font-semibold">Questions</div>
        <div className="text-[11.5px] text-ink-faint">{totalPoints(questions)} marks in total</div>
      </div>
      {(importWarnings.length > 0 || toCheck > 0) && (
        <div role="status" className="mb-3 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3.5 py-2.5 text-[12.5px] leading-snug text-warn-ink">
          {toCheck > 0 && (
            <p className="font-semibold">
              Imported by Bloom. {toCheck} question{toCheck === 1 ? " needs" : "s need"} checking against the paper before you can publish.
            </p>
          )}
          {importWarnings.length > 0 && (
            <ul className="mt-1 list-disc pl-5">{importWarnings.map((w, k) => <li key={k}>{w}</li>)}</ul>
          )}
        </div>
      )}
      <fieldset disabled={locked} className="grid gap-3">
        {questions.map((q, i) => (
          <div key={i} className={`rounded-lg border bg-white p-3.5 ${q.check?.length ? "border-warn-ink/50" : "border-line"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-micro tracking-[0.1em] text-ink-faint">Q{i + 1}</span>
              <select
                aria-label={`Question ${i + 1} type`}
                className="rounded-md border border-[#D3DAD5] bg-white px-2 py-1.5 text-[12.5px]"
                value={q.kind}
                onChange={(e) => changeKind(i, e.target.value as QuestionKind)}
              >
                {(Object.keys(QUESTION_KIND_LABEL) as QuestionKind[]).map((k) => <option key={k} value={k}>{QUESTION_KIND_LABEL[k]}</option>)}
              </select>
              <label className="flex items-center gap-1.5 text-[12.5px] text-ink-muted">
                <input
                  type="number" min={1} max={100} aria-label={`Question ${i + 1} marks`}
                  className="w-16 rounded-md border border-[#D3DAD5] px-2 py-1.5 text-[12.5px]"
                  value={Number.isNaN(q.points) ? "" : q.points}
                  onChange={(e) => set(i, { points: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
                />
                marks
              </label>
              <span className="flex-1" />
              {!locked && (
                <>
                  <Button disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</Button>
                  <Button disabled={i === questions.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</Button>
                  <Button onClick={() => onChange(questions.filter((_, j) => j !== i))}>Remove</Button>
                </>
              )}
            </div>
            <textarea
              aria-label={`Question ${i + 1}`}
              className={`${TEXTAREA} mt-2.5`}
              rows={q.kind === "long" ? 3 : 2}
              placeholder="Write the question"
              value={q.prompt}
              onChange={(e) => set(i, { prompt: e.target.value })}
            />
            {q.check?.length ? (
              <div className="mt-2 flex items-start gap-3 rounded-md bg-warn-ink/5 px-2.5 py-2 text-[12px] leading-snug text-warn-ink">
                <ul className="flex-1 list-disc pl-4" aria-label={`Question ${i + 1}: check this`}>
                  {q.check.map((c, k) => <li key={k}>{c}</li>)}
                </ul>
                {!locked && <Button onClick={() => set(i, { check: undefined })}>Looks right</Button>}
              </div>
            ) : null}
            {q.kind === "choice" ? (
              <div className="mt-2.5 grid gap-1.5">
                {q.options.map((o, k) => (
                  <div key={k} className="flex items-center gap-2">
                    <input
                      type="radio" name={`q${i}-correct`} aria-label={`Option ${k + 1} is correct`}
                      checked={q.correctOption === k} onChange={() => set(i, { correctOption: k })}
                    />
                    <input
                      aria-label={`Option ${k + 1}`}
                      className="flex-1 rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px]"
                      placeholder={`Option ${String.fromCharCode(65 + k)}`}
                      value={o}
                      onChange={(e) => set(i, { options: q.options.map((x, j) => (j === k ? e.target.value : x)) })}
                    />
                    {!locked && q.options.length > 2 && (
                      <button
                        type="button" className="px-1.5 text-[12px] text-ink-faint hover:text-ink" aria-label={`Remove option ${k + 1}`}
                        onClick={() => set(i, {
                          options: q.options.filter((_, j) => j !== k),
                          correctOption: q.correctOption === k ? null : q.correctOption !== null && q.correctOption > k ? q.correctOption - 1 : q.correctOption,
                        })}
                      >✕</button>
                    )}
                  </div>
                ))}
                <div className="flex items-center justify-between">
                  <span className="text-[11.5px] text-ink-faint">Tick the correct option.</span>
                  {!locked && q.options.length < 8 && (
                    <button type="button" className="text-[12px] font-semibold text-forest" onClick={() => set(i, { options: [...q.options, ""] })}>+ Add option</button>
                  )}
                </div>
              </div>
            ) : (
              <input
                aria-label={`Question ${i + 1} model answer`}
                className="mt-2 w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[12.5px]"
                placeholder="Model answer or marking points (optional, only staff see this)"
                value={q.modelAnswer}
                onChange={(e) => set(i, { modelAnswer: e.target.value })}
              />
            )}
          </div>
        ))}
      </fieldset>
      {!locked && (
        <div className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(QUESTION_KIND_LABEL) as QuestionKind[]).map((k) => (
            <Button key={k} onClick={() => onChange([...questions, blankQuestion(k)])}>+ {QUESTION_KIND_LABEL[k]}</Button>
          ))}
          {aiStatus?.aiEnabled && (
            <>
              <Button disabled={!ai.subject || !ai.className} onClick={() => setDrafting(true)}
                title={!ai.subject ? "Pick the class and subject first." : undefined}>Draft questions with Bloom</Button>
              <Button disabled={!ai.subject || !ai.className} onClick={() => setImporting(true)}
                title={!ai.subject ? "Pick the class and subject first." : undefined}>Import a paper with Bloom</Button>
            </>
          )}
        </div>
      )}
      {drafting && (
        <AiQuestionsModal
          subject={ai.subject}
          className={ai.className}
          kind={ai.kind}
          onClose={() => setDrafting(false)}
          onAdd={(drafts) => { onChange([...questions, ...drafts]); setDrafting(false); }}
        />
      )}
      {importing && (
        <AiPaperImportModal
          subject={ai.subject}
          className={ai.className}
          kind={ai.kind}
          hasQuestions={questions.length > 0}
          onClose={() => setImporting(false)}
          onImported={(draft, replace) => { onImport(draft, replace); setImporting(false); }}
        />
      )}
    </div>
  );
}
