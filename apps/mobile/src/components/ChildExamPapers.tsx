import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  PAPER_KIND_LABEL, familyPaperGroups, loadStudentPapers, paperWindow, scoreLabel, studentWindow, windowLabel,
  type StudentPaper,
} from "@figbloom/shared";
import { Skeleton } from "./Skeleton";
import { useTheme } from "../ui/ThemeContext";

/**
 * A child's exams and tests, for the parent: what is coming up, what was not
 * sat (no mark, and never shown as a 0), and the score and the teacher's
 * feedback once results are released. Questions and answers stay with the
 * learner. Nothing at all when there is nothing to show.
 */
export function ChildExamPapers({ studentId, classId }: { studentId: string; classId: string | null }) {
  const { t, s } = useTheme();
  const [papers, setPapers] = useState<StudentPaper[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    if (!classId) { setPapers([]); return; }
    setPapers(null);
    loadStudentPapers(classId, studentId)
      .then((p) => { if (alive) setPapers(p); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [classId, studentId]);

  if (failed) return <Text style={[s.small, { marginTop: 20, color: t.status.warnInk }]}>Could not load exams and tests. Open this tab again to retry.</Text>;
  if (!papers) {
    return (
      <View style={[s.card, { marginTop: 20, gap: 8 }]}>
        <Skeleton width="35%" height={10} />
        <Skeleton width="70%" height={13} />
      </View>
    );
  }

  const now = Date.now();
  const { upcoming, notSat, released } = familyPaperGroups(papers, now);
  if (!upcoming.length && !notSat.length && !released.length) return null;

  const rows: { key: string; title: string; meta: string; pill?: { label: string; bg: string; ink: string }; score?: string; feedback?: string | null }[] = [
    ...upcoming.map((v) => {
      const win = studentWindow(v);
      const open = paperWindow(win, now) === "open";
      return {
        key: v.paper.id, title: v.paper.title, meta: `${PAPER_KIND_LABEL[v.paper.kind]} · ${v.paper.subjectName} · ${windowLabel(win, now)}`,
        pill: open ? { label: "Open now", bg: t.status.warnBg, ink: t.status.warnInk } : { label: "Coming up", bg: t.status.infoBg, ink: t.status.infoInk },
      };
    }),
    ...notSat.map((v) => {
      const excused = v.state?.status === "excused";
      return {
        key: v.paper.id, title: v.paper.title,
        meta: `${PAPER_KIND_LABEL[v.paper.kind]} · ${v.paper.subjectName} · ${excused ? "excused by the teacher, no mark" : "not sat, no mark (not a 0)"}`,
        pill: { label: excused ? "Excused" : "Missed", bg: t.status.mutedBg, ink: t.status.mutedInk },
      };
    }),
    ...released.map((v) => ({
      key: v.paper.id, title: v.paper.title, meta: `${PAPER_KIND_LABEL[v.paper.kind]} · ${v.paper.subjectName}`,
      score: scoreLabel(v.result!.finalScore, v.total ?? 0), feedback: v.result!.feedback,
    })),
  ];

  return (
    <>
      <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Exams & tests</Text>
      <View style={s.card}>
        {rows.map((r, i) => (
          <View key={r.key} style={{ paddingVertical: 11, borderBottomWidth: i === rows.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
            <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start", gap: 8 }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: "600" }}>{r.title}</Text>
                <Text style={[s.faint, { marginTop: 2 }]}>{r.meta}</Text>
              </View>
              {r.pill && (
                <View style={[s.pill, { backgroundColor: r.pill.bg }]}>
                  <Text style={[s.pillLabel, { color: r.pill.ink }]}>{r.pill.label}</Text>
                </View>
              )}
              {!!r.score && <Text style={[{ color: t.appSurface.ink }, s.mono, { fontWeight: "700" }]}>{r.score}</Text>}
            </View>
            {!!r.feedback && <Text style={[s.small, { marginTop: 6, lineHeight: 18 }]}>{r.feedback}</Text>}
          </View>
        ))}
      </View>
    </>
  );
}
