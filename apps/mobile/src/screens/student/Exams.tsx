import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { PAPER_KIND_LABEL, paperStanding, studentWindow, windowLabel, type StandingTone, type StudentPaper } from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { SubScreen } from "../../components/SubScreen";
import { useStudentData } from "../../studentData";
import { useStudentPapers } from "../../lib/useStudentPapers";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { Tap } from "../../ui/Tap";

type Tab = "coming" | "done";

const TONE: Record<StandingTone, { bg: string; ink: string }> = {
  ok: { bg: t.status.okBg, ink: t.status.okInk },
  info: { bg: t.status.infoBg, ink: t.status.infoInk },
  warn: { bg: t.status.warnBg, ink: t.status.warnInk },
  muted: { bg: t.status.mutedBg, ink: t.status.mutedInk },
};

/**
 * The exams and tests for the learner's class: what is coming up or open
 * (an online paper is sat from here, against the clock) and what is done, with
 * results once the teacher has released them. The same rules as the web's
 * Exams screen, from the same shared code.
 */
export function StudentExams() {
  const nav = useNavigation<any>();
  const { accent } = useStudentData();
  const tint = accentFor(accent).deep;
  const { state, retry } = useStudentPapers();
  const [tab, setTab] = useState<Tab>("coming");
  // "Coming up" becomes "Open now" without anyone leaving the screen.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const papers = state.kind === "ready" ? state.papers : [];
  const standing = new Map(papers.map((v) => [v.paper.id, paperStanding(v, now)]));
  const coming = papers.filter((v) => !standing.get(v.paper.id)!.done).sort((a, b) => a.paper.opensAt.localeCompare(b.paper.opensAt));
  const done = papers.filter((v) => standing.get(v.paper.id)!.done);
  const rows = tab === "done" ? done : coming;

  return (
    <SubScreen
      tint={tint}
      title="Exams & tests"
      sub={state.kind === "ready" ? `${coming.length} coming up or open` : "Papers and tests for your class"}
    >
      {state.kind === "loading" ? (
        <ActivityIndicator color={tint} style={{ marginTop: 24 }} />
      ) : state.kind === "failed" ? (
        <ErrorState title="Couldn't load your exams" onRetry={retry} />
      ) : state.kind === "none" ? (
        <EmptyState title="No class yet" body="This login is not yet linked to a class. Contact the school office." />
      ) : (
        <>
          <View style={[s.row, { gap: 8, marginBottom: 12 }]} accessibilityRole="tablist">
            {([["coming", "Coming up", coming.length], ["done", "Done", done.length]] as const).map(([key, label, n]) => {
              const on = tab === key;
              return (
                <Tap
                  key={key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  onPress={() => setTab(key)}
                  style={{ ...HIT, borderRadius: 999, paddingHorizontal: 14, justifyContent: "center", backgroundColor: on ? tint : t.appSurface.lineSoft }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", color: on ? "#fff" : t.appSurface.inkMuted }}>{label} {n}</Text>
                </Tap>
              );
            })}
          </View>

          {rows.length === 0 ? (
            tab === "done" ? (
              <EmptyState title="Nothing here yet" body="Papers you've handed in, and results once they're out, appear here." />
            ) : (
              <EmptyState title="No exams coming up" body="When a teacher posts an exam or a test for your class, it appears here." />
            )
          ) : (
            rows.map((v) => <PaperRow key={v.paper.id} view={v} now={now} onOpen={() => nav.navigate("ExamPaper", { paperId: v.paper.id })} />)
          )}
        </>
      )}
    </SubScreen>
  );
}

function PaperRow({ view, now, onOpen }: { view: StudentPaper; now: number; onOpen: () => void }) {
  const st = paperStanding(view, now);
  const tone = TONE[st.tone];
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={`${view.paper.title}, ${view.paper.subjectName}, ${st.label}`}
      onPress={onOpen}
      style={[s.card, { marginBottom: 8, padding: 14 }]}
    >
      <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start", gap: 8 }]}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14.5, fontWeight: "600" }}>{view.paper.title}</Text>
          <Text style={[s.faint, { marginTop: 2 }]}>{PAPER_KIND_LABEL[view.paper.kind]} · {view.paper.subjectName}</Text>
        </View>
        <View style={[s.pill, { backgroundColor: tone.bg }]}>
          <Text style={[s.pillLabel, { color: tone.ink }]}>{st.label}</Text>
        </View>
      </View>
      <Text style={[s.small, { marginTop: 8 }]}>{windowLabel(studentWindow(view), now)}</Text>
    </Tap>
  );
}
