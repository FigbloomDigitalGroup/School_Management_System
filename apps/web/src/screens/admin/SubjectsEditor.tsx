import { useState } from "react";
import { fetchClassSubjects, setClassSubjectTeacher, type ClassLevel } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

interface TeacherOption { id: string; full_name: string }

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
  // A reloadKey refetch keeps what's already on screen; switching to a different class's
  // data must not show the previous one's meanwhile — skeleton for those only.
  const classKey = `${tenantId}:${classId}:${classLevel}:${formLevel}`;
  const [loadedFor, setLoadedFor] = useState(classKey);
  if (!loading && loadedFor !== classKey) setLoadedFor(classKey);
  const pending = loading && (!rows || loadedFor !== classKey);
  const reload = () => setReloadKey((k) => k + 1);

  async function setTeacher(subjectId: string, teacherId: string) {
    try {
      await setClassSubjectTeacher({ tenantId, classId, subjectId, teacherId: teacherId || null });
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not update that assignment: ${err.message}` : "Could not update that assignment.", "error");
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
      ) : pending || !rows ? (
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
