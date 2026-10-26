import { useMemo, useState } from "react";
import {
  describeChange, fetchCbeLevels, fetchLearnerTrend, cbeLevelTrend, RUBRIC_BANDS, subjectStandings,
  type LearnerTrend, type SubjectStanding,
} from "@figbloom/shared";
import { Cell, DataTable, Mono } from "../ui/DataTable";
import { TableSkeleton } from "../ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { fmt, MAX_SERIES } from "./ChartFrame";
import { DistributionChart } from "./DistributionChart";
import { LineChart } from "./LineChart";
import { SeriesPicker } from "./SeriesPicker";

interface Props {
  studentId: string;
  /** The learner's line: "Amani's mean", or "Your mean" on the learner's own screen. */
  meanLabel: string;
}

/**
 * One learner's results over time: overall mean against the class, chosen
 * subjects side by side, where they're strongest and weakest, and CBE rubric
 * levels by month. Published results only (learner_results_history), so the
 * same view is safe for families and staff.
 */
export function LearnerProgress({ studentId, meanLabel }: Props) {
  const { data, loading, error } = useAsync(
    () => Promise.all([fetchLearnerTrend(studentId), fetchCbeLevels({ studentId })]),
    [studentId],
  );
  const trend = data?.[0];
  const cbe = useMemo(() => cbeLevelTrend(data?.[1] ?? []), [data]);

  if (error) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
        <span aria-hidden>✕</span>Could not load progress over time: {error.message}
      </p>
    );
  }
  if (loading || !trend) return <TableSkeleton rows={4} />;
  if (trend.exams.length === 0 && cbe.length === 0) return null;

  return (
    // viz-root: the tables' change arrows use the chart tokens too
    <div className="viz-root space-y-4">
      {trend.exams.length > 0 && <ExamProgress trend={trend} meanLabel={meanLabel} />}
      {cbe.length > 0 && (
        <DistributionChart
          title="CBE rubric levels over time"
          summary="Every published strand judgement, by month. EE1 and EE2 count as EE, and so on."
          bands={RUBRIC_BANDS}
          rows={cbe}
          noun="judgements"
        />
      )}
    </div>
  );
}

function ExamProgress({ trend, meanLabel }: { trend: LearnerTrend; meanLabel: string }) {
  const standings = useMemo(() => subjectStandings(trend), [trend]);
  // Strongest and weakest to start with: the two a parent asks about first.
  const [picked, setPicked] = useState<string[] | null>(null);
  const chosen = picked ?? [...new Set([standings[0]?.id, standings[standings.length - 1]?.id].filter((v): v is string => !!v))];
  const points = trend.exams.map((e) => ({ label: e.name, sublabel: e.termName }));
  const onlyOne = trend.exams.length === 1;

  return (
    <>
      {onlyOne && (
        <p className="rounded-lg border border-line bg-sunken px-3 py-2.5 text-[12.5px] text-ink-muted">
          One exam is out so far. Trends fill in as more results are published.
        </p>
      )}
      <LineChart
        title="Mean mark over time"
        summary={describeChange(trend.overall, trend.exams) ?? "The mean of every subject sat in each exam, against the class."}
        points={points}
        series={[
          { key: "learner", name: meanLabel, values: trend.overall },
          { key: "class", name: "Class mean", values: trend.classOverall },
        ]}
      />
      <LineChart
        title="Subjects over time"
        summary={chosen.length ? `Pick up to ${MAX_SERIES} subjects to compare.` : "Pick subjects to compare."}
        points={points}
        series={trend.subjects.filter((s) => chosen.includes(s.id)).map((s) => ({ key: s.id, name: s.name, values: s.scores }))}
        controls={<SeriesPicker label="Subjects to show" options={trend.subjects} chosen={chosen} onChange={setPicked} />}
      />
      <DataTable
        title="Strengths and subjects to watch"
        columns={[
          { key: "name", header: "Subject", width: "1.5fr", render: (s: SubjectStanding) => <Cell sub={`${s.sittings} exam${s.sittings === 1 ? "" : "s"}`}>{s.name}</Cell> },
          { key: "avg", header: "Average", align: "right", width: "0.7fr", render: (s: SubjectStanding) => <Mono>{fmt(s.average)}</Mono> },
          { key: "latest", header: "Latest", align: "right", width: "0.7fr", render: (s: SubjectStanding) => <Mono>{fmt(s.latest)}</Mono> },
          { key: "change", header: "Since first", align: "right", width: "0.8fr", render: (s: SubjectStanding) => <Change value={s.change} /> },
          {
            key: "vs", header: "Against class", align: "right", width: "1fr",
            render: (s: SubjectStanding) => (
              <span className="text-[12.5px] text-ink-muted">
                {s.vsClass === null ? "—" : Math.abs(s.vsClass) < 0.5 ? "At the class mean" : `${fmt(Math.abs(s.vsClass))} ${s.vsClass > 0 ? "above" : "below"}`}
              </span>
            ),
          },
        ]}
        rows={standings}
        rowKey={(s) => s.id}
        minWidth="560px"
        empty={{ title: "No subjects yet", body: "Subjects appear here once results are published." }}
      />
    </>
  );
}

/** A signed change with an arrow: never colour alone. */
export function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[12.5px] text-ink-faint">—</span>;
  if (Math.abs(value) < 0.5) return <Mono>±0</Mono>;
  const up = value > 0;
  return (
    <span className="font-mono text-[12.5px] font-semibold tabular-nums" style={{ color: up ? "var(--viz-up)" : "var(--viz-down)" }}>
      <span aria-hidden>{up ? "▲" : "▼"} </span>
      <span className="sr-only">{up ? "up " : "down "}</span>
      {up ? "+" : "−"}{fmt(Math.abs(value))}
    </span>
  );
}
