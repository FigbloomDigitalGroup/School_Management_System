import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  addDefaultBehaviourCategories, BEHAVIOUR_MODE_LABEL, BEHAVIOUR_RESET_LABEL, fetchBehaviourCategories, fetchBehaviourClasses,
  fetchBehaviourPoints, fetchBehaviourRecorders, fetchBehaviourSettings, fetchClassLearners, fetchSchoolLearners, saveBehaviourCategory,
  saveBehaviourSettings, setBehaviourCategoryArchived, SEVERITY_LABEL, settingsProblem, thresholdsReached,
  type BehaviourCategory, type BehaviourEntryRow, type BehaviourLearner, type BehaviourMode, type BehaviourReset,
  type BehaviourSettings, type BehaviourSeverity,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import {
  askAndVoid, IncidentModal, LearnerBehaviour, PointsFigure, RecordBehaviourModal, ThresholdBadges,
} from "../../components/behaviour/Behaviour";
import { BehaviourLog } from "../../components/behaviour/BehaviourLog";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

type Tab = "log" | "incidents" | "learners" | "settings";
const TABS: { key: Tab; label: string }[] = [
  { key: "log", label: "Log" }, { key: "incidents", label: "Serious incidents" }, { key: "learners", label: "Learners & points" }, { key: "settings", label: "Settings" },
];

/**
 * The office's behaviour page (the 'discipline' area and full admins): the whole school's log, serious
 * incidents with what was done about them, every learner's points with threshold badges, and the
 * points settings and categories.
 */
