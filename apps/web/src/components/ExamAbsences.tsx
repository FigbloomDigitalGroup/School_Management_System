import { ABSENCE_LABEL, fetchExamAbsences } from "@figbloom/shared";
import { useAsync } from "../lib/useAsync";

/**
 * Subjects of one exam a learner has no score in because they missed the
 * paper or were excused (marks.absence, 20261030100000_exam_extensions).
 * They are left out of the mean and the grade above, never counted as 0, so
 * this says why they aren't in the table. Nothing when there are none.
 */
export function ExamAbsences({ studentId, examId }: { studentId: string; examId: string | null }) {
  const { data } = useAsync(
    () => (examId ? fetchExamAbsences(studentId, examId) : Promise.resolve([])),
    [studentId, examId],
  );
  if (!data?.length) return null;
  return (
    <div className="mt-3 rounded-lg border border-line-soft bg-page px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-muted">
      <span className="font-semibold text-ink">No mark: </span>
      {data.map((a) => `${a.name} (${ABSENCE_LABEL[a.absence]})`).join(", ")}.
      {" "}Not counted as 0 and left out of the mean.
    </div>
  );
}
