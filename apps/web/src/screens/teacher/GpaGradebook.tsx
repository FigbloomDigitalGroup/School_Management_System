import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createAssessment, fetchAssessments, fetchEnrollmentsForSection, fetchInstructorSections, fetchMarksForAssessment,
  finalizeSectionGrades, parseScoreInput, publishAssessment, saveMarks,
  type CourseAssessment, type EnrolledStudentRow, type InstructorSectionRow,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

/**
 * The higher-ed gradebook — same bulk keyboard-driven entry and draft/publish
 * gate as teacher/Gradebook.tsx, scoped to a course_section's assessments
 * instead of a class's exam+subject. "Finalize grades" is the extra step
 * K-12 doesn't need: it closes a section out by computing each enrolled
 * student's credit-weighted grade from every published assessment (gpa.ts),
 * stored once rather than recomputed live, same reasoning as fee_invoices.
 */
export function GpaGradebook() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();

  const { data: sectionsData, loading: sectionsLoading } = useAsync(() => fetchInstructorSections(tenant.id, profile.id), [tenant.id, profile.id]);
  const sections = useMemo(() => sectionsData ?? [], [sectionsData]);
  const [sectionId, setSectionId] = useState<string | null>(null);

  useEffect(() => {
    if (!sectionId && sections.length > 0) setSectionId(sections[0]!.id);
  }, [sectionId, sections]);

  const section = sections.find((s) => s.id === sectionId);

  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const [addingAssessment, setAddingAssessment] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // reloadKey is a dependency here too: creating an assessment, saving a
  // draft, or publishing all need this list to reflect the change (a newly
  // created assessment otherwise never appears, since sectionId alone never
  // changes when that happens).
  const { data: assessmentsData, loading: assessmentsLoading } = useAsync(
    () => (sectionId ? fetchAssessments(sectionId) : Promise.resolve([] as CourseAssessment[])),
    [sectionId, reloadKey],
  );
  const assessments = useMemo(() => assessmentsData ?? [], [assessmentsData]);

  useEffect(() => { setAssessmentId(null); }, [sectionId]);
  useEffect(() => {
    if (!assessmentId && assessments.length > 0) setAssessmentId(assessments[0]!.id);
  }, [assessmentId, assessments]);

  const assessment = assessments.find((a) => a.id === assessmentId);

  const { data: rosterData, loading: rosterLoading } = useAsync(
    () => (sectionId ? fetchEnrollmentsForSection(sectionId) : Promise.resolve([] as EnrolledStudentRow[])),
    [sectionId],
  );
  const roster = (rosterData ?? []).filter((r) => r.status === "enrolled");

  const { data: existingMarksData } = useAsync(
    () => (assessmentId ? fetchMarksForAssessment(assessmentId) : Promise.resolve({} as Record<string, number | null>)),
    [assessmentId, reloadKey],
  );
  const existingMarks = useMemo(() => existingMarksData ?? {}, [existingMarksData]);

  const [scores, setScores] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [finalizing, setFinalizing] = useState(false);

  const value = (studentId: string) => {
    const key = `${assessmentId}|${studentId}`;
    if (scores[key] !== undefined) return scores[key]!;
    if (studentId in existingMarks) {
      const s = existingMarks[studentId];
      return s === null ? "abs" : String(s);
    }
    return "";
  };

  function set(studentId: string, raw: string) {
    const key = `${assessmentId}|${studentId}`;
    const parsed = parseScoreInput(raw, assessment?.out_of ?? 100);
    setScores((s) => ({ ...s, [key]: raw }));
    setErrors((e) => {
      const next = { ...e };
      if (parsed.ok) delete next[studentId]; else next[studentId] = parsed.message;
      return next;
    });
  }

  function focusNext(i: number) {
    const el = document.querySelector<HTMLInputElement>(`[data-row="${i + 1}"]`);
    el?.focus();
    el?.select();
  }

  const entered = roster.filter((s) => value(s.student_id).trim() !== "").length;

  async function saveDraft() {
    if (!assessmentId) return;
    const rows = roster.flatMap((s) => {
      const raw = value(s.student_id).trim();
      if (raw === "") return [];
      const parsed = parseScoreInput(raw, assessment?.out_of ?? 100);
      if (!parsed.ok) return [];
      return [{ student_id: s.student_id, score: parsed.score }];
    });
    if (!rows.length) { toast("Nothing to save yet."); return; }
    try {
      await saveMarks(tenant.id, assessmentId, profile.id, rows);
      setReloadKey((k) => k + 1);
      toast("Draft saved. Nothing is visible to students yet.");
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.");
    }
  }

  async function publish() {
    if (!assessmentId || !assessment) return;
    try {
      await publishAssessment(assessmentId);
      setReloadKey((k) => k + 1);
      toast(`${assessment.name} published to ${roster.length} student${roster.length === 1 ? "" : "s"}.`);
    } catch (err) {
      toast(err instanceof Error ? `Could not publish: ${err.message}` : "Could not publish.");
    }
  }

  async function finalize() {
    if (!sectionId) return;
    setFinalizing(true);
    try {
      const { studentsGraded } = await finalizeSectionGrades(tenant.id, sectionId);
      toast(studentsGraded
        ? `Finalized grades for ${studentsGraded} student${studentsGraded === 1 ? "" : "s"}.`
        : "Nothing to finalize yet — publish at least one graded assessment first.");
    } catch (err) {
      toast(err instanceof Error ? `Could not finalize grades: ${err.message}` : "Could not finalize grades.");
    } finally {
      setFinalizing(false);
    }
  }

  if (sectionsLoading || (!sections.length && sectionsLoading)) {
    return (
      <>
        <PageHead eyebrow="Gradebook" title="Loading…" />
        <div className="px-7 py-6"><TableSkeleton rows={8} /></div>
      </>
    );
  }

  if (!sections.length) {
    return (
      <>
        <PageHead eyebrow="Gradebook" title="Gradebook" />
        <div className="px-7 py-6">
          <p className="text-[13px] text-ink-muted">No sections assigned yet. Ask the school office to assign you to a course section.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        eyebrow="Gradebook"
        title={section && assessment ? `${section.course_code} ${section.section_label} · ${assessment.name}` : "Gradebook"}
        blurb="Type a mark and press Enter to drop to the next student. Type abs for anyone who missed it — it is recorded as missing, not as zero."
        actions={
          <>
            <Button onClick={() => setAddingAssessment(true)}>Add assessment</Button>
            {assessmentId && (
              <>
                <Button onClick={() => void saveDraft()}>Save draft</Button>
                <Button variant="accent" disabled={!!assessment?.published_at || entered < roster.length} onClick={() => void publish()}>
                  {assessment?.published_at ? "Published" : entered < roster.length ? `${roster.length - entered} still to enter` : "Publish"}
                </Button>
              </>
            )}
            <Button variant="accent" disabled={finalizing} onClick={() => void finalize()}>
              {finalizing ? "Finalizing…" : "Finalize grades"}
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-7 py-3">
        <select value={sectionId ?? ""} onChange={(e) => setSectionId(e.target.value)} aria-label="Section" className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
          {sections.map((s: InstructorSectionRow) => <option key={s.id} value={s.id}>{s.course_code} {s.section_label}</option>)}
        </select>
        {assessmentsLoading ? null : assessments.length === 0 ? (
          <span className="text-[12.5px] text-ink-faint">No assessments yet — add one to start entering marks.</span>
        ) : (
          <select value={assessmentId ?? ""} onChange={(e) => setAssessmentId(e.target.value)} aria-label="Assessment" className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
            {assessments.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.weight_pct}%)</option>)}
          </select>
        )}
        {assessmentId && <span className="ml-auto text-[12.5px] text-ink-muted">{entered} of {roster.length} entered</span>}
      </div>

      <div className="px-7 py-6">
        {rosterLoading || !assessmentId ? (
          <TableSkeleton rows={6} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-line bg-white">
            <div className="grid gap-3.5 border-b border-line bg-sunken px-4 py-2.5 font-mono text-micro tracking-[0.1em] text-ink-muted"
              style={{ gridTemplateColumns: "40px minmax(0,2fr) 140px" }}>
              <div>#</div><div>STUDENT</div><div>MARK / {assessment?.out_of ?? 100}</div>
            </div>
            {roster.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12.5px] text-ink-faint">No one enrolled in this section yet.</div>
            ) : (
              roster.map((s, i) => {
                const raw = value(s.student_id);
                const err = errors[s.student_id];
                return (
                  <div key={s.student_id} className="grid items-center gap-3.5 border-b border-line-soft px-4 py-2" style={{ gridTemplateColumns: "40px minmax(0,2fr) 140px" }}>
                    <div className="font-mono text-[11px] text-ink-faint">{i + 1}</div>
                    <div className="min-w-0">
                      <div className="truncate text-body font-medium">{s.full_name}</div>
                      <div className="font-mono text-[10.5px] text-ink-faint">ADM {s.admission_no}</div>
                    </div>
                    <div>
                      <input
                        data-row={i}
                        value={raw}
                        onChange={(e) => set(s.student_id, e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); focusNext(i); } }}
                        inputMode="numeric"
                        aria-label={`Mark for ${s.full_name}`}
                        aria-invalid={!!err}
                        className="w-[92px] rounded-md border px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-forest"
                        style={{ borderColor: err ? "#B8460A" : "#D3DAD5" }}
                      />
                      {err && <div className="mt-1 text-[11px] text-warn-ink">{err}</div>}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        <p className="mt-4 max-w-[620px] text-[12.5px] leading-relaxed text-ink-muted">
          Publishing an assessment sends its marks to students immediately. Finalizing grades computes each enrolled
          student's weighted score across every published assessment and stores it as their grade for this section —
          run it again any time to recompute after publishing more assessments.
        </p>
      </div>

      {addingAssessment && sectionId && (
        <AddAssessmentModal
          tenantId={tenant.id}
          sectionId={sectionId}
          onClose={() => setAddingAssessment(false)}
          onCreated={(a) => { setAddingAssessment(false); setAssessmentId(a.id); setReloadKey((k) => k + 1); }}
          toast={toast}
        />
      )}
    </>
  );
}

function AddAssessmentModal({ tenantId, sectionId, onClose, onCreated, toast }: {
  tenantId: string; sectionId: string; onClose: () => void; onCreated: (a: CourseAssessment) => void; toast: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [weightPct, setWeightPct] = useState(20);
  const [outOf, setOutOf] = useState(100);
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!name.trim()) { toast("Give the assessment a name."); return; }
    setSaving(true);
    try {
      const a = await createAssessment({ tenant_id: tenantId, course_section_id: sectionId, name: name.trim(), weight_pct: weightPct, out_of: outOf });
      toast(`${name.trim()} added.`);
      onCreated(a);
    } catch (err) {
      toast(err instanceof Error ? `Could not add the assessment: ${err.message}` : "Could not add the assessment.");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) { e.preventDefault(); void create(); }

  return (
    <Modal open onClose={onClose} eyebrow="Gradebook" title="Add an assessment"
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void create()} disabled={saving}>{saving ? "Adding…" : "Add assessment"}</Button></>}>
      <form onSubmit={handleSubmit} className="grid gap-3">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-semibold">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Midterm" autoFocus
            className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none" />
        </label>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Weight (% of final grade)</span>
            <input value={weightPct} inputMode="numeric" onChange={(e) => setWeightPct(Number(e.target.value.replace(/[^0-9]/g, "")) || 0)}
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Out of</span>
            <input value={outOf} inputMode="numeric" onChange={(e) => setOutOf(Number(e.target.value.replace(/[^0-9]/g, "")) || 100)}
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none" />
          </label>
        </div>
      </form>
    </Modal>
  );
}
