import { useEffect, useMemo, useState } from "react";
import {
  MARK_LABEL, MARK_SHORT, MARK_STYLE, nextMark, newRegister, submitWarning, tally, toRecords, today,
  supabase,
  type AttendanceMark, type ClassGroup, type Register, type Student, type Term,
} from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { queue } from "../../lib/queue";
import { useOnline } from "../../lib/useOnline";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { TableSkeleton } from "../../components/ui/Skeleton";

/** Classes this teacher may register: assigned via teaching_assignments, or class-teacher of. */
async function fetchTeacherClasses(teacherId: string): Promise<ClassGroup[]> {
  const [{ data: assigned, error: e1 }, { data: owned, error: e2 }] = await Promise.all([
    supabase().from("teaching_assignments").select("class_id").eq("teacher_id", teacherId),
    supabase().from("classes").select("*").eq("class_teacher_id", teacherId),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);

  const assignedIds = Array.from(new Set(((assigned ?? []) as { class_id: string }[]).map((r) => r.class_id)));
  let assignedClasses: ClassGroup[] = [];
  if (assignedIds.length) {
    const { data, error } = await supabase().from("classes").select("*").in("id", assignedIds);
    if (error) throw new Error(error.message);
    assignedClasses = (data ?? []) as ClassGroup[];
  }

  const byId = new Map<string, ClassGroup>();
  for (const c of [...assignedClasses, ...((owned ?? []) as ClassGroup[])]) byId.set(c.id, c);
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchCurrentTerm(): Promise<Term | null> {
  const { data, error } = await supabase().from("terms").select("*").eq("is_current", true).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Term | null) ?? null;
}

async function fetchRoster(classId: string): Promise<Student[]> {
  const { data, error } = await supabase()
    .from("students").select("*").eq("class_id", classId).eq("active", true).order("full_name");
  if (error) throw new Error(error.message);
  return (data ?? []) as Student[];
}

async function fetchTodayMarks(classId: string): Promise<{ student_id: string; mark: AttendanceMark }[]> {
  const { data, error } = await supabase()
    .from("attendance").select("student_id, mark").eq("class_id", classId).eq("taken_on", today());
  if (error) throw new Error(error.message);
  return (data ?? []) as { student_id: string; mark: AttendanceMark }[];
}

async function writeAttendance(reg: Register, tenantId: string, takenBy: string) {
  const rows = Object.entries(reg.marks).map(([student_id, mark]) => ({
    tenant_id: tenantId,
    student_id,
    class_id: reg.classId,
    term_id: reg.termId,
    taken_by: takenBy,
    taken_on: reg.date,
    mark,
    note: reg.notes[student_id] ?? null,
  }));
  const { error } = await supabase().from("attendance").upsert(rows, { onConflict: "student_id,taken_on" });
  if (error) throw new Error(error.message);
}

/**
 * The 60-second screen — the one a teacher uses every morning, often standing
 * up, sometimes with no signal.
 *
 * Everyone starts present. The teacher taps only the exceptions, so a full class
 * of 40 is three taps and a submit. Rows are 56px so a thumb cannot miss, the
 * count updates live, and submitting offline queues the register rather than
 * failing — attendance taken at 08:00 in a dead spot must not be lost.
 */
const todayLabel = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).toUpperCase();

