import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fetchClassRoster, fetchCurrentTerm, fetchTeacherClasses, fetchTodayAttendanceMarks,
  MARK_LABEL, MARK_SHORT, MARK_STYLE, nextMark, newRegister, submitWarning, tally, toRecords, today, writeAttendance,
  supabase,
  type AttendanceMark, type ClassGroup, type Register,
} from "@figbloom/shared";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { queue } from "../../lib/queue";
import { useOnline } from "../../lib/useOnline";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";

interface AwayStudent { name: string; mark: AttendanceMark; note: string | null }
interface ClassProgress {
  present: number; absent: number; late: number; total: number;
  submitted: boolean; submittedAt: string | null;
  away: AwayStudent[]; // everyone not marked present, for the card detail
}

/** Today's state across every class this teacher has, not just the one
 *  they're looking at — what the "your classes today" cards on the
 *  confirmation screen are built from. */
async function fetchClassProgress(classes: Pick<ClassGroup, "id" | "name">[]): Promise<Map<string, ClassProgress>> {
  const classIds = classes.map((c) => c.id);
  const out = new Map<string, ClassProgress>();
  if (classIds.length === 0) return out;

  const [{ data: studentRows, error: e1 }, { data: attRows, error: e2 }] = await Promise.all([
    supabase().from("students").select("id, class_id").eq("active", true).in("class_id", classIds)
      .returns<{ id: string; class_id: string }[]>(),
    supabase().from("attendance").select("class_id, mark, note, created_at, students(full_name)")
      .in("class_id", classIds).eq("taken_on", today())
      .returns<{ class_id: string; mark: AttendanceMark; note: string | null; created_at: string; students: { full_name: string } | null }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);

  const totalByClass = new Map<string, number>();
  for (const s of studentRows ?? []) totalByClass.set(s.class_id, (totalByClass.get(s.class_id) ?? 0) + 1);
  for (const c of classes) {
    out.set(c.id, { present: 0, absent: 0, late: 0, total: totalByClass.get(c.id) ?? 0, submitted: false, submittedAt: null, away: [] });
  }

  for (const r of attRows ?? []) {
    const row = out.get(r.class_id);
    if (!row) continue;
    row.submitted = true;
    if (!row.submittedAt || r.created_at < row.submittedAt) row.submittedAt = r.created_at;
    if (r.mark === "present") row.present += 1;
    else if (r.mark === "absent" || r.mark === "late") {
      if (r.mark === "absent") row.absent += 1; else row.late += 1;
      row.away.push({ name: r.students?.full_name ?? "Unknown", mark: r.mark, note: r.note });
    }
  }
  for (const row of out.values()) row.away.sort((a, b) => a.name.localeCompare(b.name));
  return out;
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
  const [params] = useSearchParams();

  const [classId, setClassId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // null = "don't know yet" — switching classes waits here instead of
  // guessing "not submitted" and flashing the roster before the real
  // (possibly already-submitted) state loads in.
  const [submitted, setSubmitted] = useState<boolean | null>(null);
  const [held, setHeld] = useState(0);

  // "My classes" links here with ?class=<id> so the shortcut lands on the right roster.
  useEffect(() => {
    if (classId || classesData.length === 0) return;
    const requested = params.get("class");
    setClassId(classesData.find((c) => c.id === requested)?.id ?? classesData[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, classesData]);

  const { data: rosterData, loading: rosterLoading } = useAsync(
    () => (classId ? fetchClassRoster(classId) : Promise.resolve([])),
    [classId],
  );
  const { data: todayMarks, loading: marksLoading } = useAsync(
    () => (classId ? fetchTodayAttendanceMarks(classId) : Promise.resolve([])),
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

  // A register already taken today (by this teacher, earlier, or from another
  // device) should open straight to the "already in" screen, not the roster.
  // marksLoading guards against judging by the outgoing class's stale marks
  // before the new class's have actually loaded.
  useEffect(() => {
    if (!classId || marksLoading || !todayMarks) return;
    setSubmitted(todayMarks.length > 0);
  }, [classId, marksLoading, todayMarks]);

  function switchClass(id: string) {
    setClassId(id);
    setSubmitted(null);
    setReg(null);
  }

  // Rebuilt right after a submit (progressReloadKey) so the confirmation
  // screen's "your classes today" list reflects the one just taken without
  // waiting for a remount.
  const [progressReloadKey, setProgressReloadKey] = useState(0);
  const { data: classProgress } = useAsync(
    () => fetchClassProgress(classesData),
    [classesData, progressReloadKey],
  );

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
        toast("Could not save the register — check your connection and try again.", "error");
      });
      setSubmitted(true);
      setProgressReloadKey((k) => k + 1);
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

  if (classesLoading || !cls || submitted === null) {
    return (
      <div className="min-h-screen bg-page p-6">
        <TableSkeleton rows={8} />
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-page">
        <header className="flex flex-wrap items-center gap-3 border-b border-line bg-white px-6 py-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ok-bg text-lg text-ok-ink">✓</span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">{cls.name} register is in</div>
            <div className="mt-0.5 truncate text-[12px] text-ink-muted">
              {counts.present} present · {counts.absent} absent · {counts.late} late —{" "}
              {online
                ? "parents of absent learners get an SMS at 09:00, not immediately"
                : `held on this phone${held > 1 ? ` with ${held - 1} other register(s)` : ""}, sends itself once you have signal`}
            </div>
          </div>
          <Button variant="primary" onClick={() => setSubmitted(false)}>Correct a mark</Button>
        </header>

        <div className="px-6 py-6">
          <div className="mb-3 font-mono text-micro tracking-[0.12em] text-ink-faint">YOUR CLASSES TODAY</div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {classesData.map((c) => {
              const p = classProgress?.get(c.id);
              const active = c.id === classId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => switchClass(c.id)}
                  className="grid content-start gap-2 rounded-xl border p-4 text-left"
                  style={{ borderColor: active ? "var(--accent)" : "#E2E6E2", background: active ? "#FFF8F6" : "#fff" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[14px] font-semibold">{c.name}</span>
                    {p && (p.submitted ? <Badge tone="ok">Submitted</Badge> : <Badge tone="warn">Not taken</Badge>)}
                  </div>

                  {!p ? (
                    <Skeleton className="h-3 w-2/3" />
                  ) : p.submitted ? (
                    <>
                      <div className="text-[11.5px] text-ink-faint">
                        {p.submittedAt
                          ? `Taken at ${new Date(p.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                          : "Taken today"}
                      </div>
                      <div className="text-[12.5px] text-ink-muted">
                        {p.present + p.late}/{p.total} here
                        {p.absent > 0 ? ` · ${p.absent} absent` : ""}
                        {p.late > 0 ? ` · ${p.late} late` : ""}
                      </div>
                      {p.away.length > 0 && (
                        <ul className="grid gap-1 border-t border-line-soft pt-2">
                          {p.away.map((a, i) => (
                            <li key={i} className="flex items-start justify-between gap-2 text-[12px]">
                              <span className="min-w-0 truncate">
                                {a.name}
                                {a.note && <span className="block truncate text-[11px] text-ink-faint">{a.note}</span>}
                              </span>
                              <span className="shrink-0 font-medium" style={{ color: MARK_STYLE[a.mark].ink }}>{MARK_LABEL[a.mark]}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p className="text-[12.5px] text-ink-faint">Tap to take attendance.</p>
                  )}
                </button>
              );
            })}
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
