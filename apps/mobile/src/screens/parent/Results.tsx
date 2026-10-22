import { ScrollView, Text, View } from "react-native";
import { againstMean, GRADE_INK, gradeFor, gradingSchemeFor } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild, useSubjects } from "../../data";
import { Skeleton } from "../../components/Skeleton";
import { CbeResults } from "../../components/CbeResults";
import { useCbeResults } from "../../lib/useCbeResults";

/** A mark with its context. No class position — that is a decision, see the web note. */
export function ParentResults() {
  const { child, index, accent, country } = useChild();
  const subjects = useSubjects();
  const cbe = useCbeResults(child.id, country);
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  const scheme = gradingSchemeFor(country, child.classLevel);
  const cbeResults = cbe.results ?? [];
  const sorted = [...subjects].sort((x, y) => y.score - x.score);
  const strongestWeakest = sorted.length > 0 ? { strongest: sorted[0]!.name, weakest: sorted[sorted.length - 1]!.name } : null;

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <Text style={s.headerTitle}>Results</Text>
        <Text style={s.headerSub}>{child.name}{child.mean !== null && child.examName ? ` · ${child.examName}` : ""}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {child.mean === null && cbe.results === null && !cbe.failed ? (
          <View style={[s.card, { gap: 8 }]}>
            <Skeleton width="30%" height={10} />
            <Skeleton width="45%" height={28} />
            <Skeleton width="80%" height={11} />
          </View>
        ) : child.mean === null && !cbeResults.length ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={[s.h2, { marginBottom: 4 }]}>Not published yet</Text>
            <Text style={[s.small, { textAlign: "center" }]}>
              {cbe.failed
                ? "Could not check for CBE results — check your connection and open this tab again."
                : `${child.first}'s results will appear here as soon as the school publishes them.`}
            </Text>
          </View>
        ) : (
          <>
            {cbeResults.length > 0 && <View style={{ marginBottom: child.mean !== null ? 16 : 0 }}><CbeResults results={cbeResults} /></View>}
            {child.mean !== null && (
              <>
                <View style={[s.card, { backgroundColor: tint, borderColor: tint }]}>
                  <Text style={[s.eyebrow, { color: "rgba(255,255,255,0.7)" }]}>
                    MEAN GRADE{child.examName ? ` · ${child.examName.toUpperCase()}` : ""}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 12, marginTop: 6 }}>
                    <Text style={{ fontSize: 38, fontWeight: "700", color: "#fff" }}>{gradeFor(child.mean, scheme)}</Text>
                    <Text style={[s.mono, { color: "rgba(255,255,255,0.8)", fontSize: 14 }]}>{child.mean} marks</Text>
                  </View>
                  {strongestWeakest && (
                    <Text style={{ fontSize: 12.5, lineHeight: 19, color: "rgba(255,255,255,0.85)", marginTop: 8 }}>
                      {strongestWeakest.strongest} is the strongest; {strongestWeakest.weakest} is the one to watch.
                    </Text>
                  )}
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
          </>
        )}
      </ScrollView>
    </View>
  );
}
