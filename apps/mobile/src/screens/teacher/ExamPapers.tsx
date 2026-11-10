import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  PAPER_KIND_LABEL, PAPER_MODE_LABEL, deleteExamPaper, fetchClassSizes, fetchExamPapers, fetchMyTeachingPairs, fetchTeacherClasses, paperStatus,
  savedPaperPublishProblem, setPaperPublished, windowLabel,
  type ExamPaperRow, type PaperStatusTone,
} from "@figbloom/shared";
import { accentFor } from "../../theme";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { TeacherSession } from "../../teacherNavigation";
import { Button } from "../../ui/Button";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { useTheme } from "../../ui/ThemeContext";

type State =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; papers: ExamPaperRow[]; sizes: Record<string, number>; hasClasses: boolean };

/**
 * The exam papers and tests this teacher has posted for the classes and subjects they teach. A paper is a draft,
 * seen only by staff, until it is published; then the class's learners can read it or sit it. Writing and changing
 * one is its own screen. Marking the written answers of a paper sat online stays on the website. Read again
 * whenever this comes back into view.
 */
export function TeacherExamPapers({ session }: { session: TeacherSession }) {
  const { t, s, accentInk } = useTheme();
  const nav = useNavigation<any>();
  const a = accentFor(session.accent);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const read = useCallback(() => {
    let alive = true;
    Promise.all([fetchExamPapers(session.tenantId), fetchMyTeachingPairs(session.profileId), fetchTeacherClasses(session.profileId)])
      .then(async ([all, pairs, classes]) => {
        const papers = all.filter((p) => pairs.has(`${p.classId}:${p.subjectId}`));
        const sizes = await fetchClassSizes([...new Set(papers.map((p) => p.classId))]);
        if (alive) setState({ kind: "ready", papers, sizes, hasClasses: classes.length > 0 });
      })
      // A failed re-read must not blank what is already on screen.
      .catch(() => { if (alive) setState((cur) => (cur.kind === "ready" ? cur : { kind: "failed" })); });
    return () => { alive = false; };
  }, [session.tenantId, session.profileId]);
  // A message about an earlier action is stale once the screen is left and come back to.
  useFocusEffect(useCallback(() => { setStatus(null); return read(); }, [read]));

  async function run(p: ExamPaperRow, work: () => Promise<void>, done: string) {
    setBusyId(p.id);
    setStatus(null);
    try {
      await work();
      setStatus(done);
      read();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "That didn't work. Check your connection and try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function togglePublish(p: ExamPaperRow) {
    if (p.publishedAt) {
      Alert.alert("Unpublish this?", `"${p.title}": ${p.className} won't see it any more.`, [
        { text: "Keep it published", style: "cancel" },
        { text: "Unpublish", onPress: () => void run(p, () => setPaperPublished(p.id, false), "Unpublished. Only staff can see it now.") },
      ]);
      return;
    }
    await run(p, async () => {
      const problem = await savedPaperPublishProblem(p);
      if (problem) throw new Error(problem);
      await setPaperPublished(p.id, true);
    }, `Published. ${p.className} can see it now.`);
  }

  function remove(p: ExamPaperRow) {
    Alert.alert("Delete this?", `"${p.title}" for ${p.className}. Its questions are deleted too.`, [
      { text: "Keep it", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void run(p, () => deleteExamPaper(p.id), "Deleted.") },
    ]);
  }

  const ready = state.kind === "ready" ? state : null;
  const now = Date.now();
  const tone = (k: PaperStatusTone) => ({ bg: t.status[`${k}Bg`], ink: t.status[`${k}Ink`] });

  return (
    <View style={s.screen}>
      <ScreenHeader title="Exams & tests" sub="Post a paper for a class you teach" color={a.deep} back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {state.kind === "loading" ? (
          <ActivityIndicator color={accentInk(a.deep)} style={{ marginTop: 24 }} />
        ) : state.kind === "failed" ? (
          <ErrorState title="Couldn't load your papers" onRetry={() => { setState({ kind: "loading" }); read(); }} />
        ) : !ready!.hasClasses ? (
          <EmptyState title="No classes yet" body="You aren't assigned to any classes yet. Ask the school admin to add you to a class." />
        ) : (
          <>
            <Button label="New paper" tint={a.deep} onPress={() => nav.navigate("ExamPaperEditor")} />
            {!!status && <Text accessibilityLiveRegion="polite" style={s.small}>{status}</Text>}

            {ready!.papers.length === 0 ? (
              <EmptyState title="No papers yet" body="Post an exam paper or a test. It stays a draft, seen only by staff, until you publish it." />
            ) : (
              ready!.papers.map((p) => {
                const badge = paperStatus(p, now);
                const c = tone(badge.tone);
                const busy = busyId === p.id;
                const sat = p.mode === "online" ? `${Math.min(p.attemptCount, ready!.sizes[p.classId] ?? p.attemptCount)} of ${ready!.sizes[p.classId] ?? "?"} have sat it` : null;
                return (
                  <View key={p.id} style={[s.card, { gap: 4 }]}>
                    <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start", gap: 8 }]}>
                      <Text style={[s.eyebrow, { flex: 1 }]}>{PAPER_KIND_LABEL[p.kind].toUpperCase()} · {p.className} · {p.subjectName}</Text>
                      <View style={[s.pill, { backgroundColor: c.bg }]}>
                        <Text style={[s.pillLabel, { color: c.ink }]}>{badge.label}</Text>
                      </View>
                    </View>
                    <Text style={{ color: t.appSurface.ink, fontSize: 15, fontWeight: "600" }}>{p.title}</Text>
                    <Text style={s.small}>{PAPER_MODE_LABEL[p.mode]}{p.durationMinutes ? ` · ${p.durationMinutes} min` : ""}{sat ? ` · ${sat}` : ""}</Text>
                    <Text style={s.faint}>{windowLabel(p, now)}</Text>
                    <View style={[s.row, { flexWrap: "wrap", gap: 4, marginTop: 4 }]}>
                      <Button variant="quiet" tint={a.deep} label="Edit" disabled={busy} onPress={() => nav.navigate("ExamPaperEditor", { paper: p })} style={{ paddingHorizontal: 10 }} />
                      <Button variant="quiet" tint={a.deep} label={p.publishedAt ? "Unpublish" : "Publish"} loading={busy} onPress={() => void togglePublish(p)} style={{ paddingHorizontal: 10 }} />
                      {p.attemptCount === 0 && (
                        <Button variant="quiet" tint={t.status.warnInk} label="Delete" disabled={busy} onPress={() => remove(p)} style={{ paddingHorizontal: 10 }} />
                      )}
                    </View>
                  </View>
                );
              })
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
