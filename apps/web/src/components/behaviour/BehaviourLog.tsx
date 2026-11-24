import { useState, type ReactNode } from "react";
import {
  BEHAVIOUR_KIND_LABEL, fetchBehaviourEntriesPage,
  type BehaviourCategory, type BehaviourEntryRow, type BehaviourKind, type EntryFilters,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import { Cell, DataTable } from "../ui/DataTable";
import { Pagination } from "../ui/Pagination";
import { TableSkeleton } from "../ui/Skeleton";
import { usePaging } from "../ui/usePaging";
import { useAsync } from "../../lib/useAsync";
import { FollowUpBadge, KindBadge, PointsText } from "./Behaviour";

const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-KE", { day: "numeric", month: "short" });

const selectCls = "rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[12.5px]";

/**
 * The behaviour log, paged on the server (newest first) with filters. The office filters by class,
 * kind, category, teacher and dates; a teacher's view is fixed to one class. RLS decides whose
 * entries come back.
 */
export function BehaviourLog({ tenantId, fixed, classes, categories, recorders, title, reloadKey, onOpenLearner, rowAction, filterSet = "office" }: {
  tenantId: string;
  /** Filters the viewer can't change (a teacher's class; the incidents list's "serious"). */
  fixed?: EntryFilters;
  classes?: { id: string; name: string }[];
  categories: BehaviourCategory[];
  recorders?: { id: string; full_name: string }[];
  title?: string;
  reloadKey: number;
  onOpenLearner?: (studentId: string, name: string) => void;
  rowAction?: (e: BehaviourEntryRow) => ReactNode;
  filterSet?: "office" | "teacher" | "incidents";
}) {
  const [classId, setClassId] = useState("");
  const [kind, setKind] = useState<BehaviourKind | "">("");
  const [categoryId, setCategoryId] = useState("");
  const [recordedBy, setRecordedBy] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [openOnly, setOpenOnly] = useState(filterSet === "incidents");
  const filters: EntryFilters = {
    classId: classId || null, kind: kind || null, categoryId: categoryId || null, recordedBy: recordedBy || null,
    from: from || null, to: to || null, openOnly: filterSet === "incidents" ? openOnly : false, ...fixed,
  };
  const key = JSON.stringify(filters);
  const [total, setTotal] = useState(0);
  const paging = usePaging(total, key, 25);
  const { data, loading, error } = useAsync(async () => {
    const page = await fetchBehaviourEntriesPage(tenantId, filters, paging.offset, paging.size);
    setTotal(page.total);
    return page;
  }, [tenantId, key, paging.offset, paging.size, reloadKey]);

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2">
      {filterSet === "office" && classes && (
        <select aria-label="Class" className={selectCls} value={classId} onChange={(e) => setClassId(e.target.value)}>
          <option value="">All classes</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      {filterSet !== "incidents" && (
        <select aria-label="Kind" className={selectCls} value={kind} onChange={(e) => { setKind(e.target.value as BehaviourKind | ""); setCategoryId(""); }}>
          <option value="">Merits and demerits</option>
          {(["merit", "demerit", "incident"] as const).map((k) => <option key={k} value={k}>{BEHAVIOUR_KIND_LABEL[k]}s</option>)}
        </select>
      )}
      {filterSet !== "incidents" && (
        <select aria-label="Category" className={selectCls} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">All categories</option>
          {categories.filter((c) => !kind || c.kind === kind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      {filterSet === "office" && recorders && (
        <select aria-label="Recorded by" className={selectCls} value={recordedBy} onChange={(e) => setRecordedBy(e.target.value)}>
          <option value="">Any teacher</option>
          {recorders.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
        </select>
      )}
      {filterSet === "incidents" && (
        <select aria-label="Follow-up" className={selectCls} value={openOnly ? "open" : "all"} onChange={(e) => setOpenOnly(e.target.value === "open")}>
          <option value="open">Open</option>
          <option value="all">Open and resolved</option>
        </select>
      )}
      <input aria-label="From" type="date" className={selectCls} value={from} onChange={(e) => setFrom(e.target.value)} />
      <span className="text-[12px] text-ink-faint">to</span>
      <input aria-label="To" type="date" className={selectCls} value={to} onChange={(e) => setTo(e.target.value)} />
      {(classId || kind || categoryId || recordedBy || from || to) && (
        <Button onClick={() => { setClassId(""); setKind(""); setCategoryId(""); setRecordedBy(""); setFrom(""); setTo(""); }}>Clear</Button>
      )}
    </div>
  );

  if (error) return <p className="text-[12.5px] text-warn-ink">Could not load the log: {error.message}</p>;
  return (
    <div className="grid gap-2">
      {loading && !data ? <TableSkeleton rows={8} /> : (
        <DataTable<BehaviourEntryRow>
          title={title}
          filters={filterBar}
          pageSize={0}
          minWidth="900px"
          rows={data?.rows ?? []}
          rowKey={(e) => e.id}
          rowsLabel="entries"
          empty={{ title: filterSet === "incidents" ? "No serious incidents here." : "Nothing recorded here yet.", body: "Merits, demerits and incidents appear here as teachers record them." }}
          columns={[
            { key: "date", header: "Date", width: "0.6fr", render: (e) => <span className="text-[12.5px]" style={e.voided_at ? { textDecoration: "line-through" } : undefined}>{shortDate(e.occurred_on)}</span> },
            { key: "learner", header: "Learner", width: "1.4fr", render: (e) => (
              onOpenLearner
                ? <button type="button" className="text-left hover:underline" onClick={() => onOpenLearner(e.student_id, e.studentName)}><Cell sub={e.className ?? undefined}>{e.studentName}</Cell></button>
                : <Cell sub={e.className ?? undefined}>{e.studentName}</Cell>
            ) },
            { key: "what", header: "What", width: "1.6fr", render: (e) => (
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5"><span className="text-[13px] font-semibold">{e.categoryName ?? BEHAVIOUR_KIND_LABEL[e.kind]}</span><KindBadge e={e} /></div>
                {e.note && <div className="truncate text-[12px] text-ink-muted" title={e.note}>{e.note}</div>}
                {e.staffNote && <div className="truncate text-[12px] text-ink-faint" title={e.staffNote}>Staff only: {e.staffNote}</div>}
              </div>
            ) },
            { key: "points", header: "Points", width: "0.5fr", align: "right", render: (e) => <PointsText n={e.points} /> },
            { key: "by", header: "Recorded by", width: "1fr", render: (e) => <span className="text-[12.5px]">{e.recorderName ?? "—"}</span> },
            { key: "follow", header: "Follow-up", width: "1fr", render: (e) => <FollowUpBadge e={e} /> },
            ...(rowAction ? [{ key: "act", header: "", width: "0.8fr", align: "right" as const, render: (e: BehaviourEntryRow) => rowAction(e) }] : []),
          ]}
        />
      )}
      {total > 0 && <Pagination {...paging.props} label="entries" />}
    </div>
  );
}
