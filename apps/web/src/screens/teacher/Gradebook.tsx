import { useEffect, useMemo, useState } from "react";
import { GRADE_INK, gradeFor, parseScoreInput, summarise, supabase, type ClassGroup, type Exam, type Student, type Subject, type Term } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { TableSkeleton } from "../../components/ui/Skeleton";

/** Classes this teacher may grade: assigned via teaching_assignments, or class-teacher of. */
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

/** Subjects this teacher is assigned to teach for one specific class. */
async function fetchTeacherSubjectsForClass(teacherId: string, classId: string): Promise<Subject[]> {
  const { data, error } = await supabase()
    .from("teaching_assignments")
    .select("subject_id, subjects(*)")
    .eq("teacher_id", teacherId)
    .eq("class_id", classId);
  if (error) throw new Error(error.message);

  const byId = new Map<string, Subject>();
  for (const row of (data ?? []) as { subject_id: string; subjects: Subject | Subject[] | null }[]) {
    const subj = Array.isArray(row.subjects) ? row.subjects[0] : row.subjects;
    if (subj) byId.set(subj.id, subj);
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchExams(termId: string): Promise<Exam[]> {
  const { data, error } = await supabase().from("exams").select("*").eq("term_id", termId).order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as Exam[];
}

async function fetchRoster(classId: string): Promise<Student[]> {
  const { data, error } = await supabase()
    .from("students").select("*").eq("class_id", classId).eq("active", true).order("full_name");
  if (error) throw new Error(error.message);
  return (data ?? []) as Student[];
}

/** Existing scores for one exam+subject, keyed by student — only students with a saved row appear. */
async function fetchMarks(examId: string, subjectId: string, studentIds: string[]): Promise<Record<string, number | null>> {
  if (!studentIds.length) return {};
  const { data, error } = await supabase()
    .from("marks").select("student_id, score")
    .eq("exam_id", examId).eq("subject_id", subjectId).in("student_id", studentIds);
  if (error) throw new Error(error.message);
  const out: Record<string, number | null> = {};
  for (const row of (data ?? []) as { student_id: string; score: number | null }[]) out[row.student_id] = row.score;
  return out;
}

/**
 * Bulk entry, keyboard first. A teacher entering 40 marks should never touch
 * the mouse: type, Enter, next row. Marks are never auto-averaged from a
 * partial roster — the header says how many are still missing instead.
 */
export function Gradebook() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();

  const { data: classListData, loading: classesLoading } = useAsync(() => fetchTeacherClasses(profile.id), [profile.id]);
  const { data: term } = useAsync(() => fetchCurrentTerm(), [tenant.id]);
  const classesData = useMemo(() => classListData ?? [], [classListData]);

  const [classId, setClassId] = useState<string | null>(null);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [examId, setExamId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [scores, setScores] = useState<Record<string, string>>({});
  const [marksVersion, setMarksVersion] = useState(0);

  useEffect(() => {
    if (!classId && classesData.length > 0) setClassId(classesData[0]!.id);
  }, [classId, classesData]);

  // Subjects are scoped per class — reset the selection whenever the class changes.
  useEffect(() => { setSubjectId(null); }, [classId]);

  const { data: subjectListData } = useAsync(
    () => (classId ? fetchTeacherSubjectsForClass(profile.id, classId) : Promise.resolve([])),
    [classId, profile.id],
  );
  const subjectsData = useMemo(() => subjectListData ?? [], [subjectListData]);

  useEffect(() => {
    if (!subjectId && subjectsData.length > 0) setSubjectId(subjectsData[0]!.id);
  }, [subjectId, subjectsData]);

  const { data: examListData } = useAsync(() => (term?.id ? fetchExams(term.id) : Promise.resolve([])), [term?.id]);
  const examsData = useMemo(() => examListData ?? [], [examListData]);

  useEffect(() => {
    if (!examId && examsData.length > 0) setExamId(examsData[0]!.id);
  }, [examId, examsData]);

  const { data: rosterData, loading: rosterLoading } = useAsync(
    () => (classId ? fetchRoster(classId) : Promise.resolve([])),
    [classId],
  );
  const roster = rosterData ?? [];

  const { data: existingMarksData } = useAsync(
    () => (examId && subjectId && rosterData && rosterData.length
      ? fetchMarks(examId, subjectId, rosterData.map((s) => s.id))
      : Promise.resolve({} as Record<string, number | null>)),
    [examId, subjectId, rosterData, marksVersion],
  );
  const existingMarks = useMemo(() => existingMarksData ?? {}, [existingMarksData]);

  const subject = subjectsData.find((s) => s.id === subjectId);
  const exam = examsData.find((e) => e.id === examId);

  const value = (id: string) => {
    const key = `${classId}|${examId}|${subjectId}|${id}`;
    if (scores[key] !== undefined) return scores[key]!;
    if (id in existingMarks) {
      const s = existingMarks[id];
      return s === null ? "abs" : String(s);
    }
    return "";
  };

  function set(id: string, raw: string) {
    const key = `${classId}|${examId}|${subjectId}|${id}`;
    const parsed = parseScoreInput(raw);
    setScores((s) => ({ ...s, [key]: raw }));
    setErrors((e) => {
      const next = { ...e };
      if (parsed.ok) delete next[id]; else next[id] = parsed.message;
      return next;
    });
  }

  const entered = roster.filter((s) => value(s.id).trim() !== "").length;
  const summary = summarise(roster.map((s) => {
    const v = parseScoreInput(value(s.id));
    return { subject: s.id, score: v.ok ? v.score : null };
  }));
  const mean = useMemo(() => {
    const vals = Object.values(existingMarks).filter((v): v is number => v !== null);
    if (!vals.length) return null;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }, [existingMarks]);

  function focusNext(i: number) {
    const el = document.querySelector<HTMLInputElement>(`[data-row="${i + 1}"]`);
    el?.focus();
    el?.select();
  }

  async function saveDraft() {
    if (!examId || !subjectId) return;
    const rows = roster.flatMap((s) => {
      const raw = value(s.id).trim();
      if (raw === "") return [];
      const parsed = parseScoreInput(raw);
      if (!parsed.ok) return [];
      return [{
        tenant_id: tenant.id,
        exam_id: examId,
        student_id: s.id,
        subject_id: subjectId,
        score: parsed.score,
        entered_by: profile.id,
      }];
    });
    if (!rows.length) { toast("Nothing to save yet."); return; }
    const { error } = await supabase().from("marks").upsert(rows, { onConflict: "exam_id,student_id,subject_id" });
    if (error) { toast(`Could not save: ${error.message}`); return; }
    setMarksVersion((v) => v + 1);
    toast("Draft saved. Nothing is visible to parents yet.");
  }

  // Publishing flips the exam's published_at, which is what gates parent/student visibility elsewhere.
  async function publish() {
    if (!examId || !subject || !exam) return;
    const { error } = await supabase().from("exams").update({ published_at: new Date().toISOString() }).eq("id", examId);
    if (error) { toast(`Could not publish: ${error.message}`); return; }
    toast(`${subject.name} ${exam.name} published to ${roster.length} learners and their parents`);
  }

  if (classesLoading || !classId) {
    return (
      <>
        <PageHead eyebrow="Gradebook" title="Loading…" />
        <div className="px-7 py-6"><TableSkeleton rows={8} /></div>
      </>
    );
  }

  return (
    <>
      <PageHead
        eyebrow="Gradebook"
        title={subject && exam ? `${subject.name} · ${exam.name}` : "Loading…"}
        blurb="Type a mark and press Enter to drop to the next learner. Type abs for anyone who missed the paper — it is recorded as missing, not as zero."
        actions={
          <>
            <Button onClick={() => { void saveDraft(); }}>Save draft</Button>
            <Button
              variant="accent"
              disabled={entered < roster.length}
              onClick={() => { void publish(); }}
            >
              {entered < roster.length ? `${roster.length - entered} still to enter` : "Publish marks"}
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-7 py-3">
        <select value={classId} onChange={(e) => setClassId(e.target.value)} aria-label="Class" className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
          {classesData.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={subjectId ?? ""} onChange={(e) => setSubjectId(e.target.value)} aria-label="Subject" className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
          {subjectsData.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={examId ?? ""} onChange={(e) => setExamId(e.target.value)} aria-label="Exam" className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
          {examsData.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-4 text-[12.5px] text-ink-muted">
          <span>{entered} of {roster.length} entered</span>
          <span className="font-mono">
            {summary.meanScore === null ? "no mean yet" : `your mean ${summary.meanScore}`}
          </span>
          <span className="font-mono">
            {mean === null ? "no class mean yet" : `class mean ${mean}`}
          </span>
        </div>
      </div>

      <div className="px-7 py-6">
        {rosterLoading ? (
          <TableSkeleton rows={8} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-line bg-white">
            <div className="grid gap-3.5 border-b border-line bg-sunken px-4 py-2.5 font-mono text-micro tracking-[0.1em] text-ink-muted"
              style={{ gridTemplateColumns: "40px minmax(0,2fr) 120px 80px minmax(0,1.4fr)" }}>
              <div>#</div><div>LEARNER</div><div>MARK / 100</div><div>GRADE</div><div>AGAINST CLASS MEAN</div>
            </div>

            {roster.map((s, i) => {
              const raw = value(s.id);
              const parsed = parseScoreInput(raw);
              const score = parsed.ok ? parsed.score : null;
              const grade = score === null ? null : gradeFor(score);
              const err = errors[s.id];
              return (
                <div key={s.id} className="grid items-center gap-3.5 border-b border-line-soft px-4 py-2"
                  style={{ gridTemplateColumns: "40px minmax(0,2fr) 120px 80px minmax(0,1.4fr)" }}>
                  <div className="font-mono text-[11px] text-ink-faint">{i + 1}</div>
                  <div className="min-w-0">
                    <div className="truncate text-body font-medium">{s.full_name}</div>
                    <div className="font-mono text-[10.5px] text-ink-faint">ADM {s.admission_no}</div>
                  </div>
                  <div>
                    <input
                      data-row={i}
                      value={raw}
                      onChange={(e) => set(s.id, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); focusNext(i); } }}
                      inputMode="numeric"
                      aria-label={`Mark for ${s.full_name}`}
                      aria-invalid={!!err}
                      className="w-[92px] rounded-md border px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-forest"
                      style={{ borderColor: err ? "#B8460A" : "#D3DAD5" }}
                    />
                    {err && <div className="mt-1 text-[11px] text-warn-ink">{err}</div>}
                  </div>
                  <div className="font-mono text-[14px] font-medium" style={{ color: grade ? GRADE_INK[grade] : "#9AA69E" }}>
                    {grade ?? (raw.trim().toLowerCase().startsWith("abs") ? "abs" : "—")}
                  </div>
                  <div className="text-[12.5px] text-ink-muted">
                    {score === null || mean === null ? "" : score === mean ? `Exactly the class mean of ${mean}` : `${Math.abs(score - mean)} ${score > mean ? "above" : "below"} the mean`}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="mt-4 max-w-[620px] text-[12.5px] leading-relaxed text-ink-muted">
          Publishing sends the marks to parents and students at the same moment. Until then only you can see them, so a
          mistyped mark never reaches a parent before you have checked the column.
        </p>
      </div>
    </>
  );
}
