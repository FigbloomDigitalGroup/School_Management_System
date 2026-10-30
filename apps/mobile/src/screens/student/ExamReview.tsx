import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { fetchSittingQuestions, scoreLabel, totalPoints, type SittingQuestion } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { SubScreen } from "../../components/SubScreen";
import { useStudentData } from "../../studentData";
import { useStudentPapers } from "../../lib/useStudentPapers";
import { EmptyState, ErrorState } from "../../ui/StateView";

/** A marked paper looked back at: the score, the teacher's feedback, and for each question what was answered, the marks and any note. */
export function StudentExamReview({ route }: { route: { params: { paperId: string } } }) {
  const { paperId } = route.params;
  const { accent } = useStudentData();
  const tint = accentFor(accent).deep;
  const { state, retry } = useStudentPapers();
  const view = state.kind === "ready" ? state.papers.find((v) => v.paper.id === paperId) : undefined;
  const attempt = view?.result;

  const [questions, setQuestions] = useState<SittingQuestion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    fetchSittingQuestions(paperId)
      .then((q) => { if (alive) setQuestions(q); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [paperId, reloadKey]);

  return (
    <SubScreen tint={tint} title={view?.paper.title ?? "Marked paper"} sub={view ? `${view.paper.subjectName} · marked` : "Your marked paper"}>
      {state.kind === "loading" ? (
        <ActivityIndicator color={tint} style={{ marginTop: 24 }} />
      ) : state.kind === "failed" ? (
        <ErrorState title="Couldn't load this paper" onRetry={retry} />
      ) : !attempt ? (
        <EmptyState title="Not marked yet" body="Your marked paper appears here once your teacher releases the results." />
      ) : failed ? (
        <ErrorState title="Couldn't load the questions" onRetry={() => { setQuestions(null); setReloadKey((k) => k + 1); }} />
      ) : !questions ? (
        <ActivityIndicator color={tint} style={{ marginTop: 24 }} />
      ) : (
        <View style={{ gap: 12 }}>
          <View style={[s.card, { backgroundColor: t.status.okBg, gap: 6 }]}>
            <Text style={[s.eyebrow, { color: t.status.okInk }]}>YOUR SCORE</Text>
            <Text style={{ fontSize: 24, fontWeight: "700", color: t.status.okInk }}>{scoreLabel(attempt.finalScore, totalPoints(questions))}</Text>
            {!!attempt.feedback && <Text style={[s.small, { color: t.status.okInk, lineHeight: 19 }]}>{attempt.feedback}</Text>}
          </View>

          {questions.map((q, i) => {
            const a = attempt.answers[q.id];
            const got = attempt.questionMarks[q.id] ?? 0;
            const note = attempt.questionNotes[q.id];
            const markInk = got === q.points ? t.status.okInk : got === 0 ? t.status.warnInk : t.appSurface.ink;
            return (
              <View key={q.id} style={[s.card, { gap: 8 }]}>
                <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start", gap: 8 }]}>
                  <Text style={{ flex: 1, fontSize: 14.5, fontWeight: "600", lineHeight: 20 }}>{i + 1}. {q.prompt}</Text>
                  <Text accessibilityLabel={`${got} out of ${q.points} marks`} style={[s.mono, { fontWeight: "700", color: markInk }]}>{got} / {q.points}</Text>
                </View>
                <Text style={[s.small, { lineHeight: 19 }]}>
                  {a === undefined ? "No answer" : typeof a === "number" ? q.options[a] ?? "—" : a}
                </Text>
                {!!note && <Text style={{ fontSize: 13, color: t.appSurface.ink }}>Teacher: {note}</Text>}
              </View>
            );
          })}
        </View>
      )}
    </SubScreen>
  );
}
