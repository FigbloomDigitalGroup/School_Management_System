import { useEffect, useState } from "react";
import {
  AI_COMMENT_BATCH, chunk, draftReportComments, learnerForAi,
  defaultReportCardOptions, fetchClassReportCards, fetchReportCardSetup, fetchTermExams, gradingSchemeFor, rubricFor,
  prepareClassReportCards, reportCardFileName, saveReportCardComments, saveReportCards, saveTeacherComment,
  setReportCardsPublished, suggestComment, type ReportCardOptions, type StoredReportCard,
  CAPACITY_LABEL, fetchDocumentSignatures, signatureDate, signatureFor, signDocuments, type StoredSignature,
} from "@figbloom/shared";
import { CompetencyRatings } from "../../components/CompetencyRatings";
import { SignDocumentModal } from "../../components/signatures/SignDocumentModal";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { AI_DRAFT_NOTE, useAiStatus } from "../../lib/useAi";

/**
 * Report cards for a class and term. The office picks which exams count,
 * prepares the class (every learner's card worked out and stored), writes or
 * fills in comments, downloads the PDFs to print, and publishes them so
 * families can download their own from Results. A class teacher sees their
 * own class here, writes the class teacher's comment and downloads, but
 * can't prepare or publish.
 */
export function ReportCards({ teacher = false }: { teacher?: boolean }) {
  const toast = useToast();
  const { tenant, profile } = useTenantSession();
  const [termId, setTermId] = useState("");
  const [classId, setClassId] = useState("");
  const [examIds, setExamIds] = useState<string[] | null>(null);
  const [options, setOptions] = useState<ReportCardOptions | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<StoredReportCard | null>(null);
  const [signing, setSigning] = useState(false);

  const setup = useAsync(() => fetchReportCardSetup(tenant.id, teacher ? profile.id : undefined), [tenant.id, teacher, profile.id]);
  const terms = setup.data?.terms ?? [];
  const classes = setup.data?.classes ?? [];

  // Start on the current term and the first class.
  useEffect(() => {
    const d = setup.data;
    if (!d) return;
    setTermId((id) => id || (d.terms.find((t) => t.isCurrent) ?? d.terms[0])?.id || "");
    setClassId((id) => id || d.classes[0]?.id || "");
  }, [setup.data]);

  const cls = classes.find((c) => c.id === classId);
  const scheme = cls ? gradingSchemeFor(tenant.country, cls.level) : "kcse";
  // CBE classes are judged on a rubric, so their cards can come from CBE assessments alone, with no exams.
  const isCbe = !!cls && rubricFor(tenant.country, cls.level) !== null;

  const exams = useAsync(() => (termId ? fetchTermExams(termId) : Promise.resolve([])), [termId]);
  // Every exam with results out counts by default; options start from the class's grading scheme.
  useEffect(() => { setExamIds(null); }, [termId]);
  useEffect(() => {
    if (examIds === null && exams.data) setExamIds(exams.data.filter((e) => e.published).map((e) => e.id));
  }, [exams.data, examIds]);
  useEffect(() => { setOptions(defaultReportCardOptions(scheme)); }, [classId, scheme]);

  const cards = useAsync(
    () => (termId && classId ? fetchClassReportCards(termId, classId) : Promise.resolve([] as StoredReportCard[])),
    [termId, classId, reloadKey],
  );
  const rows = cards.data ?? [];
  const drafts = rows.filter((c) => !c.publishedAt);
  const published = rows.filter((c) => c.publishedAt);

  // The office signs as principal, a class teacher as class teacher; both
  // are stamped on the PDF while the card is unchanged since signing.
  const capacity = teacher ? "class_teacher" : "principal";
  const sigs = useAsync(() => fetchDocumentSignatures("report_card", rows.map((c) => c.id)), [cards.data, reloadKey]);
  const signatures: StoredSignature[] = sigs.data ?? [];
  const unsigned = rows.filter((c) => !signatureFor(signatures, c.id, capacity, { currentOnly: true }));

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try { await fn(); } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong.", "error");
    } finally { setBusy(null); }
  }

  const prepare = () => run("prepare", async () => {
    if (!options || !examIds) return;
    const prepared = await prepareClassReportCards({
      tenantId: tenant.id,
      school: { name: tenant.name, county: tenant.county, country: tenant.country, logoUrl: tenant.logo_url, accent: tenant.accent },
      termId, classId, examIds, options,
    });
    if (!prepared.length) { toast("This class has no learners to prepare report cards for.", "error"); return; }
    const { saved, skippedPublished } = await saveReportCards(tenant.id, termId, classId, prepared);
    toast(skippedPublished
      ? `${saved} report cards prepared. ${skippedPublished} already sent to families were left as issued.`
      : `${saved} report cards prepared.`);
    setReloadKey((k) => k + 1);
  });

  const ai = useAiStatus();

  // Bloom (AI) drafts the empty comment boxes on cards not yet sent. They stay drafts
  // until someone reads them and sends the class.
  const aiComments = () => run("ai", async () => {
    const targets = teacher
      ? rows.filter((c) => !c.publishedAt && !c.teacherComment)
      : drafts.filter((c) => !c.teacherComment || !c.principalComment);
    if (!targets.length) { toast("Every report card not yet sent already has its comments."); return; }
    let n = 0;
    for (const batch of chunk(targets, AI_COMMENT_BATCH)) {
      const out = await draftReportComments(teacher ? "teacher" : "both", batch.map((c) => learnerForAi(c.id, c.data)));
      const byRef = new Map(out.map((o) => [o.ref, o]));
      for (const c of batch) {
        const o = byRef.get(c.id);
        if (!o) continue;
        if (teacher) {
          if (o.teacher.trim()) { await saveTeacherComment(c.id, o.teacher); n++; }
          continue;
        }
        const patch: { teacher?: string; principal?: string } = {};
        if (!c.teacherComment && o.teacher.trim()) patch.teacher = o.teacher;
        if (!c.principalComment && o.principal.trim()) patch.principal = o.principal;
        if (patch.teacher || patch.principal) { await saveReportCardComments(c.id, patch); n++; }
      }
    }
    toast(n ? `Bloom drafted comments for ${n} learner${n === 1 ? "" : "s"}. Read and edit them before the cards are sent.` : "Bloom didn't return any comments. Try again.");
    setReloadKey((k) => k + 1);
  });

  const fillComments = () => run("fill", async () => {
    let n = 0;
    for (const c of drafts) {
      const first = c.data.learner.name.split(" ")[0] ?? "";
      const patch: { teacher?: string; principal?: string } = {};
      if (!c.teacherComment) patch.teacher = suggestComment(c.data.summary.grade, first, "teacher");
      if (!c.principalComment) patch.principal = suggestComment(c.data.summary.grade, first, "principal");
      if (patch.teacher || patch.principal) { await saveReportCardComments(c.id, patch); n++; }
    }
    toast(n ? `Suggested comments added to ${n} report cards. Edit any of them before publishing.` : "Every report card already has its comments.");
    setReloadKey((k) => k + 1);
  });

  const publish = (ids: string[], on: boolean) => run(on ? "publish" : "withdraw", async () => {
    const what = on ? `Send ${ids.length} report card${ids.length === 1 ? "" : "s"} to families? They can then download them from Results.` : `Withdraw ${ids.length} report card${ids.length === 1 ? "" : "s"}? Families will no longer see them.`;
    if (!window.confirm(what)) return;
    await setReportCardsPublished(ids, on);
    toast(on ? "Report cards sent to families." : "Report cards withdrawn.");
    setReloadKey((k) => k + 1);
  });

  const download = (list: StoredReportCard[], kind: "cards" | "sheet") => run(kind, async () => {
    const pdf = await import("../../lib/reportCardPdf");
    const logo = await pdf.fetchLogo(tenant.logo_url);
    const first = list[0]!.data;
    if (kind === "sheet") {
      pdf.saveFile(await pdf.renderResultsSheetPdf(list.map((c) => c.data), { logo }), `${first.term.name} results - ${first.learner.className}.pdf`);
    } else {
      const bytes = await pdf.renderReportCardsPdf(list.map((c) => ({
        data: c.data, teacherComment: c.teacherComment, principalComment: c.principalComment,
        signatures: {
          teacher: signatureFor(signatures, c.id, "class_teacher", { currentOnly: true }),
          principal: signatureFor(signatures, c.id, "principal", { currentOnly: true }),
        },
      })), { logo });
      pdf.saveFile(bytes, list.length === 1 ? reportCardFileName(first) : `${first.term.name} report cards - ${first.learner.className}.pdf`);
    }
  });

  const term = terms.find((t) => t.id === termId);
  const anyPosition = rows.some((c) => c.data.summary.position !== null);

  return (
    <>
      <PageHead
        eyebrow={term ? `Report cards · ${term.name.toLowerCase()}` : "Report cards"}
        title="Report cards"
        blurb={teacher
          ? "Your class's report cards for the term. Write the class teacher's comment for each learner and download them. The office prepares and sends them to families."
          : "Prepare a class's report cards from the term's exams, add comments, download them to print, and send them to families, who can then download their own from Results."}
        actions={rows.length ? (
          <div className="flex flex-wrap gap-2">
            <Button disabled={!!busy} onClick={() => download(rows, "sheet")}>{busy === "sheet" ? "Preparing…" : "Results sheet (PDF)"}</Button>
            <Button disabled={!!busy} onClick={() => download(rows, "cards")}>{busy === "cards" ? "Preparing…" : "All report cards (PDF)"}</Button>
          </div>
        ) : undefined}
      />

      <div className="space-y-5 px-7 py-6">
        {setup.error ? (
          <p className="rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">Could not load your classes: {setup.error.message}</p>
        ) : setup.loading && !setup.data ? (
          <TableSkeleton rows={3} />
        ) : !classes.length ? (
          <p className="rounded-lg border border-line bg-white px-4 py-6 text-[13px] text-ink-faint">
            {teacher ? "You aren't the class teacher of any class, so there are no report cards for you to comment on." : "Add classes in School settings first."}
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:max-w-[640px]">
              <SelectField id="rc-term" label="Term" value={termId} onChange={(e) => setTermId(e.target.value)} options={terms.map((t) => ({ value: t.id, label: t.name }))} />
              <SelectField id="rc-class" label="Class" value={classId} onChange={(e) => setClassId(e.target.value)} options={classes.map((c) => ({ value: c.id, label: c.name }))} />
            </div>

            {!teacher && options && (
              <section className="rounded-lg border border-line bg-white p-4">
                <h2 className="text-[14px] font-semibold">{rows.length ? "Prepare again" : "Prepare this class"}</h2>
                <p className="mt-0.5 text-[12px] text-ink-faint">
                  Each subject shows a column per exam and the average of the exams a learner sat. Preparing again updates the drafts and keeps comments; cards already sent to families stay as they were.
                </p>
                <div className="mt-3 text-[12px] font-medium text-ink-soft">Exams that count</div>
                {exams.loading && !exams.data ? <p className="mt-1 text-[12.5px] text-ink-faint">Loading exams…</p> : !(exams.data ?? []).length ? (
                  <p className="mt-1 text-[12.5px] text-ink-faint">
                    {isCbe ? "No exams this term. The report cards will carry this term's published CBE assessments and the core competencies." : "No exams this term. Set them up under Exams."}
                  </p>
                ) : (
                  <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-2">
                    {(exams.data ?? []).map((e) => (
                      <label key={e.id} className="flex items-center gap-2 text-[13px]">
                        <input type="checkbox" style={{ accentColor: "#17402A" }} checked={examIds?.includes(e.id) ?? false}
                          onChange={(ev) => setExamIds((ids) => ev.target.checked ? [...(ids ?? []), e.id] : (ids ?? []).filter((x) => x !== e.id))} />
                        {e.name}{!e.published && <span className="text-[11px] text-ink-faint">(no results out)</span>}
                      </label>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-2">
                  {([
                    ["showPosition", "Position in class"],
                    ["showAttendance", "Attendance"],
                    ["showFees", "Fee balance"],
                    ["showActivities", "Clubs and achievements"],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 text-[13px]">
                      <input type="checkbox" style={{ accentColor: "#17402A" }} checked={options[key]}
                        onChange={(e) => setOptions({ ...options, [key]: e.target.checked })} />
                      {label}
                    </label>
                  ))}
                  <div className="w-[190px]">
                    <TextField id="rc-next-term" label="Next term begins (optional)" type="date" value={options.nextTermBegins ?? ""}
                      onChange={(e) => setOptions({ ...options, nextTermBegins: e.target.value || null })} />
                  </div>
                </div>
                {scheme === "cbc" && options.showPosition && (
                  <p className="mt-2 text-[11.5px] text-warn-ink">CBC report cards usually leave out position. It's on for this class.</p>
                )}
                <div className="mt-4">
                  <Button variant="accent" disabled={!!busy || (!examIds?.length && !isCbe)} onClick={prepare}>
                    {busy === "prepare" ? "Preparing…" : rows.length ? "Prepare again" : "Prepare report cards"}
                  </Button>
                </div>
              </section>
            )}

            {isCbe && termId && <CompetencyRatings tenantId={tenant.id} termId={termId} classId={classId} />}

            {cards.error ? (
              <p className="rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">Could not load report cards: {cards.error.message}</p>
            ) : cards.loading && !cards.data ? (
              <TableSkeleton rows={5} />
            ) : (
              <DataTable
                title={`${cls?.name ?? "Class"} · ${rows.length} report card${rows.length === 1 ? "" : "s"}`}
                filters={rows.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button disabled={!!busy || !unsigned.length} onClick={() => setSigning(true)}
                      title={`Sign as ${CAPACITY_LABEL[capacity].toLowerCase()}; the signature and date go on the PDF`}>
                      {unsigned.length ? `Sign ${unsigned.length} card${unsigned.length === 1 ? "" : "s"}` : "All signed"}
                    </Button>
                    {ai?.aiEnabled && (
                      <Button disabled={!!busy || !drafts.length} onClick={aiComments} title={AI_DRAFT_NOTE}>
                        {busy === "ai" ? "Drafting…" : "Draft comments with Bloom"}
                      </Button>
                    )}
                    {!teacher && <Button disabled={!!busy || !drafts.length} onClick={fillComments}>{busy === "fill" ? "Filling…" : "Suggest missing comments"}</Button>}
                    {!teacher && drafts.length > 0 && <Button variant="accent" disabled={!!busy} onClick={() => publish(drafts.map((c) => c.id), true)}>Send {drafts.length} to families</Button>}
                    {!teacher && published.length > 0 && <Button disabled={!!busy} onClick={() => publish(published.map((c) => c.id), false)}>Withdraw all</Button>}
                  </div>
                ) : undefined}
                columns={[
                  { key: "name", header: "Learner", width: "1.5fr", render: (c: StoredReportCard) => <Cell sub={`ADM ${c.data.learner.admissionNo}`}>{c.data.learner.name}</Cell> },
                  { key: "mean", header: "Mean", align: "right", render: (c: StoredReportCard) => <Mono>{c.data.summary.mean === null ? "–" : `${c.data.summary.mean}%`}</Mono> },
                  { key: "grade", header: "Grade", align: "right", render: (c: StoredReportCard) => <Mono>{c.data.summary.grade ?? "–"}</Mono> },
                  ...(anyPosition ? [{ key: "pos", header: "Position", align: "right" as const, render: (c: StoredReportCard) => <Mono>{c.data.summary.position === null ? "–" : `${c.data.summary.position}/${c.data.summary.ranked}`}</Mono> }] : []),
                  { key: "comments", header: "Comments", width: "1fr", render: (c: StoredReportCard) => (
                    <span className="text-[12px] text-ink-faint">
                      {[c.teacherComment && "Class teacher", c.principalComment && "Principal"].filter(Boolean).join(" · ") || "None yet"}
                    </span>
                  ) },
                  { key: "signed", header: "Signed", width: "1fr", render: (c: StoredReportCard) => {
                    const mine = signatures.filter((s) => s.docId === c.id);
                    if (!mine.length) return <span className="text-[12px] text-ink-faint">Not yet</span>;
                    return (
                      <span className="text-[12px] text-ink-faint">
                        {mine.map((s) => (
                          <span key={s.id} className={`block ${s.isCurrent === false ? "text-warn-ink" : ""}`}
                            title={s.isCurrent === false ? "The card changed after this signature, so it isn't printed. Sign again." : `${s.fullName}, ${signatureDate(s.signedAt)}`}>
                            {CAPACITY_LABEL[s.capacity]}{s.isCurrent === false ? " (changed since)" : ""}
                          </span>
                        ))}
                      </span>
                    );
                  } },
                  { key: "status", header: "Status", render: (c: StoredReportCard) => (c.publishedAt ? <Badge tone="ok">Sent</Badge> : <Badge tone="muted">Draft</Badge>) },
                  { key: "actions", header: "", align: "right", width: "1.3fr", render: (c: StoredReportCard) => (
                    <div className="flex justify-end gap-1.5">
                      <Button onClick={() => setCommenting(c)}>Comments</Button>
                      <Button disabled={!!busy} onClick={() => download([c], "cards")}>PDF</Button>
                    </div>
                  ) },
                ]}
                rows={rows}
                rowKey={(c) => c.id}
                empty={teacher
                  ? { title: "Not prepared yet", body: "The office hasn't prepared report cards for this class and term yet." }
                  : { title: "No report cards yet", body: "Choose the exams that count above, then prepare the class." }}
              />
            )}
          </>
        )}
      </div>

      {signing && (
        <SignDocumentModal
          title={`Sign ${unsigned.length} report card${unsigned.length === 1 ? "" : "s"}`}
          what={`these ${unsigned.length === 1 ? "report card" : `${unsigned.length} report cards`} for ${cls?.name ?? "this class"}`}
          capacityLabel={CAPACITY_LABEL[capacity]}
          defaultName={profile.full_name}
          onSign={async (mark) => {
            const n = await signDocuments("report_card", unsigned.map((c) => c.id), capacity, mark);
            setSigning(false);
            setReloadKey((k) => k + 1);
            toast(`Signed ${n} report card${n === 1 ? "" : "s"}. Your signature and the date are on their PDFs.`);
          }}
          onClose={() => setSigning(false)}
        />
      )}

      {commenting && (
        <CommentsModal
          card={commenting}
          teacher={teacher}
          onClose={() => setCommenting(null)}
          onSaved={() => { setCommenting(null); setReloadKey((k) => k + 1); toast("Comments saved."); }}
        />
      )}
    </>
  );
}

function CommentsModal({ card, teacher, onClose, onSaved }: { card: StoredReportCard; teacher: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [teacherText, setTeacherText] = useState(card.teacherComment ?? "");
  const [principalText, setPrincipalText] = useState(card.principalComment ?? "");
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState<"teacher" | "principal" | null>(null);
  const ai = useAiStatus();
  const d = card.data;
  const first = d.learner.name.split(" ")[0] ?? "";
  const locked = teacher && !!card.publishedAt;

  /** Fills one box with an AI draft (improving what's there, if anything). Nothing is saved until Save. */
  async function aiDraft(who: "teacher" | "principal") {
    setDrafting(who);
    try {
      const current = who === "teacher" ? teacherText : principalText;
      const [o] = await draftReportComments(who, [learnerForAi(card.id, d, current)]);
      const text = (who === "teacher" ? o?.teacher : o?.principal)?.trim();
      if (!text) throw new Error("Bloom didn't return a comment. Try again.");
      if (who === "teacher") setTeacherText(text); else setPrincipalText(text);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not draft a comment.", "error");
    } finally { setDrafting(null); }
  }
  const aiLink = (who: "teacher" | "principal", has: boolean) => ai?.aiEnabled && !locked && (
    <button type="button" disabled={!!drafting} className="mt-1 ml-3 text-[12px] font-medium text-accent underline disabled:opacity-50" title={AI_DRAFT_NOTE} onClick={() => aiDraft(who)}>
      {drafting === who ? "Drafting…" : has ? "Improve with Bloom" : "Draft with Bloom"}
    </button>
  );

  async function save() {
    setSaving(true);
    try {
      if (teacher) await saveTeacherComment(card.id, teacherText);
      else await saveReportCardComments(card.id, { teacher: teacherText, principal: principalText });
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save the comments.", "error");
    } finally { setSaving(false); }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${d.learner.className} · ${d.term.name}`}
      title={d.learner.name}
      blurb={`Mean ${d.summary.mean === null ? "–" : `${d.summary.mean}%`} · grade ${d.summary.grade ?? "–"}${d.summary.position !== null ? ` · position ${d.summary.position} of ${d.summary.ranked}` : ""}`}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={saving || locked} onClick={save}>{saving ? "Saving…" : "Save comments"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {ai?.aiEnabled && !locked && <p className="text-[11.5px] text-ink-faint">{AI_DRAFT_NOTE}</p>}
        {locked && <p className="text-[12.5px] text-warn-ink">This report card has gone out to the family. Ask the office to withdraw it to change your comment.</p>}
        <div>
          <TextArea id="rc-teacher-comment" label="Class teacher's comment" value={teacherText} maxLength={600} disabled={locked}
            onChange={(e) => setTeacherText(e.target.value)} />
          {!teacherText && d.summary.grade && !locked && (
            <button type="button" className="mt-1 text-[12px] font-medium text-accent underline" onClick={() => setTeacherText(suggestComment(d.summary.grade, first, "teacher"))}>Use a suggested comment</button>
          )}
          {aiLink("teacher", !!teacherText.trim())}
        </div>
        {!teacher && (
          <div>
            <TextArea id="rc-principal-comment" label="Principal's comment" value={principalText} maxLength={600}
              onChange={(e) => setPrincipalText(e.target.value)} />
            {!principalText && d.summary.grade && (
              <button type="button" className="mt-1 text-[12px] font-medium text-accent underline" onClick={() => setPrincipalText(suggestComment(d.summary.grade, first, "principal"))}>Use a suggested comment</button>
            )}
            {aiLink("principal", !!principalText.trim())}
          </div>
        )}
      </div>
    </Modal>
  );
}
