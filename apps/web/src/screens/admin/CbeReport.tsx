import { GRADE_INK, rubricFor, summariseStrands, supabase, yearSortKey, type ClassLevel } from "@figbloom/shared";
import { DataTable } from "../../components/ui/DataTable";
import { useAsync } from "../../lib/useAsync";

const BANDS = ["EE", "ME", "AE", "BE"] as const;
type Band = (typeof BANDS)[number];

interface Row {
  key: string;
  className: string;
  subjectName: string;
  assessmentTitle: string;
  counts: Record<Band, number>;
  learners: number;
  sort: number;
}

/** Per class x learning area, the latest published assessment this term:
 *  how many learners sit at each rubric band overall. 8-level results fold
 *  into their band (EE1 and EE2 are both EE) so every class reads the same way. */
interface ReportRow {
  student_id: string;
  level_code: string;
  cbe_assessments: {
    id: string; title: string; assessed_on: string; class_id: string; subject_id: string;
    subjects: { name: string } | null; classes: { name: string; level: ClassLevel; form_level: number } | null;
  };
}

async function fetchCbeReport(tenantId: string, termId: string, country: string): Promise<Row[]> {
  const { data, error } = await supabase().from("cbe_results")
    .select("student_id, level_code, cbe_assessments!inner(id, title, assessed_on, published_at, term_id, class_id, subject_id, subjects(name), classes(name, level, form_level))")
    .eq("tenant_id", tenantId)
    .eq("cbe_assessments.term_id", termId)
    .not("cbe_assessments.published_at", "is", null)
    .returns<ReportRow[]>();
  if (error) throw new Error(error.message);

  const latest = new Map<string, { id: string; on: string }>();
  for (const r of data ?? []) {
    const k = `${r.cbe_assessments.class_id}:${r.cbe_assessments.subject_id}`;
    const cur = latest.get(k);
    if (!cur || r.cbe_assessments.assessed_on > cur.on) latest.set(k, { id: r.cbe_assessments.id, on: r.cbe_assessments.assessed_on });
  }

  const byAssessment = new Map<string, { a: ReportRow["cbe_assessments"]; codes: Map<string, string[]> }>();
  for (const r of data ?? []) {
    const k = `${r.cbe_assessments.class_id}:${r.cbe_assessments.subject_id}`;
    if (latest.get(k)?.id !== r.cbe_assessments.id) continue;
    const g = byAssessment.get(k) ?? { a: r.cbe_assessments, codes: new Map() };
    g.codes.set(r.student_id, [...(g.codes.get(r.student_id) ?? []), r.level_code]);
    byAssessment.set(k, g);
  }

  const rows: Row[] = [];
  for (const [key, g] of byAssessment) {
    const level = g.a.classes?.level ?? "primary";
    const rubric = rubricFor(country, level) ?? [];
    const counts: Record<Band, number> = { EE: 0, ME: 0, AE: 0, BE: 0 };
    for (const codes of g.codes.values()) {
      const overall = summariseStrands(codes, rubric).overall;
      if (overall) counts[overall.code.slice(0, 2) as Band] += 1;
    }
    rows.push({
      key, className: g.a.classes?.name ?? "Class", subjectName: g.a.subjects?.name ?? "Learning area", assessmentTitle: g.a.title,
      counts, learners: g.codes.size, sort: yearSortKey(level, g.a.classes?.form_level ?? 0),
    });
  }
  return rows.sort((a, b) => a.sort - b.sort || a.className.localeCompare(b.className) || a.subjectName.localeCompare(b.subjectName));
}

export function CbeReport({ tenantId, termId, country }: { tenantId: string; termId: string | null; country: string }) {
  const { data } = useAsync(() => (termId ? fetchCbeReport(tenantId, termId, country) : Promise.resolve([] as Row[])), [tenantId, termId, country]);
  if (!data?.length) return null;
  return (
    <div className="mt-4">
      <DataTable
        title="CBE learning areas · latest published assessment"
        columns={[
          { key: "class", header: "Class", render: (r: Row) => <span className="text-[13px] font-medium">{r.className}</span> },
          { key: "area", header: "Learning area", width: "1.4fr", render: (r: Row) => (
            <div className="min-w-0"><div className="truncate text-[13px]">{r.subjectName}</div><div className="truncate text-[11px] text-ink-faint">{r.assessmentTitle}</div></div>
          ) },
          { key: "spread", header: "Learners by overall level", width: "2fr", render: (r: Row) => (
            <div>
              <div className="flex h-2 overflow-hidden rounded-full bg-sunken" aria-hidden>
                {BANDS.map((b) => r.counts[b] > 0 && <span key={b} style={{ width: `${(r.counts[b] / r.learners) * 100}%`, background: GRADE_INK[b] }} />)}
              </div>
              <div className="mt-1 flex gap-3 font-mono text-[11.5px]">
                {BANDS.map((b) => <span key={b} style={{ color: GRADE_INK[b] }}>{b} {r.counts[b]}</span>)}
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
