import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { supabase } from "@figbloom/shared";
import type { ClassGroup, Profile, Student, Subject } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge, RoleBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { listStudentDocuments, privateDocUrl, uploadAvatar, uploadStudentDocument, type StudentDocument } from "../../lib/uploads";
import { downloadCsvTemplate, importStudents, parseStudentCsv, type ImportRow } from "../../lib/studentImport";
import { inviteStaff, provisionGuardian, type InviteStaffResult, type ProvisionGuardianResult } from "../../lib/platformAdmin";

type StudentRow = Pick<Student, "id" | "admission_no" | "full_name" | "class_id" | "boarding"> & { avatar_url: string | null };
type StaffRow = Pick<Profile, "id" | "full_name" | "role" | "staff_title" | "email" | "phone" | "login_id"> & { avatar_url: string | null };

const DOC_TYPES: { value: string; label: string }[] = [
  { value: "birth_certificate", label: "Birth certificate" },
  { value: "kcpe_certificate", label: "KCPE certificate" },
  { value: "medical_form", label: "Medical form" },
  { value: "transfer_letter", label: "Transfer letter" },
  { value: "other", label: "Other" },
];

const AVATAR_TONES = [
  { bg: "#E3EFE7", ink: "#1B4D2E" },
  { bg: "#FDECD8", ink: "#8A4B12" },
  { bg: "#E7E9FB", ink: "#3B3F8C" },
  { bg: "#FBE7EC", ink: "#8C2F49" },
  { bg: "#E7F6FB", ink: "#175C74" },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function toneFor(id: string): { bg: string; ink: string } {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length]!;
}

/** A photo if one's set, else the initials-in-a-colored-box placeholder used across the console. */
function Avatar({ id, name, url, size = 30 }: { id: string; name: string; url?: string | null; size?: number }) {
  if (url) {
    return <img src={url} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  const { bg, ink } = toneFor(id);
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full font-bold"
      style={{ width: size, height: size, background: bg, color: ink, fontSize: Math.round(size * 0.4) }}
    >
      {initialsOf(name)}
    </span>
  );
}

interface PeopleData {
  classes: Pick<ClassGroup, "id" | "name">[];
  students: StudentRow[];
  staff: StaffRow[];
  feeByStudent: Map<string, { total: number; paid: number }>;
  subjects: Subject[];
  subjectIdsByTeacher: Map<string, string[]>;
}

async function fetchPeople(): Promise<PeopleData> {
  const sb = supabase();
  const { data: term } = await sb.from("terms").select("id").eq("is_current", true).maybeSingle<{ id: string }>();

  const [{ data: classRows }, { data: studentRows }, { data: staffRows }, invoicesRes, { data: subjectRows }, { data: teacherSubjectRows }] = await Promise.all([
    sb.from("classes").select("id,name").order("name").returns<Pick<ClassGroup, "id" | "name">[]>(),
    sb.from("students").select("id,admission_no,full_name,class_id,boarding,avatar_url").eq("active", true).order("full_name").returns<StudentRow[]>(),
    sb.from("profiles").select("id,full_name,role,staff_title,email,phone,login_id,avatar_url").in("role", ["school_admin", "teacher", "driver"]).order("full_name").returns<StaffRow[]>(),
    term
      ? sb.from("fee_invoices").select("student_id,total_cents,paid_cents").eq("term_id", term.id).returns<{ student_id: string; total_cents: number; paid_cents: number }[]>()
      : Promise.resolve({ data: [] as { student_id: string; total_cents: number; paid_cents: number }[] }),
    sb.from("subjects").select("*").order("name").returns<Subject[]>(),
    sb.from("teacher_subjects").select("teacher_id, subject_id").returns<{ teacher_id: string; subject_id: string }[]>(),
  ]);

  const feeByStudent = new Map<string, { total: number; paid: number }>();
  for (const inv of invoicesRes.data ?? []) feeByStudent.set(inv.student_id, { total: inv.total_cents, paid: inv.paid_cents });

  const subjectIdsByTeacher = new Map<string, string[]>();
  for (const row of teacherSubjectRows ?? []) {
    const ids = subjectIdsByTeacher.get(row.teacher_id) ?? [];
    ids.push(row.subject_id);
    subjectIdsByTeacher.set(row.teacher_id, ids);
  }

  return {
    classes: classRows ?? [],
    students: studentRows ?? [],
    staff: staffRows ?? [],
    feeByStudent,
    subjects: subjectRows ?? [],
    subjectIdsByTeacher,
  };
}