export function Attendance() {
  const online = useOnline();
  const toast = useToast();
  const { profile, tenant } = useTenantSession();

  const { data: classListData, loading: classesLoading } = useAsync(() => fetchTeacherClasses(profile.id), [profile.id]);
  const { data: term } = useAsync(() => fetchCurrentTerm(), [tenant.id]);
  const classesData = useMemo(() => classListData ?? [], [classListData]);

  const [classId, setClassId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [held, setHeld] = useState(0);

  useEffect(() => {
    if (!classId && classesData.length > 0) setClassId(classesData[0]!.id);
  }, [classId, classesData]);

  const { data: rosterData, loading: rosterLoading } = useAsync(
    () => (classId ? fetchRoster(classId) : Promise.resolve([])),
    [classId],
  );
  const { data: todayMarks } = useAsync(
    () => (classId ? fetchTodayMarks(classId) : Promise.resolve([])),
    [classId],
  );
  const roster = rosterData ?? [];

  const [reg, setReg] = useState<Register | null>(null);

  useEffect(() => {
    if (!classId || !term?.id || !rosterData || !todayMarks) return;
    const base = newRegister(classId, term.id, rosterData.map((s) => s.id));
    for (const row of todayMarks) {
      if (row.student_id in base.marks) base.marks[row.student_id] = row.mark;
    }
    setReg(base);
  }, [classId, term?.id, rosterData, todayMarks]);

  function switchClass(id: string) {
    setClassId(id);
    setSubmitted(false);
    setReg(null);
  }

  const counts = useMemo(
    () => (reg ? tally(reg) : { present: 0, absent: 0, late: 0, excused: 0, total: 0 }),
    [reg],
  );

  function cycle(studentId: string) {
    setReg((r) => (r ? { ...r, marks: { ...r.marks, [studentId]: nextMark(r.marks[studentId] ?? "present") } } : r));
  }

  function setMark(studentId: string, mark: AttendanceMark) {
    setReg((r) => (r ? { ...r, marks: { ...r.marks, [studentId]: mark } } : r));
  }

  function submit() {
    if (!reg) return;
    const warning = submitWarning(reg);
    if (warning && !confirming) { setConfirming(warning); return; }
    setConfirming(null);
    if (online) {
      void writeAttendance(reg, tenant.id, profile.id).catch((err: Error) => {
        console.error(err);
        toast("Could not save the register — check your connection and try again.");
      });
      setSubmitted(true);
      toast(`Register submitted · ${counts.present} present, ${counts.absent} absent, ${counts.late} late`);
    } else {
      void queue.enqueue("attendance", toRecords(reg, tenant.id, profile.id))
        .then(() => queue.pending())
        .then((p) => setHeld(p.length));
      setSubmitted(true);
      toast("Saved on this phone. It will send itself when you have signal.");
    }
  }

  const cls = classesData.find((c) => c.id === classId);

  if (classesLoading || !cls) {
    return (
      <div className="min-h-screen bg-page p-6">
        <TableSkeleton rows={8} />
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="grid min-h-screen place-items-center bg-page p-6">
        <div className="w-full max-w-[440px] rounded-2xl border border-line bg-white p-6 text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-ok-bg text-2xl text-ok-ink">✓</div>
          <h1 className="text-[19px] font-semibold">{cls.name} register is in</h1>
          <p className="mx-auto mt-2 max-w-[340px] text-[13px] leading-relaxed text-ink-muted">
            {online
              ? "Parents of absent learners get an SMS at 09:00, not immediately — a learner who arrives late should not trigger a false alarm."
              : `Held on this phone${held > 1 ? ` with ${held - 1} other register(s)` : ""}. It sends itself the moment you have signal.`}
          </p>
          <dl className="my-5 flex justify-center gap-6">
            {(["present", "absent", "late"] as AttendanceMark[]).map((k) => (
              <div key={k}>
                <dd className="font-mono text-2xl" style={{ color: MARK_STYLE[k].ink }}>{counts[k]}</dd>
                <dt className="mt-0.5 text-[11.5px] text-ink-faint">{MARK_LABEL[k]}</dt>
              </div>
            ))}
          </dl>
          <div className="grid gap-2">
            <Button variant="primary" block onClick={() => setSubmitted(false)}>Correct a mark</Button>
            <Button block onClick={() => switchClass(classesData[(classesData.indexOf(cls) + 1) % classesData.length]!.id)}>
              Take the next class
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-page">
      <header className="border-b border-line bg-white px-5 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">
              ATTENDANCE · {todayLabel}
            </div>
            <div className="mt-1 flex items-center gap-2.5">
              <select
                value={classId ?? ""}
                onChange={(e) => switchClass(e.target.value)}
                aria-label="Class"
                className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[15px] font-semibold"
              >
                {classesData.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <span className="text-[13px] text-ink-muted">{roster.length} learners</span>
            </div>
          </div>
          {!online && (
            <div className="flex items-center gap-2 rounded-lg bg-orange-soft px-3 py-2 text-[12.5px] text-orange-ink">
              <span className="h-2 w-2 rounded-full bg-orange" /> No signal — this will save on the phone
            </div>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white px-5 py-2.5">
        {(["present", "absent", "late"] as AttendanceMark[]).map((k) => (
          <span key={k} className="rounded-full px-2.5 py-1 text-[12.5px] font-semibold" style={{ background: MARK_STYLE[k].bg, color: MARK_STYLE[k].ink }}>
            {counts[k]} {MARK_LABEL[k].toLowerCase()}
          </span>
        ))}
        <span className="ml-auto text-[12.5px] text-ink-muted">Everyone starts present — tap only the exceptions.</span>
      </div>

      {reg && !rosterLoading ? (
        <ul className="min-h-0 flex-1 overflow-auto">
          {roster.map((s, i) => {
            const mark = reg.marks[s.id] ?? "present";
            const style = MARK_STYLE[mark];
            return (
              <li key={s.id}>
                <div className="flex items-center gap-3 border-b border-line-soft bg-white px-5" style={{ minHeight: 56 }}>
                  <span className="w-6 shrink-0 font-mono text-[11px] text-ink-faint">{i + 1}</span>
                  <button onClick={() => cycle(s.id)} className="min-w-0 flex-1 py-2 text-left">
                    <div className="truncate text-[14.5px] font-medium">{s.full_name}</div>
                    <div className="font-mono text-[10.5px] text-ink-faint">ADM {s.admission_no}</div>
                  </button>
                  <div role="group" aria-label={`Mark for ${s.full_name}`} className="flex shrink-0 gap-1.5">
                    {(["present", "absent", "late"] as AttendanceMark[]).map((k) => {
                      const on = mark === k;
                      return (
                        <button
                          key={k}
                          onClick={() => setMark(s.id, k)}
                          aria-pressed={on}
                          aria-label={MARK_LABEL[k]}
                          className="grid place-items-center rounded-lg text-[13px] font-bold transition"
                          style={{
                            width: 44, height: 44,
                            background: on ? MARK_STYLE[k].bg : "#F6F8F6",
                            color: on ? MARK_STYLE[k].ink : "#9AA69E",
                            boxShadow: on ? `inset 0 0 0 1.5px ${MARK_STYLE[k].ink}` : undefined,
                          }}
                        >
                          {MARK_SHORT[k]}
                        </button>
                      );
                    })}
                  </div>
                  <span className="hidden w-16 shrink-0 text-right text-[11.5px] sm:block" style={{ color: style.ink }}>
                    {MARK_LABEL[mark]}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <TableSkeleton rows={8} />
        </div>
      )}

      <footer className="border-t border-line bg-white px-5 py-3">
        {confirming ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-ink-muted">{confirming}</p>
            <div className="flex gap-2">
              <Button onClick={() => setConfirming(null)}>Go back</Button>
              <Button variant="primary" onClick={submit}>Yes, submit</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[12.5px] text-ink-muted">
              Parents of absent learners are texted at 09:00, so a late arrival can still be corrected.
            </p>
            <Button variant="accent" onClick={submit} className="px-6 py-3 text-[15px]">
              Submit register
            </Button>
          </div>
        )}
      </footer>
    </div>
  );
}
