import { useEffect, useState } from "react";
import { MARK_LABEL, MARK_STYLE, supabase, type AttendanceMark } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";

interface RosterMark { id: string; name: string; admissionNo: string; mark: AttendanceMark }

async function fetchClassAttendance(classId: string, date: string): Promise<RosterMark[]> {
  const sb = supabase();
  const [{ data: students, error: e1 }, { data: marks, error: e2 }] = await Promise.all([
    sb.from("students").select("id, full_name, admission_no").eq("class_id", classId).eq("active", true).order("full_name")
      .returns<{ id: string; full_name: string; admission_no: string }[]>(),
    sb.from("attendance").select("student_id, mark").eq("class_id", classId).eq("taken_on", date)
      .returns<{ student_id: string; mark: AttendanceMark }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);

  const markByStudent = new Map((marks ?? []).map((m) => [m.student_id, m.mark]));
  return (students ?? []).map((s) => ({
    id: s.id,
    name: s.full_name,
    admissionNo: s.admission_no,
    mark: markByStudent.get(s.id) ?? "present",
  }));
}

/**
 * Opened from the Dashboard's attendance fraction — a principal's next
 * question after seeing a class isn't fully present is always "who,
 * exactly", and by what kind of absence (late arrivals aren't absentees).
 */
export function AttendanceDetail({ classId, className, date, onClose }: {
  classId: string; className: string; date: string; onClose: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<RosterMark[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchClassAttendance(classId, date)
      .then((r) => { if (alive) setRows(r); })
      .catch((err: Error) => { if (alive) toast(`Could not load attendance: ${err.message}`); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, date]);

  const away = (rows ?? []).filter((r) => r.mark !== "present");

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={date}
      title={`${className} · who wasn't here`}
      blurb="Learners marked present are left off this list — only late arrivals, absences and excusals show here."
      actions={<Button onClick={onClose}>Close</Button>}
    >
      {!rows ? (
        <TableSkeleton rows={4} />
      ) : away.length === 0 ? (
        <p className="text-[13px] text-ink-muted">Everyone in {className} was present and on time.</p>
      ) : (
        <ul className="grid gap-2">
          {away.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-line-soft px-3 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium">{r.name}</span>
                <span className="font-mono text-[11px] text-ink-faint">ADM {r.admissionNo}</span>
              </span>
              <span
                className="shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                style={{ background: MARK_STYLE[r.mark].bg, color: MARK_STYLE[r.mark].ink }}
              >
                {MARK_LABEL[r.mark]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
