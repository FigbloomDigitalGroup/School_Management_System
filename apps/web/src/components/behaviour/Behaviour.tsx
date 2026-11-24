import { useMemo, useState, type ReactNode } from "react";
import {
  BEHAVIOUR_KIND_LABEL, fetchBehaviourPoints, fetchBehaviourSettings, fetchLearnerBehaviour, formatPoints, INCIDENT_ACTION_LABEL,
  kindCounts, recordBehaviour, setBehaviourIncident, SEVERITY_LABEL, thresholdsReached, todayIso, voidBehaviourEntry,
  type BehaviourCategory, type BehaviourEntryRow, type BehaviourKind, type BehaviourLearner, type BehaviourSettings,
  type BehaviourThreshold, type FollowUpStatus, type IncidentAction, type LearnerPoints,
} from "@figbloom/shared";
import { Badge, type Tone } from "../ui/Badge";
import { Button } from "../ui/Button";
import { promptDialog } from "../ui/Confirm";
import { EmptyState } from "../ui/DataTable";
import { SelectField, TextField } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { PagedList } from "../ui/PagedList";
import { TableSkeleton } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { useAsync } from "../../lib/useAsync";

/**
 * The behaviour log's shared pieces: the Merit / Demerit form (one learner or several), an entry's line,
 * the points figure with its threshold badges, the incident record, and a learner's timeline as staff
 * or as their family sees it.
 */

export const KIND_TONE: Record<BehaviourKind, Tone> = { merit: "ok", demerit: "warn", incident: "warn" };

export function KindBadge({ e }: { e: Pick<BehaviourEntryRow, "kind" | "severity"> }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={KIND_TONE[e.kind]}>{BEHAVIOUR_KIND_LABEL[e.kind]}</Badge>
      {e.severity && e.severity !== "minor" && <Badge tone={e.severity === "serious" ? "warn" : "info"}>{SEVERITY_LABEL[e.severity]}</Badge>}
    </span>
  );
}

export function PointsText({ n }: { n: number }) {
  return <span className="font-mono text-[13px]" style={{ color: n > 0 ? "#1F7A45" : n < 0 ? "#B4400A" : undefined }}>{formatPoints(n)}</span>;
}

export function ThresholdBadges({ points, thresholds }: { points: Pick<LearnerPoints, "merit_points" | "demerit_points"> | undefined; thresholds: readonly BehaviourThreshold[] }) {
  if (!points) return null;
  const hit = thresholdsReached(points, thresholds);
  if (!hit.length) return null;
  return <span className="inline-flex flex-wrap gap-1">{hit.map((t) => <Badge key={`${t.points}:${t.label}`} tone={t.points < 0 ? "warn" : "ok"}>{t.label}</Badge>)}</span>;
}

/** "42 points" (or the period's merits and demerits when points are off). */
export function PointsFigure({ points, settings }: { points: LearnerPoints | undefined; settings: BehaviourSettings }) {
  if (!points) return <span className="text-ink-faint">—</span>;
  if (points.balance === null) return <span className="text-[13px]">{points.merit_points} merit · {Math.abs(points.demerit_points)} demerit</span>;
  return <span className="font-mono text-[15px] font-semibold">{points.balance}{settings.mode === "demerits_only" ? ` / ${settings.starting_points}` : ""}</span>;
}

export function periodLabel(p: Pick<LearnerPoints, "period_start" | "period_end"> | undefined, reset: BehaviourSettings["reset"]): string {
  if (!p || reset === "never") return "since the start";
  return p.period_start ? `since ${new Date(`${p.period_start}T00:00:00`).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })}` : "";
}

const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });

// ---------------------------------------------------------------- recording

