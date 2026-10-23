import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  againstMean, fetchClassRoster, fetchCurrentTerm, fetchExamsForTerm, fetchMarksForExamSubject, fetchPublishedSubjects, fetchTeacherClasses,
  fetchTeacherSubjectsForClass, GRADE_INK, gradeFor, gradingSchemeFor, parseScoreInput, publishMarks, rubricFor, saveExamMarks,
  summarise, unpublishMarks, type ClassGroup, type Exam, type Student, type Subject,
} from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { PillPicker } from "../../components/PillPicker";
import { Skeleton } from "../../components/Skeleton";
import { queue } from "../../storage";
import type { TeacherSession } from "../../navigation";
import { TeacherCbeGradebookBody } from "./CbeGradebook";

/** Stand-in for a PillPicker row while its options load — same height, so nothing jumps. */
function PillsSkeleton() {
  return (
    <View style={{ flexDirection: "row", gap: 8, paddingBottom: 8 }}>
      {[72, 96, 64].map((w) => <Skeleton key={w} width={w} height={44} radius={999} />)}
    </View>
  );
}

/**
 * Same rules as web's own apps/web/src/screens/teacher/Gradebook.tsx (the
 * plain exam-marks screen — this screen's real counterpart, not the CBE or
 * GPA ones below): default nothing, type a mark or "abs", publish sends it
 * to parents/students. Mobile trades the keyboard-first bulk grid for one
 * scrollable list of number fields — "Enter, next row" becomes "next
 * field", via onSubmitEditing + a ref per row.
 *
 * Deliberate difference: a failed saveDraft queues the rows on-device
 * instead of failing loudly like web's toast does (see saveDraft below) —
 * intentional for flaky rural connectivity, the same tradeoff Attendance.tsx
 * and the driver app's location queue make. The real error is still folded
 * into the status message so a permanently-failing save (not just an
 * offline one) doesn't go unnoticed forever.
 *
 * CBE strand assessment (FIG-775) lives in this same tab rather than as a
 * separate screen: whichever class is selected, the mode (below) switches
 * automatically to Strands when rubricFor() says that class's level is
 * judged by the CBC rubric, not by percentage marks — a class is one or the
 * other, never both, so this isn't a user preference, just routing. See
 * CbeGradebook.tsx for the strand-judging UI itself; class/term/subject/
 * roster are fetched once here and passed down, since they're identical
 * regardless of which model applies.
 *
 * Known gap, not fixed here: Higher-ed/GPA grading (apps/web/src/screens/
 * teacher/GpaGradebook.tsx) is a different tenant type (institution_type:
 * "higher_ed") with no seeded demo data anywhere in this repo; this screen
 * has no course-section concept and isn't a partial implementation of it.
 */
