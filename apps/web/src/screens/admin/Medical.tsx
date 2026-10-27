import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fetchNotifyPolicy, fetchOpenVisits, fetchVisits, localDay, NOTIFY_POLICY_LABEL, saveNotifyPolicy, sickBayBoard,
  type NotifyPolicy, type SickBayVisit,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { ErrorLine, hm, OutcomeBadge, OverdueMedication, when } from "../../components/medical/common";
import { VisitModal } from "../../components/medical/VisitModal";
import { MedicalRecordModal } from "../../components/medical/MedicalRecordModal";
import { MedicationRound } from "../../components/medical/Round";
import { MedicationRequests } from "../../components/medical/Requests";
import { MedicalReports } from "../../components/medical/Reports";

type Tab = "bay" | "round" | "requests" | "reports";
const TABS: { key: Tab; label: string }[] = [
  { key: "bay", label: "Sick bay" },
  { key: "round", label: "Medication round" },
  { key: "requests", label: "Requests" },
  { key: "reports", label: "Reports" },
];

/** The board refreshes itself this often, for a sick bay screen left open all day. */
const REFRESH_MS = 60_000;

/**
 * The sick bay (the medical admin area, 20261101300000): for the school
 * nurse or matron, and full admins. Who is in now, today's visits, the
 * medication round, families' medication requests and the office's
 * reports. Clinical details here are for the medical area only; opening a
 * learner's record is noted in the audit trail.
 */
