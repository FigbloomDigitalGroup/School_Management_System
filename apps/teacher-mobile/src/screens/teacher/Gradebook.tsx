import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  fetchClassRoster, fetchCurrentTerm, fetchExamsForTerm, fetchMarksForExamSubject, fetchTeacherClasses,
  fetchTeacherSubjectsForClass, GRADE_INK, gradeFor, gradingSchemeFor, parseScoreInput, publishExam, saveExamMarks,
  type ClassGroup, type Exam, type Student, type Subject,
} from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { PillPicker } from "../../components/PillPicker";
import type { TeacherSession } from "../../navigation";

/**
 * Same rules as web: default nothing, type a mark or "abs", publish sends
 * it to parents/students. Mobile trades the keyboard-first bulk grid for
 * one scrollable list of number fields — "Enter, next row" becomes
 * "next field", via onSubmitEditing + a ref per row.
 */
export function TeacherGradebook({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);

  const [classes, setClasses] = useState<ClassGroup[] | null>(null);
  const [classId, setClassId] = useState<string | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [examId, setExamId] = useState<string | null>(null);
  const [roster, setRoster] = useState<Student[] | null>(null);
  const [existingMarks, setExistingMarks] = useState<Record<string, number | null>>({});
  const [scores, setScores] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [marksVersion, setMarksVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputs = useRef<Record<number, TextInput | null>>({});

  useEffect(() => {
    let alive = true;
    Promise.all([fetchTeacherClasses(session.profileId), fetchCurrentTerm()])
      .then(([cls, term]) => {
        if (!alive) return;
        setClasses(cls);
        setTermId(term?.id ?? null);
        if (cls.length) setClassId((id) => id ?? cls[0]!.id);
      })
      .catch(() => { if (alive) setClasses([]); });
    return () => { alive = false; };
  }, [session.profileId]);

  useEffect(() => {
    if (!classId) return;
    let alive = true;
    setSubjectId(null);
    setSubjects(null);
    fetchTeacherSubjectsForClass(session.profileId, classId)
      .then((subs) => { if (alive) { setSubjects(subs); if (subs.length) setSubjectId(subs[0]!.id); } })
      .catch(() => { if (alive) setSubjects([]); });
    fetchClassRoster(classId)
      .then((r) => { if (alive) setRoster(r); })
      .catch(() => { if (alive) setRoster([]); });
    return () => { alive = false; };
  }, [classId, session.profileId]);

  useEffect(() => {
    if (!termId) return;
    let alive = true;
    fetchExamsForTerm(termId)
      .then((ex) => { if (alive) { setExams(ex); if (ex.length) setExamId((id) => id ?? ex[0]!.id); } })
      .catch(() => { if (alive) setExams([]); });
    return () => { alive = false; };
  }, [termId]);

  useEffect(() => {
    if (!examId || !subjectId || !roster || !roster.length) { setExistingMarks({}); return; }
    let alive = true;
    fetchMarksForExamSubject(examId, subjectId, roster.map((s) => s.id))
      .then((m) => { if (alive) setExistingMarks(m); })
      .catch(() => { if (alive) setExistingMarks({}); });
    return () => { alive = false; };
  }, [examId, subjectId, roster, marksVersion]);

  const selectedClass = classes?.find((c) => c.id === classId);
  const scheme = gradingSchemeFor(session.country, selectedClass?.level ?? "secondary");

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
    if (!rows.length) return;
    setBusy(true);
    try {
      await saveExamMarks(rows);
      setMarksVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!examId) return;
    setBusy(true);
    try {
      await saveExamMarks(buildRows());
      await publishExam(examId);
      setMarksVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }

  if (!classes || (classes.length > 0 && !selectedClass)) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={a.deep} />
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
          <View style={s.card}><Text style={s.small}>No classes assigned yet. Contact the school office.</Text></View>
        </View>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Gradebook</Text>
        <Text style={s.headerSub}>{entered} of {roll.length} entered</Text>
      </View>

      <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 8 }}>
        {classes.length > 1 && <PillPicker items={classes} selectedId={classId} onPick={setClassId} accent={session.accent} />}
        {!!subjects?.length && <PillPicker items={subjects} selectedId={subjectId} onPick={setSubjectId} accent={session.accent} />}
        {!!exams?.length && <PillPicker items={exams} selectedId={examId} onPick={setExamId} accent={session.accent} />}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 8 }} keyboardShouldPersistTaps="handled">
        {roll.map((student, i) => {
          const raw = value(student.id);
          const parsed = parseScoreInput(raw);
          const grade = parsed.ok && parsed.score !== null ? gradeFor(parsed.score, scheme) : null;
          const err = errors[student.id];
          return (
            <View key={student.id} style={[s.card, { marginBottom: 8, padding: 12, flexDirection: "row", alignItems: "center", gap: 10 }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, fontWeight: "500" }}>{student.full_name}</Text>
                <Text style={s.faint}>ADM {student.admission_no}</Text>
              </View>
              <TextInput
                ref={(el) => { inputs.current[i] = el; }}
                value={raw}
                onChangeText={(v) => setScore(student.id, v)}
                onSubmitEditing={() => inputs.current[i + 1]?.focus()}
                returnKeyType="next"
                keyboardType="default"
                placeholder="—"
                accessibilityLabel={`Mark for ${student.full_name}`}
                style={{
                  ...HIT, width: 64, borderWidth: 1, borderRadius: 10, textAlign: "center",
                  fontFamily: "monospace", fontSize: 14,
                  borderColor: err ? t.status.warnInk : t.appSurface.line,
                }}
              />
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

      <View style={{ flexDirection: "row", gap: 10, padding: 16, borderTopWidth: 1, borderTopColor: t.appSurface.line, backgroundColor: t.appSurface.card }}>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void saveDraft()}
          style={[s.primary, { ...HIT, flex: 1, backgroundColor: t.appSurface.lineSoft, opacity: busy ? 0.6 : 1 }]}
        >
          <Text style={[s.primaryLabel, { color: t.appSurface.ink }]}>Save draft</Text>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={busy || entered < roll.length}
          onPress={() => void publish()}
          style={[s.primary, { ...HIT, flex: 1, backgroundColor: t.brand.orange, opacity: busy || entered < roll.length ? 0.6 : 1 }]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : (
            <Text style={s.primaryLabel}>{entered < roll.length ? `${roll.length - entered} left` : "Publish"}</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}
