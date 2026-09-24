import { useState } from "react";
import { subjectOffered, supabase, type ClassLevel, type Subject } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

interface TeacherOption { id: string; full_name: string }
interface SubjectRow { subject: Subject; teacherId: string | null }
interface ClassSubjectsData { rows: SubjectRow[]; qualifiedTeacherIdsBySubject: Map<string, Set<string>> }

async function fetchClassSubjects(tenantId: string, classId: string, classLevel: ClassLevel, formLevel: number): Promise<ClassSubjectsData> {
  const sb = supabase();
  const [{ data: subjects, error: e1 }, { data: assignments, error: e2 }, { data: specializations, error: e3 }] = await Promise.all([
    sb.from("subjects").select("*").eq("tenant_id", tenantId).order("name").returns<Subject[]>(),
    sb.from("teaching_assignments").select("subject_id, teacher_id").eq("class_id", classId)
      .returns<{ subject_id: string; teacher_id: string }[]>(),
    sb.from("teacher_subjects").select("subject_id, teacher_id").eq("tenant_id", tenantId).returns<{ subject_id: string; teacher_id: string }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  if (e3) throw new Error(e3.message);

  // A subject applies here unless it's explicitly bounded to a form/grade
  // range that excludes this class — e.g. "Computer Studies" set to
  // Form 1-2 only won't show up on this list for a Form 3 class at all.
  const offered = (subjects ?? []).filter((s) => subjectOffered(s, { level: classLevel, year: formLevel }));

  const teacherBySubject = new Map((assignments ?? []).map((a) => [a.subject_id, a.teacher_id]));
  const rows = offered.map((s) => ({ subject: s, teacherId: teacherBySubject.get(s.id) ?? null }));

  const qualifiedTeacherIdsBySubject = new Map<string, Set<string>>();
  for (const row of specializations ?? []) {
    const ids = qualifiedTeacherIdsBySubject.get(row.subject_id) ?? new Set<string>();
    ids.add(row.teacher_id);
    qualifiedTeacherIdsBySubject.set(row.subject_id, ids);
  }

  return { rows, qualifiedTeacherIdsBySubject };
}

/**
 * Who teaches what, in this one class. This is the only place teaching_assignments
 * rows get created — a teacher's "My classes" (subjects column) and their ability
 * to enter marks in Gradebook both come from what's set here, not from the
 * class's timetable (which is just free-text period labels, unrelated data).
 *
 * The subject list itself (name, code, which forms/grades offer it) is
 * managed school-wide under Subjects, not here (FIG-406) — this only
 * assigns a teacher to whichever subjects actually apply to this class.
 */
export function SubjectsEditor({ classId, className, tenantId, classLevel, formLevel, teachers, onClose }: {
  classId: string; className: string; tenantId: string; classLevel: ClassLevel; formLevel: number;
  teachers: TeacherOption[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchClassSubjects(tenantId, classId, classLevel, formLevel), [tenantId, classId, classLevel, formLevel, reloadKey]);
  const rows = data?.rows;
  const reload = () => setReloadKey((k) => k + 1);

  async function setTeacher(subjectId: string, teacherId: string) {
    try {
      if (!teacherId) {
        const { error: err } = await supabase().from("teaching_assignments")
          .delete().eq("class_id", classId).eq("subject_id", subjectId);
        if (err) throw err;
      } else {
        const { error: err } = await supabase().from("teaching_assignments").upsert(
          { tenant_id: tenantId, class_id: classId, subject_id: subjectId, teacher_id: teacherId },
          { onConflict: "class_id,subject_id" },
        );
        if (err) throw err;
      }
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not update that assignment: ${err.message}` : "Could not update that assignment.");
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Subjects"
      title={`Subjects · ${className}`}
      blurb="Pick who teaches each subject here — this is what shows on a teacher's own 'My classes' page, and what lets them enter marks in Gradebook. Add a subject, rename one, or change which forms offer it under Subjects in the sidebar."
      actions={<Button onClick={onClose}>Done</Button>}
    >
      {error ? (
        <p className="text-[12.5px] text-warn-ink">Could not load subjects: {error.message}</p>
      ) : loading || !rows ? (
        <TableSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <p className="text-[12.5px] text-ink-muted">No subjects apply to this class yet — add or widen one under Subjects in the sidebar.</p>
      ) : (
        <ul className="grid gap-1.5">
          {rows.map((r) => {
            const qualifiedIds = data?.qualifiedTeacherIdsBySubject.get(r.subject.id);
            const qualified = qualifiedIds ? teachers.filter((t) => qualifiedIds.has(t.id)) : [];
            const others = qualifiedIds ? teachers.filter((t) => !qualifiedIds.has(t.id)) : teachers;
            return (
              <li key={r.subject.id} className="flex items-center gap-3 rounded-lg border border-line-soft px-3 py-2">
                <span className="min-w-0 flex-1 text-[13px] font-medium">{r.subject.name}</span>
                <span className="font-mono text-[11px] text-ink-faint">{r.subject.code}</span>
                <select
                  value={r.teacherId ?? ""}
                  onChange={(e) => void setTeacher(r.subject.id, e.target.value)}
                  aria-label={`Teacher for ${r.subject.name}`}
                  className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
                >
                  <option value="">Unassigned</option>
                  {qualified.length > 0 ? (
                    <>
                      <optgroup label={`Teaches ${r.subject.name}`}>
                        {qualified.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                      </optgroup>
                      <optgroup label="Other teachers">
                        {others.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                      </optgroup>
                    </>
                  ) : (
                    others.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)
                  )}
                </select>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
