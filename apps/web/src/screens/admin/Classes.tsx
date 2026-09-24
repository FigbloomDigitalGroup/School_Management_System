import { useState, type FormEvent } from "react";
import { fetchClassTimetableSlots, saveClassTimetable, supabase } from "@figbloom/shared";
import type { ClassGroup, ClassLevel } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast, type ToastFn } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { TimetableEditor } from "./TimetableEditor";
import { SubjectsEditor } from "./SubjectsEditor";
import { PromoteClass } from "./PromoteClass";

interface TeacherOption { id: string; full_name: string }
interface SubjectOption { id: string; name: string }

interface ClassesData {
  classes: ClassGroup[];
  teachers: TeacherOption[];
  subjects: SubjectOption[];
  studentCountByClass: Map<string, number>;
}

async function fetchClasses(tenantId: string): Promise<ClassesData> {
  const sb = supabase();
  const [{ data: classRows, error: e1 }, { data: teacherRows, error: e2 }, { data: studentRows, error: e3 }, { data: subjectRows, error: e4 }] = await Promise.all([
    sb.from("classes").select("*").eq("tenant_id", tenantId).order("form_level").order("name").returns<ClassGroup[]>(),
    sb.from("profiles").select("id,full_name").eq("tenant_id", tenantId).eq("role", "teacher").order("full_name").returns<TeacherOption[]>(),
    sb.from("students").select("id,class_id").eq("tenant_id", tenantId).eq("active", true).returns<{ id: string; class_id: string }[]>(),
    sb.from("subjects").select("id,name").eq("tenant_id", tenantId).order("name").returns<SubjectOption[]>(),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  if (e4) throw e4;

  const studentCountByClass = new Map<string, number>();
  for (const s of studentRows ?? []) studentCountByClass.set(s.class_id, (studentCountByClass.get(s.class_id) ?? 0) + 1);

  return { classes: classRows ?? [], teachers: teacherRows ?? [], subjects: subjectRows ?? [], studentCountByClass };
}

// A class's own grading band (FIG-356) — independent of tenant.level, which
// only matters for a 'combined' tenant where individual classes differ from
// each other. The range and label ("Grade" vs "Form") both depend on it.
const FORM_LEVEL_RANGE_BY_LEVEL: Record<ClassLevel, number[]> = {
  primary: [1, 2, 3, 4, 5, 6],
  junior_secondary: [7, 8, 9],
  secondary: [1, 2, 3, 4],
};
const LEVEL_LABEL: Record<ClassLevel, string> = { primary: "Grade", junior_secondary: "Grade", secondary: "Form" };
const LEVEL_OPTION_LABEL: Record<ClassLevel, string> = { primary: "Primary", junior_secondary: "Junior secondary", secondary: "Secondary" };

/**
 * The list every other class-teacher assignment shortcut (TermSetup's
 * checklist, Gradebook, Attendance) assumes already exists — creating,
 * renaming, and retiring a class lives here, not scattered across term setup.
 */
export function AdminClasses() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const combined = tenant.level === "combined";
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchClasses(tenant.id), [tenant.id, reloadKey]);
  const [creating, setCreating] = useState(false);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [editingTimetableFor, setEditingTimetableFor] = useState<ClassGroup | null>(null);
  const [editingSubjectsFor, setEditingSubjectsFor] = useState<ClassGroup | null>(null);
  const [promotingFrom, setPromotingFrom] = useState<ClassGroup | null>(null);
  const reload = () => setReloadKey((k) => k + 1);

  async function setClassTeacher(classId: string, teacherId: string) {
    const { error: err } = await supabase().from("classes").update({ class_teacher_id: teacherId || null }).eq("id", classId);
    if (err) { toast(`Could not update the class teacher: ${err.message}`, "error"); return; }
    reload();
  }

  async function deleteClass(c: ClassGroup) {
    const count = data?.studentCountByClass.get(c.id) ?? 0;
    if (count > 0) { toast(`${c.name} has ${count} learner${count === 1 ? "" : "s"} on it — move them first.`, "error"); return; }
    if (!window.confirm(`Delete ${c.name}? This cannot be undone.`)) return;
    const { error: err } = await supabase().from("classes").delete().eq("id", c.id);
    if (err) { toast(`Could not delete ${c.name}: ${err.message}`, "error"); return; }
    toast(`${c.name} deleted.`);
    reload();
  }

  return (
    <>
      <PageHead
        eyebrow="School · classes"
        title="Classes"
        blurb={data ? `${data.classes.length} classes.` : "Loading classes…"}
        actions={
          <>
            <Button onClick={() => setBulkCreating(true)}>Bulk add</Button>
            <Button variant="accent" onClick={() => setCreating(true)}>Add class</Button>
          </>
        }
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load classes: {error.message}
          </p>
        ) : loading || !data ? (
          <TableSkeleton rows={8} />
        ) : (
          <DataTable
            columns={[
              { key: "name", header: "Class", width: "1.4fr", render: (c: ClassGroup) => <Cell sub={c.stream ?? undefined}>{c.name}</Cell> },
              ...(combined
                ? [{ key: "level", header: "Level", render: (c: ClassGroup) => <span className="text-[13px]">{LEVEL_OPTION_LABEL[c.level]}</span> }]
                : []),
              { key: "form", header: "Form", render: (c: ClassGroup) => <Mono>{c.form_level}</Mono> },
              { key: "room", header: "Room", render: (c: ClassGroup) => <span className="text-[13px]">{c.room ?? "—"}</span> },
              {
                key: "teacher", header: "Class teacher", width: "1.4fr",
                render: (c: ClassGroup) => (
                  <select
                    value={c.class_teacher_id ?? ""}
                    onChange={(e) => void setClassTeacher(c.id, e.target.value)}
                    aria-label={`Class teacher for ${c.name}`}
                    className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
                  >
                    <option value="">Unassigned</option>
                    {(data.teachers ?? []).map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                  </select>
                ),
              },
              {
                key: "learners", header: "Learners", align: "right",
                render: (c: ClassGroup) => <Mono>{data.studentCountByClass.get(c.id) ?? 0}</Mono>,
              },
              {
                key: "actions", header: "", align: "right", width: "2fr",
                render: (c: ClassGroup) => (
                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setPromotingFrom(c)}
                      className="text-[12px] font-semibold text-leaf hover:underline"
                    >
                      Promote
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingSubjectsFor(c)}
                      className="text-[12px] font-semibold text-leaf hover:underline"
                    >
                      Subjects
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingTimetableFor(c)}
                      className="text-[12px] font-semibold text-leaf hover:underline"
                    >
                      Timetable
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteClass(c)}
                      className="text-[12px] font-semibold text-warn-ink hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                ),
              },
            ]}
            rows={data.classes}
            rowKey={(c) => c.id}
            minWidth="980px"
            empty={{
              title: "No classes yet",
              body: "Add the school's first class to start assigning learners and teachers.",
              action: <Button variant="primary" onClick={() => setCreating(true)}>Add class</Button>,
            }}
          />
        )}
      </div>

      {creating && (
        <CreateClassModal
          teachers={data?.teachers ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); reload(); }}
          toast={toast}
        />
      )}

      {bulkCreating && (
        <BulkCreateClassesModal
          existingNames={new Set((data?.classes ?? []).map((c) => c.name.trim().toLowerCase()))}
          onClose={() => setBulkCreating(false)}
          onCreated={(count) => { setBulkCreating(false); reload(); toast(`${count} class${count === 1 ? "" : "es"} created.`); }}
          toast={toast}
        />
      )}

      {editingTimetableFor && (
        <TimetableEditor
          entityId={editingTimetableFor.id}
          title={editingTimetableFor.name}
          subjects={data?.subjects ?? []}
          fetchSlots={fetchClassTimetableSlots}
          saveSlots={(id, slots) => saveClassTimetable(tenant.id, id, slots)}
          onClose={() => setEditingTimetableFor(null)}
        />
      )}

      {editingSubjectsFor && (
        <SubjectsEditor
          classId={editingSubjectsFor.id}
          className={editingSubjectsFor.name}
          tenantId={tenant.id}
          formLevel={editingSubjectsFor.form_level}
          teachers={data?.teachers ?? []}
          onClose={() => setEditingSubjectsFor(null)}
        />
      )}

      {promotingFrom && data && (
        <PromoteClass
          sourceClass={promotingFrom}
          allClasses={data.classes}
          tenantId={tenant.id}
          authorId={profile.id}
          onClose={() => setPromotingFrom(null)}
          onDone={() => { setPromotingFrom(null); reload(); }}
        />
      )}
    </>
  );
}

