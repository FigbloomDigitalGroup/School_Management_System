import { changeOver, fetchSemesterGpas } from "@figbloom/shared";
import { useAsync } from "../../lib/useAsync";
import { TableSkeleton } from "../ui/Skeleton";
import { LineChart } from "./LineChart";

/**
 * A higher-ed learner's GPA semester by semester, with the cumulative GPA
 * beside it. Finalized course grades only, the same ones the GPA tile counts.
 */
export function GpaProgress({ studentId }: { studentId: string }) {
  const { data, loading, error } = useAsync(() => fetchSemesterGpas(studentId), [studentId]);
  if (error) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
        <span aria-hidden>✕</span>Could not load GPA over time: {error.message}
      </p>
    );
  }
  if (loading || !data) return <TableSkeleton rows={3} />;
  if (data.length === 0) return null;

  // changeOver() rounds to one place, too coarse for a GPA: the difference is taken here.
  const c = changeOver(data.map((s) => s.cumulative));
  const delta = c ? c.to - c.from : 0;
  const summary = !c ? "One finalized semester so far."
    : Math.abs(delta) < 0.005 ? `Cumulative GPA steady since ${data[c.fromIndex]!.name}`
    : `Cumulative GPA ${delta > 0 ? "up" : "down"} ${Math.abs(delta).toFixed(2)} since ${data[c.fromIndex]!.name}`;
  return (
    <LineChart
      title="GPA over time"
      summary={summary}
      points={data.map((s) => ({ label: s.name, sublabel: `${s.credits} credits` }))}
      series={[
        { key: "semester", name: "Semester GPA", values: data.map((s) => s.gpa) },
        { key: "cumulative", name: "Cumulative GPA", values: data.map((s) => s.cumulative) },
      ]}
      yMax={4}
      yTicks={[0, 1, 2, 3, 4]}
      digits={2}
    />
  );
}
