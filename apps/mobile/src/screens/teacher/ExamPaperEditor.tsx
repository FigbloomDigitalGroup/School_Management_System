import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { CircleAlert, FileText } from "lucide-react-native";
import {
  PAPER_KIND_LABEL, PHONE_UPLOAD_LIMIT_BYTES, createExamPaper, fetchCurrentTermExams, fetchPaperContent, fetchTeacherClasses, fetchTeacherSubjectsForClass,
  formatFileSize, fromLocalInput, publishProblem, saveExamQuestions, savePaperBody, setPaperFile, setPaperPublished,
  updateExamPaper, validatePaper, validateQuestions,
  type ClassGroup, type ExamPaperRow, type PaperKind, type PaperMode, type QuestionDraft, type Subject,
} from "@figbloom/shared";
import { accentFor, HIT } from "../../theme";
import { PillPicker } from "../../components/PillPicker";
import { QuestionEditor } from "../../components/QuestionEditor";
import { ScreenHeader } from "../../components/ScreenHeader";
import { formatDateInput, formatTimeInput, joinDateTime, splitDateTime } from "../../lib/dateInput";
import { openExamFile } from "../../lib/examFile";
import { PDF_OR_IMAGE, pickFile, type PickedFile } from "../../lib/pickFile";
import { uploadExamPaperFile } from "../../lib/uploads";
import type { TeacherSession } from "../../teacherNavigation";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";

const KINDS = (Object.keys(PAPER_KIND_LABEL) as PaperKind[]).map((k) => ({ id: k, name: PAPER_KIND_LABEL[k] }));

/** Tomorrow 08:00 on this phone: a sensible time for a new paper to open. */
function tomorrowMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return splitDateTime(d.toISOString());
}

/**
 * An exam paper or test for a class and subject this teacher teaches: new, or an existing one changed. It is
 * saved as a draft, seen only by staff, or published straight away. Learners either sit it online (timed
 * questions, multiple choice marked for them) or read it and answer on paper. Once a learner has started, its
 * class, subject, how it is taken and its questions are fixed; the title, instructions and times can still
 * change. The file goes up when the paper is saved, so leaving mid-save asks first.
 */
