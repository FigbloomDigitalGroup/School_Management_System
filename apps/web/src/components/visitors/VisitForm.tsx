import { useState } from "react";
import {
  escalatesOnArrival, fetchVisitHosts, findVisitLearners, pushVisit, recordVisit, visitDraftProblem,
  VISIT_HOST_KIND_LABEL, type Visit, type VisitDraft, type VisitHostKind, type VisitLearner,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import { SelectField, TextField } from "../ui/Field";
import { useToast } from "../ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

const EMPTY: VisitDraft = { visitor_name: "", visitor_phone: "", id_number: "", vehicle_plate: "", purpose: "", host_kind: "office" };

const HOST_KIND_OPTIONS = (Object.keys(VISIT_HOST_KIND_LABEL) as VisitHostKind[]).map((k) => ({ value: k, label: VISIT_HOST_KIND_LABEL[k] }));

/**
 * Records one visitor: at the gate (the guard) or as a walk-in at the
 * office (reception). Saving tells whoever needs to know straight away:
 * reception and the host see it live, and visit-notify pushes their phones.
 */
export function VisitForm({ entryPoint, onRecorded }: { entryPoint: Visit["entry_point"]; onRecorded?: (v: Visit) => void }) {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [draft, setDraft] = useState<VisitDraft>(EMPTY);
  const [learner, setLearner] = useState<VisitLearner | null>(null);
  const [learnerQuery, setLearnerQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const { data: hosts } = useAsync(() => fetchVisitHosts(tenant.id), [tenant.id]);
  const { data: matches, loading: searching } = useAsync(
    () => (draft.host_kind === "learner" && !learner ? findVisitLearners(tenant.id, learnerQuery) : Promise.resolve([])),
    [tenant.id, draft.host_kind, learnerQuery, learner?.id],
  );

  const set = (patch: Partial<VisitDraft>) => { setDraft((d) => ({ ...d, ...patch })); setProblem(null); };

  async function save() {
    const why = visitDraftProblem(draft);
    if (why) { setProblem(why); return; }
    setSaving(true);
    try {
      const v = await recordVisit(tenant.id, draft, entryPoint);
      void pushVisit(v.id);
      const told = v.escalated ? " The principal's office has been told."
        : v.host_kind === "teacher" ? ` ${v.host_name ?? "Their host"} has been told.` : "";
      toast(entryPoint === "gate" ? `${v.visitor_name} recorded. Reception has been told.${told}` : `${v.visitor_name} is in the queue.${told}`);
      setDraft(EMPTY);
      setLearner(null);
      setLearnerQuery("");
      onRecorded?.(v);
    } catch (err) {
      toast(err instanceof Error ? `Could not record the visitor: ${err.message}` : "Could not record the visitor.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="grid gap-3.5"
      onSubmit={(e) => { e.preventDefault(); void save(); }}
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <TextField id="visit-name" label="Visitor's name" placeholder="e.g. Grace Atieno" value={draft.visitor_name} onChange={(e) => set({ visitor_name: e.target.value })} autoComplete="off" />
        <TextField id="visit-phone" label="Phone (optional)" placeholder="e.g. 0712 345 678" value={draft.visitor_phone} onChange={(e) => set({ visitor_phone: e.target.value })} inputMode="tel" autoComplete="off" />
        <TextField id="visit-id" label="ID number (optional)" value={draft.id_number} onChange={(e) => set({ id_number: e.target.value })} autoComplete="off" />
        <TextField id="visit-plate" label="Vehicle plate (optional)" placeholder="e.g. KDA 123B" value={draft.vehicle_plate} onChange={(e) => set({ vehicle_plate: e.target.value })} autoComplete="off" mono />
      </div>

      <SelectField
        id="visit-host-kind"
        label="Here to see"
        value={draft.host_kind}
        onChange={(e) => { set({ host_kind: e.target.value as VisitHostKind, host_id: null, student_id: null }); setLearner(null); }}
        options={HOST_KIND_OPTIONS}
        hint={escalatesOnArrival(draft.host_kind) ? "The principal's office is told as soon as you save." : undefined}
      />

      {draft.host_kind === "teacher" && (
        <SelectField
          id="visit-host"
          label="Who"
          value={draft.host_id ?? ""}
          onChange={(e) => set({ host_id: e.target.value || null })}
          options={[{ value: "", label: hosts ? "Pick a member of staff" : "Loading staff…" }, ...(hosts ?? []).map((h) => ({ value: h.id, label: h.staff_title ? `${h.full_name} · ${h.staff_title}` : h.full_name }))]}
        />
      )}

      {draft.host_kind === "learner" && (
        learner ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-page px-3 py-2.5 text-[13px]">
            <span><span className="font-semibold">{learner.full_name}</span>{learner.class_name ? <span className="text-ink-muted"> · {learner.class_name}</span> : null}</span>
            <button type="button" className="text-[12.5px] font-semibold text-forest hover:underline" onClick={() => { setLearner(null); set({ student_id: null }); }}>Change</button>
          </div>
        ) : (
          <div>
            <TextField id="visit-learner" label="Learner" placeholder="Type a name or admission number" value={learnerQuery} onChange={(e) => setLearnerQuery(e.target.value)} autoComplete="off" />
            {learnerQuery.trim().length >= 2 && (
              <ul className="mt-1.5 grid gap-1">
                {(matches ?? []).map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className="w-full rounded-md border border-line px-3 py-2 text-left text-[13px] hover:border-forest"
                      onClick={() => { setLearner(m); set({ student_id: m.id }); }}
                    >
                      <span className="font-semibold">{m.full_name}</span>
                      <span className="text-ink-muted">{[m.admission_no, m.class_name].filter(Boolean).map((x) => ` · ${x}`).join("")}</span>
                    </button>
                  </li>
                ))}
                {!searching && matches?.length === 0 && <li className="text-[12.5px] text-ink-faint">No learner matches that.</li>}
              </ul>
            )}
          </div>
        )
      )}

      <TextField id="visit-purpose" label="Reason for the visit" placeholder="e.g. Fees query, collecting a child, delivery" value={draft.purpose} onChange={(e) => set({ purpose: e.target.value })} error={problem ?? undefined} autoComplete="off" />

      <div className="flex justify-end">
        <Button type="submit" variant="accent" disabled={saving}>{saving ? "Saving…" : entryPoint === "gate" ? "Record and send to reception" : "Add to the queue"}</Button>
      </div>
    </form>
  );
}
