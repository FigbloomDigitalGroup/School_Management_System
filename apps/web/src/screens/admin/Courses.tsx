import { useMemo, useState, type FormEvent } from "react";
import {
  assignSectionInstructor, createCourse, createCourseSection, createSemester, enrollStudents,
  fetchCourseSections, fetchCourses, fetchEnrollmentsForSection, fetchSectionTimetableSlots, fetchSemesters,
  saveSectionTimetable, setCurrentSemester, setEnrollmentStatus, supabase,
  type Course, type CourseSectionRow, type EnrolledStudentRow, type Semester,
} from "@figbloom/shared";
import { TimetableEditor } from "./TimetableEditor";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

interface TeacherOption { id: string; full_name: string }
interface StudentOption { id: string; full_name: string; admission_no: string }

async function fetchTeachers(tenantId: string): Promise<TeacherOption[]> {
  const { data, error } = await supabase().from("profiles").select("id,full_name").eq("tenant_id", tenantId).eq("role", "teacher").order("full_name").returns<TeacherOption[]>();
  if (error) throw error;
  return data ?? [];
}

async function fetchActiveStudents(tenantId: string): Promise<StudentOption[]> {
  const { data, error } = await supabase().from("students").select("id,full_name,admission_no").eq("tenant_id", tenantId).eq("active", true).order("full_name").returns<StudentOption[]>();
  if (error) throw error;
  return data ?? [];
}

type Tab = "semesters" | "courses" | "sections";

/**
 * The higher-ed catalogue/enrollment console — what admin/Classes.tsx and
 * TimetableEditor are for K-12, folded into one screen since a higher-ed
 * tenant needs semesters, a course catalogue, and section rosters set up
 * together before anything else here works. Only shown to higher_ed tenants
 * (ConsoleShell hides admin/classes for them; this is their equivalent).
 */
