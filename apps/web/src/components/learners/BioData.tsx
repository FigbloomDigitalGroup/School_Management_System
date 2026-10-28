import { useEffect, useState } from "react";
import {
  BIO_FIELD_LABELS, bioChanges, bioFieldList, bioProblem, bioToInput, bioValueLabel, decideBioRequest, fetchLearnerBio,
  fetchLearnerGuardians, fetchPendingBioRequest, fetchPendingBioRequests, saveLearnerBio, splitBioChanges, supabase,
  type BioIdentityField, type BioRequest, type LearnerBioInput, type LearnerGuardianContact, type PendingBioRequest,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import type { ToastFn } from "../ui/Toast";
import { SendSignInAgainButton } from "../PasswordReset";

/**
 * Bio data (20261027040000_parent_bio_data.sql): the identity details a
 * school registers a learner by, and everyday details a family keeps up to
 * date. A parent's change to name, date of birth, gender, birth certificate
 * or UPI goes to the office for approval; the rest saves at once. The office
 * sees and decides those requests here (per learner) and on People (all).
 */

const input = "w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px] outline-none";
const label = "mb-1 block text-[11.5px] font-semibold";
const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function BioFields({ value, onChange, withNameAndGender, pending }: {
  value: LearnerBioInput;
  onChange: (v: LearnerBioInput) => void;
  /** The office edits name and gender under Details already. */
  withNameAndGender: boolean;
  /** Fields with a change waiting for the office: marked, so a parent knows. */
  pending: Set<string>;
}) {
  const set = (patch: Partial<LearnerBioInput>) => onChange({ ...value, ...patch });
  const text = (k: keyof LearnerBioInput) => ({
    value: (value[k] as string | null) ?? "",
    onChange: (e: { target: { value: string } }) => set({ [k]: e.target.value } as Partial<LearnerBioInput>),
  });
  const caption = (k: keyof LearnerBioInput) => (
    <span className={label}>
      {BIO_FIELD_LABELS[k]}
      {pending.has(k) && <span className="ml-1.5 rounded-full bg-[#FDF3E1] px-1.5 py-px text-[10.5px] font-semibold text-[#8A5A0B]">Awaiting office</span>}
    </span>
  );

  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
      {withNameAndGender && (
        <>
          <label className="block">
            {caption("full_name")}
            <input {...text("full_name")} maxLength={120} className={input} />
          </label>
          <label className="block">
            {caption("gender")}
            <select value={value.gender ?? ""} onChange={(e) => set({ gender: (e.target.value || null) as LearnerBioInput["gender"] })} className={input}>
              <option value="">Not set</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </label>
        </>
      )}
      <label className="block">
        {caption("date_of_birth")}
        <input type="date" {...text("date_of_birth")} max={new Date().toISOString().slice(0, 10)} className={input} />
      </label>
      <label className="block">
        {caption("birth_cert_no")}
        <input {...text("birth_cert_no")} maxLength={40} className={`${input} font-mono`} />
      </label>
      <label className="block">
        {caption("upi_no")}
        <input {...text("upi_no")} maxLength={30} placeholder="From NEMIS, if the learner has one" className={`${input} font-mono`} />
      </label>
      <label className="block">
        {caption("nationality")}
        <input {...text("nationality")} maxLength={60} placeholder="e.g. Kenyan" className={input} />
      </label>
      <label className="block">
        {caption("religion")}
        <input {...text("religion")} maxLength={60} className={input} />
      </label>
      <label className="block">
        {caption("previous_school")}
        <input {...text("previous_school")} maxLength={160} className={input} />
      </label>
    </div>
  );
}

/** "Date of birth: 12 Mar 2014 → 13 Mar 2014" for each field in a request. */
function RequestLines({ request }: { request: BioRequest }) {
  return (
    <ul className="mt-1 grid gap-0.5 text-[12.5px]">
      {(Object.keys(request.changes) as BioIdentityField[]).map((f) => (
        <li key={f}>
          <span className="text-ink-muted">{BIO_FIELD_LABELS[f]}:</span>{" "}
          <span className="line-through decoration-ink-faint">{bioValueLabel(f, request.previous[f])}</span>{" → "}
          <span className="font-semibold">{bioValueLabel(f, request.changes[f])}</span>
        </li>
      ))}
    </ul>
  );
}

