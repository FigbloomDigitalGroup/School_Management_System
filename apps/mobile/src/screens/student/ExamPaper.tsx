import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  COUNTING_LABEL, PAPER_KIND_LABEL, canStartPaper, fetchPaperText, paperResitWaiting, paperWindow, scoreLabel, studentWindow, windowLabel,
  type StudentPaper,
} from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { SubScreen } from "../../components/SubScreen";
import { useStudentData } from "../../studentData";
import { openExamFile } from "../../lib/examFile";
import { useStudentPapers } from "../../lib/useStudentPapers";
import { Button } from "../../ui/Button";
import { EmptyState, ErrorState } from "../../ui/StateView";

const mins = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/**
 * One paper: when it is on, how long there is, the instructions, and what to
 * do next (start it, carry on, read it, or see the marked paper). What is
 * offered follows the same rules as the web's Exams screen. Read again each
 * time it comes back into view, so it is right after a sitting.
 */
export function StudentExamPaper({ route }: { route: { params: { paperId: string } } }) {
  const { accent } = useStudentData();
  const tint = accentFor(accent).deep;
  const { state, retry } = useStudentPapers();
  const view = state.kind === "ready" ? state.papers.find((v) => v.paper.id === route.params.paperId) : undefined;
  // A paper opens, or a window closes, while this screen is open.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  return (
    <SubScreen
      tint={tint}
      title={view?.paper.title ?? "Exam"}
      sub={view ? `${PAPER_KIND_LABEL[view.paper.kind]} · ${view.paper.subjectName}` : "Exams & tests"}
    >
      {state.kind === "loading" ? (
        <ActivityIndicator color={tint} style={{ marginTop: 24 }} />
      ) : state.kind === "failed" ? (
        <ErrorState title="Couldn't load this paper" onRetry={retry} />
      ) : !view ? (
        <EmptyState title="This paper is not available" body="It may have been withdrawn. Go back to see your exams and tests." />
      ) : (
        <PaperDetail view={view} now={now} tint={tint} />
      )}
    </SubScreen>
  );
}

