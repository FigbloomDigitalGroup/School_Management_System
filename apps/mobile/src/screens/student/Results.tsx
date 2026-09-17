import { ScrollView, Text, View } from "react-native";
import { againstMean, GRADE_INK, gradeFor, gradingSchemeFor } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useStudentData } from "../../studentData";

/** A mark with its context. No class position — the same product decision the parent app makes. */
export function StudentResults() {
  const { data, accent, country } = useStudentData();
  const a = accentFor(accent);
  const scheme = gradingSchemeFor(country, data.classLevel ?? "secondary");
  const subjects = data.subjects;
  const meanMark = subjects.length ? Math.round(subjects.reduce((sum, sub) => sum + sub.score, 0) / subjects.length) : null;

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Results</Text>
        <Text style={s.headerSub}>{data.examName ?? "No exam published yet"}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {subjects.length === 0 || meanMark === null ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={s.small}>Your results will appear here as soon as the school publishes them.</Text>
          </View>
        ) : (
          <>
            <View style={[s.card, { backgroundColor: a.deep, borderColor: a.deep }]}>
              <Text style={[s.eyebrow, { color: "rgba(255,255,255,0.7)" }]}>MEAN GRADE</Text>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 12, marginTop: 6 }}>
                <Text style={{ fontSize: 38, fontWeight: "700", color: "#fff" }}>{gradeFor(meanMark, scheme)}</Text>
                <Text style={[s.mono, { color: "rgba(255,255,255,0.8)", fontSize: 14 }]}>{meanMark} marks</Text>
              </View>
              <Text style={{ fontSize: 12.5, lineHeight: 19, color: "rgba(255,255,255,0.85)", marginTop: 8 }}>
                Class position is not shown here. Ask your class teacher if you want it.
              </Text>
            </View>

            {subjects.map((sub) => (
              <View key={sub.name} style={[s.card, { marginTop: 8, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "500" }}>{sub.name}</Text>
                  <View style={{ height: 6, borderRadius: 3, backgroundColor: t.appSurface.lineSoft, marginTop: 8, overflow: "hidden" }}>
                    <View style={{ height: 6, borderRadius: 3, width: `${sub.score}%`, backgroundColor: sub.score >= 80 ? "#1B4D2E" : sub.score >= 65 ? "#2E7D4F" : "#F9A05C" }} />
                  </View>
                  <Text style={[s.faint, { marginTop: 6 }]}>
                    {sub.classMean !== null ? againstMean(sub.score, sub.classMean) : "Class mean not available"}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[s.mono, { fontSize: 18 }]}>{sub.score}</Text>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: GRADE_INK[gradeFor(sub.score, scheme)] }}>
                    {gradeFor(sub.score, scheme)}
                  </Text>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}
