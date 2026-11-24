import { useState } from "react";
import {
  actOnPapers, countPaperMarks, createExam, deleteExam, fetchCurrentTerm, fetchExamSetPapers, fetchExamSummaries, fetchGradesAccess, gradesCapabilities, renameExam, topUpExam,
  validateExamName, validateExamOutOf, type ExamSetPaper, type ExamSummary, type SetUpResult,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { confirmDialog } from "../../components/ui/Confirm";

/**
 * Where a term's exams are set up. Teachers enter marks for their own classes
 * in the Gradebook and publish each class and subject when they are ready, so
 * results go out teacher by teacher, not all at once.
 *
 * On the new system an exam is made of one paper for each class and subject that has a teacher, each out of the exam's total, and the
 * school office (the Academics area) publishes the papers from here: renaming and deleting an exam are not there yet.
 */
export function Exams() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const caps = gradesCapabilities();
  const { data: access } = useAsync(() => fetchGradesAccess(), [tenant.id]);
  const [reloadKey, setReloadKey] = useState(0);
  // null: closed. { exam: undefined }: naming a new exam. { exam }: renaming it.
  const [editing, setEditing] = useState<{ exam?: ExamSummary } | null>(null);
  const [papersOf, setPapersOf] = useState<ExamSummary | null>(null);

  const { data, loading, error } = useAsync(async () => {
    const term = await fetchCurrentTerm();
    return { term, exams: term ? await fetchExamSummaries(term.id) : [] };
  }, [tenant.id, reloadKey]);

  async function remove(exam: ExamSummary) {
    if (!(await confirmDialog({ title: `Delete "${exam.name}"?`, body: "Nothing has been entered for it yet.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await deleteExam(exam.id);
      toast(`"${exam.name}" deleted`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete the exam.", "error");
    }
  }

  async function topUp(exam: ExamSummary) {
    try {
      const done = await topUpExam(exam.id, exam.outOf);
      toast(done.made > 0
        ? `${done.made} new paper${done.made === 1 ? "" : "s"} set up for "${exam.name}"`
        : `"${exam.name}" already has a paper for every class and subject with a teacher`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the papers.", "error");
    }
    setReloadKey((k) => k + 1);
  }

  const term = data?.term ?? null;
  const exams = data?.exams ?? [];

  return (
    <>
      <PageHead
        eyebrow={term ? `Exams · ${term.name.toLowerCase()}` : "Exams"}
        title="Exams"
        blurb={caps.examPapers
          ? "Set up each exam once a term: it makes a paper for every class and subject that has a teacher. Teachers enter marks for their own classes in the Gradebook; the school office publishes each paper here when it is ready."
          : "Set up each exam once a term. Teachers then enter marks for their own classes in the Gradebook and publish each class and subject when they are ready: one teacher publishing never releases another teacher's marks."}
        actions={<Button variant="accent" disabled={!term} onClick={() => setEditing({})}>New exam</Button>}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load exams: {error.message}
          </p>
        ) : loading && !data ? (
          <TableSkeleton rows={4} />
        ) : !term ? (
          <div className="rounded-lg border border-line bg-white">
            <EmptyState title="No term is open" body="Open the current term in School settings first. Exams belong to a term." />
          </div>
        ) : exams.length === 0 ? (
          <div className="rounded-lg border border-line bg-white">
            <EmptyState
              title="No exams yet this term"
              body="Create the first one, for example Mock 1 or End of Term 3. Teachers can then enter marks for it."
              action={<Button variant="accent" onClick={() => setEditing({})}>New exam</Button>}
            />
          </div>
        ) : (
          <DataTable
            title={`${term.name} exams`}
            columns={[
              {
                key: "name", header: "Exam", width: "1.6fr",
                render: (e: ExamSummary) => <Cell sub={caps.examPapers ? `Out of ${e.outOf} · ${e.papers ?? 0} paper${e.papers === 1 ? "" : "s"}` : `Out of ${e.outOf}`}>{e.name}</Cell>,
              },
              ...(caps.examMarkCounts
                ? [{ key: "marks", header: "Marks entered", align: "right" as const, render: (e: ExamSummary) => <Mono>{e.marksEntered.toLocaleString()}</Mono> }]
                : []),
              {
                key: "out", header: "Results out", align: "right",
                render: (e: ExamSummary) => {
                  if (e.resultsOut === 0) return <Badge tone="muted">Not published</Badge>;
                  return caps.examPapers
                    ? <Badge tone="ok">{e.resultsOut} of {e.papers ?? 0} paper{e.papers === 1 ? "" : "s"}</Badge>
                    : <Badge tone="ok">{e.resultsOut} class{e.resultsOut === 1 ? "" : "es"} × subject{e.resultsOut === 1 ? "" : "s"}</Badge>;
                },
              },
              {
                key: "actions", header: "", align: "right", width: "1.6fr",
                render: (e: ExamSummary) => (
                  <div className="flex flex-wrap justify-end gap-2">
                    {caps.examPapers && <Button onClick={() => setPapersOf(e)}>Papers</Button>}
                    {caps.examPapers && <Button onClick={() => void topUp(e)}>Add new class subjects</Button>}
                    {caps.renameExam && <Button onClick={() => setEditing({ exam: e })}>Rename</Button>}
                    {caps.deleteExam && (
                      <Button
                        onClick={() => void remove(e)}
                        disabled={e.marksEntered > 0}
                        title={e.marksEntered > 0 ? "Marks have been entered, so this exam can't be deleted." : undefined}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={exams}
            rowKey={(e) => e.id}
            minWidth="640px"
            empty={{ title: "No exams yet this term", body: "Create the first one." }}
          />
        )}
      </div>

      {editing && term && (
        <ExamNameModal
          exam={editing.exam}
          otherNames={exams.filter((e) => e.id !== editing.exam?.id).map((e) => e.name)}
          onClose={() => setEditing(null)}
          onSave={async (name, outOf) => {
            if (editing.exam) {
              await renameExam(editing.exam.id, name);
              toast(`Renamed to "${name}"`);
            } else {
              const made = (await createExam(tenant.id, term.id, name, outOf)) as SetUpResult | undefined;
              toast(made
                ? `"${name}" created: ${made.made} paper${made.made === 1 ? "" : "s"}, one for each class and subject with a teacher. Teachers can enter marks for it now.`
                : `"${name}" created. Teachers can enter marks for it now.`);
            }
            setEditing(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
      {papersOf && (
        <PapersModal exam={papersOf} canPublish={access?.publish !== false} onClose={() => setPapersOf(null)} onChanged={() => setReloadKey((k) => k + 1)} />
      )}
    </>
  );
}

function ExamNameModal({ exam, otherNames, onClose, onSave }: {
  exam?: ExamSummary;
  otherNames: string[];
  onClose: () => void;
  onSave: (name: string, outOf: number) => Promise<void>;
}) {
  const caps = gradesCapabilities();
  const [name, setName] = useState(exam?.name ?? "");
  const [total, setTotal] = useState("100");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    const checked = validateExamName(name, otherNames);
    if (!checked.ok) { setError(checked.message); return; }
    // The paper's total is chosen on the new system only; Supabase exams are always out of 100.
    const out = caps.examPapers && !exam ? validateExamOutOf(total) : { ok: true as const, outOf: 100 };
    if (!out.ok) { setError(out.message); return; }
    setSaving(true);
    setError("");
    try {
      await onSave(checked.name, out.outOf);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Exams"
      title={exam ? `Rename ${exam.name}` : "New exam"}
      blurb={exam ? undefined : caps.examPapers
        ? "Makes a paper for every class and subject that has a teacher. Teachers enter marks for their own classes; the school office publishes them."
        : "Marked out of 100. Teachers enter marks for their own classes and publish them when they are ready."}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : exam ? "Rename" : "Create exam"}</Button>
        </>
      }
      width={480}
    >
      <TextField
        id="exam-name"
        label="Name"
        placeholder="e.g. Mock 1, End of Term 3"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
        error={error || undefined}
      />
      {caps.examPapers && !exam && (
        <div className="mt-3">
          <TextField
            id="exam-out-of"
            label="Marked out of"
            placeholder="100"
            inputMode="decimal"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
          />
        </div>
      )}
    </Modal>
  );
}

const STATUS_BADGE = { draft: ["muted", "Draft"], published: ["ok", "Published"], closed: ["muted", "Closed"] } as const;

/** New system only: one exam's papers (a class and subject each), the state each is in, and publishing or closing them. */
function PapersModal({ exam, canPublish, onClose, onChanged }: { exam: ExamSummary; canPublish: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const { data: papers, error } = useAsync(() => fetchExamSetPapers(exam.id), [exam.id, reload]);
  const { data: counts } = useAsync(
    () => (papers ? countPaperMarks(papers.map((p) => p.id)) : Promise.resolve(new Map<string, number>())),
    [papers],
  );

  async function act(action: "publish" | "close", targets: ExamSetPaper[]) {
    if (targets.length === 0) return;
    const empty = action === "publish" ? targets.filter((p) => (counts?.get(p.id) ?? 0) === 0).length : 0;
    const what = action === "publish" ? "Publish" : "Close";
    const ok = await confirmDialog({
      title: `${what} ${targets.length} paper${targets.length === 1 ? "" : "s"} of "${exam.name}"?`,
      body: action === "publish"
        ? `Their marks go out to learners and their parents, and a published paper cannot go back to draft.${empty > 0 ? ` ${empty} of them ${empty === 1 ? "has" : "have"} no marks yet.` : ""}`
        : "A closed paper takes no more changes, and cannot be opened again.",
      confirmLabel: what,
      danger: action === "publish" && empty > 0,
    });
    if (!ok) return;
    setBusy(true);
    const res = await actOnPapers(action, targets.map((p) => p.id));
    setBusy(false);
    setReload((k) => k + 1);
    onChanged();
    const past = action === "publish" ? "published" : "closed";
    if (res.failed === 0) toast(`${res.done} paper${res.done === 1 ? "" : "s"} ${past}`);
    else toast(`${res.done} of ${targets.length} papers ${past} (${res.failed} failed: ${res.firstError ?? "refused"})`, "error");
  }

  const drafts = (papers ?? []).filter((p) => p.status === "draft");
  const published = (papers ?? []).filter((p) => p.status === "published");
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Exams"
      title={`${exam.name} · papers`}
      blurb={`One paper for each class and subject, each out of ${exam.outOf}. Teachers enter the marks; publishing sends a paper's marks to learners and their parents.`}
      actions={
        <>
          <Button onClick={onClose}>Close</Button>
          {canPublish && <Button disabled={busy || drafts.length === 0} onClick={() => void act("publish", drafts)}>Publish all drafts</Button>}
          {canPublish && <Button disabled={busy || published.length === 0} onClick={() => void act("close", published)}>Close all published</Button>}
        </>
      }
      width={720}
    >
      {error ? (
        <p className="text-[12.5px] text-warn-ink">Could not load the papers: {error.message}</p>
      ) : !papers ? (
        <TableSkeleton rows={4} />
      ) : papers.length === 0 ? (
        <p className="text-[12.5px] text-ink-muted">This exam has no papers.</p>
      ) : (
        <div className="max-h-[360px] overflow-y-auto rounded-lg border border-line">
          <table className="w-full text-left text-[12.5px]">
            <thead className="sticky top-0 bg-sunken font-mono text-micro tracking-[0.1em] text-ink-muted">
              <tr><th className="px-3 py-2">CLASS</th><th className="px-3 py-2">SUBJECT</th><th className="px-3 py-2 text-right">MARKS</th><th className="px-3 py-2">STATUS</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody>
              {papers.map((p) => (
                <tr key={p.id} className="border-t border-line-soft">
                  <td className="px-3 py-2">{p.className}</td>
                  <td className="px-3 py-2">{p.subjectName}</td>
                  <td className="px-3 py-2 text-right font-mono">{counts ? counts.get(p.id) ?? "—" : "…"}</td>
                  <td className="px-3 py-2"><Badge tone={STATUS_BADGE[p.status][0]}>{STATUS_BADGE[p.status][1]}</Badge></td>
                  <td className="px-3 py-2 text-right">
                    {canPublish && p.status === "draft" && <Button disabled={busy} onClick={() => void act("publish", [p])}>Publish</Button>}
                    {canPublish && p.status === "published" && <Button disabled={busy} onClick={() => void act("close", [p])}>Close</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!canPublish && <p className="mt-3 text-[12.5px] text-ink-muted">Publishing needs the Academics area, which you do not have.</p>}
    </Modal>
  );
}