export function AdminMedical() {
  const { tenant } = useTenantSession();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "bay") as Tab;
  const setTab = (t: Tab) => { const next = new URLSearchParams(params); next.set("tab", t); setParams(next, { replace: true }); };
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);
  const [editing, setEditing] = useState<SickBayVisit | "new" | null>(null);
  const [record, setRecord] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    const id = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <>
      <PageHead
        eyebrow="Medical"
        title="Sick bay"
        blurb="Log visits, give the medication round, and approve families' medication requests. Allergies and conditions show on every learner you open."
        actions={<Button variant="accent" onClick={() => setEditing("new")}>New visit</Button>}
      />
      <div className="grid gap-5 px-7 py-6">
        <OverdueMedication key={reloadKey} tenantId={tenant.id} slug={tenant.slug} />
        <div role="group" aria-label="Show" className="flex w-fit flex-wrap rounded-md border border-[#D3DAD5] bg-white p-0.5">
          {TABS.map((t) => (
            <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => setTab(t.key)} className="rounded px-3 py-1.5 text-small"
              style={tab === t.key ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === "bay" && <Board reloadKey={reloadKey} onEdit={setEditing} onOpen={(id, name) => setRecord({ id, name })} />}
        {tab === "round" && <MedicationRound onOpenLearner={(id, name) => setRecord({ id, name })} />}
        {tab === "requests" && <MedicationRequests onChanged={reload} />}
        {tab === "reports" && <MedicalReports />}
        {tab === "bay" && <GuardianPolicy tenantId={tenant.id} />}
      </div>

      {editing && <VisitModal visit={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
      {record && <MedicalRecordModal studentId={record.id} name={record.name} onClose={() => setRecord(null)} />}
    </>
  );
}

function Board({ reloadKey, onEdit, onOpen }: { reloadKey: number; onEdit: (v: SickBayVisit) => void; onOpen: (id: string, name: string) => void }) {
  const { tenant } = useTenantSession();
  const today = localDay(new Date());
  const { data, loading, error } = useAsync(async () => {
    const start = new Date(`${today}T00:00:00`);
    const [open, todays] = await Promise.all([
      fetchOpenVisits(tenant.id),
      fetchVisits(tenant.id, start, new Date(start.getTime() + 86_400_000)),
    ]);
    return { open: sickBayBoard(open), todays };
  }, [tenant.id, today, reloadKey]);

  if (error) return <ErrorLine what="the sick bay" error={error} />;
  if (loading && !data) return <TableSkeleton rows={5} />;
  const name = (v: SickBayVisit) => v.students?.full_name ?? "";

  const learner = {
    key: "learner", header: "Learner", width: "1.6fr",
    render: (v: SickBayVisit) => (
      <button type="button" className="text-left" onClick={(e) => { e.stopPropagation(); onOpen(v.student_id, name(v)); }} title="Open their medical record">
        <Cell sub={[v.students?.admission_no && `ADM ${v.students.admission_no}`, v.students?.classes?.name].filter(Boolean).join(" · ")}>
          <span className="underline decoration-dotted underline-offset-2">{name(v)}</span>
        </Cell>
      </button>
    ),
  };

  return (
    <>
      <DataTable
        title={`In the sick bay now · ${data?.open.length ?? 0}`}
        rows={data?.open ?? []}
        rowKey={(v) => v.id}
        onRowClick={onEdit}
        minWidth="680px"
        empty={{ title: "Nobody in the sick bay", body: "A learner you log a visit for shows here until they leave." }}
        columns={[
          { key: "in", header: "In", width: "0.7fr", render: (v) => <Mono>{when(v.time_in)}</Mono> },
          learner,
          { key: "complaint", header: "Complaint", width: "1.6fr", render: (v) => <span className="text-[13px]">{v.complaint}{v.temperature_c != null ? ` · ${v.temperature_c}°C` : ""}</span> },
          { key: "status", header: "Status", width: "1fr", render: (v) => <OutcomeBadge outcome={v.outcome} /> },
        ]}
      />
      <DataTable
        title={`Today's visits · ${data?.todays.length ?? 0}`}
        rows={data?.todays ?? []}
        rowKey={(v) => v.id}
        onRowClick={onEdit}
        minWidth="680px"
        empty={{ title: "No visits yet today", body: "Every visit logged today is listed here, with where the learner went." }}
        columns={[
          { key: "in", header: "In", width: "0.6fr", render: (v) => <Mono>{hm(v.time_in)}</Mono> },
          learner,
          { key: "complaint", header: "Complaint", width: "1.4fr", render: (v) => <span className="text-[13px]">{v.complaint}</span> },
          { key: "outcome", header: "Outcome", width: "1.1fr", render: (v) => <OutcomeBadge outcome={v.outcome} /> },
          { key: "out", header: "Out", width: "0.6fr", render: (v) => <Mono>{v.time_out ? hm(v.time_out) : "–"}</Mono> },
        ]}
      />
    </>
  );
}

/** Whether families hear about every visit or only serious outcomes. */
function GuardianPolicy({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const { data, loading } = useAsync(() => fetchNotifyPolicy(tenantId), [tenantId]);
  const [policy, setPolicy] = useState<NotifyPolicy | null>(null);
  const value = policy ?? data ?? "serious";

  async function change(p: NotifyPolicy) {
    setPolicy(p);
    try {
      await saveNotifyPolicy(tenantId, p);
      toast("Saved.");
    } catch (err) {
      setPolicy(null);
      toast(err instanceof Error ? err.message : "Could not save.", "error");
    }
  }

  return (
    <section className="rounded-lg border border-line bg-white px-4 py-3">
      <h2 className="text-body font-semibold">Telling families</h2>
      <p className="mt-0.5 text-[12.5px] text-ink-muted">
        Guardians get a notice in the app and on their phone, naming where their child went (never the complaint or your notes), and can see their child's visits and medication.
      </p>
      <select aria-label="When families are told" disabled={loading} value={value} onChange={(e) => void change(e.target.value as NotifyPolicy)}
        className="mt-2 rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px] outline-none">
        {(Object.keys(NOTIFY_POLICY_LABEL) as NotifyPolicy[]).map((p) => <option key={p} value={p}>{NOTIFY_POLICY_LABEL[p]}</option>)}
      </select>
    </section>
  );
}
