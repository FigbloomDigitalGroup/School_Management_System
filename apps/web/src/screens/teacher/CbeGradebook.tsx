import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  GRADE_INK, addSchoolStrand, createCbeAssessment, fetchCbeAssessments, fetchCbeEntries, fetchClassRoster, fetchCurrentTerm,
  fetchStrandsForGrade, fetchTeacherClasses, fetchTeacherSubjectsForClass, publishCbeAssessment, rubricFor, saveCbeEntries,
  summariseStrands, yearLabel, type CbeAssessment, type CbeEntry,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

const cellKey = (studentId: string, strandId: string) => `${studentId}|${strandId}`;

/**
 * CBE strand assessment: one rubric level per learner per strand, plus a
 * comment per learner for the report card. Nothing reaches parents until
 * Publish, and Publish waits until every learner has a level on every strand.
 */
export function CbeGradebook() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [params] = useSearchParams();

  const { data: allClasses, loading: classesLoading } = useAsync(() => fetchTeacherClasses(profile.id), [profile.id]);
  const classes = useMemo(() => (allClasses ?? []).filter((c) => rubricFor(tenant.country, c.level)), [allClasses, tenant.country]);
  const { data: term, loading: termLoading } = useAsync(() => fetchCurrentTerm(), [tenant.id]);

  const [classId, setClassId] = useState<string | null>(null);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const [levels, setLevels] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [addingStrand, setAddingStrand] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (classId || !classes.length) return;
    const requested = params.get("class");
    setClassId(classes.find((c) => c.id === requested)?.id ?? classes[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, classes]);
  useEffect(() => { setSubjectId(null); setAssessmentId(null); }, [classId]);
  useEffect(() => { setAssessmentId(null); }, [subjectId]);
  useEffect(() => { setLevels({}); setComments({}); }, [assessmentId]);

  const cls = classes.find((c) => c.id === classId) ?? null;
  const rubric = cls ? rubricFor(tenant.country, cls.level) ?? [] : [];

  const { data: subjectList } = useAsync(() => (classId ? fetchTeacherSubjectsForClass(profile.id, classId) : Promise.resolve([])), [classId, profile.id]);
  const subjects = useMemo(() => subjectList ?? [], [subjectList]);
  useEffect(() => { if (!subjectId && subjects.length) setSubjectId(subjects[0]!.id); }, [subjectId, subjects]);
  const subject = subjects.find((s) => s.id === subjectId) ?? null;
  const areaId = subject?.learning_area_id ?? null;

  const { data: assessmentList } = useAsync(
    () => (classId && subjectId && term ? fetchCbeAssessments(classId, subjectId, term.id) : Promise.resolve([] as CbeAssessment[])),
    [classId, subjectId, term?.id, version],
  );
  const assessments = useMemo(() => assessmentList ?? [], [assessmentList]);
  useEffect(() => { if (!assessmentId && assessments.length) setAssessmentId(assessments[0]!.id); }, [assessmentId, assessments]);
  const assessment = assessments.find((a) => a.id === assessmentId) ?? null;

  const { data: strandList, loading: strandsLoading } = useAsync(
    () => (areaId && cls ? fetchStrandsForGrade(areaId, cls.form_level) : Promise.resolve([])),
    [areaId, cls?.form_level, version],
  );
  const strands = strandList ?? [];
  const { data: rosterData, loading: rosterLoading } = useAsync(() => (classId ? fetchClassRoster(classId) : Promise.resolve([])), [classId]);
  const roster = rosterData ?? [];
  const { data: saved } = useAsync(() => (assessmentId ? fetchCbeEntries(assessmentId) : Promise.resolve({} as Record<string, CbeEntry>)), [assessmentId, version]);
  const entries = useMemo(() => saved ?? {}, [saved]);

  const level = (studentId: string, strandId: string) =>
    levels[cellKey(studentId, strandId)] ?? entries[studentId]?.levels[strandId] ?? "";
  const comment = (studentId: string) => comments[studentId] ?? entries[studentId]?.comment ?? "";

  const totalCells = roster.length * strands.length;
  const filled = roster.reduce((n, s) => n + strands.filter((st) => level(s.id, st.id)).length, 0);
  const dirty = Object.keys(levels).length > 0 || Object.keys(comments).length > 0;

  async function save(): Promise<boolean> {
    if (!assessment) return false;
    const results: { studentId: string; strandId: string; code: string }[] = [];
    const cleared: { studentId: string; strandId: string }[] = [];
    for (const [k, code] of Object.entries(levels)) {
      const [studentId, strandId] = k.split("|") as [string, string];
      if (code) results.push({ studentId, strandId, code });
      else if (entries[studentId]?.levels[strandId]) cleared.push({ studentId, strandId });
    }
    try {
      await saveCbeEntries({
        tenantId: tenant.id, assessmentId: assessment.id, enteredBy: profile.id, results, cleared,
        comments: Object.entries(comments).map(([studentId, c]) => ({ studentId, comment: c })),
      });
    } catch (err) {
      toast(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    setLevels({});
    setComments({});
    setVersion((v) => v + 1);
    return true;
  }

  async function saveDraft() {
    setBusy(true);
    if (await save()) toast(assessment?.published_at ? "Saved — parents see the update straight away." : "Draft saved. Nothing is visible to parents yet.");
    setBusy(false);
  }

  async function publish() {
    if (!assessment || !subject) return;
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      await publishCbeAssessment(assessment.id);
      setVersion((v) => v + 1);
      toast(`${subject.name} · ${assessment.title} published to ${roster.length} learners and their parents.`);
    } catch (err) {
      toast(`Could not publish: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (classesLoading || termLoading) {
    return <><PageHead eyebrow="Gradebook · strand assessment" title="Loading…" /><div className="px-7 py-6"><TableSkeleton rows={8} /></div></>;
  }
  if (!classes.length) {
    return <Empty title="No CBE classes" body="None of your classes are assessed on the CBE rubric. Exam marks for Form classes are under Exam marks." />;
  }
  if (!term) {
    return <Empty title="No current term" body="Strand assessments belong to a term. Ask the school admin to set this term's dates under School settings." />;
  }

  return (
    <>
      <PageHead
        eyebrow="Gradebook · strand assessment"
        title={subject && assessment ? `${subject.name} · ${assessment.title}` : subject ? subject.name : "Strand assessment"}
        blurb="Pick a level for each learner on each strand. The overall level is worked out from the strands — you only judge the strands."
        actions={assessment && strands.length > 0 ? (
          <>
            <Button onClick={() => void saveDraft()} disabled={busy || !dirty}>{assessment.published_at ? "Save changes" : "Save draft"}</Button>
            {!assessment.published_at && (
              <Button variant="accent" onClick={() => void publish()} disabled={busy || filled < totalCells}>
                {filled < totalCells ? `${totalCells - filled} still to judge` : "Publish"}
              </Button>
            )}
          </>
        ) : undefined}
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-7 py-3">
        <select value={classId ?? ""} onChange={(e) => setClassId(e.target.value)} aria-label="Class" className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={subjectId ?? ""} onChange={(e) => setSubjectId(e.target.value)} aria-label="Learning area" className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
          {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {areaId && (
          <>
            <select value={assessmentId ?? ""} onChange={(e) => setAssessmentId(e.target.value)} aria-label="Assessment"
              className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small" disabled={!assessments.length}>
              {!assessments.length && <option value="">No assessments yet</option>}
              {assessments.map((a) => <option key={a.id} value={a.id}>{a.title}{a.published_at ? " · published" : ""}</option>)}
            </select>
            <Button onClick={() => setCreating(true)}>New assessment</Button>
          </>
        )}
        {assessment && strands.length > 0 && (
          <span className="ml-auto text-[12.5px] text-ink-muted">{filled} of {totalCells} judged</span>
        )}
      </div>

      <div className="px-7 py-6">
        {!subject ? (
          <p className="text-[12.5px] text-ink-muted">You aren't assigned any learning areas in this class yet.</p>
        ) : !areaId ? (
          <Notice>
            {subject.name} isn't linked to a KICD learning area, so there are no strands to assess against. Ask the school admin to
            add it from the KICD curriculum (Subjects → Add from KICD).
          </Notice>
        ) : strandsLoading || rosterLoading ? (
          <TableSkeleton rows={8} />
        ) : !strands.length ? (
          <Notice>
            No strands are loaded for {cls ? yearLabel(cls.level, cls.form_level) : "this grade"} {subject.name} yet — KICD's are still being added to the catalogue.{" "}
            <button type="button" onClick={() => setAddingStrand(true)} className="font-semibold text-leaf hover:underline">Add your own strands</button> to start assessing now.
          </Notice>
        ) : !assessment ? (
          <Notice>
            Create the first assessment for {subject.name} this term — a topic test, a project or the end-of-term assessment.{" "}
            <button type="button" onClick={() => setCreating(true)} className="font-semibold text-leaf hover:underline">New assessment</button>
          </Notice>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-line bg-white">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line bg-sunken font-mono text-micro tracking-[0.1em] text-ink-muted">
                    <th className="sticky left-0 z-10 bg-sunken px-4 py-2.5 font-normal">LEARNER</th>
                    {strands.map((st) => (
                      <th key={st.id} className="min-w-[128px] px-2 py-2.5 align-bottom font-normal" title={st.subStrands.map((x) => x.name).join(" · ") || undefined}>
                        <span className="block font-sans text-[11.5px] font-semibold normal-case tracking-normal text-ink">{st.name}</span>
                        {st.tenant_id && <span className="font-sans text-[10.5px] normal-case tracking-normal text-ink-faint">school's own</span>}
                      </th>
                    ))}
                    <th className="px-3 py-2.5 font-normal">OVERALL</th>
                    <th className="min-w-[220px] px-3 py-2.5 font-normal">COMMENT FOR THE REPORT</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((s) => {
                    const overall = summariseStrands(strands.map((st) => level(s.id, st.id)), rubric).overall;
                    return (
                      <tr key={s.id} className="border-b border-line-soft">
                        <td className="sticky left-0 z-10 bg-white px-4 py-2">
                          <div className="truncate text-body font-medium">{s.full_name}</div>
                          <div className="font-mono text-[10.5px] text-ink-faint">ADM {s.admission_no}</div>
                        </td>
                        {strands.map((st) => {
                          const v = level(s.id, st.id);
                          return (
                            <td key={st.id} className="px-2 py-2">
                              <select
                                value={v}
                                onChange={(e) => setLevels((l) => ({ ...l, [cellKey(s.id, st.id)]: e.target.value }))}
                                aria-label={`${st.name} level for ${s.full_name}`}
                                className="w-full rounded-md border border-[#D3DAD5] bg-white px-2 py-1.5 font-mono text-[13px] font-semibold"
                                style={{ color: v ? GRADE_INK[v] : "#9AA69E" }}
                              >
                                <option value="">—</option>
                                {rubric.map((r) => <option key={r.code} value={r.code} title={r.label}>{r.code}</option>)}
                              </select>
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 font-mono text-[14px] font-semibold" style={{ color: overall ? GRADE_INK[overall.code] : "#9AA69E" }} title={overall?.label}>
                          {overall?.code ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={comment(s.id)}
                            onChange={(e) => setComments((c) => ({ ...c, [s.id]: e.target.value }))}
                            placeholder="Optional"
                            aria-label={`Comment for ${s.full_name}`}
                            className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-forest"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
              <p className="max-w-[620px] text-[12.5px] leading-relaxed text-ink-muted">
                {rubric.map((r) => `${r.code} ${r.label.toLowerCase()}`).join(" · ")}.{" "}
                {assessment.published_at
                  ? "This assessment is published — changes you save reach parents immediately."
                  : "Publishing releases this class's results for this learning area only, to learners and their parents at the same moment."}
              </p>
              <button type="button" onClick={() => setAddingStrand(true)} className="text-[12px] font-semibold text-leaf hover:underline">+ Add a strand</button>
            </div>
          </>
        )}
      </div>

      {creating && classId && subjectId && (
        <NewAssessmentModal
          onClose={() => setCreating(false)}
          onCreate={async (title, kind) => {
            try {
              const a = await createCbeAssessment({ tenantId: tenant.id, termId: term.id, classId, subjectId, title, kind, createdBy: profile.id });
              setCreating(false);
              setVersion((v) => v + 1);
              setAssessmentId(a.id);
              toast(`${title} created.`);
            } catch (err) {
              toast(`Could not create the assessment: ${err instanceof Error ? err.message : String(err)}`);
            }
          }}
        />
      )}
      {addingStrand && areaId && cls && (
        <AddStrandModal
          heading={`${yearLabel(cls.level, cls.form_level)} ${subject?.name ?? ""}`}
          onClose={() => setAddingStrand(false)}
          onAdd={async (name) => {
            try {
              await addSchoolStrand(tenant.id, areaId, cls.form_level, name);
              setAddingStrand(false);
              setVersion((v) => v + 1);
              toast(`${name} added for this school.`);
            } catch (err) {
              toast(`Could not add the strand: ${err instanceof Error ? err.message : String(err)}`);
            }
          }}
        />
      )}
    </>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <>
      <PageHead eyebrow="Gradebook · strand assessment" title={title} />
      <div className="px-7 py-6"><p className="max-w-[560px] text-[13px] leading-relaxed text-ink-muted">{body}</p></div>
    </>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="max-w-[640px] rounded-lg border border-line bg-white px-4 py-3 text-[13px] leading-relaxed text-ink-muted">{children}</p>;
}

function NewAssessmentModal({ onClose, onCreate }: { onClose: () => void; onCreate: (title: string, kind: CbeAssessment["kind"]) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<CbeAssessment["kind"]>("summative");
  const [saving, setSaving] = useState(false);
  return (
    <Modal open onClose={onClose} eyebrow="Strand assessment" title="New assessment"
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="accent" disabled={saving || !title.trim()} onClick={async () => { setSaving(true); await onCreate(title.trim(), kind); setSaving(false); }}>
          {saving ? "Creating…" : "Create"}
        </Button>
      </>}>
      <div className="grid gap-3.5">
        <TextField id="cbe-title" label="Title" placeholder="e.g. End of Term 1, or Project: water cycle" value={title} onChange={(e) => setTitle(e.target.value)} />
        <SelectField id="cbe-kind" label="Kind" value={kind} onChange={(e) => setKind(e.target.value as CbeAssessment["kind"])}
          options={[{ value: "summative", label: "Summative — counts on the report card" }, { value: "formative", label: "Formative — checking progress" }]} />
      </div>
    </Modal>
  );
}

function AddStrandModal({ heading, onClose, onAdd }: { heading: string; onClose: () => void; onAdd: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Modal open onClose={onClose} eyebrow={heading} title="Add a strand"
      blurb="Adds a strand for your school only. Use the name from KICD's curriculum design where you have it, so it lines up once the official list is loaded."
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="accent" disabled={saving || !name.trim()} onClick={async () => { setSaving(true); await onAdd(name.trim()); setSaving(false); }}>
          {saving ? "Adding…" : "Add strand"}
        </Button>
      </>}>
      <TextField id="strand-name" label="Strand" placeholder="e.g. Numbers" value={name} onChange={(e) => setName(e.target.value)} />
    </Modal>
  );
}
