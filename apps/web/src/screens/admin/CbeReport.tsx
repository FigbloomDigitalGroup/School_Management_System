import { CBE_BANDS, GRADE_INK, fetchCbeBandReport, type CbeBandRow } from "@figbloom/shared";
import { DataTable } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";

export function CbeReport({ tenantId, termId, country }: { tenantId: string; termId: string | null; country: string }) {
  const { data, loading } = useAsync(() => (termId ? fetchCbeBandReport(tenantId, termId, country) : Promise.resolve([] as CbeBandRow[])), [tenantId, termId, country]);
  // Hold the table's place while a term's report loads rather than popping in after.
  if (loading && termId) return <div className="mt-4"><TableSkeleton rows={4} /></div>;
  if (!data?.length) return null;
  return (
    <div className="mt-4">
      <DataTable
        title="CBE learning areas · latest published assessment"
        columns={[
          { key: "class", header: "Class", render: (r: CbeBandRow) => <span className="text-[13px] font-medium">{r.className}</span> },
          { key: "area", header: "Learning area", width: "1.4fr", render: (r: CbeBandRow) => (
            <div className="min-w-0"><div className="truncate text-[13px]">{r.subjectName}</div><div className="truncate text-[11px] text-ink-faint">{r.assessmentTitle}</div></div>
          ) },
          { key: "spread", header: "Learners by overall level", width: "2fr", render: (r: CbeBandRow) => (
            <div>
              <div className="flex h-2 overflow-hidden rounded-full bg-sunken" aria-hidden>
                {CBE_BANDS.map((b) => r.counts[b] > 0 && <span key={b} style={{ width: `${(r.counts[b] / r.learners) * 100}%`, background: GRADE_INK[b] }} />)}
              </div>
              <div className="mt-1 flex gap-3 font-mono text-[11.5px]">
                {CBE_BANDS.map((b) => <span key={b} style={{ color: GRADE_INK[b] }}>{b} {r.counts[b]}</span>)}
                <span className="text-ink-faint">of {r.learners}</span>
              </div>
            </div>
          ) },
        ]}
        rows={data}
        rowKey={(r) => r.key}
        minWidth="620px"
        empty={{ title: "No published assessments yet.", body: "Once a teacher publishes a strand assessment, each class's spread appears here." }}
      />
    </div>
  );
}
