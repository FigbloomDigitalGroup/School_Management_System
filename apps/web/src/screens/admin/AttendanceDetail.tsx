import { useEffect, useMemo, useState } from "react";
import {
  adminAccessFor, fetchCollectorDetails, fetchEarlySignOutsForStudents, liveSignOutsByStudent, mayRecordEarlySignOut, mayVoidEarlySignOut, signOutList, signOutTime,
  supabase, today, voidEarlySignOut, MARK_LABEL, MARK_STYLE,
  type AttendanceMark, type EarlySignOut, type EarlySignOutCollector,
} from "@figbloom/shared";
import { EarlySignOutModal } from "../../components/attendance/EarlySignOutModal";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { promptDialog } from "../../components/ui/Confirm";
import { SelectField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { authorisedByText, collectorContactText, collectorLine, leftEarlyLabel, noteText, signOutPickerLabel, voidReasonText } from "../../lib/earlySignOutView";
import { useTenantSession } from "../../lib/sessionContext";

interface RosterMark { id: string; name: string; admissionNo: string; mark: AttendanceMark }

interface Loaded {
  rows: RosterMark[];
  classTeacherId: string | null;
  signOuts: EarlySignOut[];
  details: Map<string, EarlySignOutCollector>;
}

async function fetchClassAttendance(classId: string, date: string): Promise<Loaded> {
  const sb = supabase();
  const [{ data: students, error: e1 }, { data: marks, error: e2 }, { data: cls, error: e3 }] = await Promise.all([
    sb.from("students").select("id, full_name, admission_no").eq("class_id", classId).eq("active", true).order("full_name")
      .returns<{ id: string; full_name: string; admission_no: string }[]>(),
    sb.from("attendance").select("student_id, mark").eq("class_id", classId).eq("taken_on", date)
      .returns<{ student_id: string; mark: AttendanceMark }[]>(),
    sb.from("classes").select("class_teacher_id").eq("id", classId).maybeSingle<{ class_teacher_id: string | null }>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  if (e3) throw new Error(e3.message);

  const markByStudent = new Map((marks ?? []).map((m) => [m.student_id, m.mark]));
  const rows = (students ?? []).map((s) => ({
    id: s.id,
    name: s.full_name,
    admissionNo: s.admission_no,
    mark: markByStudent.get(s.id) ?? "present",
  }));
  // A failed read of the sign-outs must not hide the register: the register is what this window is for.
  const signOuts = signOutList(await fetchEarlySignOutsForStudents(rows.map((r) => r.id), date).catch(() => [] as EarlySignOut[]));
  const details = await fetchCollectorDetails(signOuts.map((s) => s.id)).catch(() => new Map<string, EarlySignOutCollector>());
  return { rows, classTeacherId: cls?.class_teacher_id ?? null, signOuts, details };
}

/**
 * Opened from the Dashboard's attendance fraction — a principal's next
 * question after seeing a class isn't fully present is always "who,
 * exactly", and by what kind of absence (late arrivals aren't absentees).
 *
 * Also the place to see who left early that day (FIG-1513 stage A), to sign a learner out (today only) and to void a sign-out made
 * by mistake. The database decides who may; the buttons are only offered to those it would let through.
 */
export function AttendanceDetail({ classId, className, date, onClose }: {
  classId: string; className: string; date: string; onClose: () => void;
}) {
  const toast = useToast();
  const { profile, adminAreas, actingForTenant } = useTenantSession();
  const access = adminAccessFor(profile.role, adminAreas, actingForTenant);
  const [data, setData] = useState<Loaded | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [pick, setPick] = useState("");
  const [signing, setSigning] = useState<{ id: string; name: string; mark: AttendanceMark } | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchClassAttendance(classId, date)
      .then((r) => { if (alive) setData(r); })
      .catch((err: Error) => { if (alive) toast(`Could not load attendance: ${err.message}`, "error"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, date, reloadKey]);

  const rows = data?.rows ?? null;
  const away = (rows ?? []).filter((r) => r.mark !== "present");
  // The latest live sign-out of each learner: a learner may leave, return and leave again.
  const liveByStudent = useMemo(() => liveSignOutsByStudent(data?.signOuts ?? []), [data]);
  const canRecord = mayRecordEarlySignOut(access, !!data?.classTeacherId && data.classTeacherId === profile.id) && date === today();
  // Everyone is listed, including learners already signed out (they can leave again); the label says so.
  const signable = rows ?? [];

  async function voidOne(s: EarlySignOut) {
    const reason = await promptDialog({
      title: `Void ${s.student_name}'s sign-out?`,
      body: "It stays on record, marked void, with your reason. Use it only for a sign-out made by mistake.",
      label: "Reason",
      required: true,
      confirmLabel: "Void sign-out",
    });
    if (reason === null) return;
    setVoiding(s.id);
    try {
      await voidEarlySignOut(s.id, reason);
      toast("Sign-out voided.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(`Could not void the sign-out: ${err instanceof Error ? err.message : "something went wrong"}`, "error");
    } finally {
      setVoiding(null);
    }
  }

  return (
    <>
    <Modal
      open={!signing}
      onClose={onClose}
      eyebrow={date}
      title={`${className} · who wasn't here`}
      blurb="Learners marked present are left off the first list — only late arrivals, absences and excusals show there. Early sign-outs are listed below it."
      actions={<Button onClick={onClose}>Close</Button>}
    >
      {!rows ? (
        <TableSkeleton rows={4} />
      ) : (
        <>
          {away.length === 0 ? (
            <p className="text-[13px] text-ink-muted">Everyone in {className} was present and on time.</p>
          ) : (
            <ul className="grid gap-2">
              {away.map((r) => {
                const so = liveByStudent.get(r.id);
                return (
                  <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-line-soft px-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium">{r.name}</span>
                      <span className="font-mono text-[11px] text-ink-faint">ADM {r.admissionNo}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {so && <Badge tone="info">{leftEarlyLabel(so)}</Badge>}
                      <span
                        className="rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                        style={{ background: MARK_STYLE[r.mark].bg, color: MARK_STYLE[r.mark].ink }}
                      >
                        {MARK_LABEL[r.mark]}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <h3 className="mb-2 mt-5 text-small font-semibold">Left early</h3>
          {data!.signOuts.length === 0 ? (
            <p className="text-[13px] text-ink-muted">Nobody from {className} was signed out early.</p>
          ) : (
            <ul className="grid gap-2">
              {data!.signOuts.map((s) => {
                const voided = !!s.voided_at;
                const strike = voided ? "text-ink-faint line-through" : "";
                return (
                  <li key={s.id} className="rounded-lg border border-line-soft px-3 py-2.5 text-[12.5px]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className={`text-[13.5px] font-medium ${strike}`}>{s.student_name} · {signOutTime(s)}</div>
                        <div className={`text-ink-muted ${voided ? "line-through" : ""}`}>{s.reason}. Authorised by {authorisedByText(data!.details.get(s.id))}.</div>
                        <div className={`text-ink-muted ${voided ? "line-through" : ""}`}>Collected by {collectorLine(s)}.</div>
                        <div className={`text-[11.5px] text-ink-muted ${voided ? "line-through" : ""}`}>{collectorContactText(data!.details.get(s.id))}</div>
                        {noteText(data!.details.get(s.id)) && (
                          <div className={`text-[11.5px] text-ink-muted ${voided ? "line-through" : ""}`}>Note: {noteText(data!.details.get(s.id))}</div>
                        )}
                        {voided && <div className="text-[11.5px] text-warn-ink">Voided: {voidReasonText(data!.details.get(s.id))}</div>}
                      </div>
                      {!voided && mayVoidEarlySignOut(access, s.recorded_by, profile.id) && (
                        <Button variant="danger" disabled={voiding === s.id} onClick={() => void voidOne(s)}>
                          {voiding === s.id ? "Voiding…" : "Void"}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {canRecord && (
            <div className="mt-4 flex items-end gap-2.5">
              <div className="min-w-0 flex-1">
                <SelectField
                  id="early-sign-out-learner"
                  label="Sign a learner out early"
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  options={[{ value: "", label: "Pick a learner…" }, ...signable.map((r) => ({ value: r.id, label: signOutPickerLabel(r.name, r.admissionNo, liveByStudent.get(r.id)) }))]}
                />
              </div>
              <Button
                variant="primary"
                disabled={!pick}
                onClick={() => { const r = signable.find((x) => x.id === pick); if (r) setSigning({ id: r.id, name: r.name, mark: r.mark }); }}
              >
                Sign out early
              </Button>
            </div>
          )}
        </>
      )}
    </Modal>
    {signing && (
      <EarlySignOutModal
        studentId={signing.id}
        studentName={signing.name}
        className={className}
        todayMark={signing.mark}
        onClose={() => setSigning(null)}
        onRecorded={() => { setPick(""); setReloadKey((k) => k + 1); }}
      />
    )}
    </>
  );
}
