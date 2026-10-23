import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  createCbeAssessment, fetchCbeAssessments, fetchCbeEntries, fetchStrandsForGrade, GRADE_INK, isRetryable, publishCbeAssessment,
  rubricFor, saveCbeEntries, summariseStrands, yearLabel,
  type CbeAssessment, type CbeEntry, type ClassGroup, type StrandNode, type Student, type Subject,
} from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { PillPicker } from "../../components/PillPicker";
import { Skeleton } from "../../components/Skeleton";
import { queue } from "../../storage";
import type { TeacherSession } from "../../navigation";

const cellKey = (studentId: string, strandId: string) => `${studentId}|${strandId}`;
/** Not a rubric code — the explicit "not yet judged" option in every strand's chip row. */
const UNJUDGED = "";

function PillsSkeleton() {
  return (
    <View style={{ flexDirection: "row", gap: 8, paddingBottom: 8 }}>
      {[96, 72].map((w) => <Skeleton key={w} width={w} height={44} radius={999} />)}
    </View>
  );
}

/**
 * CBE strand assessment — the mobile counterpart to apps/web/src/screens/
 * teacher/CbeGradebook.tsx, for classes the CBC rubric applies to
 * (pre_primary/primary/junior_secondary/senior_school). Web judges every
 * strand for every learner in one big table; a phone has no room for that
 * grid, so this judges one strand at a time (PillPicker across the top) with
 * a chip row per learner, the same row-of-chips shape Attendance.tsx uses for
 * present/absent/late — "—" (not yet judged) is just another chip in that
 * row, not a separate clear action, since blank is a real, valid state here.
 *
 * Deliberately out of scope (unlike web): adding a school's own strand when
 * KICD's catalogue has none yet. That's an occasional admin-ish action that
 * fits the bigger web screen better; this one only judges strands that
 * already exist.
 *
 * class/term/subject/roster are owned by the caller (TeacherGradebook) and
 * passed in — identical regardless of grading model, so fetching them again
 * here would just be a second trip for the same rows.
 */