/**
 * Bulk actions matter more than search here — an admin's real job is moving
 * forty learners at once, not finding one. Selection is sticky across filtering
 * so a class change can be built up in two passes.
 */
export function People() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [tab, setTab] = useState<"students" | "staff">("students");
  const [query, setQuery] = useState("");
  const [classId, setClassId] = useState("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [manage, setManage] = useState<{ kind: "students" | "staff"; row: StudentRow | StaffRow } | null>(null);
  const [avatarOverrides, setAvatarOverrides] = useState<Record<string, string>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addStaffOpen, setAddStaffOpen] = useState(false);
  const [inviteGuardiansOpen, setInviteGuardiansOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const { data, loading, error } = useAsync(() => fetchPeople(), [reloadKey]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.students ?? [])
      .filter((s) => classId === "all" || s.class_id === classId)
      .filter((s) => !q || s.full_name.toLowerCase().includes(q) || s.admission_no.includes(q))
      .slice(0, 60);
  }, [data, query, classId]);

  const staffRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.staff ?? []).filter((s) => !q || s.full_name.toLowerCase().includes(q));
  }, [data, query]);

  const classesById = useMemo(() => new Map((data?.classes ?? []).map((c) => [c.id, c.name])), [data]);
  const subjectsById = useMemo(() => new Map((data?.subjects ?? []).map((s) => [s.id, s])), [data]);

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const switchTab = (t: "students" | "staff") => { setTab(t); setPicked(new Set()); };

  const openManage = (kind: "students" | "staff", row: StudentRow | StaffRow) => setManage({ kind, row });

  return (
    <>
      <PageHead
        eyebrow="School · people"
        title="Students & staff"
        blurb={
          data
            ? `${data.students.length.toLocaleString()} learners and ${data.staff.length.toLocaleString()} staff. Import from a spreadsheet at the start of a term; after that, add one at a time.`
            : "Loading the roster…"
        }
        actions={
          tab === "students" ? (
            <>
              <Button onClick={() => setImportOpen(true)}>Import from CSV</Button>
              <Button variant="accent" onClick={() => setAddOpen(true)}>Add a learner</Button>
            </>
          ) : (
            <Button variant="accent" onClick={() => setAddStaffOpen(true)}>+ Add staff</Button>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-7 py-3">
        <div className="flex rounded-md border border-[#D3DAD5] bg-white p-0.5">
          {(["students", "staff"] as const).map((t) => (
            <button key={t} onClick={() => switchTab(t)} className="rounded px-3 py-1.5 text-small capitalize"
              style={tab === t ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
              {t}
            </button>
          ))}
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or admission number"
          aria-label="Search people"
          className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small outline-none" />
        {tab === "students" && (
          <select value={classId} onChange={(e) => setClassId(e.target.value)} aria-label="Class"
            className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
            <option value="all">Every class</option>
            {(data?.classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          {loading ? "…" : `${tab === "students" ? rows.length : staffRows.length} shown`}
        </span>
      </div>

      {tab === "students" && picked.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-sunken px-7 py-2.5">
          <span className="text-small font-semibold">{picked.size} selected</span>
          <Button onClick={() => toast(`Moved ${picked.size} learners to another class`)}>Change class</Button>
          <Button onClick={() => setInviteGuardiansOpen(true)}>Invite guardians</Button>
          <Button onClick={() => toast(`Exported ${picked.size} records`)}>Export</Button>
          <button onClick={() => setPicked(new Set())} className="text-small font-semibold text-leaf">Clear</button>
        </div>
      )}

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load people: {error.message}
          </p>
        ) : loading || !data ? (
          <TableSkeleton rows={8} />
        ) : tab === "students" ? (
          <DataTable
            columns={[
              {
                key: "pick", header: "", width: "40px",
                render: (s) => (
                  <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${s.full_name}`} style={{ accentColor: "#17402A" }} />
                ),
              },
              { key: "name", header: "Learner", width: "1.8fr", render: (s) => (
                <div className="flex items-center gap-2.5">
                  <Avatar id={s.id} name={s.full_name} url={avatarOverrides[s.id] ?? s.avatar_url} />
                  <Cell sub={`ADM ${s.admission_no}`}>{s.full_name}</Cell>
                </div>
              ) },
              { key: "class", header: "Class", render: (s) => <span className="text-[13px]">{s.class_id ? classesById.get(s.class_id) : "—"}</span> },
              { key: "board", header: "Residence", render: (s) => <Badge tone="muted">{s.boarding ? "Boarder" : "Day"}</Badge> },
              { key: "guardian", header: "Guardian", width: "1.2fr", render: () => <Mono>+254 7·· ··· ···</Mono> },
              { key: "fees", header: "Fees", align: "right", render: (s) => {
                const inv = data.feeByStudent.get(s.id);
                if (!inv) return <Badge tone="muted">No invoice</Badge>;
                const owes = inv.paid < inv.total;
                return <Badge tone={owes ? "warn" : "ok"}>{owes ? "Balance due" : "Cleared"}</Badge>;
              } },
            ]}
            rows={rows}
            rowKey={(s) => s.id}
            onRowClick={(s) => openManage("students", s)}
            minWidth="880px"
            empty={{
              title: "No learner matches that",
              body: "Try the admission number instead. If they were admitted this week, an import may still be running.",
              action: <Button variant="primary" onClick={() => setAddOpen(true)}>Add a learner</Button>,
            }}
          />
        ) : (
          <DataTable
            columns={[
              { key: "name", header: "Staff", width: "1.8fr", render: (s: StaffRow) => (
                <div className="flex items-center gap-2.5">
                  <Avatar id={s.id} name={s.full_name} url={avatarOverrides[s.id] ?? s.avatar_url} />
                  <Cell sub={s.staff_title ?? undefined}>{s.full_name}</Cell>
                </div>
              ) },
              { key: "role", header: "Role", render: (s: StaffRow) => <RoleBadge role={s.role} tenant={tenant} /> },
              {
                key: "subjects", header: "Subjects", width: "1.4fr",
                render: (s: StaffRow) => {
                  if (s.role !== "teacher") return <span className="text-[12.5px] text-ink-faint">—</span>;
                  const names = (data.subjectIdsByTeacher.get(s.id) ?? [])
                    .map((id) => subjectsById.get(id)?.name)
                    .filter((n): n is string => Boolean(n));
                  return names.length
                    ? <span className="text-[13px]">{names.join(", ")}</span>
                    : <span className="text-[12.5px] text-ink-faint">None set</span>;
                },
              },
              { key: "login", header: "Login", width: "1.2fr", render: (s: StaffRow) => <Mono>{s.login_id ?? s.email ?? "—"}</Mono> },
              { key: "phone", header: "Phone", render: (s: StaffRow) => <Mono>{s.phone ?? "—"}</Mono> },
            ]}
            rows={staffRows}
            rowKey={(s) => s.id}
            onRowClick={(s) => openManage("staff", s)}
            minWidth="920px"
            empty={{
              title: "No staff match that",
              body: "Admins and teachers appear here once their accounts are created.",
            }}
          />
        )}
      </div>

      {manage && (
        <Modal
          key={manage.row.id}
          open
          onClose={() => setManage(null)}
          eyebrow={manage.kind === "students" ? "Learner" : "Staff"}
          title={`Manage ${manage.row.full_name}`}
          blurb={manage.kind === "students" ? "Details, photo, and records for this learner." : "Details and photo for this staff member."}
          actions={<Button variant="primary" onClick={() => setManage(null)}>Done</Button>}
        >
          {manage.kind === "students" ? (
            <StudentProfileEditor
              student={manage.row as StudentRow}
              classes={data?.classes ?? []}
              onSaved={() => setReloadKey((k) => k + 1)}
              toast={toast}
            />
          ) : (
            <StaffProfileEditor
              staff={manage.row as StaffRow}
              onSaved={() => setReloadKey((k) => k + 1)}
              toast={toast}
            />
          )}
          <AvatarEditor
            id={manage.row.id}
            name={manage.row.full_name}
            kind={manage.kind}
            tenantId={tenant.id}
            url={avatarOverrides[manage.row.id] ?? manage.row.avatar_url}
            onUploaded={(url) => setAvatarOverrides((m) => ({ ...m, [manage.row.id]: url }))}
            toast={toast}
          />
          {manage.kind === "students" && (
            <StudentDocuments tenantId={tenant.id} uploaderId={profile.id} studentId={manage.row.id} toast={toast} />
          )}
          {manage.kind === "staff" && (manage.row as StaffRow).role === "teacher" && data && (
            <TeacherSubjectsEditor
              teacherId={manage.row.id}
              tenantId={tenant.id}
              subjects={data.subjects}
              selectedIds={new Set(data.subjectIdsByTeacher.get(manage.row.id) ?? [])}
              onChange={() => setReloadKey((k) => k + 1)}
              toast={toast}
            />
          )}
        </Modal>
      )}

      {addOpen && data && (
        <AddStudentModal
          tenantId={tenant.id}
          classes={data.classes}
          existingAdmissionNos={new Set(data.students.map((s) => s.admission_no))}
          onClose={() => setAddOpen(false)}
          onAdded={(name) => {
            setAddOpen(false);
            setReloadKey((k) => k + 1);
            toast(`${name} added.`);
          }}
          toast={toast}
        />
      )}

      {importOpen && data && (
        <ImportStudentsModal
          tenantId={tenant.id}
          classes={data.classes}
          existingAdmissionNos={new Set(data.students.map((s) => s.admission_no))}
          onClose={() => setImportOpen(false)}
          onImported={(count) => {
            setImportOpen(false);
            setReloadKey((k) => k + 1);
            toast(`Imported ${count} learner${count === 1 ? "" : "s"}.`);
          }}
          toast={toast}
        />
      )}

      {addStaffOpen && (
        <AddStaffModal
          tenantId={tenant.id}
          onClose={() => setAddStaffOpen(false)}
          onAdded={() => setReloadKey((k) => k + 1)}
          toast={toast}
        />
      )}

      {inviteGuardiansOpen && data && (
        <InviteGuardiansModal
          tenantId={tenant.id}
          students={data.students.filter((s) => picked.has(s.id)).map((s) => ({ id: s.id, name: s.full_name }))}
          onClose={() => setInviteGuardiansOpen(false)}
          onInvited={() => { setPicked(new Set()); setReloadKey((k) => k + 1); }}
          toast={toast}
        />
      )}
    </>
  );
}

function AddStudentModal({ tenantId, classes, existingAdmissionNos, onClose, onAdded, toast }: {
  tenantId: string;
  classes: Pick<ClassGroup, "id" | "name">[];
  existingAdmissionNos: Set<string>;
  onClose: () => void;
  onAdded: (name: string) => void;
  toast: (m: string) => void;
}) {
  const [admissionNo, setAdmissionNo] = useState("");
  const [fullName, setFullName] = useState("");
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [boarding, setBoarding] = useState(false);
  const [dob, setDob] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!admissionNo.trim() || !fullName.trim() || !classId) {
      toast("Admission number, name and class are all required.");
      return;
    }
    if (existingAdmissionNos.has(admissionNo.trim())) {
      toast(`Admission ${admissionNo.trim()} is already on the roster.`);
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase().from("students").insert({
        tenant_id: tenantId,
        admission_no: admissionNo.trim(),
        full_name: fullName.trim(),
        class_id: classId,
        boarding,
        date_of_birth: dob || null,
        active: true,
      });
      if (error) throw error;
      onAdded(fullName.trim());
    } catch (err) {
      toast(err instanceof Error ? `Could not add the learner: ${err.message}` : "Could not add the learner.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Students"
      title="Add a learner"
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void handleAdd()} disabled={saving}>
            {saving ? "Adding…" : "Add learner"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Admission number</span>
            <input
              value={admissionNo}
              onChange={(e) => setAdmissionNo(e.target.value)}
              placeholder="e.g. 4501"
              autoFocus
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Class</span>
            <select
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]"
            >
              {classes.length === 0 && <option value="">No classes yet</option>}
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-semibold">Full name</span>
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="e.g. Wanjiku Kamau"
            className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
          />
        </label>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Date of birth (optional)</span>
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
            />
          </label>
          <label className="mt-6 flex items-center gap-2">
            <input type="checkbox" checked={boarding} onChange={(e) => setBoarding(e.target.checked)} style={{ accentColor: "#17402A" }} />
            <span className="text-[13px]">Boarder</span>
          </label>
        </div>
      </div>
    </Modal>
  );
}

function ImportStudentsModal({ tenantId, classes, existingAdmissionNos, onClose, onImported, toast }: {
  tenantId: string;
  classes: Pick<ClassGroup, "id" | "name">[];
  existingAdmissionNos: Set<string>;
  onClose: () => void;
  onImported: (count: number) => void;
  toast: (m: string) => void;
}) {
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);

  const classIdByName = useMemo(
    () => new Map(classes.map((c) => [c.name.trim().toLowerCase(), c.id])),
    [classes],
  );

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setRows(parseStudentCsv(text, { classIdByName, existingAdmissionNos }));
    };
    reader.readAsText(file);
  }

  const validCount = rows?.filter((r) => r.errors.length === 0).length ?? 0;
  const errorCount = (rows?.length ?? 0) - validCount;

  async function handleImport() {
    if (!rows) return;
    setImporting(true);
    try {
      const count = await importStudents(tenantId, classIdByName, rows);
      onImported(count);
    } catch (err) {
      toast(err instanceof Error ? `Import failed: ${err.message}` : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Students"
      title="Import from CSV"
      blurb="Columns: admission_no, full_name, class, boarding, date_of_birth. Class must match one of this school's existing classes."
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void handleImport()} disabled={!rows || validCount === 0 || importing}>
            {importing ? "Importing…" : `Import ${validCount || ""} learner${validCount === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={downloadCsvTemplate}>Download template</Button>
          <label className="text-small font-medium text-leaf">
            <span className="hit inline-block cursor-pointer rounded-md border border-[#D3DAD5] bg-white px-3 py-1.5 hover:bg-page">
              {fileName || "Choose CSV file"}
            </span>
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} aria-label="CSV file" />
          </label>
        </div>

        {rows && (
          <>
            <p className="text-[12.5px] text-ink-muted">
              {validCount} of {rows.length} row{rows.length === 1 ? "" : "s"} ready to import
              {errorCount > 0 ? ` · ${errorCount} need fixing (fix the file and re-upload)` : ""}.
            </p>
            <div className="max-h-[320px] overflow-y-auto rounded-lg border border-line">
              {rows.map((r) => (
                <div key={r.line} className="flex items-start gap-3 border-b border-line-soft px-3 py-2 last:border-0">
                  <span className="w-8 shrink-0 font-mono text-[11px] text-ink-faint">L{r.line}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium">
                      {r.full_name || "—"} <span className="text-ink-faint">· ADM {r.admission_no || "—"} · {r.className || "—"}</span>
                    </div>
                    {r.errors.length > 0 && (
                      <ul className="mt-0.5 text-[11.5px] leading-relaxed text-warn-ink">
                        {r.errors.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    )}
                  </div>
                  <Badge tone={r.errors.length === 0 ? "ok" : "warn"}>{r.errors.length === 0 ? "Ready" : "Fix"}</Badge>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

const STAFF_ROLE_OPTIONS = [
  { value: "teacher", label: "Teacher" },
  { value: "driver", label: "Driver" },
];

/** Adds a teacher or driver (FIG-398/400) — no email, an assigned login_id
 *  (e.g. "TC-0001") instead, shown once on success the same way every other
 *  credential-reveal modal in this app works. */
function AddStaffModal({ tenantId, onClose, onAdded, toast }: {
  tenantId: string; onClose: () => void; onAdded: () => void; toast: (m: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<"teacher" | "driver">("teacher");
  const [staffTitle, setStaffTitle] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<InviteStaffResult | null>(null);

  async function add() {
    if (!fullName.trim()) { toast("A name is required."); return; }
    setSaving(true);
    try {
      const r = await inviteStaff({ tenant_id: tenantId, full_name: fullName.trim(), role, staff_title: staffTitle.trim() || undefined, phone: phone.trim() || undefined });
      setResult(r);
      onAdded();
    } catch (err) {
      toast(err instanceof Error ? `Could not add staff: ${err.message}` : "Could not add staff.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Staff"
      title={result ? "Staff added" : "Add staff"}
      actions={result ? <Button variant="accent" onClick={onClose}>Done</Button> : (
        <><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void add()} disabled={saving}>{saving ? "Adding…" : "Add"}</Button></>
      )}
    >
      {result ? (
        <div>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
            No email/SMS provider is configured locally, so nothing was sent — hand these credentials to them directly.
          </p>
          <div className="rounded-lg border border-line bg-page p-3.5">
            {[["Login ID", result.login_id], ["Password", result.password]].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-line-soft py-2 text-[12.5px] last:border-0">
                <span className="text-ink-muted">{k}</span><span className="font-mono font-medium">{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-3.5">
          <TextField id="staff-name" label="Full name" placeholder="e.g. Otieno Ouma" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          <SelectField id="staff-role" label="Role" value={role} onChange={(e) => setRole(e.target.value as "teacher" | "driver")} options={STAFF_ROLE_OPTIONS} />
          <TextField id="staff-title" label="Title (optional)" placeholder="e.g. Class teacher" value={staffTitle} onChange={(e) => setStaffTitle(e.target.value)} />
          <TextField id="staff-phone" label="Phone (optional)" placeholder="e.g. 0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      )}
    </Modal>
  );
}

/** Turns "Invite guardians" from a stub into a real provisioning flow
 *  (FIG-399/400) — links one new guardian account to every learner selected
 *  on the roster, with an assigned login_id instead of email/phone OTP. */
function InviteGuardiansModal({ tenantId, students, onClose, onInvited, toast }: {
  tenantId: string; students: { id: string; name: string }[]; onClose: () => void; onInvited: () => void; toast: (m: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [relationship, setRelationship] = useState<"mother" | "father" | "guardian">("guardian");
  const [isPrimaryPayer, setIsPrimaryPayer] = useState(true);
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ProvisionGuardianResult | null>(null);

  async function invite() {
    if (!fullName.trim()) { toast("A name is required."); return; }
    setSaving(true);
    try {
      const r = await provisionGuardian({
        tenant_id: tenantId,
        full_name: fullName.trim(),
        students: students.map((s) => ({ student_id: s.id, relationship, is_primary_payer: isPrimaryPayer })),
        phone: phone.trim() || undefined,
      });
      setResult(r);
      onInvited();
    } catch (err) {
      toast(err instanceof Error ? `Could not add the guardian: ${err.message}` : "Could not add the guardian.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Guardians"
      title={result ? "Guardian added" : "Invite a guardian"}
      blurb={result ? undefined : `Linked to ${students.map((s) => s.name).join(", ")}.`}
      actions={result ? <Button variant="accent" onClick={onClose}>Done</Button> : (
        <><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void invite()} disabled={saving}>{saving ? "Adding…" : "Invite"}</Button></>
      )}
    >
      {result ? (
        <div>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
            No email/SMS provider is configured locally, so nothing was sent — hand these credentials to them directly.
          </p>
          <div className="rounded-lg border border-line bg-page p-3.5">
            {[["Login ID", result.login_id], ["Password", result.password]].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-line-soft py-2 text-[12.5px] last:border-0">
                <span className="text-ink-muted">{k}</span><span className="font-mono font-medium">{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-3.5">
          <TextField id="guardian-name" label="Full name" placeholder="e.g. Rose Achieng" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          <SelectField
            id="guardian-relationship" label="Relationship" value={relationship}
            onChange={(e) => setRelationship(e.target.value as "mother" | "father" | "guardian")}
            options={[{ value: "mother", label: "Mother" }, { value: "father", label: "Father" }, { value: "guardian", label: "Guardian" }]}
          />
          <TextField id="guardian-phone" label="Phone (optional)" placeholder="e.g. 0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={isPrimaryPayer} onChange={(e) => setIsPrimaryPayer(e.target.checked)} style={{ accentColor: "#17402A" }} />
            <span className="text-[13px]">Primary fee payer</span>
          </label>
        </div>
      )}
    </Modal>
  );
}

/** The only place a learner's basic record (name, admission number, class,
 *  residence) can be corrected after admission — previously nowhere. */
function StudentProfileEditor({ student, classes, onSaved, toast }: {
  student: StudentRow;
  classes: Pick<ClassGroup, "id" | "name">[];
  onSaved: () => void;
  toast: (m: string) => void;
}) {
  const [fullName, setFullName] = useState(student.full_name);
  const [admissionNo, setAdmissionNo] = useState(student.admission_no);
  const [classId, setClassId] = useState(student.class_id ?? "");
  const [boarding, setBoarding] = useState(student.boarding);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!fullName.trim() || !admissionNo.trim()) { toast("Name and admission number are required."); return; }
    setSaving(true);
    try {
      const { error } = await supabase().from("students").update({
        full_name: fullName.trim(),
        admission_no: admissionNo.trim(),
        class_id: classId || null,
        boarding,
      }).eq("id", student.id);
      if (error) throw error;
      toast("Details saved.");
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-5 border-b border-line-soft pb-5">
      <h3 className="mb-2 text-[13px] font-semibold">Details</h3>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Full name</span>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)}
            className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Admission number</span>
          <input value={admissionNo} onChange={(e) => setAdmissionNo(e.target.value)}
            className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 font-mono text-[13px] outline-none" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Class</span>
          <select value={classId} onChange={(e) => setClassId(e.target.value)}
            className="w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px]">
            <option value="">Unassigned</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="mt-6 flex items-center gap-2">
          <input type="checkbox" checked={boarding} onChange={(e) => setBoarding(e.target.checked)} style={{ accentColor: "#17402A" }} />
          <span className="text-[13px]">Boarder</span>
        </label>
      </div>
      <Button variant="primary" className="mt-3" onClick={() => void save()} disabled={saving}>
        {saving ? "Saving…" : "Save details"}
      </Button>
    </div>
  );
}

/** The only place a staff member's own record (name, title, phone) can be
 *  corrected after they're added — previously nowhere. Role and login_id
 *  are credentials, not editable here. */
function StaffProfileEditor({ staff, onSaved, toast }: {
  staff: StaffRow;
  onSaved: () => void;
  toast: (m: string) => void;
}) {
  const [fullName, setFullName] = useState(staff.full_name);
  const [staffTitle, setStaffTitle] = useState(staff.staff_title ?? "");
  const [phone, setPhone] = useState(staff.phone ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!fullName.trim()) { toast("A name is required."); return; }
    setSaving(true);
    try {
      const { error } = await supabase().from("profiles").update({
        full_name: fullName.trim(),
        staff_title: staffTitle.trim() || null,
        phone: phone.trim() || null,
      }).eq("id", staff.id);
      if (error) throw error;
      toast("Details saved.");
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-5 border-b border-line-soft pb-5">
      <h3 className="mb-2 text-[13px] font-semibold">Details</h3>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Full name</span>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)}
            className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Title</span>
          <input value={staffTitle} onChange={(e) => setStaffTitle(e.target.value)} placeholder="e.g. Class teacher"
            className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Phone</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 0712 345 678"
            className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none" />
        </label>
      </div>
      <Button variant="primary" className="mt-3" onClick={() => void save()} disabled={saving}>
        {saving ? "Saving…" : "Save details"}
      </Button>
    </div>
  );
}

function AvatarEditor({ id, name, kind, tenantId, url, onUploaded, toast }: {
  id: string; name: string; kind: "students" | "staff"; tenantId: string; url?: string | null;
  onUploaded: (url: string) => void; toast: (m: string) => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const newUrl = await uploadAvatar(tenantId, kind, id, file);
      const table = kind === "students" ? "students" : "profiles";
      const { error } = await supabase().from(table).update({ avatar_url: newUrl }).eq("id", id);
      if (error) throw error;
      onUploaded(newUrl);
      toast("Photo updated");
    } catch (err) {
      toast("Could not upload: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  return (
    <div className="flex items-center gap-3.5">
      <Avatar id={id} name={name} url={url} size={56} />
      <label className="text-small font-medium text-leaf">
        <span className="hit inline-block cursor-pointer rounded-md border border-[#D3DAD5] bg-white px-3 py-1.5 hover:bg-page">
          {uploading ? "Uploading…" : "Change photo"}
        </span>
        <input type="file" accept="image/*" className="hidden" onChange={onChange} disabled={uploading} aria-label="Upload photo" />
      </label>
    </div>
  );
}

function StudentDocuments({ tenantId, uploaderId, studentId, toast }: {
  tenantId: string; uploaderId: string; studentId: string; toast: (m: string) => void;
}) {
  const [docs, setDocs] = useState<StudentDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [docType, setDocType] = useState("birth_certificate");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    listStudentDocuments(studentId)
      .then((d) => { if (alive) setDocs(d); })
      .catch((err: Error) => { if (alive) toast("Could not load documents: " + err.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  async function openDoc(doc: StudentDocument) {
    try {
      const url = await privateDocUrl(doc.file_path);
      window.open(url, "_blank");
    } catch (err) {
      toast("Could not open document: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  async function addDocument(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await uploadStudentDocument({ tenantId, studentId, uploadedBy: uploaderId, docType, file });
      setDocs(await listStudentDocuments(studentId));
      toast("Document added");
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      toast("Could not upload: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mt-5 border-t border-line-soft pt-4">
      <h3 className="text-[13px] font-semibold">Documents</h3>
      {loading ? (
        <p className="mt-2 text-small text-ink-faint">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="mt-2 text-small text-ink-faint">No documents on file yet.</p>
      ) : (
        <ul className="mt-2 grid gap-1.5">
          {docs.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => openDoc(d)}
                className="flex w-full items-center justify-between gap-3 rounded-md border border-line-soft bg-page px-3 py-2 text-left hover:bg-sunken">
                <span className="min-w-0 truncate text-small font-medium">{d.file_name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone="muted">{DOC_TYPES.find((t) => t.value === d.doc_type)?.label ?? d.doc_type}</Badge>
                  <span className="font-mono text-[10.5px] text-ink-faint">{new Date(d.uploaded_at).toLocaleDateString()}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={addDocument} className="mt-3 flex flex-wrap items-center gap-2">
        <select value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="Document type"
          className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
          {DOC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <input ref={fileRef} type="file" aria-label="Document file" className="text-small" />
        <Button type="submit" variant="primary" disabled={uploading}>{uploading ? "Uploading…" : "Add document"}</Button>
      </form>
    </div>
  );
}

/**
 * What this teacher is qualified to teach, set once at hiring and rarely
 * touched again — separate from teaching_assignments (which class they're
 * actually teaching this term). Read by SubjectsEditor to surface qualified
 * teachers first when a class needs a subject assigned.
 */
function TeacherSubjectsEditor({ teacherId, tenantId, subjects, selectedIds, onChange, toast }: {
  teacherId: string;
  tenantId: string;
  subjects: Subject[];
  selectedIds: Set<string>;
  onChange: () => void;
  toast: (m: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggle(subjectId: string, checked: boolean) {
    setBusyId(subjectId);
    try {
      if (checked) {
        const { error } = await supabase().from("teacher_subjects")
          .insert({ tenant_id: tenantId, teacher_id: teacherId, subject_id: subjectId });
        if (error) throw error;
      } else {
        const { error } = await supabase().from("teacher_subjects")
          .delete().eq("teacher_id", teacherId).eq("subject_id", subjectId);
        if (error) throw error;
      }
      onChange();
    } catch (err) {
      toast(err instanceof Error ? `Could not update: ${err.message}` : "Could not update.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mt-5 border-t border-line-soft pt-4">
      <h3 className="text-[13px] font-semibold">Subjects this teacher is qualified to teach</h3>
      {subjects.length === 0 ? (
        <p className="mt-2 text-small text-ink-faint">No subjects have been added yet — add some under Classes first.</p>
      ) : (
        <div className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {subjects.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={selectedIds.has(s.id)}
                disabled={busyId === s.id}
                onChange={(e) => void toggle(s.id, e.target.checked)}
                style={{ accentColor: "#17402A" }}
              />
              {s.name}
            </label>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
        This doesn't assign them anywhere on its own — it just makes them easier to find when picking a subject teacher for a class.
      </p>
    </div>
  );
}