export function AdminBehaviour() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab | null) ?? "log";
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); p.set("tab", t); setParams(p, { replace: true }); };
  const [reloadKey, setReloadKey] = useState(0);
  const [viewing, setViewing] = useState<{ id: string; name: string } | null>(null);
  const [incident, setIncident] = useState<BehaviourEntryRow | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);

  const base = useAsync(async () => {
    const [settings, categories, classes, recorders] = await Promise.all([
      fetchBehaviourSettings(tenant.id), fetchBehaviourCategories(tenant.id), fetchBehaviourClasses(tenant.id), fetchBehaviourRecorders(tenant.id),
    ]);
    return { settings, categories, classes, recorders };
  }, [tenant.id, reloadKey]);
  const reload = () => setReloadKey((k) => k + 1);
  const voidAction = (e: BehaviourEntryRow) => !e.voided_at ? (
    <Button onClick={() => void askAndVoid(e).then((ok) => { if (ok) { toast("Entry voided."); reload(); } }).catch((err: Error) => toast(err.message, "error"))}>Void</Button>
  ) : null;

  return (
    <>
      <PageHead eyebrow="People" title="Behaviour"
        blurb="Merits, demerits and serious incidents across the school, each learner's points, and how the school's points work."
        actions={base.data ? <Button variant="accent" onClick={() => setRecordOpen(true)}>Record</Button> : undefined} />
      <div className="grid gap-4 px-7 py-6">
        <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-white p-1" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className="rounded px-3 py-1.5 text-small"
              style={tab === t.key ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>{t.label}</button>
          ))}
        </div>
        {base.error ? <p className="text-[12.5px] text-warn-ink">Could not load: {base.error.message}</p>
          : !base.data ? <TableSkeleton rows={8} />
          : tab === "log" ? (
            <BehaviourLog key="log" tenantId={tenant.id} title="Behaviour log" classes={base.data.classes} categories={base.data.categories}
              recorders={base.data.recorders} reloadKey={reloadKey} onOpenLearner={(id, name) => setViewing({ id, name })} rowAction={voidAction} />
          ) : tab === "incidents" ? (
            <BehaviourLog key="incidents" tenantId={tenant.id} title="Serious incidents" filterSet="incidents" fixed={{ seriousOnly: true }}
              categories={base.data.categories} reloadKey={reloadKey} onOpenLearner={(id, name) => setViewing({ id, name })}
              rowAction={(e) => <Button onClick={() => setIncident(e)}>{e.follow_up_status === "open" ? "Follow up" : "Edit"}</Button>} />
          ) : tab === "learners" ? (
            <LearnersPoints settings={base.data.settings} classes={base.data.classes} reloadKey={reloadKey} onOpen={(id, name) => setViewing({ id, name })} />
          ) : (
            <SettingsPanel key={reloadKey} settings={base.data.settings} categories={base.data.categories} onSaved={(msg) => { toast(msg); reload(); }} />
          )}
      </div>

      {recordOpen && base.data && (
        <OfficeRecord classes={base.data.classes} categories={base.data.categories} settings={base.data.settings}
          onClose={() => setRecordOpen(false)} onDone={(msg) => { toast(msg); setRecordOpen(false); reload(); }} />
      )}
      {incident && <IncidentModal entry={incident} onClose={() => setIncident(null)} onDone={(msg) => { toast(msg); setIncident(null); reload(); }} />}
      {viewing && (
        <Modal open onClose={() => setViewing(null)} eyebrow="Behaviour" title={viewing.name} width={720}
          actions={<Button variant="primary" onClick={() => setViewing(null)}>Done</Button>}>
          <LearnerBehaviour studentId={viewing.id} tenantId={tenant.id} staff firstName={viewing.name.split(" ")[0]} reloadKey={reloadKey}
            canVoid={() => true} onChanged={reload} />
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- record (office): a class, then learners

function OfficeRecord({ classes, categories, settings, onClose, onDone }: {
  classes: { id: string; name: string }[]; categories: BehaviourCategory[]; settings: BehaviourSettings;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const [classId, setClassId] = useState<string>("");
  const { data: learners } = useAsync(() => (classId ? fetchClassLearners(classId) : Promise.resolve<BehaviourLearner[] | null>(null)), [classId]);
  if (!classId || !learners) {
    return (
      <Modal open onClose={onClose} eyebrow="Behaviour" title="Record for which class?" actions={<Button onClick={onClose}>Cancel</Button>}>
        <SelectField id="rec-class" label="Class" value={classId} onChange={(e) => setClassId(e.target.value)}
          options={[{ value: "", label: "Choose a class…" }, ...classes.map((c) => ({ value: c.id, label: c.name }))]} />
      </Modal>
    );
  }
  return <RecordBehaviourModal kind="merit" learners={learners} preselected={[]} categories={categories} settings={settings} allowIncident onClose={onClose} onDone={onDone} />;
}

// ---------------------------------------------------------------- every learner's points

function LearnersPoints({ settings, classes, reloadKey, onOpen }: {
  settings: BehaviourSettings; classes: { id: string; name: string }[]; reloadKey: number; onOpen: (id: string, name: string) => void;
}) {
  const { tenant } = useTenantSession();
  const [classId, setClassId] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [query, setQuery] = useState("");
  const { data, loading, error } = useAsync(async () => {
    const [learners, points] = await Promise.all([fetchSchoolLearners(tenant.id), fetchBehaviourPoints(null)]);
    return { learners, points };
  }, [tenant.id, reloadKey]);
  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.learners.filter((l) => (!classId || l.class_id === classId)
      && (!q || l.full_name.toLowerCase().includes(q) || (l.admission_no ?? "").toLowerCase().includes(q))
      && (!onlyFlagged || thresholdsReached(data.points.get(l.id) ?? { merit_points: 0, demerit_points: 0 }, settings.thresholds).length > 0));
  }, [data, classId, query, onlyFlagged, settings.thresholds]);
  const flagged = data ? data.learners.filter((l) => thresholdsReached(data.points.get(l.id) ?? { merit_points: 0, demerit_points: 0 }, settings.thresholds).length > 0).length : 0;

  if (error) return <p className="text-[12.5px] text-warn-ink">Could not load: {error.message}</p>;
  if (loading || !data) return <TableSkeleton rows={8} />;
  const sel = "rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[12.5px]";
  return (
    <DataTable
      title={`${rows.length} learners`}
      filters={
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Find a learner" placeholder="Find a learner…" className={sel} value={query} onChange={(e) => setQuery(e.target.value)} />
          <select aria-label="Class" className={sel} value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">All classes</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-[12.5px]"><input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
            Over a threshold {flagged > 0 && <Badge tone="warn">{flagged}</Badge>}</label>
        </div>
      }
      rows={rows}
      rowKey={(l) => l.id}
      rowsLabel="learners"
      onRowClick={(l) => onOpen(l.id, l.full_name)}
      empty={{ title: "No learners match.", body: "Try another class or clear the search." }}
      columns={[
        { key: "name", header: "Learner", width: "1.8fr", render: (l) => <Cell sub={l.className ?? undefined}>{l.full_name}</Cell> },
        { key: "adm", header: "Adm", width: "0.7fr", render: (l) => <Mono>{l.admission_no ?? ""}</Mono> },
        { key: "m", header: "Merits", width: "0.6fr", align: "right", render: (l) => <Mono>{data.points.get(l.id)?.merit_points ?? 0}</Mono> },
        { key: "d", header: "Demerits", width: "0.6fr", align: "right", render: (l) => <Mono>{Math.abs(data.points.get(l.id)?.demerit_points ?? 0)}</Mono> },
        { key: "p", header: "Points", width: "0.7fr", align: "right", render: (l) => <PointsFigure points={data.points.get(l.id)} settings={settings} /> },
        { key: "t", header: "", width: "1.2fr", render: (l) => <ThresholdBadges points={data.points.get(l.id)} thresholds={settings.thresholds} /> },
      ]}
    />
  );
}

// ---------------------------------------------------------------- settings and categories

function SettingsPanel({ settings, categories, onSaved }: { settings: BehaviourSettings; categories: BehaviourCategory[]; onSaved: (msg: string) => void }) {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [s, setS] = useState(settings);
  const [thresholds, setThresholds] = useState(settings.thresholds.map((t) => ({ points: String(t.points), label: t.label })));
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<BehaviourCategory | "merit" | "demerit" | null>(null);

  const draft: BehaviourSettings = { ...s, thresholds: thresholds.map((t) => ({ points: Number(t.points), label: t.label })) };
  const problem = settingsProblem(draft);

  async function save() {
    setSaving(true);
    try { await saveBehaviourSettings(draft); onSaved("Behaviour settings saved."); }
    catch (err) { toast(err instanceof Error ? err.message : "Could not save.", "error"); setSaving(false); }
  }
  async function addDefaults() {
    try { const n = await addDefaultBehaviourCategories(tenant.id); onSaved(n ? `${n} suggested categories added.` : "You already have all the suggested categories."); }
    catch (err) { toast(err instanceof Error ? err.message : "Could not add them.", "error"); }
  }
  async function archive(c: BehaviourCategory) {
    try { await setBehaviourCategoryArchived(c.id, !c.archived_at); onSaved(c.archived_at ? `${c.name} is back in use.` : `${c.name} archived: past entries keep it.`); }
    catch (err) { toast(err instanceof Error ? err.message : "Could not change it.", "error"); }
  }

  const box = "grid gap-3.5 rounded-lg border border-line bg-white p-5";
  return (
    <div className="grid gap-4">
      <section className={box}>
        <h2 className="text-body font-semibold">Points</h2>
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={s.points_enabled} onChange={(e) => setS({ ...s, points_enabled: e.target.checked })} />Keep points (off: the log only)</label>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField id="bs-mode" label="How points work" value={s.mode} onChange={(e) => setS({ ...s, mode: e.target.value as BehaviourMode })}
            options={Object.entries(BEHAVIOUR_MODE_LABEL).map(([value, label]) => ({ value, label }))} />
          <SelectField id="bs-reset" label="Points start again" value={s.reset} onChange={(e) => setS({ ...s, reset: e.target.value as BehaviourReset })}
            options={Object.entries(BEHAVIOUR_RESET_LABEL).map(([value, label]) => ({ value, label }))} />
          <TextField id="bs-start" label="Starting balance (demerits only)" type="number" min={0} max={10000} disabled={s.mode !== "demerits_only"}
            value={String(s.starting_points)} onChange={(e) => setS({ ...s, starting_points: Number(e.target.value) })} />
          <TextField id="bs-max" label="Most points for one entry" type="number" min={1} max={100}
            value={String(s.max_points_per_entry)} onChange={(e) => setS({ ...s, max_points_per_entry: Number(e.target.value) })} />
        </div>
        <h3 className="mt-1 text-small font-semibold">What families see</h3>
        <p className="text-[12.5px] text-ink-muted">Parents and learners always see merits and the points total. Staff-only notes are never shown.</p>
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={s.parents_see_demerits} onChange={(e) => setS({ ...s, parents_see_demerits: e.target.checked })} />Show demerits to parents and learners</label>
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={s.parents_see_incidents} onChange={(e) => setS({ ...s, parents_see_incidents: e.target.checked })} />Show incidents to parents and learners</label>
        <h3 className="mt-1 text-small font-semibold">Thresholds</h3>
        <p className="text-[12.5px] text-ink-muted">A badge on the learner for the office and their teachers when, in the current period, their demerits reach a negative threshold or their merits reach a positive one.</p>
        {thresholds.map((t, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <TextField id={`th-p-${i}`} label="Points" type="number" value={t.points} onChange={(e) => setThresholds(thresholds.map((x, j) => (j === i ? { ...x, points: e.target.value } : x)))} />
            <TextField id={`th-l-${i}`} label="Label" maxLength={60} value={t.label} onChange={(e) => setThresholds(thresholds.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <Button onClick={() => setThresholds(thresholds.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          {thresholds.length < 10 && <Button onClick={() => setThresholds([...thresholds, { points: "-10", label: "" }])}>Add a threshold</Button>}
          <span className="flex-1" />
          {problem && <span className="text-[12.5px] text-warn-ink">{problem}</span>}
          <Button variant="accent" disabled={saving || problem !== null} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</Button>
        </div>
      </section>

      <section className={box}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-body font-semibold">Categories</h2>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void addDefaults()}>Add the suggested categories</Button>
            <Button onClick={() => setEditing("merit")}>New merit</Button>
            <Button onClick={() => setEditing("demerit")}>New demerit</Button>
          </div>
        </div>
        {categories.length === 0 ? (
          <p className="text-[13px] text-ink-muted">No categories yet. Add the suggested ones (Helping others +2, Late to class −1, Fighting −5 serious, …) and change them to suit the school.</p>
        ) : (
          <DataTable rows={categories} rowKey={(c) => c.id} pageSize={0} minWidth="560px"
            empty={{ title: "No categories.", body: "" }}
            columns={[
              { key: "name", header: "Category", width: "1.6fr", render: (c) => <span className="text-[13px]" style={c.archived_at ? { opacity: 0.5 } : undefined}>{c.name}</span> },
              { key: "kind", header: "Kind", width: "0.7fr", render: (c) => <Badge tone={c.kind === "merit" ? "ok" : "warn"}>{c.kind === "merit" ? "Merit" : "Demerit"}</Badge> },
              { key: "pts", header: "Points", width: "0.5fr", align: "right", render: (c) => <Mono>{c.kind === "merit" ? "+" : "−"}{c.points}</Mono> },
              { key: "sev", header: "Severity", width: "0.7fr", render: (c) => c.severity ? <span className="text-[12.5px]">{SEVERITY_LABEL[c.severity]}</span> : null },
              { key: "act", header: "", width: "1.2fr", align: "right", render: (c) => (
                <div className="flex justify-end gap-1.5">
                  {!c.archived_at && <Button onClick={() => setEditing(c)}>Edit</Button>}
                  <Button onClick={() => void archive(c)}>{c.archived_at ? "Restore" : "Archive"}</Button>
                </div>
              ) },
            ]} />
        )}
      </section>
      {editing && <CategoryModal tenantId={tenant.id} category={typeof editing === "string" ? null : editing} kind={typeof editing === "string" ? editing : editing.kind}
        onClose={() => setEditing(null)} onSaved={(msg) => { setEditing(null); onSaved(msg); }} />}
    </div>
  );
}

function CategoryModal({ tenantId, category, kind, onClose, onSaved }: {
  tenantId: string; category: BehaviourCategory | null; kind: "merit" | "demerit"; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(category?.name ?? "");
  const [points, setPoints] = useState(String(category?.points ?? (kind === "merit" ? 2 : 1)));
  const [severity, setSeverity] = useState<BehaviourSeverity>(category?.severity ?? "minor");
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try { await saveBehaviourCategory(tenantId, { kind, name, points: Number(points), severity: kind === "merit" ? null : severity }, category?.id); onSaved(`${name.trim()} saved.`); }
    catch (err) { toast(err instanceof Error ? err.message : "Could not save.", "error"); setSaving(false); }
  }
  return (
    <Modal open onClose={onClose} eyebrow="Behaviour category" title={category ? `Edit ${category.name}` : kind === "merit" ? "New merit category" : "New demerit category"}
      blurb="Points are the default for each entry; a teacher can change them within the school's limit."
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="accent" disabled={saving || name.trim().length < 2} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button></>}>
      <div className="grid gap-3.5 sm:grid-cols-[2fr_1fr_1fr]">
        <TextField id="cat-name" label="Name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField id="cat-points" label="Points" type="number" min={1} max={100} value={points} onChange={(e) => setPoints(e.target.value)} />
        {kind === "demerit" && (
          <SelectField id="cat-sev" label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value as BehaviourSeverity)}
            options={Object.entries(SEVERITY_LABEL).map(([value, label]) => ({ value, label }))} />
        )}
      </div>
    </Modal>
  );
}