/** Approve / reject buttons for one request, with an optional reason on reject. */
function DecideButtons({ request, onDone, toast }: { request: BioRequest; onDone: () => void; toast: ToastFn }) {
  const [working, setWorking] = useState(false);
  async function decide(approve: boolean) {
    const note = approve ? undefined : window.prompt("Why not? The family sees this. (Optional)") ?? undefined;
    setWorking(true);
    try {
      await decideBioRequest(request.id, approve, note);
      toast(approve ? "Approved. The learner's details are updated." : "Rejected. The details stay as they were.");
      onDone();
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="mt-2 flex gap-2">
      <Button variant="primary" disabled={working} onClick={() => void decide(true)}>Approve</Button>
      <Button disabled={working} onClick={() => void decide(false)}>Reject</Button>
    </div>
  );
}

/**
 * Load, edit and save one learner's bio data. "parent" for a guardian's child
 * profile, "admin" for Manage learner (approves requests, sees who changed it).
 */
export function BioDataEditor({ studentId, toast, mode, title = "Bio data", onRequestDecided }: {
  studentId: string; toast: ToastFn; mode: "parent" | "admin"; title?: string;
  /** The office approved or rejected a request here: lists elsewhere can refresh. */
  onRequestDecided?: () => void;
}) {
  const [saved, setSaved] = useState<LearnerBioInput | null>(null);
  const [value, setValue] = useState<LearnerBioInput | null>(null);
  const [stamp, setStamp] = useState<{ at: string; by: string | null } | null>(null);
  const [request, setRequest] = useState<BioRequest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchLearnerBio(studentId), fetchPendingBioRequest(studentId)])
      .then(async ([bio, req]) => {
        let by: string | null = null;
        // who changed it last, for the office: a parent's name, or a colleague's
        if (mode === "admin" && bio.bio_updated_by) {
          const { data } = await supabase().from("profiles").select("full_name, role").eq("id", bio.bio_updated_by)
            .maybeSingle<{ full_name: string; role: string }>();
          if (data) by = data.role === "parent" ? `${data.full_name} (parent)` : data.full_name;
        }
        if (!alive) return;
        // a parent's form starts from what they asked for while it waits, so
        // saving something else doesn't look like it undid the request
        const input = mode === "parent" && req ? { ...bioToInput(bio), ...req.changes } as LearnerBioInput : bioToInput(bio);
        setSaved(input);
        setValue(input);
        setRequest(req);
        setStamp(bio.bio_updated_at ? { at: bio.bio_updated_at, by } : null);
      })
      .catch((err: Error) => { if (alive) setLoadError(err.message); });
    return () => { alive = false; };
  }, [studentId, mode, reloadKey]);

  const changes = saved && value ? bioChanges(saved, value) : {};
  const { now, approval } = splitBioChanges(changes);
  const dirty = now.length + approval.length > 0;

  async function save() {
    if (!value || !dirty) return;
    const problem = bioProblem(value);
    if (problem) { toast(problem, "error"); return; }
    setSaving(true);
    try {
      const r = await saveLearnerBio(studentId, changes);
      toast(
        r.pending.length === 0 ? "Details saved."
          : r.saved.length === 0 ? `Sent to the school office to approve: ${bioFieldList(r.pending)}.`
          : `Saved. ${bioFieldList(r.pending)} sent to the school office to approve.`,
      );
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function withdraw() {
    if (!request) return;
    try {
      await decideBioRequest(request.id, false);
      toast("Request withdrawn.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not withdraw: ${err.message}` : "Could not withdraw.", "error");
    }
  }

  const pendingFields = new Set(request ? Object.keys(request.changes) : []);

  return (
    <div className="mb-5 border-b border-line-soft pb-5">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {mode === "parent" && (
        <p className="mt-0.5 text-[12px] text-ink-muted">
          Changes to name, date of birth, gender, birth certificate or UPI number go to the school office to check first. The rest saves straight away.
        </p>
      )}
      <div className="mt-2">
        {loadError ? (
          <p className="text-[12.5px] text-warn-ink">Could not load bio data: {loadError}</p>
        ) : !value ? (
          <p className="text-small text-ink-faint">Loading…</p>
        ) : (
          <>
            {request && mode === "admin" && (
              <div className="mb-3 rounded-lg border border-[#F0DDB8] bg-[#FDF3E1] px-3 py-2.5">
                <div className="text-[12.5px] font-semibold text-[#8A5A0B]">A parent asked to change these details · {shortDate(request.created_at)}</div>
                <RequestLines request={request} />
                <DecideButtons request={request} onDone={() => { setReloadKey((k) => k + 1); onRequestDecided?.(); }} toast={toast} />
              </div>
            )}
            <BioFields
              value={value}
              onChange={(v) => setValue(v)}
              withNameAndGender={mode === "parent"}
              pending={mode === "parent" ? pendingFields : new Set()}
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? "Saving…" : mode === "parent" && approval.length > 0 ? "Save and send for approval" : "Save bio data"}
              </Button>
              {mode === "parent" && request && (
                <button type="button" onClick={() => void withdraw()} className="text-[12px] text-ink-muted underline hover:text-ink">
                  Withdraw the change waiting for approval
                </button>
              )}
              {stamp && (
                <span className="text-[11.5px] text-ink-faint">
                  Last updated {shortDate(stamp.at)}{stamp.by ? ` by ${stamp.by}` : ""}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The office's view of who looks after a learner and how to reach them; parents keep it current from My account. */
export function GuardianContacts({ studentId, schoolName }: { studentId: string; schoolName?: string }) {
  const [rows, setRows] = useState<LearnerGuardianContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchLearnerGuardians(studentId)
      .then((r) => { if (alive) setRows(r); })
      .catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [studentId]);

  return (
    <div className="mb-5 border-b border-line-soft pb-5">
      <h3 className="text-[13px] font-semibold">Guardians</h3>
      {error ? (
        <p className="mt-1 text-[12.5px] text-warn-ink">Could not load guardians: {error}</p>
      ) : !rows ? (
        <p className="mt-1 text-small text-ink-faint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-ink-faint">No guardian linked yet. Use Invite guardians.</p>
      ) : (
        <ul className="mt-1.5 grid gap-1.5">
          {rows.map((g) => (
            <li key={g.profile_id} className="flex flex-wrap items-baseline gap-x-3 text-[13px]">
              <span className="font-medium">{g.full_name}</span>
              <span className="text-[12px] capitalize text-ink-muted">{g.relationship}</span>
              <span className="font-mono text-[12.5px]">{g.phone ?? "No phone"}</span>
              {g.alt_phone && <span className="font-mono text-[12.5px] text-ink-muted">also {g.alt_phone}</span>}
              {g.email && <span className="text-[12.5px] text-ink-muted">{g.email}</span>}
              {g.email && <SendSignInAgainButton profileId={g.profile_id} name={g.full_name} email={g.email} schoolName={schoolName} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Top of People: every change parents have asked for, decided in place, or
 * opened on the learner. Renders nothing when there are none.
 */
export function BioRequestsPanel({ tenantId, onOpenLearner, toast, reloadKey = 0 }: {
  tenantId: string; onOpenLearner: (studentId: string) => void; toast: ToastFn; reloadKey?: number;
}) {
  const [rows, setRows] = useState<PendingBioRequest[]>([]);
  const [open, setOpen] = useState(false);
  const [ownKey, setOwnKey] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchPendingBioRequests(tenantId)
      .then((r) => { if (alive) setRows(r); })
      // a school without the migration yet, or a read error: the panel just stays away
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [tenantId, reloadKey, ownKey]);

  if (rows.length === 0) return null;
  return (
    <section className="mb-4 overflow-hidden rounded-lg border border-[#F0DDB8] bg-[#FDF3E1]">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left">
        <span className="text-[13px] font-semibold text-[#8A5A0B]">
          {rows.length === 1 ? "1 change to a learner's details" : `${rows.length} changes to learners' details`} from parents to approve
        </span>
        <span aria-hidden className="text-[#8A5A0B]">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <ul className="border-t border-[#F0DDB8] bg-white">
          {rows.map((r) => (
            <li key={r.id} className="border-b border-line-soft px-4 py-3 last:border-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <button type="button" onClick={() => onOpenLearner(r.student_id)} className="text-[13px] font-semibold underline-offset-2 hover:underline">
                  {r.student_name}
                </button>
                <span className="text-[11.5px] text-ink-faint">
                  {r.requester_name ? `Asked by ${r.requester_name}` : "Asked by a parent"} · {shortDate(r.created_at)}
                </span>
              </div>
              <RequestLines request={r} />
              <DecideButtons request={r} onDone={() => setOwnKey((k) => k + 1)} toast={toast} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
