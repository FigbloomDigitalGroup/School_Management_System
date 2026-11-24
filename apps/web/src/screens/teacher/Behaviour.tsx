import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fetchBehaviourCategories, fetchBehaviourPoints, fetchBehaviourSettings, fetchClassLearners, fetchMyClasses,
  type BehaviourEntryRow,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { askAndVoid, LearnerBehaviour, PointsFigure, RecordBehaviourModal, ThresholdBadges } from "../../components/behaviour/Behaviour";
import { BehaviourLog } from "../../components/behaviour/BehaviourLog";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

/**
 * A teacher's behaviour page: the learners of a class they teach (class teacher or subject teacher)
 * with each one's points and threshold badges, a quick Merit / Demerit for one learner or several
 * (a class merit), and the class's behaviour log.
 */
export function TeacherBehaviour() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [params, setParams] = useSearchParams();
  const [reloadKey, setReloadKey] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [recording, setRecording] = useState<"merit" | "demerit" | null>(null);
  const [viewing, setViewing] = useState<{ id: string; name: string } | null>(null);

  const base = useAsync(async () => {
    const [classes, settings, categories] = await Promise.all([
      fetchMyClasses(profile.id), fetchBehaviourSettings(tenant.id), fetchBehaviourCategories(tenant.id),
    ]);
    return { classes, settings, categories };
  }, [profile.id, tenant.id]);
  const classes = base.data?.classes ?? [];
  const classId = params.get("class") ?? classes.find((c) => c.class_teacher_id === profile.id)?.id ?? classes[0]?.id ?? null;
  const cls = classes.find((c) => c.id === classId) ?? null;

  const roster = useAsync(async () => {
    if (!classId) return null;
    const learners = await fetchClassLearners(classId);
    const points = await fetchBehaviourPoints(learners.map((l) => l.id));
    return { learners, points };
  }, [classId, reloadKey]);

  const chooseClass = (id: string) => { const p = new URLSearchParams(params); p.set("class", id); setParams(p, { replace: true }); setPicked(new Set()); };
  const done = (msg: string) => { toast(msg); setRecording(null); setPicked(new Set()); setReloadKey((k) => k + 1); };
  const mine = (e: BehaviourEntryRow) => e.recorded_by === profile.id;

  const settings = base.data?.settings;
  const learners = roster.data?.learners ?? [];
  const allPicked = learners.length > 0 && learners.every((l) => picked.has(l.id));

  return (
    <>
      <PageHead eyebrow="Teaching" title="Behaviour"
        blurb="Give merits and record demerits for the learners you teach. Choose several learners for a class merit."
        actions={cls && settings ? <>
          <Button variant="accent" onClick={() => setRecording("merit")}>Merit{picked.size > 1 ? ` (${picked.size})` : ""}</Button>
          <Button onClick={() => setRecording("demerit")}>Demerit{picked.size > 1 ? ` (${picked.size})` : ""}</Button>
        </> : undefined} />
      <div className="grid gap-5 px-7 py-6">
        {base.error ? <p className="text-[12.5px] text-warn-ink">Could not load: {base.error.message}</p>
          : base.loading || !settings ? <TableSkeleton rows={6} />
          : classes.length === 0 ? <p className="text-[13px] text-ink-muted">You don't teach a class yet. Ask the office to assign you as a class or subject teacher.</p>
          : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="bh-class" className="text-[12.5px] font-semibold">Class</label>
                <select id="bh-class" value={classId ?? ""} onChange={(e) => chooseClass(e.target.value)}
                  className="rounded-md border border-[#D3DAD5] bg-white px-3 py-1.5 text-[13px]">
                  {classes.map((c) => <option key={c.id} value={c.id}>{c.name}{c.class_teacher_id === profile.id ? " (your class)" : ""}</option>)}
                </select>
                {settings.points_enabled && <span className="text-[12px] text-ink-faint">Points reset {settings.reset === "never" ? "never" : `every ${settings.reset}`}.</span>}
              </div>
              {roster.loading && !roster.data ? <TableSkeleton rows={8} /> : (
                <DataTable
                  title={cls ? `${cls.name}: ${learners.length} learners` : undefined}
                  filters={<Button onClick={() => setPicked(allPicked ? new Set() : new Set(learners.map((l) => l.id)))}>{allPicked ? "Clear" : "Choose all"}</Button>}
                  rows={learners}
                  rowKey={(l) => l.id}
                  rowsLabel="learners"
                  pageSize={50}
                  minWidth="640px"
                  empty={{ title: "No learners in this class.", body: "Learners appear here once the office adds them to the class." }}
                  columns={[
                    { key: "pick", header: "", width: "0.3fr", render: (l) => (
                      <input type="checkbox" aria-label={`Choose ${l.full_name}`} checked={picked.has(l.id)}
                        onChange={() => setPicked((s) => { const x = new Set(s); if (x.has(l.id)) x.delete(l.id); else x.add(l.id); return x; })} />
                    ) },
                    { key: "name", header: "Learner", width: "1.8fr", render: (l) => (
                      <button type="button" className="text-left hover:underline" onClick={() => setViewing({ id: l.id, name: l.full_name })}><Cell>{l.full_name}</Cell></button>
                    ) },
                    { key: "adm", header: "Adm", width: "0.7fr", render: (l) => <Mono>{l.admission_no ?? ""}</Mono> },
                    { key: "points", header: "Points", width: "0.8fr", align: "right", render: (l) => <PointsFigure points={roster.data?.points.get(l.id)} settings={settings} /> },
                    { key: "flags", header: "", width: "1.2fr", render: (l) => <ThresholdBadges points={roster.data?.points.get(l.id)} thresholds={settings.thresholds} /> },
                    { key: "act", header: "", width: "1.3fr", align: "right", render: (l) => (
                      <div className="flex justify-end gap-1.5">
                        <Button onClick={() => { setPicked(new Set([l.id])); setRecording("merit"); }}>+ Merit</Button>
                        <Button onClick={() => { setPicked(new Set([l.id])); setRecording("demerit"); }}>− Demerit</Button>
                      </div>
                    ) },
                  ]}
                />
              )}
              {classId && (
                <BehaviourLog tenantId={tenant.id} title={`${cls?.name ?? "Class"} behaviour log`} filterSet="teacher" fixed={{ classId }}
                  categories={base.data?.categories ?? []} reloadKey={reloadKey}
                  onOpenLearner={(id, name) => setViewing({ id, name })}
                  rowAction={(e) => !e.voided_at && mine(e) ? (
                    <Button onClick={() => void askAndVoid(e).then((ok) => { if (ok) { toast("Entry voided."); setReloadKey((k) => k + 1); } }).catch((err: Error) => toast(err.message, "error"))}>Void</Button>
                  ) : null} />
              )}
            </>
          )}
      </div>

      {recording && settings && (
        <RecordBehaviourModal kind={recording} learners={learners} preselected={[...picked]} categories={base.data?.categories ?? []}
          settings={settings} onClose={() => setRecording(null)} onDone={done} />
      )}
      {viewing && (
        <Modal open onClose={() => setViewing(null)} eyebrow="Behaviour" title={viewing.name} width={720}
          actions={<Button variant="primary" onClick={() => setViewing(null)}>Done</Button>}>
          <LearnerBehaviour studentId={viewing.id} tenantId={tenant.id} staff firstName={viewing.name.split(" ")[0]} reloadKey={reloadKey}
            canVoid={mine} onChanged={() => setReloadKey((k) => k + 1)} />
        </Modal>
      )}
    </>
  );
}
