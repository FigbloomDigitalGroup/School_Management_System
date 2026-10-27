import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import {
  describeChange, examsOf, fetchClassLearnerMeans, fetchClassPerformance, fetchTeacherClasses, GRADE_BANDS, gradeDistributions,
  gradingSchemeFor, movers, overallMeans, subjectComparison, subjectMeans,
  type ClassGroup, type ClassPerformanceRow, type LearnerMeanRow, type Mover,
} from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { BarList } from "../../components/charts/BarList";
import { DistributionBars } from "../../components/charts/DistributionBars";
import { LineChart } from "../../components/charts/LineChart";
import { fmt, MAX_SERIES, SERIES_COLORS, VIZ } from "../../components/charts/tokens";
import { PillPicker } from "../../components/PillPicker";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { TeacherSession } from "../../navigation";

/**
 * Results over time for a class the teacher teaches or is class teacher of:
 * the mean exam by exam, each subject's line, how subjects compare in one
 * exam, how grades spread, and who moved most. The same loaders and sums as
 * the web's Performance screen (apps/web/src/screens/admin/Performance.tsx),
 * published results only, so an exam still being entered never pulls a mean
 * down. The CBE rubric chart and the one-learner view are on the web.
 */
export function TeacherPerformance({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  const [classes, setClasses] = useState<ClassGroup[] | null>(null);
  const [classId, setClassId] = useState<string | null>(null);
  const [rows, setRows] = useState<ClassPerformanceRow[] | null>(null);
  const [means, setMeans] = useState<LearnerMeanRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pickedExam, setPickedExam] = useState<string | null>(null);
  const [pickedSubjects, setPickedSubjects] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchTeacherClasses(session.profileId)
      .then((c) => {
        if (!alive) return;
        const sorted = [...c].sort((x, y) => x.name.localeCompare(y.name));
        setClasses(sorted);
        setClassId((cur) => cur ?? sorted[0]?.id ?? null);
      })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load your classes."); });
    return () => { alive = false; };
  }, [session.profileId]);

  useEffect(() => {
    if (!classId) return;
    let alive = true;
    setRows(null);
    setMeans([]);
    setError(null);
    setPickedExam(null);
    setPickedSubjects(null);
    Promise.all([fetchClassPerformance(session.tenantId, classId), fetchClassLearnerMeans(classId)])
      .then(([r, m]) => { if (alive) { setRows(r); setMeans(m); } })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load performance."); });
    return () => { alive = false; };
  }, [session.tenantId, classId]);

  const cls = classes?.find((c) => c.id === classId) ?? null;
  const exams = useMemo(() => examsOf(rows ?? []), [rows]);
  const found = pickedExam ? exams.findIndex((e) => e.id === pickedExam) : -1;
  const examIdx = found >= 0 ? found : exams.length - 1;
  const exam = exams[examIdx] ?? null;
  const prevExam = examIdx > 0 ? exams[examIdx - 1]! : null;

  const overall = useMemo(() => overallMeans(rows ?? [], exams), [rows, exams]);
  const subjects = useMemo(() => subjectMeans(rows ?? [], exams), [rows, exams]);
  const chosen = (pickedSubjects ?? subjects.slice(0, 3).map((x) => x.id)).filter((id) => subjects.some((x) => x.id === id));
  const comparison = useMemo(() => (exam ? subjectComparison(rows ?? [], exam.id) : []), [rows, exam]);
  const scheme = cls ? gradingSchemeFor(session.country, cls.level) : null;
  const distributions = useMemo(() => (scheme ? gradeDistributions(rows ?? [], exams, scheme) : []), [rows, exams, scheme]);
  const moved = useMemo(() => (exam && prevExam ? movers(means, prevExam.id, exam.id) : { improved: [], dropped: [] }), [means, exam, prevExam]);

  const points = exams.map((e) => ({ label: e.name, sublabel: e.termName }));
  const latestMean = exam ? overall[examIdx] ?? null : null;
  const prevMean = prevExam ? overall[examIdx - 1] ?? null : null;
  const delta = latestMean !== null && prevMean !== null ? latestMean - prevMean : null;

  function toggleSubject(id: string) {
    const on = chosen.includes(id);
    if (on) setPickedSubjects(chosen.filter((x) => x !== id));
    else if (chosen.length < MAX_SERIES) setPickedSubjects([...chosen, id]);
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="Performance" sub="Published results, exam by exam" color={a.deep} back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {classes && classes.length > 0 && (
          <View>
            <Text style={[s.eyebrow, { marginBottom: 6 }]}>CLASS</Text>
            <PillPicker items={classes.map((c) => ({ id: c.id, name: c.name }))} selectedId={classId} onPick={setClassId} accent={session.accent} />
          </View>
        )}
        {exams.length > 1 && (
          <View>
            <Text style={[s.eyebrow, { marginBottom: 6 }]}>EXAM</Text>
            <PillPicker items={[...exams].reverse().map((e) => ({ id: e.id, name: e.name }))} selectedId={exam?.id ?? null} onPick={setPickedExam} accent={session.accent} />
          </View>
        )}

        {error ? (
          <View style={s.card}><Text style={[s.small, { color: t.status.warnInk }]}>Could not load performance: {error}</Text></View>
        ) : !classes || (classId && !rows) ? (
          <ActivityIndicator color={a.deep} style={{ marginTop: 32 }} />
        ) : classes.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={{ fontSize: 15, fontWeight: "600" }}>No classes yet</Text>
            <Text style={[s.small, { marginTop: 6, textAlign: "center" }]}>Once the office assigns you a class or subject, its results over time appear here.</Text>
          </View>
        ) : exams.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={{ fontSize: 15, fontWeight: "600" }}>Nothing published yet</Text>
            <Text style={[s.small, { marginTop: 6, textAlign: "center" }]}>Trends for {cls?.name ?? "this class"} appear once marks are published in the Gradebook.</Text>
          </View>
        ) : (
          <>
            {exam && (
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Stat label="MEAN MARK" value={fmt(latestMean)} sub={`${exam.name}`} />
                <Stat
                  label="SINCE LAST EXAM"
                  value={delta === null ? "—" : `${delta >= 0 ? "+" : "−"}${fmt(Math.abs(delta))}`}
                  sub={prevExam ? `Against ${prevExam.name}` : "First published exam"}
                  tone={delta === null ? undefined : delta >= 0 ? VIZ.up : VIZ.down}
                />
                <Stat label="SUBJECTS OUT" value={String(comparison.length)} sub={`${comparison.reduce((n, x) => n + x.learners, 0).toLocaleString()} marks`} />
              </View>
            )}

            <LineChart
              title={`Mean mark over time · ${cls?.name ?? ""}`}
              summary={describeChange(overall, exams) ?? "Every published mark, exam by exam."}
              points={points}
              series={[{ key: "mean", name: "Mean mark", values: overall }]}
            />

            {subjects.length > 0 && (
              <View style={{ gap: 8 }}>
                <LineChart
                  title="Subjects over time"
                  summary={`Each subject's mean. Pick up to ${MAX_SERIES}.`}
                  points={points}
                  series={subjects.filter((x) => chosen.includes(x.id)).map((x) => ({ key: x.id, name: x.name, values: x.means }))}
                />
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {subjects.map((x) => {
                    const idx = chosen.indexOf(x.id);
                    const on = idx >= 0;
                    return (
                      <TouchableOpacity
                        key={x.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={`${x.name}${on ? ", shown" : ""}`}
                        onPress={() => toggleSubject(x.id)}
                        style={{ ...HIT, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, paddingHorizontal: 12, borderWidth: 1, borderColor: on ? SERIES_COLORS[idx] : t.appSurface.line, backgroundColor: t.appSurface.card }}
                      >
                        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: on ? SERIES_COLORS[idx] : t.appSurface.line }} />
                        <Text style={{ fontSize: 12.5, fontWeight: "600", color: on ? t.appSurface.ink : t.appSurface.inkMuted }}>{x.name}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            {exam && comparison.length > 0 && (
              <BarList
                title={`Subjects compared · ${exam.name}`}
                summary={comparison.length > 1 ? `${comparison[0]!.name} is strongest; ${comparison[comparison.length - 1]!.name} is weakest.` : null}
                bars={comparison.map((x) => ({ key: x.id, label: x.name, value: x.mean, detail: `${x.learners} marks` }))}
              />
            )}

            {scheme && distributions.length > 0 && (
              <DistributionBars
                title="Grade distribution by exam"
                summary={`Every published mark, grouped by ${scheme === "kcse" ? "KCSE letter" : "CBC level"}.`}
                bands={GRADE_BANDS[scheme]}
                rows={distributions}
                noun="marks"
              />
            )}

            {exam && (prevExam ? (
              <>
                <Movers title={`Most improved since ${prevExam.name}`} rows={moved.improved} empty="Nobody's mean rose between these two exams." />
                <Movers title={`Biggest drops since ${prevExam.name}`} rows={moved.dropped} empty="Nobody's mean fell between these two exams." />
              </>
            ) : (
              <Text style={s.small}>Most improved and biggest drops need two published exams for {cls?.name ?? "this class"}.</Text>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <View style={[s.card, { flex: 1, padding: 12 }]}>
      <Text style={[s.eyebrow, { fontSize: 8.5 }]}>{label}</Text>
      <Text style={{ fontSize: 22, fontWeight: "600", marginTop: 4, color: tone ?? t.appSurface.ink }}>{value}</Text>
      <Text numberOfLines={2} style={[s.faint, { marginTop: 2 }]}>{sub}</Text>
    </View>
  );
}

function Movers({ title, rows, empty }: { title: string; rows: Mover[]; empty: string }) {
  return (
    <View style={s.card}>
      <Text style={s.h2}>{title}</Text>
      {rows.length === 0 ? (
        <Text style={[s.small, { marginTop: 6 }]}>{empty}</Text>
      ) : rows.map((m, i) => (
        <View key={m.studentId} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: t.appSurface.lineSoft, marginTop: i === 0 ? 6 : 0 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13.5, color: t.appSurface.ink }}>{m.name}</Text>
          <Text style={[s.mono, { color: t.appSurface.inkFaint }]}>{fmt(m.from)} → {fmt(m.to)}</Text>
          <Text style={[s.mono, { width: 52, textAlign: "right", fontWeight: "700", color: m.change >= 0 ? VIZ.up : VIZ.down }]}>
            {m.change >= 0 ? "+" : "−"}{fmt(Math.abs(m.change))}
          </Text>
        </View>
      ))}
    </View>
  );
}
