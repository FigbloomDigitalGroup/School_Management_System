import { useEffect, useMemo, useState } from "react";
import {
  createHomework, deleteHomework, fetchClassSizes, fetchMyHomework, fetchTeacherClasses, fetchTeacherSubjectsForClass,
  formatShortDate, HAND_IN_OPTIONS, updateHomework, validateHomework,
  type HandIn, type HomeworkInput, type HomeworkRow,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

/** Today as YYYY-MM-DD in the teacher's own timezone (toISOString alone would be UTC and a day behind after midnight in Nairobi). */
const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/**
 * Homework a teacher sets for a class and subject they teach. Learners see it
 * on their Work tab (their own class only) and mark it handed in; this screen
 * shows how many have.
 */
export function Homework() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  // null: closed. { work: undefined }: a new one. { work }: editing it.
  const [editing, setEditing] = useState<{ work?: HomeworkRow } | null>(null);

  const { data: classes } = useAsync(() => fetchTeacherClasses(profile.id), [profile.id]);
  const { data, loading, error } = useAsync(async () => {
    const work = await fetchMyHomework(profile.id);
    const sizes = await fetchClassSizes([...new Set(work.map((w) => w.classId))]);
    return { work, sizes };
  }, [profile.id, reloadKey]);

  async function remove(w: HomeworkRow) {
    const extra = w.handedIn > 0 ? ` ${w.handedIn} learner${w.handedIn === 1 ? " has" : "s have"} marked it handed in; that goes with it.` : "";
    if (!window.confirm(`Delete "${w.title}" for ${w.className}?${extra}`)) return;
    try {
      await deleteHomework(w.id);
      toast("Homework deleted");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete the homework.", "error");
    }
  }

  const work = data?.work ?? [];
  const sizes = data?.sizes ?? {};
  const today = localToday();

  return (
    <>
      <PageHead
        eyebrow="Homework"
        title="Homework"
        blurb="Set work for a class and subject you teach. Learners in that class see it on their Work tab and mark it handed in."
        actions={<Button variant="accent" disabled={!classes?.length} onClick={() => setEditing({})}>Set homework</Button>}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load your homework: {error.message}
          </p>
        ) : loading && !data ? (
          <TableSkeleton rows={4} />
        ) : classes && classes.length === 0 ? (
          <div className="rounded-lg border border-line bg-white">
            <EmptyState title="No classes yet" body="You aren't assigned to any classes yet. Ask the school admin to add you to a class." />
          </div>
        ) : work.length === 0 ? (
          <div className="rounded-lg border border-line bg-white">
            <EmptyState
              title="No homework set yet"
              body="Set the first piece of work for one of your classes. Learners see it straight away."
              action={<Button variant="accent" onClick={() => setEditing({})}>Set homework</Button>}
            />
          </div>
        ) : (
          <DataTable
            title="Homework you've set"
            columns={[
              { key: "title", header: "Homework", width: "1.8fr", render: (w: HomeworkRow) => <Cell sub={w.body ? w.body.slice(0, 80) + (w.body.length > 80 ? "…" : "") : undefined}>{w.title}</Cell> },
              { key: "class", header: "Class · subject", width: "1.2fr", render: (w: HomeworkRow) => <Cell sub={w.subjectName}>{w.className}</Cell> },
              { key: "due", header: "Due", render: (w: HomeworkRow) => (
                <div className="flex items-center gap-2">
                  <Mono>{formatShortDate(w.dueOn)}</Mono>
                  {w.dueOn < today ? <Badge tone="muted">Past due</Badge> : w.dueOn === today ? <Badge tone="warn">Due today</Badge> : null}
                </div>
              ) },
              { key: "in", header: "Handed in", align: "right", render: (w: HomeworkRow) => <Mono>{w.handedIn} of {sizes[w.classId] ?? "?"}</Mono> },
              { key: "actions", header: "", align: "right", width: "1.1fr", render: (w: HomeworkRow) => (
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setEditing({ work: w })}>Edit</Button>
                  <Button onClick={() => void remove(w)}>Delete</Button>
                </div>
              ) },
            ]}
            rows={work}
            rowKey={(w) => w.id}
            minWidth="760px"
            empty={{ title: "No homework set yet", body: "Set the first piece of work." }}
          />
        )}
      </div>

      {editing && (
        <HomeworkModal
          work={editing.work}
          classes={classes ?? []}
          teacherId={profile.id}
          today={today}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            if (editing.work) await updateHomework(editing.work.id, input);
            else await createHomework(tenant.id, profile.id, input);
            toast(editing.work ? "Homework updated" : "Homework set. Learners in the class can see it now.");
            setEditing(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </>
  );
}

function HomeworkModal({ work, classes, teacherId, today, onClose, onSave }: {
  work?: HomeworkRow;
  classes: { id: string; name: string }[];
  teacherId: string;
  today: string;
  onClose: () => void;
  onSave: (input: HomeworkInput) => Promise<void>;
}) {
  const [classId, setClassId] = useState(work?.classId ?? classes[0]?.id ?? "");
  const [subjectId, setSubjectId] = useState(work?.subjectId ?? "");
  const [title, setTitle] = useState(work?.title ?? "");
  const [body, setBody] = useState(work?.body ?? "");
  const [dueOn, setDueOn] = useState(work?.dueOn ?? "");
  const [handIn, setHandIn] = useState<HandIn>(work?.handIn ?? "paper");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Subjects are per class: only the ones this teacher is assigned in the chosen class.
  const { data: subjectList } = useAsync(
    async () => ({ classId, list: classId ? await fetchTeacherSubjectsForClass(teacherId, classId) : [] }),
    [classId, teacherId],
  );
  const subjects = useMemo(() => (subjectList?.classId === classId ? subjectList.list : null), [subjectList, classId]);

  // Keep a valid subject selected as the class changes.
  useEffect(() => {
    if (!subjects) return;
    if (!subjects.some((s) => s.id === subjectId)) setSubjectId(subjects[0]?.id ?? "");
  }, [subjects, subjectId]);

  async function save() {
    const checked = validateHomework({ classId, subjectId, title, body, dueOn, handIn }, today, { allowPast: !!work });
    if (!checked.ok) { setError(checked.message); return; }
    setSaving(true);
    setError("");
    try {
      await onSave(checked.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }

  const noSubjects = subjects !== null && subjects.length === 0;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Homework"
      title={work ? "Edit homework" : "Set homework"}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={saving || noSubjects} onClick={() => void save()}>{saving ? "Saving…" : work ? "Save changes" : "Set homework"}</Button>
        </>
      }
      width={560}
    >
      <div className="grid gap-3.5">
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <SelectField id="hw-class" label="Class" value={classId} onChange={(e) => setClassId(e.target.value)} options={classes.map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField
            id="hw-subject" label="Subject" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}
            options={(subjects ?? []).map((s) => ({ value: s.id, label: s.name }))}
            hint={noSubjects ? "You aren't assigned a subject in this class. Ask the school admin." : undefined}
          />
        </div>
        <TextField id="hw-title" label="Title" placeholder="e.g. Exercise 4.2, page 61" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextArea id="hw-body" label="Instructions (optional)" placeholder="Anything learners need to know" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <TextField id="hw-due" label="Due date" type="date" min={work ? undefined : today} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          <SelectField
            id="hw-handin" label="How to hand in" value={handIn} onChange={(e) => setHandIn(e.target.value as HandIn)}
            options={HAND_IN_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            hint={HAND_IN_OPTIONS.find((o) => o.value === handIn)?.hint}
          />
        </div>
        {error && (
          <p className="flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{error}</p>
        )}
      </div>
    </Modal>
  );
}
