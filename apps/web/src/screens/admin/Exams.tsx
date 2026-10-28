import { useState } from "react";
import { createExam, deleteExam, fetchCurrentTerm, fetchExamSummaries, renameExam, validateExamName, type ExamSummary } from "@figbloom/shared";
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
 */
export function Exams() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  // null: closed. { exam: undefined }: naming a new exam. { exam }: renaming it.
  const [editing, setEditing] = useState<{ exam?: ExamSummary } | null>(null);

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

  const term = data?.term ?? null;
  const exams = data?.exams ?? [];

  return (
    <>
      <PageHead
        eyebrow={term ? `Exams · ${term.name.toLowerCase()}` : "Exams"}
        title="Exams"
        blurb="Set up each exam once a term. Teachers then enter marks for their own classes in the Gradebook and publish each class and subject when they are ready: one teacher publishing never releases another teacher's marks."
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
              { key: "name", header: "Exam", width: "1.6fr", render: (e: ExamSummary) => <Cell sub={`Out of ${e.outOf}`}>{e.name}</Cell> },
              { key: "marks", header: "Marks entered", align: "right", render: (e: ExamSummary) => <Mono>{e.marksEntered.toLocaleString()}</Mono> },
              { key: "out", header: "Results out", align: "right", render: (e: ExamSummary) => (
                e.resultsOut > 0
                  ? <Badge tone="ok">{e.resultsOut} class{e.resultsOut === 1 ? "" : "es"} × subject{e.resultsOut === 1 ? "" : "s"}</Badge>
                  : <Badge tone="muted">Not published</Badge>
              ) },
              { key: "actions", header: "", align: "right", width: "1.2fr", render: (e: ExamSummary) => (
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setEditing({ exam: e })}>Rename</Button>
                  <Button
                    onClick={() => void remove(e)}
                    disabled={e.marksEntered > 0}
                    title={e.marksEntered > 0 ? "Marks have been entered, so this exam can't be deleted." : undefined}
                  >
                    Delete
                  </Button>
                </div>
              ) },
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
          onSave={async (name) => {
            if (editing.exam) await renameExam(editing.exam.id, name);
            else await createExam(tenant.id, term.id, name);
            toast(editing.exam ? `Renamed to "${name}"` : `"${name}" created. Teachers can enter marks for it now.`);
            setEditing(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </>
  );
}

function ExamNameModal({ exam, otherNames, onClose, onSave }: {
  exam?: ExamSummary;
  otherNames: string[];
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(exam?.name ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    const checked = validateExamName(name, otherNames);
    if (!checked.ok) { setError(checked.message); return; }
    setSaving(true);
    setError("");
    try {
      await onSave(checked.name);
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
      blurb={exam ? undefined : "Marked out of 100. Teachers enter marks for their own classes and publish them when they are ready."}
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
    </Modal>
  );
}
