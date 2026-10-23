import type { PublishedExam } from "@figbloom/shared";

/**
 * Moves between the exams a learner has results for. Teachers publish a class
 * and subject at a time, so the newest exam can be only partly out: each pill
 * says how many subjects, and the earlier complete exam is one tap away.
 * Nothing to switch between with fewer than two.
 */
export function ExamSwitcher({ exams, value, onPick }: {
  exams: PublishedExam[];
  value: string | null;
  onPick: (examId: string) => void;
}) {
  if (exams.length < 2) return null;
  return (
    <div role="group" aria-label="Exam" className="mb-5 flex flex-wrap gap-1.5">
      {exams.map((e) => {
        const on = e.id === value;
        return (
          <button
            key={e.id}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(e.id)}
            className="rounded-full px-3 py-1.5 text-[12px]"
            style={on ? { background: "#17402A", color: "#fff", fontWeight: 600 } : { background: "#EEF1EE", color: "#5F6B62" }}
          >
            {e.name}
            <span style={{ opacity: 0.7 }}> · {e.subjectCount} subject{e.subjectCount === 1 ? "" : "s"}</span>
          </button>
        );
      })}
    </div>
  );
}
