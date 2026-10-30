import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Alert, AppState, ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  fetchSittingQuestions, formatTimeLeft, saveExamAttempt, startExamAttempt, timeLeftMs,
  type Answers, type AttemptSession, type ExamPaperRow, type SittingQuestion,
} from "@figbloom/shared";
import { accentFor, fieldLine, HIT, s, t } from "../../theme";
import { useStudentData } from "../../studentData";
import { BackLink } from "../../ui/BackLink";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { Tap } from "../../ui/Tap";

/** Answers are saved this often while there is something unsaved, and whenever the app leaves the screen. */
const AUTOSAVE_MS = 15_000;
/** Under this, the clock turns warning-coloured. */
const LOW_MS = 5 * 60_000;

/**
 * Sitting an online paper. Starting records the start time on the server,
 * which also enforces the time limit: the countdown here is the server's
 * deadline (corrected for this phone's clock), answers are saved every few
 * seconds and whenever the app is put away, and what is there is handed in
 * automatically when the clock reaches zero. Leaving the screen saves first
 * and asks, since the clock keeps running while you are away.
 */
export function StudentExamSitting({ route }: { route: { params: { paper: ExamPaperRow } } }) {
  const nav = useNavigation<any>();
  const { accent } = useStudentData();
  const tint = accentFor(accent).deep;
  const paper = route.params.paper;

  const [session, setSession] = useState<AttemptSession | null>(null);
  const [questions, setQuestions] = useState<SittingQuestion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [now, setNow] = useState(Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [saveNote, setSaveNote] = useState("");
  const dirty = useRef(false);
  const answersRef = useRef<Answers>({});
  answersRef.current = answers;
  /** Handed in: nothing left to save or to protect. A ref, so the back-button listener always sees the latest. */
  const finished = useRef(false);
  const started = useRef(false);

  // Start (or pick up) the sitting, then the questions.
  useEffect(() => {
    let alive = true;
    setLoadError(null);
    setQuestions(null);
    (async () => {
      const sess = await startExamAttempt(paper.id);
      if (!alive) return;
      started.current = true;
      setSession(sess);
      setAnswers(sess.answers);
      finished.current = !!sess.submittedAt;
      const q = await fetchSittingQuestions(paper.id);
      if (alive) setQuestions(q);
    })().catch((err: unknown) => { if (alive) setLoadError(err instanceof Error ? err.message : "Could not start this paper."); });
    return () => { alive = false; };
  }, [paper.id, loadKey]);

  const save = useCallback(async (submit: boolean) => {
    if (finished.current) return;
    if (!submit && !dirty.current) return;
    dirty.current = false;
    try {
      const next = await saveExamAttempt(paper.id, answersRef.current, submit);
      setSession(next);
      if (next.submittedAt) finished.current = true;
      setSaveNote(`Saved ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`);
    } catch (err) {
      dirty.current = true;
      setSaveNote("Not saved: check your connection");
      if (submit) throw err;
    }
  }, [paper.id]);

  // Autosave, and once more the moment the app is put away (another app, the screen locking).
  useEffect(() => {
    const id = setInterval(() => void save(false), AUTOSAVE_MS);
    const sub = AppState.addEventListener("change", (st) => { if (st !== "active") void save(false); });
    return () => { clearInterval(id); sub.remove(); };
  }, [save]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const handedIn = !!session?.submittedAt;
  const left = session?.deadline ? timeLeftMs(session.deadline, now, session.skewMs) : null;

  const submit = useCallback(async (auto: boolean) => {
    setSubmitting(true);
    try {
      await save(true);
      if (auto) AccessibilityInfo.announceForAccessibility("Time is up. Your answers have been handed in.");
    } catch (err) {
      Alert.alert("Could not hand in", `${err instanceof Error ? err.message : "Something went wrong."} Check your connection and try again.`);
    } finally {
      setSubmitting(false);
    }
  }, [save]);

  // The clock reached zero: hand in what is there, once. If that fails (no signal) the Hand in button is still
  // there, and the server hands in the last saved answers itself when the teacher opens the scripts.
  const autoTried = useRef(false);
  useEffect(() => {
    if (left === 0 && session && !session.submittedAt && !autoTried.current) {
      autoTried.current = true;
      void submit(true);
    }
  }, [left, session, submit]);

  // A screen reader hears the clock at two moments, not every second.
  const announced = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (left === null || handedIn || left <= 0) return;
    if (left <= 60_000 && !announced.current["1"]) { announced.current["1"] = true; AccessibilityInfo.announceForAccessibility("One minute left."); }
    else if (left <= LOW_MS && !announced.current["5"]) { announced.current["5"] = true; AccessibilityInfo.announceForAccessibility("Five minutes left."); }
  }, [left, handedIn]);

  // Leaving by any route (the back link, the hardware back button): save, and ask, because the clock keeps running.
  useEffect(() => nav.addListener("beforeRemove", (e: { preventDefault: () => void; data: { action: unknown } }) => {
    if (finished.current || !started.current) return;
    e.preventDefault();
    Alert.alert(
      "Leave this paper?",
      "Your answers save as you go, and the clock keeps running while you are away. You can carry on from the Exams screen until time is up.",
      [
        { text: "Stay", style: "cancel" },
        {
          text: "Save and leave",
          onPress: () => {
            void save(false).then(() => {
              if (!dirty.current) { nav.dispatch(e.data.action); return; }
              Alert.alert("Your latest answers weren't saved", "Check your connection. Stay to try again, or leave without them.", [
                { text: "Stay", style: "cancel" },
                { text: "Leave without them", style: "destructive", onPress: () => nav.dispatch(e.data.action) },
              ]);
            });
          },
        },
      ],
    );
  }), [nav, save]);

  function answer(id: string, value: number | string) {
    dirty.current = true;
    setAnswers((a) => {
      const next = { ...a };
      if (value === "") delete next[id];
      else next[id] = value;
      return next;
    });
  }

  function confirmSubmit() {
    const blank = (questions ?? []).filter((q) => !(q.id in answers)).length;
    const msg = blank
      ? `${blank} question${blank === 1 ? " is" : "s are"} unanswered. Hand in anyway? You can't change your answers after.`
      : "Hand in now? You can't change your answers after.";
    Alert.alert("Hand in?", msg, [
      { text: "Keep working", style: "cancel" },
      { text: "Hand in", onPress: () => void submit(false) },
    ]);
  }

  const low = left !== null && left < LOW_MS;

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <BackLink label={handedIn ? "Back" : "Save and leave"} onPress={() => nav.goBack()} />
        <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start", gap: 12 }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.headerEyebrow}>{paper.subjectName.toUpperCase()}</Text>
            <Text style={s.headerTitle} numberOfLines={2}>{paper.title}</Text>
          </View>
          {left !== null && !handedIn && (
            <View
              accessible
              accessibilityLabel={`${formatTimeLeft(left)} left`}
              style={{ borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: low ? "#fff" : "rgba(255,255,255,0.18)" }}
            >
              <Text style={[s.mono, { fontSize: 16, fontWeight: "700", color: low ? t.status.warnInk : "#fff" }]}>{formatTimeLeft(left)}</Text>
            </View>
          )}
        </View>
      </View>

      {loadError ? (
        <View style={{ padding: 16 }}>
          <ErrorState title="Couldn't start this paper" body={loadError} onRetry={() => setLoadKey((k) => k + 1)} />
        </View>
      ) : !session || !questions ? (
        <ActivityIndicator color={tint} style={{ marginTop: 32 }} />
      ) : handedIn ? (
        <View style={{ padding: 16, gap: 16 }}>
          <View style={[s.card, { backgroundColor: t.status.okBg, flexDirection: "row", gap: 8, alignItems: "flex-start" }]}>
            <Text style={{ fontSize: 14, fontWeight: "700", color: t.status.okInk }}>✓</Text>
            <Text style={[s.small, { flex: 1, color: t.status.okInk, lineHeight: 19 }]}>
              {session.timedOut ? "Time ran out, so your last saved answers were handed in." : "Handed in."} Your score appears on the Exams screen once your teacher releases the results.
            </Text>
          </View>
          <Button label="Back to exams" tint={tint} onPress={() => nav.goBack()} />
        </View>
      ) : questions.length === 0 ? (
        <View style={{ padding: 16 }}>
          <EmptyState title="No questions yet" body="This paper has no questions. Tell your teacher." />
        </View>
      ) : (
        <>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 12 }}>
            {!!paper.instructions && <Text style={[s.small, { color: t.appSurface.ink, lineHeight: 20 }]}>{paper.instructions}</Text>}
            {questions.map((q, i) => (
              <View key={q.id} style={[s.card, { gap: 10 }]}>
                <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start", gap: 8 }]}>
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", lineHeight: 21 }}>{i + 1}. {q.prompt}</Text>
                  <Text style={[s.mono, { color: t.appSurface.inkFaint }]}>{q.points} mark{q.points === 1 ? "" : "s"}</Text>
                </View>
                {q.kind === "choice" ? (
                  <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
                    {q.options.map((o, k) => {
                      const on = answers[q.id] === k;
                      return (
                        <Tap
                          key={k}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: on }}
                          accessibilityLabel={`${String.fromCharCode(65 + k)}. ${o}`}
                          onPress={() => answer(q.id, k)}
                          style={{
                            ...HIT, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
                            borderWidth: on ? 2 : 1, borderColor: on ? tint : fieldLine, backgroundColor: on ? `${tint}14` : t.appSurface.card,
                          }}
                        >
                          <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: on ? tint : fieldLine, alignItems: "center", justifyContent: "center" }}>
                            {on && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: tint }} />}
                          </View>
                          <Text style={[s.mono, { color: t.appSurface.inkFaint }]}>{String.fromCharCode(65 + k)}</Text>
                          <Text style={{ flex: 1, fontSize: 14.5, color: t.appSurface.ink }}>{o}</Text>
                        </Tap>
                      );
                    })}
                  </View>
                ) : (
                  <Field
                    label="Your answer"
                    accessibilityLabel={`Answer to question ${i + 1}`}
                    value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                    onChangeText={(v) => answer(q.id, v)}
                    onBlur={() => void save(false)}
                    multiline
                    numberOfLines={q.kind === "long" ? 8 : 3}
                    focusColor={tint}
                  />
                )}
              </View>
            ))}
          </ScrollView>
          <View style={{ padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: t.appSurface.line, backgroundColor: t.appSurface.card }}>
            <Text style={[s.faint, { textAlign: "center" }]}>{saveNote || "Your answers save as you go."}</Text>
            <Button label="Hand in" tint={tint} loading={submitting} onPress={confirmSubmit} />
          </View>
        </>
      )}
    </View>
  );
}