export function TeacherGradebook({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);

  const [classes, setClasses] = useState<ClassGroup[] | null>(null);
  const [classId, setClassId] = useState<string | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  /** The classes/term fetch itself failed — not the same as "no classes" or "no term". */
  const [loadFailed, setLoadFailed] = useState(false);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [examId, setExamId] = useState<string | null>(null);
  const [roster, setRoster] = useState<Student[] | null>(null);
  const [existingMarks, setExistingMarks] = useState<Record<string, number | null>>({});
  /** Which exam/subject/roster `existingMarks` belongs to — until it matches the
   *  current pick, the rows hold the previous subject's marks (or none). */
  const [marksFor, setMarksFor] = useState<{ examId: string; subjectId: string; roster: Student[] } | null>(null);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [marksVersion, setMarksVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const inputs = useRef<Record<number, TextInput | null>>({});
  /** Per-class override, so switching classes always re-defaults instead of
   *  carrying a stale choice onto a class the toggle shouldn't apply to. */
  const [modeOverride, setModeOverride] = useState<Record<string, "marks" | "strands">>({});

  useEffect(() => { void queue.flush(); }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchTeacherClasses(session.profileId), fetchCurrentTerm()])
      .then(([cls, term]) => {
        if (!alive) return;
        setClasses(cls);
        setTermId(term?.id ?? null);
        if (cls.length) setClassId((id) => id ?? cls[0]!.id);
      })
      .catch(() => { if (alive) { setLoadFailed(true); setClasses([]); } });
    return () => { alive = false; };
  }, [session.profileId]);

  useEffect(() => {
    if (!classId) return;
    let alive = true;
    setSubjectId(null);
    setSubjects(null);
    setRoster(null);
    fetchTeacherSubjectsForClass(session.profileId, classId)
      .then((subs) => { if (alive) { setSubjects(subs); if (subs.length) setSubjectId(subs[0]!.id); } })
      .catch(() => { if (alive) setSubjects([]); });
    fetchClassRoster(classId)
      .then((r) => { if (alive) setRoster(r); })
      .catch(() => { if (alive) setRoster([]); });
    return () => { alive = false; };
  }, [classId, session.profileId]);

  const selectedClass = classes?.find((c) => c.id === classId);
  const hasRubric = !!selectedClass && !!rubricFor(session.country, selectedClass.level);
  const mode = (classId && modeOverride[classId]) ?? (hasRubric ? "strands" : "marks");

  // Exam marks don't apply to a CBE class, so there's nothing for this fetch
  // to do while Strands mode is showing — skip it until marks mode is live.
  useEffect(() => {
    if (!termId || mode !== "marks") return;
    let alive = true;
    fetchExamsForTerm(termId)
      .then((ex) => { if (alive) { setExams(ex); if (ex.length) setExamId((id) => id ?? ex[0]!.id); } })
      .catch(() => { if (alive) setExams([]); });
    return () => { alive = false; };
  }, [termId, mode]);

  useEffect(() => {
    if (!examId || !subjectId || !roster || !roster.length) { setExistingMarks({}); return; }
    let alive = true;
    const loadedFor = { examId, subjectId, roster };
    fetchMarksForExamSubject(examId, subjectId, roster.map((s) => s.id))
      .then((m) => { if (alive) { setExistingMarks(m); setMarksFor(loadedFor); } })
      .catch(() => { if (alive) { setExistingMarks({}); setMarksFor(loadedFor); } });
    return () => { alive = false; };
  }, [examId, subjectId, roster, marksVersion]);

  // Which of this exam's subjects are already out for this class. Re-read after every save, publish or withdraw.
  const [publishedSubjects, setPublishedSubjects] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!examId || !classId || mode !== "marks") { setPublishedSubjects(new Set()); return; }
    let alive = true;
    fetchPublishedSubjects(examId, classId)
      .then((set) => { if (alive) setPublishedSubjects(set); })
      .catch(() => { /* offline: keep what we last knew */ });
    return () => { alive = false; };
  }, [examId, classId, mode, marksVersion]);
  const isPublished = !!subjectId && publishedSubjects.has(subjectId);

  const scheme = gradingSchemeFor(session.country, selectedClass?.level ?? "secondary");
  const subject = subjects?.find((s) => s.id === subjectId);
  const exam = exams?.find((e) => e.id === examId);
  /** Loaded and empty, as opposed to still loading — same distinction web's Gradebook.tsx makes. */
  const noSubjects = subjects !== null && subjects.length === 0;

  function key(studentId: string) { return `${classId}|${examId}|${subjectId}|${studentId}`; }

  function value(studentId: string): string {
    const k = key(studentId);
    if (scores[k] !== undefined) return scores[k]!;
    if (studentId in existingMarks) {
      const v = existingMarks[studentId];
      return v === null ? "abs" : String(v);
    }
    return "";
  }

  function setScore(studentId: string, raw: string) {
    const k = key(studentId);
    const parsed = parseScoreInput(raw);
    setScores((s) => ({ ...s, [k]: raw }));
    setErrors((e) => {
      const next = { ...e };
      if (parsed.ok) delete next[studentId]; else next[studentId] = parsed.message;
      return next;
    });
  }

  const roll = roster ?? [];
  const entered = roll.filter((s) => value(s.id).trim() !== "").length;
  const summary = summarise(roll.map((s) => {
    const v = parseScoreInput(value(s.id));
    return { subject: s.id, score: v.ok ? v.score : null };
  }), scheme);
  /** Mean of this exam/subject's already-saved marks only — not today's unsaved drafts. */
  const mean = useMemo(() => {
    const vals = Object.values(existingMarks).filter((v): v is number => v !== null);
    if (!vals.length) return null;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }, [existingMarks]);
  const marksReady = marksFor !== null && marksFor.examId === examId && marksFor.subjectId === subjectId && marksFor.roster === roster;
  /** First load of this class/subject/exam only — a save's refetch (marksVersion) keeps the rows on screen. */
  const rowsLoading = roster === null || subjects === null || (exams === null && termId !== null)
    || (!!examId && !!subjectId && roll.length > 0 && !marksReady);

  function buildRows() {
    if (!examId || !subjectId) return [];
    return roll.flatMap((s) => {
      const raw = value(s.id).trim();
      if (raw === "") return [];
      const parsed = parseScoreInput(raw);
      if (!parsed.ok) return [];
      return [{
        tenant_id: session.tenantId, exam_id: examId, student_id: s.id, subject_id: subjectId,
        score: parsed.score, entered_by: session.profileId,
      }];
    });
  }

  async function saveDraft() {
    const rows = buildRows();
    if (!rows.length) { setStatus("Nothing to save yet."); return; }
    setBusy(true);
    setStatus(null);
    try {
      await saveExamMarks(rows);
      setMarksVersion((v) => v + 1);
      setStatus(isPublished ? "Saved. Parents already see this subject, so the change is live." : "Draft saved.");
    } catch (err) {
      // Offline or the request failed — hold the marks on this phone rather
      // than losing what was typed; they'll send once queue.flush() next runs.
      // The real reason still goes in the message: a save that keeps failing
      // because it's genuinely invalid (not just offline) would otherwise
      // look identical to one patiently waiting for signal, forever.
      await queue.enqueue("marks", rows);
      const reason = err instanceof Error ? err.message : null;
      setStatus(reason ? `Saved on this phone (${reason}). Will send when you have signal.` : "Saved on this phone. Will send when you have signal.");
    } finally {
      setBusy(false);
    }
  }

  // Publishing means "visible to parents right now" — that can't be true
  // while offline, so unlike saveDraft this surfaces the failure instead of
  // queuing it silently. It releases THIS class's marks for THIS subject and
  // nothing else; publish_marks checks the caller teaches it.
  async function publish() {
    if (!examId || !classId || !subject || !exam) return;
    setBusy(true);
    setStatus(null);
    try {
      await saveExamMarks(buildRows());
      await publishMarks(examId, classId, subject.id);
      setMarksVersion((v) => v + 1);
      setStatus(`${subject.name} ${exam.name} is now visible to ${roll.length} learners and their parents in ${selectedClass?.name ?? "this class"}.`);
    } catch (err) {
      setStatus(err instanceof Error ? `Could not publish: ${err.message}` : "Could not publish — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function withdraw() {
    if (!examId || !classId || !subject || !exam) return;
    Alert.alert(
      "Withdraw these results?",
      `${subject.name} ${exam.name} for ${selectedClass?.name ?? "this class"} goes back to draft. Parents and learners stop seeing it until you publish again.`,
      [
        { text: "Keep published", style: "cancel" },
        {
          text: "Withdraw",
          style: "destructive",
          onPress: () => {
            setBusy(true);
            setStatus(null);
            unpublishMarks(examId, classId, subject.id)
              .then(() => { setMarksVersion((v) => v + 1); setStatus("Withdrawn. Parents and learners no longer see these marks."); })
              .catch((err) => setStatus(err instanceof Error ? `Could not withdraw: ${err.message}` : "Could not withdraw — check your connection and try again."))
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  }

  if (!classes || (classes.length > 0 && !selectedClass)) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={a.deep} />
      </View>
    );
  }

  if (loadFailed) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: a.deep }]}>
          <Text style={s.headerTitle}>Gradebook</Text>
        </View>
        <View style={{ padding: 16 }}>
          <View style={s.card}><Text style={s.small}>Could not load your classes — check your connection and open this tab again.</Text></View>
        </View>
      </View>
    );
  }

  if (classes.length === 0) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: a.deep }]}>
          <Text style={s.headerTitle}>Gradebook</Text>
        </View>
        <View style={{ padding: 16 }}>
          <View style={s.card}><Text style={s.small}>You aren't assigned to any classes yet.</Text></View>
        </View>
      </View>
    );
  }

  // No open term means no exams to mark against — say so rather than show a roster that can't be saved.
  if (!termId) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: a.deep }]}>
          <Text style={s.headerTitle}>Gradebook</Text>
        </View>
        <View style={{ padding: 16 }}>
          <View style={s.card}><Text style={s.small}>No term is open yet. Ask the school admin to set up this term.</Text></View>
        </View>
      </View>
    );
  }

  // Loaded-but-empty, not still loading (rowsLoading covers that case) — a
  // class teacher with no subject in their own class otherwise sees a fully
  // interactive, unlabelled roster with no subject ever selected.
  if (noSubjects) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: a.deep }]}>
          <Text style={s.headerTitle}>Gradebook</Text>
        </View>
        <View style={{ padding: 16 }}>
          <View style={s.card}><Text style={s.small}>You aren't assigned any subjects in this class yet. Ask the school admin to add you to one.</Text></View>
        </View>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Gradebook</Text>
        {mode === "marks" ? (
          rowsLoading ? (
            <Skeleton width={110} height={11} style={{ marginTop: 6, backgroundColor: "rgba(255,255,255,0.3)" }} />
          ) : (
            <Text style={s.headerSub}>
              {entered} of {roll.length} entered
              {summary.meanScore !== null ? ` · your mean ${summary.meanScore}` : ""}
              {mean !== null ? ` · class mean ${mean}` : ""}
            </Text>
          )
        ) : (
          <Text style={s.headerSub}>Strand assessment</Text>
        )}
      </View>

      <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 8 }}>
        {classes.length > 1 ? (
          <PillPicker items={classes} selectedId={classId} onPick={setClassId} accent={session.accent} />
        ) : (
          !!selectedClass && <Text style={[s.small, { fontWeight: "600" }]}>{selectedClass.name}</Text>
        )}
        {hasRubric && (
          <View style={{ flexDirection: "row", gap: 8 }}>
            {(["strands", "marks"] as const).map((m) => {
              const on = mode === m;
              return (
                <TouchableOpacity
                  key={m}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => classId && setModeOverride((o) => ({ ...o, [classId]: m }))}
                  style={{ ...HIT, flex: 1, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: on ? a.deep : t.appSurface.lineSoft }}
                >
                  <Text style={{ fontSize: 12.5, fontWeight: "700", color: on ? "#fff" : t.appSurface.inkMuted }}>
                    {m === "strands" ? "Strands" : "Exam marks"}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
        {subjects === null ? <PillsSkeleton /> : !!subjects.length && <PillPicker items={subjects} selectedId={subjectId} onPick={setSubjectId} accent={session.accent} />}
        {mode === "marks" && (exams === null && termId !== null ? <PillsSkeleton /> : !!exams?.length && <PillPicker items={exams} selectedId={examId} onPick={setExamId} accent={session.accent} />)}
      </View>

      {mode === "strands" ? (
        <TeacherCbeGradebookBody session={session} cls={selectedClass!} termId={termId} subject={subject} roster={roster} />
      ) : (
      <>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 8 }} keyboardShouldPersistTaps="handled">
        {rowsLoading && [0, 1, 2, 3, 4].map((i) => (
          <View key={i} style={[s.card, { marginBottom: 8, padding: 12, flexDirection: "row", alignItems: "center", gap: 10 }]}>
            <View style={{ flex: 1, gap: 6 }}>
              <Skeleton width="60%" height={14} />
              <Skeleton width="30%" height={10} />
            </View>
            <Skeleton width={64} height={44} radius={10} />
            <View style={{ width: 34 }} />
          </View>
        ))}
        {!rowsLoading && roll.map((student, i) => {
          const raw = value(student.id);
          const parsed = parseScoreInput(raw);
          const grade = parsed.ok && parsed.score !== null ? gradeFor(parsed.score, scheme) : null;
          const err = errors[student.id];
          return (
            <View key={student.id} style={[s.card, { marginBottom: 8, padding: 12, flexDirection: "row", alignItems: "center", gap: 10 }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, fontWeight: "500" }}>{student.full_name}</Text>
                <Text style={s.faint}>ADM {student.admission_no}</Text>
                {parsed.ok && parsed.score !== null && mean !== null && (
                  <Text style={s.faint}>{againstMean(parsed.score, mean)}</Text>
                )}
              </View>
              <View style={{ width: 64 }}>
                <TextInput
                  ref={(el) => { inputs.current[i] = el; }}
                  value={raw}
                  onChangeText={(v) => setScore(student.id, v)}
                  onSubmitEditing={() => inputs.current[i + 1]?.focus()}
                  returnKeyType="next"
                  keyboardType="default"
                  placeholder="—"
                  accessibilityLabel={`Mark for ${student.full_name}`}
                  aria-invalid={!!err}
                  style={{
                    ...HIT, width: 64, borderWidth: 1, borderRadius: 10, textAlign: "center",
                    fontFamily: "monospace", fontSize: 14,
                    borderColor: err ? t.status.warnInk : t.appSurface.line,
                  }}
                />
                {!!err && <Text style={{ fontSize: 10, color: t.status.warnInk, marginTop: 4, textAlign: "center" }}>{err}</Text>}
              </View>
              <Text style={{ width: 34, textAlign: "center", fontFamily: "monospace", fontSize: 13, fontWeight: "700", color: grade ? GRADE_INK[grade] : t.appSurface.inkFaint }}>
                {grade ?? (raw.trim().toLowerCase().startsWith("abs") ? "abs" : "—")}
              </Text>
            </View>
          );
        })}
        <Text style={[s.faint, { marginTop: 4 }]}>
          Type a mark, or "abs" for anyone who missed the paper — it's recorded as missing, not zero.
        </Text>
      </ScrollView>

      <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: t.appSurface.line, backgroundColor: t.appSurface.card }}>
        {!!status && <Text style={[s.small, { marginBottom: 10 }]}>{status}</Text>}
        {!!subjectId && !!examId && (
          <Text style={[s.faint, { marginBottom: 10 }]}>
            {isPublished ? "Published to parents. Changes you save go live." : "Draft: only school staff can see these marks."}
          </Text>
        )}
        <View style={{ flexDirection: "row", gap: 10 }}>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={busy || rowsLoading}
            onPress={() => void saveDraft()}
            style={[s.primary, { ...HIT, flex: 1, backgroundColor: t.appSurface.lineSoft, opacity: busy || rowsLoading ? 0.6 : 1 }]}
          >
            <Text style={[s.primaryLabel, { color: t.appSurface.ink }]}>{isPublished ? "Save changes" : "Save draft"}</Text>
          </TouchableOpacity>
          {isPublished ? (
            <TouchableOpacity
              accessibilityRole="button"
              disabled={busy || rowsLoading}
              onPress={withdraw}
              style={[s.primary, { ...HIT, flex: 1, backgroundColor: t.brand.orange, opacity: busy || rowsLoading ? 0.6 : 1 }]}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryLabel}>Withdraw</Text>}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              disabled={busy || rowsLoading || entered < roll.length}
              onPress={() => void publish()}
              style={[s.primary, { ...HIT, flex: 1, backgroundColor: t.brand.orange, opacity: busy || rowsLoading || entered < roll.length ? 0.6 : 1 }]}
            >
              {busy ? <ActivityIndicator color="#fff" /> : (
                <Text style={s.primaryLabel}>{!rowsLoading && entered < roll.length ? `${roll.length - entered} left` : "Publish"}</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>
      </>
      )}
    </View>
  );
}