export function AdminCourses() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [tab, setTab] = useState<Tab>("semesters");
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  const { data: semesters, loading: semestersLoading } = useAsync(() => fetchSemesters(tenant.id), [reloadKey]);
  const { data: courses, loading: coursesLoading } = useAsync(() => fetchCourses(tenant.id), [reloadKey]);
  const { data: teachers } = useAsync(() => fetchTeachers(tenant.id), []);
  const { data: students } = useAsync(() => fetchActiveStudents(tenant.id), []);

  const [semesterId, setSemesterId] = useState<string>("");
  const currentSemesterId = useMemo(() => semesters?.find((s) => s.is_current)?.id ?? semesters?.[0]?.id ?? "", [semesters]);
  const activeSemesterId = semesterId || currentSemesterId;

  const { data: sections, loading: sectionsLoading } = useAsync(
    () => (activeSemesterId ? fetchCourseSections(tenant.id, activeSemesterId) : Promise.resolve([] as CourseSectionRow[])),
    [activeSemesterId, reloadKey],
  );

  const [addingSemester, setAddingSemester] = useState(false);
  const [addingCourse, setAddingCourse] = useState(false);
  const [addingSection, setAddingSection] = useState(false);
  const [rosterFor, setRosterFor] = useState<CourseSectionRow | null>(null);
  const [scheduleFor, setScheduleFor] = useState<CourseSectionRow | null>(null);

  async function makeCurrent(id: string) {
    try {
      await setCurrentSemester(tenant.id, id);
      toast("Current semester updated.");
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update the current semester.");
    }
  }

  async function setInstructor(sectionId: string, instructorId: string) {
    try {
      await assignSectionInstructor(sectionId, instructorId || null);
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not assign an instructor: ${err.message}` : "Could not assign an instructor.");
    }
  }

  return (
    <>
      <PageHead
        eyebrow="School · courses"
        title="Courses"
        blurb="Semesters, the course catalogue, and section rosters."
        actions={
          tab === "semesters" ? <Button variant="accent" onClick={() => setAddingSemester(true)}>Add semester</Button>
            : tab === "courses" ? <Button variant="accent" onClick={() => setAddingCourse(true)}>Add course</Button>
            : semesters?.length ? <Button variant="accent" onClick={() => setAddingSection(true)}>Add section</Button> : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-7 py-3">
        <div className="flex rounded-md border border-[#D3DAD5] bg-white p-0.5">
          {(["semesters", "courses", "sections"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className="rounded px-3 py-1.5 text-small capitalize"
              style={tab === t ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
              {t}
            </button>
          ))}
        </div>
        {tab === "sections" && semesters && semesters.length > 0 && (
          <select
            value={activeSemesterId}
            onChange={(e) => setSemesterId(e.target.value)}
            aria-label="Semester"
            className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
          >
            {semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      <div className="px-7 py-6">
        {tab === "semesters" && (
          semestersLoading || !semesters ? <TableSkeleton rows={4} /> : (
            <DataTable
              columns={[
                { key: "name", header: "Semester", width: "1.4fr", render: (s: Semester) => <Cell sub={`${s.starts_on} – ${s.ends_on}`}>{s.name}</Cell> },
                { key: "year", header: "Year", render: (s: Semester) => <Mono>{s.year}</Mono> },
                { key: "current", header: "", align: "right", width: "1.2fr", render: (s: Semester) => (
                  s.is_current ? <Badge tone="ok">Current</Badge> : (
                    <button type="button" onClick={() => void makeCurrent(s.id)} className="text-[12px] font-semibold text-leaf hover:underline">
                      Set as current
                    </button>
                  )
                ) },
              ]}
              rows={semesters}
              rowKey={(s) => s.id}
              minWidth="560px"
              empty={{ title: "No semesters yet", body: "Add the first semester before creating courses.", action: <Button variant="primary" onClick={() => setAddingSemester(true)}>Add semester</Button> }}
            />
          )
        )}

        {tab === "courses" && (
          coursesLoading || !courses ? <TableSkeleton rows={6} /> : (
            <DataTable
              columns={[
                { key: "code", header: "Code", width: "0.7fr", render: (c: Course) => <Mono>{c.code}</Mono> },
                { key: "name", header: "Course", width: "1.6fr", render: (c: Course) => <Cell sub={c.department ?? undefined}>{c.name}</Cell> },
                { key: "credits", header: "Credits", align: "right", render: (c: Course) => <Mono>{c.credits}</Mono> },
              ]}
              rows={courses}
              rowKey={(c) => c.id}
              minWidth="560px"
              empty={{ title: "No courses yet", body: "Add the school's first course to start creating sections.", action: <Button variant="primary" onClick={() => setAddingCourse(true)}>Add course</Button> }}
            />
          )
        )}

        {tab === "sections" && (
          !semesters?.length ? (
            <p className="text-[13px] text-ink-muted">Add a semester first.</p>
          ) : sectionsLoading || !sections ? <TableSkeleton rows={6} /> : (
            <DataTable
              columns={[
                { key: "course", header: "Course", width: "1.4fr", render: (s: CourseSectionRow) => <Cell sub={s.course_code}>{s.course_name}</Cell> },
                { key: "section", header: "Section", render: (s: CourseSectionRow) => <Mono>{s.section_label}</Mono> },
                { key: "room", header: "Room", render: (s: CourseSectionRow) => <span className="text-[13px]">{s.room ?? "—"}</span> },
                { key: "instructor", header: "Instructor", width: "1.4fr", render: (s: CourseSectionRow) => (
                  <select
                    value={s.instructor_id ?? ""}
                    onChange={(e) => void setInstructor(s.id, e.target.value)}
                    aria-label={`Instructor for ${s.course_name} ${s.section_label}`}
                    className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
                  >
                    <option value="">Unassigned</option>
                    {(teachers ?? []).map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                  </select>
                ) },
                { key: "enrolled", header: "Enrolled", align: "right", render: (s: CourseSectionRow) => <Mono>{s.enrolled_count}{s.capacity ? ` / ${s.capacity}` : ""}</Mono> },
                { key: "actions", header: "", align: "right", width: "1.3fr", render: (s: CourseSectionRow) => (
                  <div className="flex justify-end gap-3">
                    <button type="button" onClick={() => setScheduleFor(s)} className="text-[12px] font-semibold text-leaf hover:underline">
                      Schedule
                    </button>
                    <button type="button" onClick={() => setRosterFor(s)} className="text-[12px] font-semibold text-leaf hover:underline">
                      Roster
                    </button>
                  </div>
                ) },
              ]}
              rows={sections}
              rowKey={(s) => s.id}
              minWidth="920px"
              empty={{ title: "No sections yet", body: "Add a section for this semester.", action: <Button variant="primary" onClick={() => setAddingSection(true)}>Add section</Button> }}
            />
          )
        )}
      </div>

      {addingSemester && (
        <AddSemesterModal onClose={() => setAddingSemester(false)} onCreated={() => { setAddingSemester(false); reload(); }} toast={toast} />
      )}
      {addingCourse && (
        <AddCourseModal onClose={() => setAddingCourse(false)} onCreated={() => { setAddingCourse(false); reload(); }} toast={toast} />
      )}
      {addingSection && semesters && semesters.length > 0 && (
        <AddSectionModal
          semesters={semesters}
          courses={courses ?? []}
          defaultSemesterId={activeSemesterId}
          onClose={() => setAddingSection(false)}
          onCreated={() => { setAddingSection(false); reload(); }}
          toast={toast}
        />
      )}
      {rosterFor && (
        <RosterModal
          section={rosterFor}
          students={students ?? []}
          onClose={() => setRosterFor(null)}
          onChanged={() => reload()}
          toast={toast}
        />
      )}
      {scheduleFor && (
        <TimetableEditor
          entityId={scheduleFor.id}
          title={`${scheduleFor.course_code} ${scheduleFor.section_label}`}
          fetchSlots={fetchSectionTimetableSlots}
          saveSlots={(id, slots) => saveSectionTimetable(tenant.id, id, slots)}
          onClose={() => setScheduleFor(null)}
        />
      )}
    </>
  );
}

function AddSemesterModal({ onClose, onCreated, toast }: { onClose: () => void; onCreated: () => void; toast: (m: string) => void }) {
  const { tenant } = useTenantSession();
  const [name, setName] = useState("");
  const [year, setYear] = useState(new Date().getFullYear());
  const [index, setIndex] = useState<1 | 2 | 3>(1);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!name.trim() || !startsOn || !endsOn) { toast("Name and both dates are required."); return; }
    setSaving(true);
    try {
      await createSemester({ tenant_id: tenant.id, name: name.trim(), year, index, starts_on: startsOn, ends_on: endsOn, is_current: false });
      toast(`${name.trim()} created.`);
      onCreated();
    } catch (err) {
      toast(err instanceof Error ? `Could not create the semester: ${err.message}` : "Could not create the semester.");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) { e.preventDefault(); void create(); }

  return (
    <Modal open onClose={onClose} eyebrow="Semesters" title="Add a semester"
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void create()} disabled={saving}>{saving ? "Creating…" : "Create semester"}</Button></>}>
      <form onSubmit={handleSubmit} className="grid gap-3">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-semibold">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Semester 1, 2026" autoFocus
            className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none" />
        </label>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Year</span>
            <input value={year} inputMode="numeric" onChange={(e) => setYear(Number(e.target.value.replace(/[^0-9]/g, "")) || year)}
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Index</span>
            <select value={index} onChange={(e) => setIndex(Number(e.target.value) as 1 | 2 | 3)}
              className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]">
              <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
            </select>
          </label>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Starts</span>
            <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)}
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Ends</span>
            <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)}
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none" />
          </label>
        </div>
      </form>
    </Modal>
  );
}

function AddCourseModal({ onClose, onCreated, toast }: { onClose: () => void; onCreated: () => void; toast: (m: string) => void }) {
  const { tenant } = useTenantSession();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [credits, setCredits] = useState(3);
  const [department, setDepartment] = useState("");
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!code.trim() || !name.trim()) { toast("Code and name are required."); return; }
    setSaving(true);
    try {
      await createCourse({ tenant_id: tenant.id, code: code.trim().toUpperCase(), name: name.trim(), credits, department: department.trim() || null });
      toast(`${code.trim().toUpperCase()} created.`);
      onCreated();
    } catch (err) {
      toast(err instanceof Error ? `Could not create the course: ${err.message}` : "Could not create the course.");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) { e.preventDefault(); void create(); }

  return (
    <Modal open onClose={onClose} eyebrow="Courses" title="Add a course"
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void create()} disabled={saving}>{saving ? "Creating…" : "Create course"}</Button></>}>
      <form onSubmit={handleSubmit} className="grid gap-3">
        <div className="grid gap-3" style={{ gridTemplateColumns: "0.8fr 1.6fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Code</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. CS201" autoFocus
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Data Structures"
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none" />
          </label>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Credits</span>
            <input value={credits} inputMode="decimal" onChange={(e) => setCredits(Number(e.target.value.replace(/[^0-9.]/g, "")) || credits)}
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Department (optional)</span>
            <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Computer Science"
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none" />
          </label>
        </div>
      </form>
    </Modal>
  );
}

function AddSectionModal({ semesters, courses, defaultSemesterId, onClose, onCreated, toast }: {
  semesters: Semester[]; courses: Course[]; defaultSemesterId: string;
  onClose: () => void; onCreated: () => void; toast: (m: string) => void;
}) {
  const { tenant } = useTenantSession();
  const [semesterId, setSemesterId] = useState(defaultSemesterId);
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [label, setLabel] = useState("A");
  const [room, setRoom] = useState("");
  const [capacity, setCapacity] = useState("");
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!semesterId || !courseId || !label.trim()) { toast("Semester, course and a section label are required."); return; }
    setSaving(true);
    try {
      await createCourseSection({
        tenant_id: tenant.id, semester_id: semesterId, course_id: courseId, section_label: label.trim(),
        instructor_id: null, room: room.trim() || null, capacity: capacity ? Number(capacity) : null,
      });
      toast(`Section ${label.trim()} created.`);
      onCreated();
    } catch (err) {
      toast(err instanceof Error ? `Could not create the section: ${err.message}` : "Could not create the section.");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) { e.preventDefault(); void create(); }

  return (
    <Modal open onClose={onClose} eyebrow="Sections" title="Add a section"
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void create()} disabled={saving || !courses.length}>{saving ? "Creating…" : "Create section"}</Button></>}>
      {!courses.length ? (
        <p className="text-[13px] text-ink-muted">Add a course first.</p>
      ) : (
        <form onSubmit={handleSubmit} className="grid gap-3">
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-semibold">Semester</span>
              <select value={semesterId} onChange={(e) => setSemesterId(e.target.value)} className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]">
                {semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-semibold">Course</span>
              <select value={courseId} onChange={(e) => setCourseId(e.target.value)} className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]">
                {courses.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </select>
            </label>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "0.6fr 1fr 0.7fr" }}>
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-semibold">Label</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="A" className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-semibold">Room (optional)</span>
              <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="e.g. LH 3" className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-semibold">Capacity (optional)</span>
              <input value={capacity} inputMode="numeric" onChange={(e) => setCapacity(e.target.value.replace(/[^0-9]/g, ""))} className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none" />
            </label>
          </div>
        </form>
      )}
    </Modal>
  );
}

function RosterModal({ section, students, onClose, onChanged, toast }: {
  section: CourseSectionRow; students: StudentOption[];
  onClose: () => void; onChanged: () => void; toast: (m: string) => void;
}) {
  const { tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: roster, loading } = useAsync(() => fetchEnrollmentsForSection(section.id), [section.id, reloadKey]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [enrolling, setEnrolling] = useState(false);

  const enrolledIds = new Set((roster ?? []).filter((r) => r.status === "enrolled").map((r) => r.student_id));
  const available = students.filter((s) => !enrolledIds.has(s.id));

  async function enroll() {
    if (!picked.size) return;
    setEnrolling(true);
    try {
      await enrollStudents(tenant.id, section.id, [...picked]);
      setPicked(new Set());
      setReloadKey((k) => k + 1);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? `Could not enroll: ${err.message}` : "Could not enroll those students.");
    } finally {
      setEnrolling(false);
    }
  }

  async function drop(enrollmentId: string) {
    try {
      await setEnrollmentStatus(enrollmentId, "dropped");
      setReloadKey((k) => k + 1);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not drop that student.");
    }
  }

  return (
    <Modal open onClose={onClose} width={640} eyebrow="Roster" title={`${section.course_code} ${section.section_label}`} actions={<Button onClick={onClose}>Done</Button>}>
      <div className="grid gap-4">
        <section>
          <h3 className="mb-2 text-[12.5px] font-semibold">Enrolled</h3>
          {loading || !roster ? (
            <p className="text-[12.5px] text-ink-faint">Loading…</p>
          ) : roster.filter((r) => r.status === "enrolled").length === 0 ? (
            <p className="text-[12.5px] text-ink-faint">No one enrolled yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-line">
              {roster.filter((r) => r.status === "enrolled").map((r: EnrolledStudentRow) => (
                <div key={r.enrollment_id} className="flex items-center justify-between gap-3 border-b border-line-soft px-3.5 py-2 last:border-0">
                  <Cell sub={`ADM ${r.admission_no}`}>{r.full_name}</Cell>
                  <button type="button" onClick={() => void drop(r.enrollment_id)} className="text-[12px] font-semibold text-warn-ink hover:underline">Drop</button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[12.5px] font-semibold">Add students</h3>
          {available.length === 0 ? (
            <p className="text-[12.5px] text-ink-faint">Everyone active is already enrolled.</p>
          ) : (
            <>
              <div className="max-h-[220px] overflow-y-auto rounded-lg border border-line">
                {available.map((s) => (
                  <label key={s.id} className="flex items-center gap-2.5 border-b border-line-soft px-3.5 py-2 last:border-0">
                    <input
                      type="checkbox"
                      checked={picked.has(s.id)}
                      onChange={() => setPicked((p) => { const n = new Set(p); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; })}
                    />
                    <Cell sub={`ADM ${s.admission_no}`}>{s.full_name}</Cell>
                  </label>
                ))}
              </div>
              <Button variant="accent" onClick={() => void enroll()} disabled={!picked.size || enrolling}>
                {enrolling ? "Enrolling…" : `Enroll ${picked.size || ""}`.trim()}
              </Button>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