function PaperDetail({ view, now, tint }: { view: StudentPaper; now: number; tint: string }) {
  const nav = useNavigation<any>();
  const { paper, state, result, total } = view;
  const win = studentWindow(view);
  const w = paperWindow(win, now);
  const ownWindow = win.opensAt !== paper.opensAt || win.closesAt !== paper.closesAt;
  const extra = state?.terms.extraMinutes ?? 0;
  const minutes = paper.durationMinutes ? paper.durationMinutes + extra : null;
  const startable = canStartPaper(view, now);
  const resit = (state?.attemptsUsed ?? 0) > 0;
  const isOpen = w !== "upcoming";
  const [text, setText] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);

  useEffect(() => {
    if (paper.mode !== "read" || !isOpen) return;
    let alive = true;
    fetchPaperText(paper.id).then((b) => { if (alive) setText(b); }).catch(() => {});
    return () => { alive = false; };
  }, [paper.id, paper.mode, isOpen]);

  async function openFile() {
    if (!paper.filePath) return;
    setFileNote(null);
    try { await openExamFile(paper.filePath); }
    catch (err) { setFileNote(err instanceof Error ? `Could not open the paper: ${err.message}` : "Could not open the paper."); }
  }

  function start() {
    const go = () => nav.navigate("ExamSitting", { paper });
    if (!minutes) { go(); return; }
    Alert.alert("Start now?", `You'll have ${mins(minutes)}, and the clock keeps running even if you leave.`, [
      { text: "Not yet", style: "cancel" },
      { text: resit ? "Start your resit" : "Start", onPress: go },
    ]);
  }

  const timeAllowed = paper.mode === "online"
    ? (minutes ? `${mins(minutes)}${extra ? ` (${extra} extra)` : ""}` : extra ? `No time limit, ${mins(extra)} extra after closing` : "No time limit")
    : "Read it, answer on paper";

  return (
    <View style={{ gap: 12 }}>
      <View style={[s.card, { gap: 12 }]}>
        <View>
          <Text style={s.eyebrow}>WHEN</Text>
          <Text style={{ fontSize: 13.5, fontWeight: "600", marginTop: 4 }}>{windowLabel(win, now)}</Text>
          {ownWindow && <Text style={[s.faint, { marginTop: 2 }]}>Your own time, set by your teacher</Text>}
        </View>
        <View>
          <Text style={s.eyebrow}>{paper.mode === "online" ? "TIME ALLOWED" : "HOW"}</Text>
          <Text style={{ fontSize: 13.5, fontWeight: "600", marginTop: 4 }}>{timeAllowed}</Text>
        </View>
      </View>

      {!!paper.instructions && <Text style={[s.small, { color: t.appSurface.ink, lineHeight: 20 }]}>{paper.instructions}</Text>}

      {result && !startable && state?.status !== "in_progress" ? (
        <View style={[s.card, { backgroundColor: t.status.okBg, gap: 6 }]}>
          <Text style={[s.eyebrow, { color: t.status.okInk }]}>YOUR SCORE</Text>
          <Text style={{ fontSize: 24, fontWeight: "700", color: t.status.okInk }}>{scoreLabel(result.finalScore, total ?? 0)}</Text>
          {!!result.feedback && <Text style={[s.small, { color: t.status.okInk, lineHeight: 19 }]}>{result.feedback}</Text>}
          <Button variant="secondary" label="See your marked paper" onPress={() => nav.navigate("ExamReview", { paperId: paper.id })} style={{ marginTop: 8 }} />
        </View>
      ) : paper.mode === "read" ? (
        !isOpen ? (
          <Text style={s.faint}>The paper opens here at the time above.</Text>
        ) : (
          <>
            {!!paper.filePath && <Button label="Open the paper" tint={tint} onPress={() => void openFile()} />}
            {!!text && <View style={s.card}><Text style={{ fontSize: 14, lineHeight: 21, color: t.appSurface.ink }}>{text}</Text></View>}
          </>
        )
      ) : state?.status === "in_progress" ? (
        <Button label="Carry on" tint={tint} onPress={() => nav.navigate("ExamSitting", { paper })} />
      ) : startable ? (
        <>
          <Text style={[s.small, { lineHeight: 19 }]}>
            {resit && state ? `This is a resit. Your earlier sitting stays on the record; ${COUNTING_LABEL[state.terms.counting].toLowerCase()}. ` : ""}
            {minutes
              ? `Once you start, you have ${mins(minutes)} and the clock keeps running even if you leave. Your answers save as you go.`
              : "Your answers save as you go. Hand in when you're done."}
          </Text>
          <Button label={resit ? "Start your resit" : "Start"} tint={tint} onPress={start} />
        </>
      ) : state?.status === "excused" ? (
        <Text style={[s.small, { lineHeight: 19 }]}>Your teacher has excused you from this paper. It has no mark, and it doesn't count against you.</Text>
      ) : state?.submittedAt ? (
        <View style={[s.card, { backgroundColor: t.status.okBg, flexDirection: "row", gap: 8, alignItems: "flex-start" }]}>
          <Text style={{ fontSize: 14, fontWeight: "700", color: t.status.okInk }}>✓</Text>
          <Text style={[s.small, { flex: 1, color: t.status.okInk, lineHeight: 19 }]}>
            Handed in. {paperResitWaiting(view) && w === "upcoming" ? "Your resit opens at the time above. " : ""}Your score appears here once your teacher releases the results.
          </Text>
        </View>
      ) : w === "upcoming" ? (
        <Text style={s.faint}>You can start at the time above.</Text>
      ) : (
        <Text style={[s.small, { lineHeight: 19 }]}>
          You missed this paper. It's recorded as missed, not as a 0. If you were away for a reason, tell your teacher: they can give you a time to sit it.
        </Text>
      )}

      {paper.mode === "online" && !!paper.filePath && isOpen && !result && (
        <Button variant="secondary" label="Open the reference sheet" onPress={() => void openFile()} />
      )}
      {!!fileNote && <Text accessibilityLiveRegion="polite" style={[s.small, { color: t.status.warnInk }]}>{fileNote}</Text>}
    </View>
  );
}
