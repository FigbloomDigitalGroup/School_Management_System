import { useEffect, useMemo, useRef, useState } from "react";
import {
  addNeed, createHomework, defaultGuide, deleteHomework, EMPTY_GUIDE, fetchAttachments, fetchClassSizes, fetchMyHomework,
  fetchTeacherClasses, fetchTeacherSubjectsForClass, formatShortDate, GUIDE_PLACEHOLDERS, guideToneFor, HAND_IN_OPTIONS,
  handedInLabel, isGuideEmpty, minutesWords, NEED_CHIPS, notifyHomeworkParents, removeAttachment, removeNeed, retoneGuide,
  updateHomework, validateHomework,
  type ClassGroup, type HandIn, type HomeworkInput, type HomeworkRow, type MediaItem, type ParentGuide,
} from "@figbloom/shared";
import { AttachmentPicker } from "../../components/AttachmentPicker";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { saveAttachments, UploadCancelled, type AttachmentBatch, type BatchProgress, type WebMediaDraft } from "../../lib/resumableUpload";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

/** Today as YYYY-MM-DD in the teacher's own timezone (toISOString alone would be UTC and a day behind after midnight in Nairobi). */
const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/**
 * Homework a teacher sets for a class and subject they teach. Learners see it
 * on their Work tab (their own class only) and mark it handed in; this screen
 * shows how many have. Each piece can carry a short "For parents" guide that
 * parents read on their Homework screen, and new work can be announced to
 * the class's parents in the same step. Worksheets, videos and links can be
 * attached; learners and parents open them from the homework itself.
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
    const [sizes, files] = await Promise.all([
      fetchClassSizes([...new Set(work.map((w) => w.classId))]),
      fetchAttachments("homework", work.map((w) => w.id)),
    ]);
    return { work, sizes, files };
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
  const fileCount = (id: string) => data?.files.get(id)?.length ?? 0;
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
              { key: "title", header: "Homework", width: "1.8fr", render: (w: HomeworkRow) => (
                <div className="flex items-start gap-2">
                  <Cell sub={w.body ? w.body.slice(0, 80) + (w.body.length > 80 ? "…" : "") : undefined}>{w.title}</Cell>
                  {!isGuideEmpty(w.guide) && <span title="Has a guide for parents"><Badge tone="info">Parent guide</Badge></span>}
                  {fileCount(w.id) > 0 && <Badge tone="muted">{fileCount(w.id)} attached</Badge>}
                </div>
              ) },
              { key: "class", header: "Class · subject", width: "1.2fr", render: (w: HomeworkRow) => <Cell sub={w.subjectName}>{w.className}</Cell> },
              { key: "due", header: "Due", render: (w: HomeworkRow) => (
                <div className="flex items-center gap-2">
                  <Mono>{formatShortDate(w.dueOn)}</Mono>
                  {w.dueOn < today ? <Badge tone="muted">Past due</Badge> : w.dueOn === today ? <Badge tone="warn">Due today</Badge> : null}
                </div>
              ) },
              { key: "in", header: "Handed in", align: "right", render: (w: HomeworkRow) => <Mono>{handedInLabel(w.handedIn, sizes[w.classId])}</Mono> },
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
          tenantId={tenant.id}
          today={today}
          onClose={() => { setEditing(null); setReloadKey((k) => k + 1); }}
          onDone={async (input, created, tell) => {
            if (!created) {
              toast("Homework updated");
            } else {
              // The homework is saved either way; a note that didn't send is reported, not treated as a failed save.
              const told = tell
                ? await notifyHomeworkParents(tenant.id, profile.id, input, tell.subjectName, tell.className).then(() => true, () => false)
                : null;
              if (told === false) toast("Homework set, but the note to parents didn't send. You can message them from Messages.", "error");
              else toast(told ? "Homework set. Learners can see it and parents have been told." : "Homework set. Learners in the class can see it now.");
            }
            setEditing(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </>
  );
}

function HomeworkModal({ work, classes, teacherId, tenantId, today, onClose, onDone }: {
  work?: HomeworkRow;
  classes: ClassGroup[];
  teacherId: string;
  tenantId: string;
  today: string;
  onClose: () => void;
  /** Everything is saved, files included. `tell` is set when the teacher ticked "Tell parents" on new homework. */
  onDone: (input: HomeworkInput, created: boolean, tell: { subjectName: string; className: string } | null) => Promise<void>;
}) {
  const [classId, setClassId] = useState(work?.classId ?? classes[0]?.id ?? "");
  const [subjectId, setSubjectId] = useState(work?.subjectId ?? "");
  const [title, setTitle] = useState(work?.title ?? "");
  const [body, setBody] = useState(work?.body ?? "");
  const [dueOn, setDueOn] = useState(work?.dueOn ?? "");
  const [handIn, setHandIn] = useState<HandIn>(work?.handIn ?? "paper");
  const cls = classes.find((c) => c.id === classId);
  const tone = guideToneFor(cls?.level, cls?.form_level ?? 0);
  // New work starts with help/avoid/time written for the class's age; existing work keeps exactly what was saved.
  const [guide, setGuide] = useState<ParentGuide>(() =>
    work ? (work.guide ?? { ...EMPTY_GUIDE, needs: [] }) : defaultGuide(cls?.level, cls?.form_level ?? 0));
  const [customNeed, setCustomNeed] = useState("");
  const [tellParents, setTellParents] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState<WebMediaDraft[]>([]);
  // Saved attachments taken off in the form: only removed when the teacher saves.
  const [removed, setRemoved] = useState<string[]>([]);
  // ...and the ones already gone, so a retry doesn't try to remove them twice.
  const gone = useRef(new Set<string>());
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const batch = useRef<AttachmentBatch | null>(null);
  // Set once new homework is created, so a retry after an upload fails updates it rather than setting it twice.
  const createdId = useRef<string | null>(null);

  const { data: saved } = useAsync(
    async () => (work ? (await fetchAttachments("homework", [work.id])).get(work.id) ?? [] : []),
    [work?.id],
  );
  const existing = (saved ?? []).filter((m) => !removed.includes(m.id));

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

  function pickClass(id: string) {
    const next = classes.find((c) => c.id === id);
    // Only help/avoid/time still holding the old class's wording change; anything typed stays.
    setGuide((g) => retoneGuide(g, tone, guideToneFor(next?.level, next?.form_level ?? 0)));
    setClassId(id);
  }

  function addCustomNeed() {
    setGuide((g) => ({ ...g, needs: addNeed(g.needs, customNeed) }));
    setCustomNeed("");
  }

  async function save() {
    const checked = validateHomework({ classId, subjectId, title, body, dueOn, handIn, guide }, today, { allowPast: !!work });
    if (!checked.ok) { setError(checked.message); return; }
    setSaving(true);
    setError("");
    let id = work?.id ?? createdId.current;
    try {
      if (id) await updateHomework(id, checked.value);
      else id = createdId.current = await createHomework(tenantId, teacherId, checked.value);
      for (const m of (saved ?? []).filter((x) => removed.includes(x.id) && !gone.current.has(x.id))) {
        await removeAttachment(m);
        gone.current.add(m.id);
      }
      if (drafts.length) {
        batch.current = saveAttachments(tenantId, "homework", id, drafts, setProgress,
          (d) => setDrafts((list) => list.filter((x) => x !== d)));
        await batch.current.done;
      }
      const subjectName = subjects?.find((s) => s.id === subjectId)?.name ?? "";
      await onDone(checked.value, !work, !work && tellParents ? { subjectName, className: cls?.name ?? "" } : null);
    } catch (err) {
      const why = err instanceof UploadCancelled ? "Upload cancelled." : err instanceof Error ? err.message : "Could not save.";
      // The homework itself is in by now if `id` is set; only the files are left.
      setError(id && drafts.length
        ? `${why} The homework is saved; the files still listed haven't been added${!work && tellParents ? " and parents haven't been told yet" : ""}. Save again to retry.`
        : why);
      setSaving(false);
    } finally {
      batch.current = null;
      setProgress(null);
    }
  }

  function removeSaved(m: MediaItem) {
    if (window.confirm(`Remove "${m.title}" from this homework? It goes when you save.`)) setRemoved((r) => [...r, m.id]);
  }

  /** Closing mid-upload stops the upload rather than leaving it running unseen. */
  function close() {
    if (batch.current && !window.confirm("Files are still uploading. Stop and close?")) return;
    batch.current?.cancel();
    onClose();
  }

  const noSubjects = subjects !== null && subjects.length === 0;

  return (
    <Modal
      open
      onClose={close}
      eyebrow="Homework"
      title={work ? "Edit homework" : "Set homework"}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="accent" disabled={saving || noSubjects} onClick={() => void save()}>{saving ? "Saving…" : work ? "Save changes" : "Set homework"}</Button>
        </>
      }
      width={560}
    >
      <div className="grid gap-3.5">
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <SelectField id="hw-class" label="Class" value={classId} onChange={(e) => pickClass(e.target.value)} options={classes.map((c) => ({ value: c.id, label: c.name }))} />
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

        <fieldset className="grid gap-3 rounded-lg border border-line-soft bg-page px-3.5 pb-3.5 pt-1">
          <legend className="px-1 text-small font-semibold">For parents</legend>
          <p className="text-[11.5px] leading-snug text-ink-faint">
            {tone === "sit_with"
              ? "Parents of young learners usually sit with them, so say how to help without doing it for them."
              : "Older learners work on their own. A line on what it's about and how long it takes is plenty."}
            {" "}Anything left blank just won't show.
          </p>
          <TextArea id="hw-about" label="What it's about" placeholder={GUIDE_PLACEHOLDERS[tone].about} value={guide.about} onChange={(e) => setGuide((g) => ({ ...g, about: e.target.value }))} />
          <div>
            <span className="mb-1.5 block text-small font-semibold">Your child will need</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Things the child needs">
              {[...NEED_CHIPS, ...guide.needs.filter((n) => !NEED_CHIPS.some((c) => c.toLowerCase() === n.toLowerCase()))].map((n) => {
                const on = guide.needs.some((x) => x.toLowerCase() === n.toLowerCase());
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setGuide((g) => ({ ...g, needs: on ? removeNeed(g.needs, n) : addNeed(g.needs, n) }))}
                    className="rounded-full px-2.5 py-1 text-[11.5px]"
                    style={on ? { background: "#17402A", color: "#fff", fontWeight: 600 } : { background: "#EEF1EE", color: "#5F6B62" }}
                  >
                    {on ? "✓ " : ""}{n}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                aria-label="Something else the child needs"
                placeholder="Something else, e.g. Old magazines"
                value={customNeed}
                onChange={(e) => setCustomNeed(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomNeed(); } }}
                className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none focus:border-forest"
              />
              <Button disabled={!customNeed.trim()} onClick={addCustomNeed}>Add</Button>
            </div>
          </div>
          <TextArea id="hw-help" label="How you can help" placeholder={GUIDE_PLACEHOLDERS[tone].help} value={guide.help} onChange={(e) => setGuide((g) => ({ ...g, help: e.target.value }))} />
          <TextArea id="hw-avoid" label="Please avoid" placeholder={GUIDE_PLACEHOLDERS[tone].avoid} value={guide.avoid} onChange={(e) => setGuide((g) => ({ ...g, avoid: e.target.value }))} />
          <TextField
            id="hw-minutes" label="Time it should take (minutes)" type="number" min={1} max={600} inputMode="numeric"
            value={guide.minutes ?? ""}
            onChange={(e) => setGuide((g) => ({ ...g, minutes: e.target.value === "" ? null : Number(e.target.value) }))}
            hint={minutesWords(guide.minutes) || "Optional."}
          />
        </fieldset>

        <AttachmentPicker
          drafts={drafts}
          onChange={setDrafts}
          existing={existing}
          onRemoveExisting={removeSaved}
          progress={progress}
          onCancel={() => batch.current?.cancel()}
          disabled={saving}
        />

        {!work && (
          <label className="flex items-start gap-2.5">
            <input type="checkbox" checked={tellParents} onChange={(e) => setTellParents(e.target.checked)} style={{ accentColor: "#17402A", marginTop: 3 }} />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">Tell parents</span>
              <span className="block text-[11.5px] leading-snug text-ink-faint">Sends the class's parents an in-app message with the due date and the guide above.</span>
            </span>
          </label>
        )}
        {error && (
          <p className="flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{error}</p>
        )}
      </div>
    </Modal>
  );
}