export function TeacherCbeGradebookBody({ session, cls, termId, subject, roster }: {
  session: TeacherSession;
  cls: ClassGroup;
  termId: string;
  subject: Subject | undefined;
  roster: Student[] | null;
}) {
  const a = accentFor(session.accent);
  const rubric = useMemo(() => rubricFor(session.country, cls.level) ?? [], [session.country, cls.level]);
  const areaId = subject?.learning_area_id ?? null;

  const [assessments, setAssessments] = useState<CbeAssessment[] | null>(null);
  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const [strands, setStrands] = useState<StrandNode[] | null>(null);
  const [strandId, setStrandId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, CbeEntry> | null>(null);
  const [levels, setLevels] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newKind, setNewKind] = useState<CbeAssessment["kind"]>("summative");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => { void queue.flush(); }, []);

  useEffect(() => {
    setAssessmentId(null);
    setAssessments(null);
    setLevels({});
    setComments({});
    if (!subject?.id) return;
    let alive = true;
    fetchCbeAssessments(cls.id, subject.id, termId)
      .then((list) => { if (alive) { setAssessments(list); if (list.length) setAssessmentId(list[0]!.id); } })
      .catch(() => { if (alive) setAssessments([]); });
    return () => { alive = false; };
  }, [cls.id, subject?.id, termId, version]);

  useEffect(() => {
    setStrandId(null);
    setStrands(null);
    if (!areaId) return;
    let alive = true;
    fetchStrandsForGrade(areaId, cls.form_level)
      .then((list) => { if (alive) { setStrands(list); if (list.length) setStrandId(list[0]!.id); } })
      .catch(() => { if (alive) setStrands([]); });
    return () => { alive = false; };
  }, [areaId, cls.form_level, version]);

  useEffect(() => {
    setEntries(null);
    setLevels({});
    setComments({});
    if (!assessmentId) return;
    let alive = true;
    fetchCbeEntries(assessmentId)
      .then((e) => { if (alive) setEntries(e); })
      .catch(() => { if (alive) setEntries({}); });
    return () => { alive = false; };
  }, [assessmentId, version]);

  const assessment = assessments?.find((x) => x.id === assessmentId) ?? null;
  const roll = roster ?? [];
  const entryMap = entries ?? {};

  function level(studentId: string, sId: string): string {
    return levels[cellKey(studentId, sId)] ?? entryMap[studentId]?.levels[sId] ?? UNJUDGED;
  }
  function setLevel(studentId: string, sId: string, code: string) {
    setLevels((l) => ({ ...l, [cellKey(studentId, sId)]: code }));
  }
  function comment(studentId: string): string {
    return comments[studentId] ?? entryMap[studentId]?.comment ?? "";
  }

  const strandList = strands ?? [];
  const totalCells = roll.length * strandList.length;
  const filled = roll.reduce((n, st) => n + strandList.filter((sd) => level(st.id, sd.id) !== UNJUDGED).length, 0);

  function buildPayload() {
    const results: { studentId: string; strandId: string; code: string }[] = [];
    const cleared: { studentId: string; strandId: string }[] = [];
    for (const [k, code] of Object.entries(levels)) {
      const [studentId, sId] = k.split("|") as [string, string];
      if (code) results.push({ studentId, strandId: sId, code });
      else if (entryMap[studentId]?.levels[sId]) cleared.push({ studentId, strandId: sId });
    }
    const commentRows = Object.entries(comments).map(([studentId, c]) => ({ studentId, comment: c }));
    return { results, cleared, commentRows };
  }

  async function saveDraft() {
    if (!assessment) return;
    const { results, cleared, commentRows } = buildPayload();
    if (!results.length && !cleared.length && !commentRows.length) { setStatus("Nothing to save yet."); return; }
    setBusy(true);
    setStatus(null);
    try {
      await saveCbeEntries({
        tenantId: session.tenantId, assessmentId: assessment.id, enteredBy: session.profileId, results, cleared, comments: commentRows,
      });
      setLevels({});
      setComments({});
      setVersion((v) => v + 1);
      setStatus(assessment.published_at ? "Saved — parents see the update straight away." : "Draft saved.");
    } catch (err) {
      // The server looked at it and said no: holding it would only park it in the queue
      // for good, so say why and leave what was entered on screen.
      if (!isRetryable(err)) {
        setStatus(`Not saved: ${err instanceof Error ? err.message : "something went wrong"}.`);
        return;
      }
      // A cleared cell can't be represented as an upsert, so an offline clear
      // is simply dropped rather than queued — the same limitation every
      // table in packages/shared/src/queue.ts has (it only knows how to
      // upsert, never delete). Judged levels and comments still queue fine.
      await queue.enqueue("cbe_results", results.map((r) => ({
        tenant_id: session.tenantId, assessment_id: assessment.id, student_id: r.studentId, strand_id: r.strandId,
        level_code: r.code, entered_by: session.profileId,
      })));
      const keptComments = commentRows.filter((c) => c.comment.trim());
      if (keptComments.length) {
        await queue.enqueue("cbe_assessment_comments", keptComments.map((c) => ({
          tenant_id: session.tenantId, assessment_id: assessment.id, student_id: c.studentId, comment: c.comment.trim(),
        })));
      }
      setLevels({});
      setComments({});
      setStatus("Saved on this phone. Will send when you have signal.");
    } finally {
      setBusy(false);
    }
  }

  // Unlike saveDraft, a failed publish surfaces loudly rather than queuing —
  // "published" means visible to parents right now, which can't be true
  // while offline. Same tradeoff Gradebook.tsx's marks publish() makes.
  async function publish() {
    if (!assessment || !subject) return;
    setBusy(true);
    setStatus(null);
    try {
      const { results, cleared, commentRows } = buildPayload();
      await saveCbeEntries({
        tenantId: session.tenantId, assessmentId: assessment.id, enteredBy: session.profileId, results, cleared, comments: commentRows,
      });
      await publishCbeAssessment(assessment.id);
      setLevels({});
      setComments({});
      setVersion((v) => v + 1);
      setStatus(`${subject.name} · ${assessment.title} published to ${roll.length} learners and their parents.`);
    } catch (err) {
      setStatus(err instanceof Error ? `Could not publish: ${err.message}` : "Could not publish — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function createAssessment() {
    if (!subject || !newTitle.trim()) return;
    setBusy(true);
    try {
      const created = await createCbeAssessment({
        tenantId: session.tenantId, termId, classId: cls.id, subjectId: subject.id,
        title: newTitle.trim(), kind: newKind, createdBy: session.profileId,
      });
      setCreating(false);
      setNewTitle("");
      setNewKind("summative");
      setVersion((v) => v + 1);
      setAssessmentId(created.id);
      setStatus(`${created.title} created.`);
    } catch (err) {
      setStatus(err instanceof Error ? `Could not create the assessment: ${err.message}` : "Could not create the assessment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <View style={{ paddingHorizontal: 16, paddingTop: 4, gap: 8 }}>
        {assessments === null ? <PillsSkeleton /> : !!assessments.length && (
          <PillPicker
            items={assessments.map((as) => ({ id: as.id, name: as.title + (as.published_at ? " · published" : "") }))}
            selectedId={assessmentId}
            onPick={setAssessmentId}
            accent={session.accent}
          />
        )}
        {!!areaId && (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setCreating((c) => !c)}
            style={{ ...HIT, alignSelf: "flex-start", paddingHorizontal: 12, borderRadius: 10, backgroundColor: t.appSurface.lineSoft, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ fontSize: 12.5, fontWeight: "700" }}>{creating ? "Cancel" : "+ New assessment"}</Text>
          </TouchableOpacity>
        )}
        {!!assessment && strandList.length > 0 && (
          <PillPicker items={strandList} selectedId={strandId} onPick={setStrandId} accent={session.accent} />
        )}
      </View>

      {creating && (
        <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
          <View style={[s.card, { gap: 10 }]}>
            <TextInput
              value={newTitle}
              onChangeText={setNewTitle}
              placeholder="e.g. End of Term 1, or Project: water cycle"
              style={{ ...HIT, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, paddingHorizontal: 12, fontSize: 14 }}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              {(["summative", "formative"] as const).map((k) => {
                const on = newKind === k;
                return (
                  <TouchableOpacity
                    key={k}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    onPress={() => setNewKind(k)}
                    style={{ ...HIT, flex: 1, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: on ? a.deep : t.appSurface.lineSoft }}
                  >
                    <Text style={{ fontSize: 12.5, fontWeight: "600", color: on ? "#fff" : t.appSurface.inkMuted }}>
                      {k === "summative" ? "Summative" : "Formative"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              disabled={!newTitle.trim() || busy}
              onPress={() => void createAssessment()}
              style={[s.primary, { ...HIT, backgroundColor: t.brand.orange, opacity: !newTitle.trim() || busy ? 0.6 : 1 }]}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryLabel}>Create</Text>}
            </TouchableOpacity>
          </View>
        </View>
      )}

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 10 }} keyboardShouldPersistTaps="handled">
        {!subject ? (
          <ActivityIndicator color={a.deep} />
        ) : !areaId ? (
          <View style={s.card}>
            <Text style={s.small}>
              {subject.name} isn't linked to a KICD learning area, so there are no strands to assess against. Ask the school admin to add it from the KICD curriculum.
            </Text>
          </View>
        ) : strands === null || roster === null || assessments === null || (!!assessmentId && entries === null) ? (
          [0, 1, 2].map((i) => (
            <View key={i} style={[s.card, { marginBottom: 8, padding: 12, gap: 8 }]}>
              <Skeleton width="55%" height={14} />
              <View style={{ flexDirection: "row", gap: 6 }}>
                {[0, 1, 2, 3].map((j) => <Skeleton key={j} width={40} height={36} radius={10} />)}
              </View>
            </View>
          ))
        ) : !strandList.length ? (
          <View style={s.card}>
            <Text style={s.small}>No strands are loaded for {yearLabel(cls.level, cls.form_level)} {subject.name} yet — KICD's are still being added to the catalogue.</Text>
          </View>
        ) : !assessment ? (
          <View style={s.card}>
            <Text style={s.small}>Create the first assessment for {subject.name} this term — a topic test, a project or the end-of-term assessment. Tap "+ New assessment" above.</Text>
          </View>
        ) : (
          roll.map((student) => {
            const overall = summariseStrands(strandList.map((sd) => level(student.id, sd.id)), rubric).overall;
            return (
              <View key={student.id} style={[s.card, { marginBottom: 8, padding: 12, gap: 8 }]}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14.5, fontWeight: "500" }}>{student.full_name}</Text>
                    <Text style={s.faint}>ADM {student.admission_no}</Text>
                  </View>
                  <Text style={{ fontFamily: "monospace", fontSize: 13.5, fontWeight: "700", color: overall ? GRADE_INK[overall.code] : t.appSurface.inkFaint }}>
                    {overall?.code ?? "—"}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {[{ code: UNJUDGED, label: "Not yet judged" }, ...rubric].map((lvl) => {
                    const on = !!strandId && level(student.id, strandId) === lvl.code;
                    return (
                      <TouchableOpacity
                        key={lvl.code || "blank"}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={`${lvl.label} for ${student.full_name}`}
                        disabled={!strandId}
                        onPress={() => strandId && setLevel(student.id, strandId, lvl.code)}
                        style={{
                          ...HIT, paddingHorizontal: 10, borderRadius: 10, alignItems: "center", justifyContent: "center",
                          backgroundColor: t.appSurface.lineSoft,
                          borderWidth: on ? 1.5 : 0, borderColor: on && lvl.code ? GRADE_INK[lvl.code] : t.appSurface.line,
                        }}
                      >
                        <Text style={{ fontSize: 12.5, fontWeight: "700", color: on && lvl.code ? GRADE_INK[lvl.code] : t.appSurface.inkMuted }}>
                          {lvl.code || "—"}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TextInput
                  value={comment(student.id)}
                  onChangeText={(v) => setComments((c) => ({ ...c, [student.id]: v }))}
                  placeholder="Comment for the report (optional)"
                  accessibilityLabel={`Comment for ${student.full_name}`}
                  style={{ borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12.5 }}
                />
              </View>
            );
          })
        )}
        {!!assessment && strandList.length > 0 && (
          <Text style={[s.faint, { marginTop: 4 }]}>
            {rubric.map((r) => `${r.code} ${r.label.toLowerCase()}`).join(" · ")}.
          </Text>
        )}
      </ScrollView>

      {!!assessment && strandList.length > 0 && (
        <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: t.appSurface.line, backgroundColor: t.appSurface.card }}>
          {!!status && <Text style={[s.small, { marginBottom: 10 }]}>{status}</Text>}
          <View style={{ flexDirection: "row", gap: 10 }}>
            <TouchableOpacity
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void saveDraft()}
              style={[s.primary, { ...HIT, flex: 1, backgroundColor: t.appSurface.lineSoft, opacity: busy ? 0.6 : 1 }]}
            >
              <Text style={[s.primaryLabel, { color: t.appSurface.ink }]}>{assessment.published_at ? "Save changes" : "Save draft"}</Text>
            </TouchableOpacity>
            {!assessment.published_at && (
              <TouchableOpacity
                accessibilityRole="button"
                disabled={busy || filled < totalCells}
                onPress={() => void publish()}
                style={[s.primary, { ...HIT, flex: 1, backgroundColor: t.brand.orange, opacity: busy || filled < totalCells ? 0.6 : 1 }]}
              >
                {busy ? <ActivityIndicator color="#fff" /> : (
                  <Text style={s.primaryLabel}>{filled < totalCells ? `${totalCells - filled} left` : "Publish"}</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </>
  );
}
