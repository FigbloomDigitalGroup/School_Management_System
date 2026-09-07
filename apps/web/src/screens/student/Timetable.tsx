import { useStudentData } from "../../lib/studentContext";
import { PageHead } from "../../components/ConsoleShell";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { EmptyState } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { fetchClassTimetable } from "../../lib/timetable";

/**
 * The weekly timetable is real per-class data (timetable_slots), fetched
 * once the student's class is known. Desktop gets the whole week as one
 * grid instead of a single scrollable day.
 */
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
const DAY_LABEL: Record<(typeof DAYS)[number], string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday",
};
const NOW_DAY = "Tue";
const NOW = 2;

interface PeriodRow {
  i: number;
  time: string;
}

export function StudentTimetable() {
  const { data, loading, error } = useStudentData();
  const { data: timetable, loading: timetableLoading } = useAsync(
    () => (data?.classId ? fetchClassTimetable(data.classId) : Promise.resolve(null)),
    [data?.classId],
  );

  if (error) {
    return (
      <>
        <PageHead eyebrow="Timetable" title="Timetable" />
        <div className="px-7 py-6">
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the timetable: {error.message}
          </p>
        </div>
      </>
    );
  }

  if (loading || (data && timetableLoading)) {
    return (
      <>
        <PageHead eyebrow="Timetable" title="Loading…" />
        <div className="px-7 py-6"><TableSkeleton rows={8} /></div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHead eyebrow="Timetable" title="Timetable" />
        <div className="px-7 py-6">
          <EmptyState title="No learner record" body="This login is not yet linked to a learner record. Contact the school office." />
        </div>
      </>
    );
  }

  const week = timetable ?? { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
  const periodCount = Math.max(...DAYS.map((d) => week[d].length), 0);
  const rows: PeriodRow[] = Array.from({ length: periodCount }, (_, i) => ({
    i,
    time: week.Mon[i]?.[0] ?? week[NOW_DAY][i]?.[0] ?? "",
  }));

  return (
    <>
      <PageHead eyebrow="Timetable" title={data.className || "Timetable"} blurb="Your full week, period by period." />

      <div className="px-7 py-6">
        <DataTable
          title="Weekly timetable"
          minWidth="920px"
          columns={[
            { key: "time", header: "Time", width: "0.55fr", render: (r: PeriodRow) => <Mono>{r.time}</Mono> },
            ...DAYS.map((d) => ({
              key: d,
              header: DAY_LABEL[d],
              width: "1fr",
              render: (r: PeriodRow) => {
                const period = week[d][r.i];
                const isNow = d === NOW_DAY && r.i === NOW;
                if (!period) return <span className="text-[12px] text-ink-faint">—</span>;
                return (
                  <div className={`rounded-md px-2 py-1 ${isNow ? "bg-orange-soft" : ""}`}>
                    <Cell sub={period[2]}>{period[1]}</Cell>
                    {isNow && <span className="mt-1 inline-block rounded-full bg-orange px-2 py-0.5 text-[10px] font-bold text-white">NOW</span>}
                  </div>
                );
              },
            })),
          ]}
          rows={rows}
          rowKey={(r) => String(r.i)}
          empty={{ title: "No timetable set", body: "This class does not have a timetable configured yet." }}
        />
      </div>
    </>
  );
}