export function TeacherExamPaperEditor({ session, route }: { session: TeacherSession; route: { params?: { paper?: ExamPaperRow } } }) {
  const { t, s, fieldLine, accentInk } = useTheme();
  const nav = useNavigation<any>();
  const a = accentFor(session.accent);
  const paper = route.params?.paper;
  const locked = (paper?.attemptCount ?? 0) > 0;
  const published = !!paper?.publishedAt;

  const [classes, setClasses] = useState<ClassGroup[] | null>(null);
  const [classId, setClassId] = useState<string | null>(paper?.classId ?? null);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [subjectId, setSubjectId] = useState<string | null>(paper?.subjectId ?? null);
  const [exams, setExams] = useState<{ id: string; name: string }[]>([]);
  const [examId, setExamId] = useState(paper?.examId ?? "");
  const [kind, setKind] = useState<PaperKind>(paper?.kind ?? "exam");
  const [title, setTitle] = useState(paper?.title ?? "");
  const [instructions, setInstructions] = useState(paper?.instructions ?? "");
  const [mode, setMode] = useState<PaperMode>(paper?.mode ?? "online");
  const [body, setBody] = useState("");
  const [opens, setOpens] = useState(() => (paper ? splitDateTime(paper.opensAt) : tomorrowMorning()));
  const [closes, setCloses] = useState(() => splitDateTime(paper?.closesAt ?? null));
  const [duration, setDuration] = useState(paper?.durationMinutes ? String(paper.durationMinutes) : paper ? "" : "60");
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [removeFile, setRemoveFile] = useState(false);
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  // An existing paper's typed text and questions are read once; saving before they arrive would wipe them.
  const [contentReady, setContentReady] = useState(!paper);
  const [contentFailed, setContentFailed] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"draft" | "publish" | null>(null);
  const saving = pending !== null;
  const savingRef = useRef(false);
  savingRef.current = saving;
  // Set once a new paper has been created, so a retry after a later step failed updates it instead of creating a second one.
  const createdId = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchTeacherClasses(session.profileId)
      .then((c) => { if (alive) { setClasses(c); setClassId((id) => id ?? c[0]?.id ?? null); } })
      .catch(() => { if (alive) setClasses([]); });
    fetchCurrentTermExams(session.tenantId).then((list) => { if (alive) setExams(list); }).catch(() => {});
    return () => { alive = false; };
  }, [session.profileId, session.tenantId]);

  const paperId = paper?.id;
  useEffect(() => {
    if (!paperId) return;
    let alive = true;
    fetchPaperContent(paperId)
      .then((c) => { if (alive) { setBody(c.body); setQuestions(c.questions); setContentReady(true); } })
      .catch(() => { if (alive) setContentFailed(true); });
    return () => { alive = false; };
  }, [paperId]);

  // Subjects are per class: only the ones this teacher is assigned in it.
  useEffect(() => {
    if (!classId) { setSubjects([]); return; }
    let alive = true;
    setSubjects(null);
    fetchTeacherSubjectsForClass(session.profileId, classId)
      .then((list) => {
        if (!alive) return;
        setSubjects(list);
        setSubjectId((cur) => (list.some((x) => x.id === cur) ? cur : list[0]?.id ?? null));
      })
      .catch(() => { if (alive) setSubjects([]); });
    return () => { alive = false; };
  }, [classId, session.profileId]);

  // Leaving while the paper is being saved may lose it, so ask first; but never trap, since a stalled upload has to be abandonable.
  useEffect(() => nav.addListener("beforeRemove", (e: { preventDefault: () => void; data: { action: unknown } }) => {
    if (!savingRef.current) return;
    e.preventDefault();
    Alert.alert("Still saving", "This hasn't finished. If you leave now, it may not be saved.", [
      { text: "Keep waiting", style: "cancel" },
      { text: "Leave anyway", style: "destructive", onPress: () => nav.dispatch(e.data.action) },
    ]);
  }), [nav]);

  async function choose() {
    setError("");
    try {
      const f = await pickFile("document", PDF_OR_IMAGE);
      if (!f) return;
      if (f.sizeBytes !== null && f.sizeBytes > PHONE_UPLOAD_LIMIT_BYTES) {
        setError(`"${f.name}" is ${formatFileSize(f.sizeBytes)}. Files can be up to ${formatFileSize(PHONE_UPLOAD_LIMIT_BYTES)}.`);
        return;
      }
      setPicked(f);
      setRemoveFile(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open your files.");
    }
  }

  async function openCurrentFile() {
    if (!paper?.filePath) return;
    try { await openExamFile(paper.filePath); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not open the file."); }
  }

  async function save(publish: boolean) {
    const opensAt = joinDateTime(opens.date, opens.time);
    const closesAt = joinDateTime(closes.date, closes.time);
    if (opensAt === null) { setError("Type when the paper opens: the date as year-month-day (2026-11-09) and the time as hours:minutes (08:30)."); return; }
    if (closesAt === null) { setError("Type when it closes the same way, or empty both boxes to keep it open."); return; }
    const hasFile = !!picked || (!!paper?.fileName && !removeFile);
    const checked = validatePaper({
      kind, title, instructions, classId: classId ?? "", subjectId: subjectId ?? "", examId: examId || null, mode, body,
      opensAt: fromLocalInput(opensAt) ?? "", closesAt: fromLocalInput(closesAt),
      durationMinutes: mode === "online" && duration.trim() ? Number(duration) : null,
    }, { hasFile });
    if (!checked.ok) { setError(checked.message); return; }

    let qs: QuestionDraft[] = questions;
    if (mode === "online" && !locked) {
      const q = validateQuestions(questions);
      if (!q.ok) { setError(q.message); return; }
      qs = q.value;
    }
    if (publish) {
      const problem = publishProblem({ mode, hasContent: hasFile || !!checked.value.body, questionCount: qs.length });
      if (problem) { setError(problem); return; }
    }

    setPending(publish ? "publish" : "draft");
    setError("");
    try {
      let id = paper?.id ?? createdId.current;
      if (id) await updateExamPaper(id, checked.value);
      else id = createdId.current = await createExamPaper(session.tenantId, checked.value);
      await savePaperBody(id, checked.value.body);
      if (picked) await setPaperFile(id, await uploadExamPaperFile(session.tenantId, id, picked));
      else if (removeFile) await setPaperFile(id, null);
      if (mode === "online" && !locked) await saveExamQuestions(id, qs);
      if (publish && !paper?.publishedAt) await setPaperPublished(id, true);
      savingRef.current = false;
      nav.goBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save. Check your connection and try again.");
      setPending(null);
    }
  }

  const noSubjects = subjects !== null && subjects.length === 0;
  const cannotSave = saving || noSubjects || !contentReady;

  const timeBoxes = (label: string, value: { date: string; time: string }, set: (v: { date: string; time: string }) => void, optional: boolean) => (
    <View>
      <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }]}>{label}</Text>
      <View style={[s.row, { gap: 10, alignItems: "flex-start" }]}>
        <Field
          style={{ flex: 3 }}
          label={`${label}: date`}
          value={value.date}
          onChangeText={(v) => { set({ ...value, date: formatDateInput(v) }); setError(""); }}
          placeholder="2026-11-09"
          keyboardType="number-pad"
          hint="Year-month-day"
          editable={!saving}
        />
        <Field
          style={{ flex: 2 }}
          label={`${label}: time`}
          value={value.time}
          onChangeText={(v) => { set({ ...value, time: formatTimeInput(v) }); setError(""); }}
          placeholder="08:30"
          keyboardType="number-pad"
          hint="24-hour"
          editable={!saving}
        />
      </View>
      {optional && <Text style={[s.faint, { marginTop: 4 }]}>Empty both to keep it open.</Text>}
    </View>
  );

  return (
    <View style={s.screen}>
      <ScreenHeader title={paper ? "Edit paper" : "New paper"} sub="Exams & tests" color={a.deep} back />
      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        <View style={[s.card, { gap: 14 }]}>
          {classes === null ? (
            <ActivityIndicator color={accentInk(a.deep)} />
          ) : classes.length === 0 ? (
            <Text style={s.small}>You aren't assigned to any classes yet. Ask the school admin to add you to a class.</Text>
          ) : (
            <>
              {locked && (
                <Text style={s.small}>
                  Learners have already started this paper, so its class, subject, how it is taken and its questions are fixed. You can still change the title, instructions and times.
                </Text>
              )}
              {contentFailed && (
                <Text accessibilityLiveRegion="polite" style={{ fontSize: 12.5, lineHeight: 18, color: t.status.warnInk }}>
                  Could not load this paper's questions, so it can't be saved from here. Go back and open it again.
                </Text>
              )}

              <View>
                <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }]}>Type</Text>
                <PillPicker items={KINDS} selectedId={kind} onPick={(k) => setKind(k as PaperKind)} accent={session.accent} />
              </View>
              <View>
                <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }]}>Class</Text>
                {locked ? <Text style={s.small}>{paper?.className}</Text> : <PillPicker items={classes} selectedId={classId} onPick={setClassId} accent={session.accent} />}
              </View>
              <View>
                <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }]}>Subject</Text>
                {locked ? <Text style={s.small}>{paper?.subjectName}</Text>
                  : subjects === null ? <ActivityIndicator color={accentInk(a.deep)} />
                  : noSubjects ? <Text style={s.faint}>You aren't assigned a subject in this class. Ask the school admin.</Text>
                  : <PillPicker items={subjects} selectedId={subjectId} onPick={setSubjectId} accent={session.accent} />}
              </View>

              <Field label="Title" value={title} onChangeText={(v) => { setTitle(v); setError(""); }} placeholder="e.g. Mid-term Mathematics Paper 1" editable={!saving} />
              <Field label="Instructions (optional)" value={instructions} onChangeText={setInstructions} placeholder="e.g. Answer all questions in Section A and any two in Section B." multiline editable={!saving} />

              <View>
                <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }]}>How learners take it</Text>
                <View style={{ gap: 8 }} accessibilityRole="radiogroup">
                  {([
                    ["online", "Sit it online", "Timed questions in the app. Multiple choice is marked for you."],
                    ["read", "Read only", "Learners open the paper and answer on paper, in class or at home."],
                  ] as const).map(([key, label, hint]) => {
                    const on = mode === key;
                    return (
                      <Tap
                        key={key}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: on, disabled: saving || locked }}
                        disabled={saving || locked}
                        onPress={() => { setMode(key); setError(""); }}
                        style={{ ...HIT, borderRadius: t.radius.lg, padding: 12, borderWidth: on ? 2 : 1, borderColor: on ? accentInk(a.deep) : fieldLine, backgroundColor: on ? `${a.deep}14` : t.appSurface.card, opacity: locked && !on ? 0.6 : 1 }}
                      >
                        <Text style={{ fontSize: 14, fontWeight: "600", color: t.appSurface.ink }}>{label}</Text>
                        <Text style={[s.faint, { marginTop: 2 }]}>{hint}</Text>
                      </Tap>
                    );
                  })}
                </View>
              </View>

              {timeBoxes("Opens", opens, setOpens, false)}
              {timeBoxes("Closes (optional)", closes, setCloses, true)}
              {mode === "online" && (
                <Field label="Time allowed (minutes)" value={duration} onChangeText={(v) => { setDuration(v.replace(/\D/g, "")); setError(""); }} keyboardType="number-pad" hint="Empty for no limit." editable={!saving} />
              )}

              <View>
                <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }]}>Counts towards</Text>
                <PillPicker items={[{ id: "", name: "Practice only" }, ...exams]} selectedId={examId} onPick={setExamId} accent={session.accent} />
                <Text style={s.faint}>
                  {mode === "online" ? "Pick a term exam to send the marked scores into the Gradebook from the website." : "Read-only papers are marked by hand: type the marks into the Gradebook as usual."}
                </Text>
              </View>

              <View style={{ gap: 8, padding: 12, borderRadius: t.radius.lg, backgroundColor: t.appSurface.page }}>
                <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink }]}>{mode === "read" ? "The paper" : "Reference sheet (optional)"}</Text>
                <Text style={s.faint}>
                  {mode === "read" ? "Upload it as a PDF or a picture, type it in below, or both. Learners can open it from when the paper opens." : "A formula sheet, map or passage learners can open while they sit the paper."}
                </Text>
                {paper?.fileName && !picked && !removeFile && (
                  <View style={[s.row, { gap: 10 }]}>
                    <FileText size={20} color={accentInk(a.deep)} />
                    <Text numberOfLines={1} style={{ flex: 1, color: t.appSurface.ink, fontSize: 13.5, fontWeight: "600" }}>{paper.fileName}</Text>
                    <Button variant="quiet" tint={a.deep} label="Open" onPress={() => void openCurrentFile()} style={{ paddingHorizontal: 8 }} />
                    <Button variant="quiet" tint={t.status.warnInk} label="Remove file" disabled={saving} onPress={() => setRemoveFile(true)} style={{ paddingHorizontal: 8 }} />
                  </View>
                )}
                {picked && <Text style={s.small}>{picked.name}{picked.sizeBytes ? ` · ${formatFileSize(picked.sizeBytes)}` : ""}</Text>}
                <Button variant="secondary" label={picked || (paper?.fileName && !removeFile) ? "Choose a different file" : "Choose a PDF or picture"} disabled={saving} onPress={() => void choose()} />
                {mode === "read" && (
                  <Field label="Or type the paper" value={body} onChangeText={(v) => { setBody(v); setError(""); }} placeholder="Type the paper here." multiline editable={!saving && contentReady} />
                )}
              </View>

              {mode === "online" && (
                contentReady
                  ? <QuestionEditor questions={questions} onChange={(q) => { setQuestions(q); setError(""); }} locked={locked} accent={session.accent} />
                  : !contentFailed && <ActivityIndicator color={accentInk(a.deep)} />
              )}

              {!!error && (
                <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
                  <CircleAlert size={14} color={t.status.warnInk} style={{ marginTop: 2 }} />
                  <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: t.status.warnInk }}>{error}</Text>
                </View>
              )}
              {saving && !!picked && <Text accessibilityLiveRegion="polite" style={s.small}>Uploading {picked.name}. Keep the app open until it finishes.</Text>}

              <View style={{ gap: 8 }}>
                {!published && (
                  <Button label="Save and publish" tint={a.deep} loading={pending === "publish"} disabled={cannotSave} onPress={() => void save(true)} />
                )}
                <Button
                  variant={published ? "primary" : "secondary"}
                  tint={published ? a.deep : undefined}
                  label={published ? "Save changes" : "Save draft"}
                  loading={pending === "draft"}
                  disabled={cannotSave}
                  onPress={() => void save(false)}
                />
                <Button variant="quiet" tint={t.appSurface.inkMuted} label="Cancel" disabled={saving} onPress={() => nav.goBack()} />
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