export function RecordBehaviourModal({ kind: initialKind, learners, preselected, categories, settings, onClose, onDone, allowIncident }: {
  kind: "merit" | "demerit";
  learners: BehaviourLearner[];
  preselected: string[];
  categories: BehaviourCategory[];
  settings: BehaviourSettings;
  onClose: () => void;
  onDone: (message: string) => void;
  /** The office may log an incident with no category or points. */
  allowIncident?: boolean;
}) {
  const [kind, setKind] = useState<BehaviourKind>(initialKind);
  const [picked, setPicked] = useState<Set<string>>(new Set(preselected));
  const usable = categories.filter((c) => !c.archived_at && (kind === "incident" ? c.kind === "demerit" : c.kind === kind));
  const [categoryId, setCategoryId] = useState<string>(usable[0]?.id ?? "");
  const category = usable.find((c) => c.id === categoryId) ?? null;
  const [points, setPoints] = useState<string>(category ? String(category.points) : kind === "incident" ? "0" : "1");
  const [note, setNote] = useState("");
  const [staffNote, setStaffNote] = useState("");
  const [date, setDate] = useState(todayIso());
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseKind = (k: BehaviourKind) => {
    setKind(k);
    const first = categories.find((c) => !c.archived_at && (k === "incident" ? c.kind === "demerit" : c.kind === k));
    setCategoryId(k === "incident" ? "" : first?.id ?? "");
    setPoints(k === "incident" ? "0" : String(first?.points ?? 1));
  };
  const chooseCategory = (id: string) => {
    setCategoryId(id);
    const c = categories.find((x) => x.id === id);
    if (c) setPoints(String(c.points));
  };

  const n = Number(points);
  const problem = picked.size === 0 ? "Choose at least one learner."
    : kind !== "incident" && !category ? "Choose a category."
    : kind === "incident" && !category && !note.trim() ? "Say what happened."
    : !Number.isInteger(n) || n < (kind === "incident" ? 0 : 1) || n > settings.max_points_per_entry ? `Points are a whole number from ${kind === "incident" ? 0 : 1} to ${settings.max_points_per_entry}.`
    : date > todayIso() ? "The date can't be in the future." : null;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? learners.filter((l) => l.full_name.toLowerCase().includes(q) || (l.admission_no ?? "").toLowerCase().includes(q)) : learners;
  }, [learners, query]);

  async function save() {
    if (problem) return;
    setSaving(true);
    setError(null);
    try {
      const count = await recordBehaviour({
        studentIds: [...picked], kind, categoryId: category?.id ?? null, points: n, note, staffNote, occurredOn: date,
        severity: kind === "incident" ? category?.severity ?? "serious" : null,
      });
      const what = category?.name ?? BEHAVIOUR_KIND_LABEL[kind];
      onDone(count === 1 ? `${what} recorded for ${learners.find((l) => picked.has(l.id))?.full_name ?? "the learner"}.` : `${what} recorded for ${count} learners.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
      setSaving(false);
    }
  }

  const toggle = (id: string) => setPicked((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  const allShown = shown.length > 0 && shown.every((l) => picked.has(l.id));

  return (
    <Modal open onClose={onClose} eyebrow="Behaviour" width={720}
      title={kind === "merit" ? "Give a merit" : kind === "demerit" ? "Record a demerit" : "Log an incident"}
      blurb={settings.points_enabled && !kindCounts(settings.mode, kind)
        ? `This school counts ${settings.mode === "merits_only" ? "merits" : "demerits"} only: this is logged but doesn't change anyone's points.`
        : "Pick one learner, or several for a class merit. The note is shown to families when the school lets them see this kind; the staff-only note never is."}
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="accent" disabled={saving || problem !== null} onClick={() => void save()}>
          {saving ? "Saving…" : picked.size > 1 ? `Record for ${picked.size} learners` : "Record"}
        </Button>
      </>}>
      <div className="grid gap-3.5">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind">
          {(["merit", "demerit", ...(allowIncident ? ["incident" as const] : [])] as BehaviourKind[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => chooseKind(k)}
              className="rounded-md border px-3 py-1.5 text-[13px]"
              style={kind === k ? { background: "#17402A", color: "#fff", borderColor: "#17402A", fontWeight: 600 } : { borderColor: "#D3DAD5" }}>
              {BEHAVIOUR_KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="grid gap-3.5 sm:grid-cols-[2fr_1fr_1fr]">
          <SelectField id="bh-category" label={kind === "incident" ? "Category (optional)" : "Category"} value={categoryId}
            onChange={(e) => chooseCategory(e.target.value)}
            options={[...(kind === "incident" ? [{ value: "", label: "No category" }] : usable.length ? [] : [{ value: "", label: "No categories yet: ask the office" }]),
              ...usable.map((c) => ({ value: c.id, label: `${c.name} (${c.kind === "merit" ? "+" : "−"}${c.points}${c.severity && c.severity !== "minor" ? `, ${SEVERITY_LABEL[c.severity].toLowerCase()}` : ""})` }))]} />
          <TextField id="bh-points" label="Points" type="number" min={kind === "incident" ? 0 : 1} max={settings.max_points_per_entry} value={points} onChange={(e) => setPoints(e.target.value)} />
          <TextField id="bh-date" label="Date" type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <TextField id="bh-note" label="Note (families may see this)" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder={kind === "merit" ? "e.g. Helped a new learner settle in" : "e.g. Arrived 20 minutes late after break"} />
        <TextField id="bh-staff-note" label="Staff-only note (optional, never shown to families)" maxLength={1000} value={staffNote} onChange={(e) => setStaffNote(e.target.value)} />
        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12.5px] font-semibold">Learners ({picked.size} chosen)</span>
            <div className="flex items-center gap-2">
              <input aria-label="Find a learner" placeholder="Find…" value={query} onChange={(e) => setQuery(e.target.value)}
                className="w-40 rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[12.5px] outline-none" />
              <Button onClick={() => setPicked((s) => { const x = new Set(s); for (const l of shown) { if (allShown) x.delete(l.id); else x.add(l.id); } return x; })}>
                {allShown ? "Clear" : "Choose all"}
              </Button>
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto rounded-md border border-line">
            {shown.length === 0 ? <p className="px-3 py-3 text-[12.5px] text-ink-faint">No learners match.</p> : shown.map((l) => (
              <label key={l.id} className="flex cursor-pointer items-center gap-2.5 border-b border-line-soft px-3 py-1.5 text-[13px] last:border-b-0 hover:bg-page">
                <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} />
                <span className="min-w-0 flex-1 truncate">{l.full_name}</span>
                {l.admission_no && <span className="font-mono text-[11.5px] text-ink-faint">{l.admission_no}</span>}
              </label>
            ))}
          </div>
        </div>
        {problem && picked.size > 0 && <p className="text-[12.5px] text-warn-ink">{problem}</p>}
        {error && <p className="rounded-md border border-warn-ink/30 bg-warn-ink/5 px-3 py-2 text-[12.5px] text-warn-ink">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the incident record (office)

export function IncidentModal({ entry, onClose, onDone }: { entry: BehaviourEntryRow; onClose: () => void; onDone: (msg: string) => void }) {
  const [action, setAction] = useState<IncidentAction | "">(entry.action_taken ?? "");
  const [status, setStatus] = useState<FollowUpStatus>(entry.follow_up_status ?? "open");
  const [told, setTold] = useState(!!entry.parent_notified_at);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setSaving(true);
    try {
      await setBehaviourIncident(entry.id, action || null, status, told);
      onDone(status === "resolved" ? "Incident resolved." : "Incident updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
      setSaving(false);
    }
  }
  return (
    <Modal open onClose={onClose} eyebrow={`${entry.studentName} · ${shortDate(entry.occurred_on)}`} title={entry.categoryName ?? "Incident"}
      blurb={entry.note ?? undefined}
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="accent" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button></>}>
      <div className="grid gap-3.5">
        {entry.staffNote && <p className="rounded-md bg-sunken px-3 py-2 text-[12.5px]"><span className="font-semibold">Staff only: </span>{entry.staffNote}</p>}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField id="inc-action" label="Action taken" value={action} onChange={(e) => setAction(e.target.value as IncidentAction | "")}
            options={[{ value: "", label: "None yet" }, ...Object.entries(INCIDENT_ACTION_LABEL).map(([value, label]) => ({ value, label }))]} />
          <SelectField id="inc-status" label="Follow-up" value={status} onChange={(e) => setStatus(e.target.value as FollowUpStatus)}
            options={[{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }]} />
        </div>
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={told} onChange={(e) => setTold(e.target.checked)} />Parents have been told</label>
        {error && <p className="text-[12.5px] text-warn-ink">{error}</p>}
      </div>
    </Modal>
  );
}

export function FollowUpBadge({ e }: { e: Pick<BehaviourEntryRow, "follow_up_status" | "action_taken"> }) {
  if (!e.follow_up_status) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={e.follow_up_status === "open" ? "warn" : "ok"}>{e.follow_up_status === "open" ? "Open" : "Resolved"}</Badge>
      {e.action_taken && <Badge tone="muted">{INCIDENT_ACTION_LABEL[e.action_taken]}</Badge>}
    </span>
  );
}

/** Asks why, then voids the entry. Resolves true when it was voided. */
export async function askAndVoid(entry: BehaviourEntryRow): Promise<boolean> {
  const reason = await promptDialog({
    title: "Void this entry?", body: "It stays in the log, struck through, and stops counting. Families no longer see it.",
    label: "Why", placeholder: "e.g. Recorded for the wrong learner", confirmLabel: "Void entry", required: true,
  });
  if (reason === null) return false;
  await voidBehaviourEntry(entry.id, reason);
  return true;
}

// ---------------------------------------------------------------- a learner's timeline

export function EntryLine({ e, staff, actions }: { e: BehaviourEntryRow; staff: boolean; actions?: ReactNode }) {
  const voided = !!e.voided_at;
  return (
    <div className="flex items-start gap-3 border-b border-line-soft px-4 py-3 last:border-b-0" style={voided ? { opacity: 0.55 } : undefined}>
      <div className="w-12 shrink-0 pt-0.5 text-right"><PointsText n={e.points} /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13.5px] font-semibold" style={voided ? { textDecoration: "line-through" } : undefined}>{e.categoryName ?? BEHAVIOUR_KIND_LABEL[e.kind]}</span>
          <KindBadge e={e} />
          {(staff || e.follow_up_status) && <FollowUpBadge e={e} />}
          {voided && <Badge tone="muted">Voided</Badge>}
        </div>
        {e.note && <p className="mt-0.5 text-[12.5px] text-ink-muted">{e.note}</p>}
        {staff && e.staffNote && <p className="mt-0.5 text-[12.5px] text-ink-muted"><span className="font-semibold">Staff only: </span>{e.staffNote}</p>}
        {voided && e.void_reason && <p className="mt-0.5 text-[12px] text-ink-faint">Voided: {e.void_reason}</p>}
        <p className="mt-0.5 text-[11.5px] text-ink-faint">
          {shortDate(e.occurred_on)}{staff && e.recorderName ? ` · ${e.recorderName}` : ""}{staff && e.className ? ` · ${e.className}` : ""}
        </p>
      </div>
      {actions && <div className="flex shrink-0 gap-1.5">{actions}</div>}
    </div>
  );
}

/**
 * A learner's behaviour: their points this period with threshold badges, and their log. Staff see
 * everything RLS gives them (staff-only notes, voided entries); a family sees what the school allows.
 */
export function LearnerBehaviour({ studentId, tenantId, staff, firstName, reloadKey = 0, canVoid, onChanged }: {
  studentId: string; tenantId: string; staff: boolean; firstName?: string | null; reloadKey?: number;
  /** Whether this viewer may void an entry (the recorder or the office): a function of the entry. */
  canVoid?: (e: BehaviourEntryRow) => boolean;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [bump, setBump] = useState(0);
  const { data, loading, error } = useAsync(async () => {
    const [settings, entries, points] = await Promise.all([
      fetchBehaviourSettings(tenantId), fetchLearnerBehaviour(studentId, staff), fetchBehaviourPoints([studentId]),
    ]);
    return { settings, entries, points: points.get(studentId) };
  }, [studentId, tenantId, staff, reloadKey, bump]);

  if (error) return <p className="text-[12.5px] text-warn-ink">Could not load behaviour: {error.message}</p>;
  if (loading || !data) return <TableSkeleton rows={3} />;
  const { settings, entries, points } = data;
  const sees = staff ? "" : settings.parents_see_demerits || settings.parents_see_incidents ? "" : " The school shares merits with families.";

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-white px-4 py-3">
        {settings.points_enabled ? (
          <div>
            <div className="font-mono text-micro tracking-[0.1em] text-ink-faint">POINTS {periodLabel(points, settings.reset).toUpperCase()}</div>
            <div className="mt-1"><PointsFigure points={points} settings={settings} /></div>
          </div>
        ) : null}
        <div>
          <div className="font-mono text-micro tracking-[0.1em] text-ink-faint">MERITS</div>
          <div className="mt-1"><PointsText n={points?.merit_points ?? 0} /></div>
        </div>
        {(staff || settings.parents_see_demerits) && (
          <div>
            <div className="font-mono text-micro tracking-[0.1em] text-ink-faint">DEMERITS</div>
            <div className="mt-1"><PointsText n={points?.demerit_points ?? 0} /></div>
          </div>
        )}
        {staff && <ThresholdBadges points={points} thresholds={settings.thresholds} />}
      </div>
      <section className="overflow-hidden rounded-lg border border-line bg-white">
        {entries.length === 0 ? (
          <EmptyState title={`Nothing recorded${firstName ? ` for ${firstName}` : ""} yet.`} body={`Merits${staff ? ", demerits and incidents" : ""} appear here as teachers record them.${sees}`} />
        ) : (
          <PagedList items={entries} keyOf={(e) => e.id} label="entries" pageSize={10} className="px-4 py-2"
            render={(e) => (
              <EntryLine e={e} staff={staff} actions={staff && !e.voided_at && canVoid?.(e) ? (
                <Button onClick={() => void askAndVoid(e).then((done) => { if (done) { toast("Entry voided."); setBump((k) => k + 1); onChanged?.(); } })
                  .catch((err: Error) => toast(err.message, "error"))}>Void</Button>
              ) : undefined} />
            )} />
        )}
      </section>
    </div>
  );
}
