import { useId, useState } from "react";
import { earlySignOutProblem, pushEarlySignOut, recordEarlySignOut, type EarlySignOutDraft } from "@figbloom/shared";
import { absentSignOutWarning, emptySignOutDraft } from "../../lib/earlySignOutView";
import { Button } from "../ui/Button";
import { TextField } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";

/**
 * Records that one learner left school early (FIG-1513 stage A): why, who authorised it and who collected them, with the collector's
 * ID number and phone. All the collector's details are required. record_early_sign_out() decides who may and says why in words when
 * it refuses; those words are shown as they come. On success the parent's phone is told (best effort) and onRecorded() refreshes.
 */
export function EarlySignOutModal({ studentId, studentName, className, todayMark, onClose, onRecorded }: {
  studentId: string; studentName: string; className?: string | null;
  /** The learner's mark on today's register, where the caller knows it. Only "absent" shows a warning; saving is never blocked. */
  todayMark?: "present" | "absent" | "late" | "excused" | null;
  onClose: () => void; onRecorded: () => void;
}) {
  const absentWarning = absentSignOutWarning(studentName, todayMark);
  const toast = useToast();
  const uid = useId();
  const [draft, setDraft] = useState<EarlySignOutDraft>(() => emptySignOutDraft(studentId));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const set = <K extends keyof EarlySignOutDraft>(key: K, value: EarlySignOutDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setProblem(null);
  };

  async function save() {
    if (saving) return;
    const why = earlySignOutProblem(draft);
    if (why) { setProblem(why); return; }
    setSaving(true);
    try {
      const id = await recordEarlySignOut(draft);
      void pushEarlySignOut(id);
      toast(`${studentName} signed out early. The parent is notified if they have the app on a phone.`);
      onRecorded();
      onClose();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "The sign-out could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={className ? `EARLY SIGN-OUT · ${className}` : "EARLY SIGN-OUT"}
      title={`Sign out ${studentName}`}
      blurb="Record who collected the learner. The parent is told on their phone, and the sign-out shows on the register and the school's daily list."
      actions={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Sign out early"}</Button>
        </>
      }
    >
      <form className="grid gap-3.5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {absentWarning && (
          <p role="status" className="flex items-start gap-1.5 rounded-md bg-orange-soft px-3 py-2 text-[12.5px] leading-snug text-orange-ink"><span aria-hidden>!</span>{absentWarning}</p>
        )}
        <TextField id={`${uid}-reason`} label="Reason for leaving" value={draft.reason} maxLength={200} onChange={(e) => set("reason", e.target.value)} />
        <TextField id={`${uid}-auth`} label="Authorised by" hint="Who at the school agreed to it." value={draft.authorised_by} maxLength={120} onChange={(e) => set("authorised_by", e.target.value)} />
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <TextField id={`${uid}-name`} label="Collected by (name)" value={draft.collected_by_name} maxLength={120} onChange={(e) => set("collected_by_name", e.target.value)} />
          <TextField id={`${uid}-rel`} label="Relationship to the learner" placeholder="e.g. Mother" value={draft.collected_by_relationship} maxLength={60} onChange={(e) => set("collected_by_relationship", e.target.value)} />
          <TextField id={`${uid}-idn`} label="Collector's ID number" value={draft.collected_by_id_number} maxLength={30} onChange={(e) => set("collected_by_id_number", e.target.value)} />
          <TextField id={`${uid}-phone`} label="Collector's phone" type="tel" value={draft.collected_by_phone} maxLength={21} onChange={(e) => set("collected_by_phone", e.target.value)} />
        </div>
        <TextField id={`${uid}-note`} label="Note (optional)" hint="Only the attendance office, school admins and whoever records this can read the note." value={draft.note ?? ""} maxLength={500} onChange={(e) => set("note", e.target.value)} />
        <TextField
          id={`${uid}-time`}
          label="Time out (optional)"
          placeholder="HH:MM"
          inputMode="numeric"
          maxLength={5}
          hint="The school's clock, 24 hours, like 10:45. Leave empty for now. It can't be later than now."
          value={draft.signed_out_time ?? ""}
          onChange={(e) => set("signed_out_time", e.target.value)}
        />
        <p className="text-[11.5px] text-ink-faint">The collector's ID number and phone, and the note, are kept private: only the attendance area, school admins (including organisation admins of the school's group) and the person recording the sign-out can read them. Never the family.</p>
        {problem && (
          <p role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{problem}</p>
        )}
      </form>
    </Modal>
  );
}
