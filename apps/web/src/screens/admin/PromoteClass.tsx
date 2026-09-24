import { useEffect, useState } from "react";
import { supabase, type ClassGroup } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";

const GRADUATE = "GRADUATE";
const WITHDRAWN = "WITHDRAWN";
const LEAVING = new Set([GRADUATE, WITHDRAWN]);

interface Roster { id: string; full_name: string; admission_no: string; profile_id: string | null }
interface PromoteRow extends Roster { target: string }

async function fetchRoster(classId: string): Promise<Roster[]> {
  const { data, error } = await supabase()
    .from("students").select("id, full_name, admission_no, profile_id").eq("class_id", classId).eq("active", true).order("full_name")
    .returns<Roster[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Each student's mean across every subject of the most recently published
 *  exam — what "promote if passing" judges against. A student with no marks
 *  on record simply has no entry, so the bulk action leaves them untouched
 *  rather than guessing. */
async function fetchLatestExamMeans(tenantId: string, studentIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!studentIds.length) return out;
  const { data: examRows, error: e1 } = await supabase()
    .from("exams").select("id").eq("tenant_id", tenantId).not("published_at", "is", null).order("published_at", { ascending: false }).limit(1)
    .returns<{ id: string }[]>();
  if (e1) throw new Error(e1.message);
  const examId = examRows?.[0]?.id;
  if (!examId) return out;

  const { data: markRows, error: e2 } = await supabase()
    .from("marks").select("student_id, score").eq("exam_id", examId).in("student_id", studentIds)
    .returns<{ student_id: string; score: number | null }[]>();
  if (e2) throw new Error(e2.message);

  const scoresByStudent = new Map<string, number[]>();
  for (const m of markRows ?? []) {
    if (m.score === null) continue;
    const arr = scoresByStudent.get(m.student_id) ?? [];
    arr.push(m.score);
    scoresByStudent.set(m.student_id, arr);
  }
  for (const [sid, scores] of scoresByStudent) out.set(sid, Math.round(scores.reduce((a, b) => a + b, 0) / scores.length));
  return out;
}

/** Same level, one form up, matching stream first — the common case for a
 *  school with parallel streams (East stays East). Falls back to any class
 *  at that next form, then to "graduating" once there's nowhere higher to go. */
function defaultTargetFor(source: ClassGroup, allClasses: ClassGroup[]): string {
  const nextForm = allClasses.filter((c) => c.level === source.level && c.form_level === source.form_level + 1);
  if (nextForm.length === 0) return GRADUATE;
  const sameStream = nextForm.find((c) => c.stream === source.stream);
  return (sameStream ?? nextForm[0]!).id;
}

/** The in-app notice sent home for one outcome — a guardian (and the student,
 *  if they have their own login) both get this, worded the same either way. */
function messageFor(r: PromoteRow, sourceClass: ClassGroup, classById: Map<string, ClassGroup>): { subject: string; body: string } {
  if (r.target === sourceClass.id) {
    return {
      subject: `${r.full_name} will repeat ${sourceClass.name}`,
      body: `${r.full_name} will repeat ${sourceClass.name} next term rather than moving up. Reach out to the school office if you'd like to talk it through.`,
    };
  }
  if (r.target === WITHDRAWN) {
    return {
      subject: `${r.full_name} has left ${sourceClass.name}`,
      body: `${r.full_name} is no longer enrolled at the school as of this term's promotion round.`,
    };
  }
  if (r.target === GRADUATE) {
    return {
      subject: `Congratulations, ${r.full_name}!`,
      body: `${r.full_name} has completed ${sourceClass.name} and graduated. Congratulations on this milestone!`,
    };
  }
  const targetName = classById.get(r.target)?.name ?? "the next class";
  return {
    subject: `Congratulations, ${r.full_name}!`,
    body: `${r.full_name} has been promoted from ${sourceClass.name} to ${targetName}. Well done this year!`,
  };
}

/**
 * There's no automatic year-end promotion — a form teacher reviews their own
 * roster and decides, student by student, who moves up and who repeats.
 * Opened per source class from admin/Classes.tsx; a sensible default is
 * pre-picked for every row so reviewing 40 names is mostly confirming, not choosing.
 * Every outcome sends an in-app notice to the student (if they have a login)
 * and every guardian on file — promoted or not, nobody finds out by surprise.
 */
export function PromoteClass({ sourceClass, allClasses, tenantId, authorId, onClose, onDone }: {
  sourceClass: ClassGroup;
  allClasses: ClassGroup[];
  tenantId: string;
  authorId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<PromoteRow[] | null>(null);
  const [examMeans, setExamMeans] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);
  const [passMark, setPassMark] = useState("50");

  useEffect(() => {
    let alive = true;
    fetchRoster(sourceClass.id)
      .then(async (roster) => {
        if (!alive) return;
        const target = defaultTargetFor(sourceClass, allClasses);
        setRows(roster.map((s) => ({ ...s, target })));
        const means = await fetchLatestExamMeans(tenantId, roster.map((s) => s.id));
        if (alive) setExamMeans(means);
      })
      .catch((err: Error) => { if (alive) setError(err); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceClass.id]);

  function setTarget(studentId: string, target: string) {
    setRows((rs) => (rs ?? []).map((r) => (r.id === studentId ? { ...r, target } : r)));
  }

  function resetToSuggested() {
    const target = defaultTargetFor(sourceClass, allClasses);
    setRows((rs) => (rs ?? []).map((r) => ({ ...r, target })));
  }

  function applyByPassMark() {
    const threshold = parseFloat(passMark);
    if (!Number.isFinite(threshold)) { toast("Enter a valid pass mark.", "error"); return; }
    if (!rows || !rows.some((r) => examMeans.has(r.id))) {
      toast("No exam marks on record for this class yet — nothing to judge by.", "error");
      return;
    }
    const promoteTarget = defaultTargetFor(sourceClass, allClasses);
    setRows((rs) => (rs ?? []).map((r) => {
      const mean = examMeans.get(r.id);
      if (mean === undefined) return r; // no score on record — leave whatever's already chosen
      return { ...r, target: mean >= threshold ? promoteTarget : sourceClass.id };
    }));
  }

  const promotedCount = rows?.filter((r) => r.target !== sourceClass.id && !LEAVING.has(r.target)).length ?? 0;
  const repeatingCount = rows?.filter((r) => r.target === sourceClass.id).length ?? 0;
  const leavingCount = rows?.filter((r) => LEAVING.has(r.target)).length ?? 0;

  async function notifyGuardians(processed: PromoteRow[]) {
    const classById = new Map(allClasses.map((c) => [c.id, c]));
    const { data: guardianRows, error: gErr } = await supabase()
      .from("guardians").select("student_id, profile_id")
      .in("student_id", processed.map((r) => r.id))
      .returns<{ student_id: string; profile_id: string }[]>();
    if (gErr) throw gErr;

    const guardianIdsByStudent = new Map<string, string[]>();
    for (const g of guardianRows ?? []) {
      const ids = guardianIdsByStudent.get(g.student_id) ?? [];
      ids.push(g.profile_id);
      guardianIdsByStudent.set(g.student_id, ids);
    }

    const now = new Date().toISOString();
    const announcements = processed.flatMap((r) => {
      const recipients = new Set<string>(guardianIdsByStudent.get(r.id) ?? []);
      if (r.profile_id) recipients.add(r.profile_id);
      if (recipients.size === 0) return [];
      const { subject, body } = messageFor(r, sourceClass, classById);
      return [...recipients].map((user_id) => ({
        tenant_id: tenantId, author_id: authorId, subject, body,
        audience: { kind: "user" as const, user_id },
        channels: ["in_app"], published_at: now,
      }));
    });

    if (announcements.length) {
      const { error: err } = await supabase().from("announcements").insert(announcements);
      if (err) throw err;
    }
  }

  async function submit() {
    if (!rows || rows.length === 0) return;
    if (!window.confirm(
      `${sourceClass.name}: move ${promotedCount} up, keep ${repeatingCount} repeating, mark ${leavingCount} as left. Apply this to all ${rows.length} learners?`,
    )) return;

    setSaving(true);
    try {
      const leaving = rows.filter((r) => LEAVING.has(r.target)).map((r) => r.id);
      if (leaving.length) {
        const { error: err } = await supabase().from("students").update({ active: false }).in("id", leaving);
        if (err) throw err;
      }

      const idsByTargetClass = new Map<string, string[]>();
      for (const r of rows) {
        if (LEAVING.has(r.target) || r.target === sourceClass.id) continue;
        const ids = idsByTargetClass.get(r.target) ?? [];
        ids.push(r.id);
        idsByTargetClass.set(r.target, ids);
      }
      for (const [classId, ids] of idsByTargetClass) {
        const { error: err } = await supabase().from("students").update({ class_id: classId }).in("id", ids);
        if (err) throw err;
      }

      try {
        await notifyGuardians(rows);
      } catch (notifyErr) {
        toast(`${sourceClass.name} was updated, but notices could not be sent: ${notifyErr instanceof Error ? notifyErr.message : "unknown error"}`, "error");
        onDone();
        return;
      }

      toast(`${sourceClass.name}: ${rows.length} learner${rows.length === 1 ? "" : "s"} processed and notified.`);
      onDone();
    } catch (err) {
      toast(err instanceof Error ? `Could not finish promoting: ${err.message}` : "Could not finish promoting.", "error");
    } finally {
      setSaving(false);
    }
  }

  const otherClasses = allClasses
    .filter((c) => c.id !== sourceClass.id)
    .sort((a, b) => a.form_level - b.form_level || a.name.localeCompare(b.name));

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Promote"
      title={`Promote · ${sourceClass.name}`}
      blurb="Pick where each learner goes next year. A likely default is already chosen for every row — check it, don't just trust it. Every outcome sends a notice home."
      width={720}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void submit()} disabled={!rows || rows.length === 0 || saving}>
            {saving ? "Applying…" : "Apply"}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="text-[12.5px] text-warn-ink">Could not load the roster: {error.message}</p>
      ) : !rows ? (
        <TableSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <p className="text-[12.5px] text-ink-muted">No active learners in {sourceClass.name} right now.</p>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-4 text-[12px] text-ink-muted">
            <span><strong className="text-ink">{promotedCount}</strong> promoted</span>
            <span><strong className="text-ink">{repeatingCount}</strong> repeating</span>
            <span><strong className="text-ink">{leavingCount}</strong> leaving</span>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-sunken px-3 py-2.5">
            <span className="text-[11.5px] font-semibold text-ink-muted">Bulk</span>
            <Button onClick={resetToSuggested}>Reset to suggested</Button>
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-[12px] text-ink-muted">Promote if exam mean ≥</span>
              <input
                value={passMark}
                onChange={(e) => setPassMark(e.target.value)}
                inputMode="numeric"
                aria-label="Pass mark"
                className="w-14 rounded-md border border-[#D3DAD5] px-2 py-1 text-center font-mono text-[12.5px] outline-none"
              />
              <Button onClick={applyByPassMark}>Apply</Button>
            </div>
          </div>

          <ul className="grid gap-1.5">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-lg border border-line-soft px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{r.full_name}</span>
                  <span className="font-mono text-[11px] text-ink-faint">
                    ADM {r.admission_no}{examMeans.has(r.id) ? ` · mean ${examMeans.get(r.id)}` : ""}
                  </span>
                </span>
                <select
                  value={r.target}
                  onChange={(e) => setTarget(r.id, e.target.value)}
                  aria-label={`Where ${r.full_name} goes next`}
                  className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
                >
                  <option value={sourceClass.id}>Repeat — stays in {sourceClass.name}</option>
                  {otherClasses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  <option value={GRADUATE}>Graduating — completed {sourceClass.name}</option>
                  <option value={WITHDRAWN}>Leaving — withdrawn from school</option>
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
