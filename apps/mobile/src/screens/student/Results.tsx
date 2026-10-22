import { ScrollView, Text, View } from "react-native";
import { againstMean, GRADE_INK, gradeFor, gradingSchemeFor } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useStudentData } from "../../studentData";
import { Skeleton } from "../../components/Skeleton";
import { CbeResults } from "../../components/CbeResults";
import { useCbeResults } from "../../lib/useCbeResults";

/** A mark with its context. No class position — the same product decision the parent app makes. */
export function StudentResults() {
  const { data, accent, country } = useStudentData();
  const a = accentFor(accent);
  const scheme = gradingSchemeFor(country, data.classLevel ?? "secondary");
  const subjects = data.subjects;
  const meanMark = subjects.length ? Math.round(subjects.reduce((sum, sub) => sum + sub.score, 0) / subjects.length) : null;
  // CBE strand results (published assessments), alongside any exam marks — same as web.
  const cbe = useCbeResults(data.studentId, country);
  const cbeResults = cbe.results ?? [];

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Results</Text>
        <Text style={s.headerSub}>{meanMark !== null && data.examName ? data.examName : data.className || "Results"}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {meanMark === null && cbe.results === null && !cbe.failed ? (
          <View style={[s.card, { gap: 8 }]}>
            <Skeleton width="30%" height={10} />
            <Skeleton width="45%" height={28} />
            <Skeleton width="80%" height={11} />
          </View>
        ) : meanMark === null ? (
          cbeResults.length > 0 ? <CbeResults results={cbeResults} heading="Your learning areas" /> : (
            <View style={[s.card, { alignItems: "center", padding: 24 }]}>
              <Text style={[s.h2, { marginBottom: 4 }]}>Not published yet</Text>
              <Text style={[s.small, { textAlign: "center" }]}>Your results will appear here as soon as the school publishes them.</Text>
            </View>
          )
        ) : (
          <>
            {cbeResults.length > 0 && <View style={{ marginBottom: 16 }}><CbeResults results={cbeResults} heading="Your learning areas" /></View>}
            <View style={[s.card, { backgroundColor: a.deep, borderColor: a.deep }]}>
              <Text style={[s.eyebrow, { color: "rgba(255,255,255,0.7)" }]}>MEAN GRADE{data.examName ? ` · ${data.examName.toUpperCase()}` : ""}</Text>
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
