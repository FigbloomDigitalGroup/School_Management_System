import { useState, type FormEvent } from "react";
import { supabase } from "@figbloom/shared";
import type { ClassGroup } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

interface TeacherOption { id: string; full_name: string }

interface ClassesData {
  classes: ClassGroup[];
  teachers: TeacherOption[];
  studentCountByClass: Map<string, number>;
}

async function fetchClasses(): Promise<ClassesData> {
  const sb = supabase();
  const [{ data: classRows, error: e1 }, { data: teacherRows, error: e2 }, { data: studentRows, error: e3 }] = await Promise.all([
    sb.from("classes").select("*").order("form_level").order("name").returns<ClassGroup[]>(),
    sb.from("profiles").select("id,full_name").eq("role", "teacher").order("full_name").returns<TeacherOption[]>(),
    sb.from("students").select("id,class_id").eq("active", true).returns<{ id: string; class_id: string }[]>(),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;

  const studentCountByClass = new Map<string, number>();
  for (const s of studentRows ?? []) studentCountByClass.set(s.class_id, (studentCountByClass.get(s.class_id) ?? 0) + 1);

  return { classes: classRows ?? [], teachers: teacherRows ?? [], studentCountByClass };
}

const FORM_LEVELS = [1, 2, 3, 4] as const;

/**
 * The list every other class-teacher assignment shortcut (TermSetup's
 * checklist, Gradebook, Attendance) assumes already exists — creating,
 * renaming, and retiring a class lives here, not scattered across term setup.
 */
export function AdminClasses() {
  const toast = useToast();
  useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchClasses(), [reloadKey]);
  const [creating, setCreating] = useState(false);
  const reload = () => setReloadKey((k) => k + 1);

  async function setClassTeacher(classId: string, teacherId: string) {
    const { error: err } = await supabase().from("classes").update({ class_teacher_id: teacherId || null }).eq("id", classId);
    if (err) { toast(`Could not update the class teacher: ${err.message}`); return; }
    reload();
  }

  async function deleteClass(c: ClassGroup) {
    const count = data?.studentCountByClass.get(c.id) ?? 0;
    if (count > 0) { toast(`${c.name} has ${count} learner${count === 1 ? "" : "s"} on it — move them first.`); return; }
    if (!window.confirm(`Delete ${c.name}? This cannot be undone.`)) return;
    const { error: err } = await supabase().from("classes").delete().eq("id", c.id);
    if (err) { toast(`Could not delete ${c.name}: ${err.message}`); return; }
    toast(`${c.name} deleted.`);
    reload();
  }

  return (
    <>
      <PageHead
        eyebrow="School · classes"
        title="Classes"
        blurb={data ? `${data.classes.length} classes across Forms ${FORM_LEVELS[0]}–${FORM_LEVELS.at(-1)}.` : "Loading classes…"}
        actions={<Button variant="accent" onClick={() => setCreating(true)}>Add class</Button>}
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
                key: "actions", header: "", align: "right", width: "0.6fr",
                render: (c: ClassGroup) => (
                  <button
                    type="button"
                    onClick={() => void deleteClass(c)}
                    className="text-[12px] font-semibold text-warn-ink hover:underline"
                  >
                    Delete
                  </button>
                ),
              },
            ]}
            rows={data.classes}
            rowKey={(c) => c.id}
            minWidth="820px"
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
    </>
  );
}

function CreateClassModal({ teachers, onClose, onCreated, toast }: {
  teachers: TeacherOption[];
  onClose: () => void;
  onCreated: () => void;
  toast: (m: string) => void;
}) {
  const { tenant } = useTenantSession();
  const [name, setName] = useState("");
  const [formLevel, setFormLevel] = useState<number>(1);
  const [stream, setStream] = useState("");
  const [room, setRoom] = useState("");
  const [classTeacherId, setClassTeacherId] = useState("");
  const [saving, setSaving] = useState(false);

  async function createClass() {
    if (!name.trim()) { toast("Give the class a name."); return; }
    setSaving(true);
    try {
      const { error } = await supabase().from("classes").insert({
        tenant_id: tenant.id,
        name: name.trim(),
        form_level: formLevel,
        stream: stream.trim() || null,
        room: room.trim() || null,
        class_teacher_id: classTeacherId || null,
      });
      if (error) throw error;
      toast(`${name.trim()} created.`);
      onCreated();
    } catch (err) {
      toast(err instanceof Error ? `Could not create the class: ${err.message}` : "Could not create the class.");
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
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Form</span>
            <select
              value={formLevel}
              onChange={(e) => setFormLevel(Number(e.target.value))}
              className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]"
            >
              {FORM_LEVELS.map((f) => <option key={f} value={f}>Form {f}</option>)}
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