/**
 * The single-class form doesn't scale past a couple of classes — a school
 * with four form levels times two streams each means typing "Form 1 North"
 * through "Form 4 South" by hand, eight times. This generates the whole
 * cross-product of form levels × stream names in one go, with a checklist
 * to drop any combination not actually needed before creating them.
 */
function BulkCreateClassesModal({ existingNames, onClose, onCreated, toast }: {
  existingNames: Set<string>;
  onClose: () => void;
  onCreated: (count: number) => void;
  toast: ToastFn;
}) {
  const { tenant } = useTenantSession();
  const combined = tenant.level === "combined";
  const [level, setLevel] = useState<ClassLevel>(tenant.level === "primary" ? "primary" : "secondary");
  const formRange = FORM_LEVEL_RANGE_BY_LEVEL[level];
  const [selectedForms, setSelectedForms] = useState<Set<number>>(new Set(formRange));
  const [streamsText, setStreamsText] = useState("");
  // A row's checked state is its default (checked, unless it already
  // exists) flipped once for every name in here — so an already-existing
  // class starts unticked without needing to seed that into state up front,
  // and toggling it back on (a genuine "yes, make a duplicate anyway") still works.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  function changeLevel(next: ClassLevel) {
    setLevel(next);
    setSelectedForms(new Set(FORM_LEVEL_RANGE_BY_LEVEL[next]));
    setToggled(new Set());
  }

  function toggleForm(f: number) {
    setSelectedForms((s) => {
      const next = new Set(s);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  }

  const streams = [...new Set(streamsText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];

  const rows = formRange
    .filter((f) => selectedForms.has(f))
    .flatMap((formLevel) => (streams.length ? streams : [null]).map((stream) => {
      const name = `${LEVEL_LABEL[level]} ${formLevel}${stream ? ` ${stream}` : ""}`;
      const already = existingNames.has(name.toLowerCase());
      const checked = toggled.has(name) ? already : !already;
      return { formLevel, stream, name, already, checked };
    }));

  const toCreate = rows.filter((r) => r.checked);

  async function createAll() {
    if (toCreate.length === 0) { toast("Pick at least one class to create.", "error"); return; }
    setSaving(true);
    try {
      const { error } = await supabase().from("classes").insert(
        toCreate.map((r) => ({
          tenant_id: tenant.id,
          name: r.name,
          level,
          form_level: r.formLevel,
          stream: r.stream,
          room: null,
          class_teacher_id: null,
        })),
      );
      if (error) throw error;
      onCreated(toCreate.length);
    } catch (err) {
      toast(err instanceof Error ? `Could not create those classes: ${err.message}` : "Could not create those classes.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Classes"
      title="Bulk add classes"
      blurb="Every form level crossed with every stream you list — untick anything you don't actually need."
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void createAll()} disabled={saving || toCreate.length === 0}>
            {saving ? "Creating…" : `Create ${toCreate.length} class${toCreate.length === 1 ? "" : "es"}`}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {combined && (
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Level</span>
            <select
              value={level}
              onChange={(e) => changeLevel(e.target.value as ClassLevel)}
              className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]"
            >
              {(Object.keys(LEVEL_OPTION_LABEL) as ClassLevel[]).map((l) => <option key={l} value={l}>{LEVEL_OPTION_LABEL[l]}</option>)}
            </select>
          </label>
        )}

        <div>
          <span className="mb-1.5 block text-[12.5px] font-semibold">{LEVEL_LABEL[level]} levels</span>
          <div className="flex flex-wrap gap-1.5">
            {formRange.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => toggleForm(f)}
                className="rounded-full border px-3 py-1.5 text-small"
                style={selectedForms.has(f)
                  ? { borderColor: "var(--accent)", background: "var(--accent)", color: "#fff", fontWeight: 600 }
                  : { borderColor: "#D3DAD5", background: "#fff", color: "#5F6B62" }}
              >
                {LEVEL_LABEL[level]} {f}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-semibold">Streams (optional)</span>
          <input
            value={streamsText}
            onChange={(e) => setStreamsText(e.target.value)}
            placeholder="e.g. North, South"
            className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
          />
          <span className="mt-1.5 block text-[11.5px] text-ink-faint">
            Comma-separated. One class per {LEVEL_LABEL[level].toLowerCase()} level for each stream — leave blank for
            one class per {LEVEL_LABEL[level].toLowerCase()} level, no stream.
          </span>
        </label>

        {rows.length > 0 && (
          <div className="rounded-lg border border-line-soft">
            <div className="max-h-[220px] overflow-y-auto">
              {rows.map((r) => (
                <label key={r.name} className="flex items-center gap-2.5 border-b border-line-soft px-3 py-2 last:border-0">
                  <input
                    type="checkbox"
                    checked={r.checked}
                    onChange={() => setToggled((s) => {
                      const next = new Set(s);
                      if (next.has(r.name)) next.delete(r.name); else next.add(r.name);
                      return next;
                    })}
                    style={{ accentColor: "#17402A" }}
                  />
                  <span className="flex-1 text-[13px]">{r.name}</span>
                  {r.already && <span className="text-[11px] text-ink-faint">already exists</span>}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function CreateClassModal({ teachers, onClose, onCreated, toast }: {
  teachers: TeacherOption[];
  onClose: () => void;
  onCreated: () => void;
  toast: ToastFn;
}) {
  const { tenant } = useTenantSession();
  const combined = tenant.level === "combined";
  // A non-combined tenant's classes always match the tenant's own level —
  // no reason to make every admin think about a field that's never anything
  // else. tenant.level's 'primary'/'secondary' map directly onto ClassLevel;
  // 'combined' has no ClassLevel equivalent, so it only ever reaches here as
  // the picker's starting point, never as the stored value.
  const [level, setLevel] = useState<ClassLevel>(tenant.level === "primary" ? "primary" : "secondary");
  const [name, setName] = useState("");
  const [formLevel, setFormLevel] = useState<number>(FORM_LEVEL_RANGE_BY_LEVEL[level][0]!);
  const [stream, setStream] = useState("");
  const [room, setRoom] = useState("");
  const [classTeacherId, setClassTeacherId] = useState("");
  const [saving, setSaving] = useState(false);

  function changeLevel(next: ClassLevel) {
    setLevel(next);
    setFormLevel(FORM_LEVEL_RANGE_BY_LEVEL[next][0]!);
  }

  async function createClass() {
    if (!name.trim()) { toast("Give the class a name.", "error"); return; }
    setSaving(true);
    try {
      const { error } = await supabase().from("classes").insert({
        tenant_id: tenant.id,
        name: name.trim(),
        level,
        form_level: formLevel,
        stream: stream.trim() || null,
        room: room.trim() || null,
        class_teacher_id: classTeacherId || null,
      });
      if (error) throw error;
      toast(`${name.trim()} created.`);
      onCreated();
    } catch (err) {
      toast(err instanceof Error ? `Could not create the class: ${err.message}` : "Could not create the class.", "error");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void createClass();
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Classes"
      title="Add a class"
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void createClass()} disabled={saving}>
            {saving ? "Creating…" : "Create class"}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="grid gap-3">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-semibold">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Form 2 East"
            autoFocus
            className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
          />
        </label>
        {combined && (
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Level</span>
            <select
              value={level}
              onChange={(e) => changeLevel(e.target.value as ClassLevel)}
              className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]"
            >
              {(Object.keys(LEVEL_OPTION_LABEL) as ClassLevel[]).map((l) => <option key={l} value={l}>{LEVEL_OPTION_LABEL[l]}</option>)}
            </select>
          </label>
        )}
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">{LEVEL_LABEL[level]}</span>
            <select
              value={formLevel}
              onChange={(e) => setFormLevel(Number(e.target.value))}
              className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]"
            >
              {FORM_LEVEL_RANGE_BY_LEVEL[level].map((f) => <option key={f} value={f}>{LEVEL_LABEL[level]} {f}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Stream (optional)</span>
            <input
              value={stream}
              onChange={(e) => setStream(e.target.value)}
              placeholder="e.g. East"
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
            />
          </label>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Room (optional)</span>
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="e.g. Block C-2"
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Class teacher (optional)</span>
            <select
              value={classTeacherId}
              onChange={(e) => setClassTeacherId(e.target.value)}
              className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]"
            >
              <option value="">Unassigned</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
            </select>
          </label>
        </div>
      </form>
    </Modal>
  );
}
