import { ScrollView, Text, View } from "react-native";
import { againstMean, GRADE_INK, gradeFor, gradingSchemeFor } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild, useSubjects } from "../../data";

const CLASS_MEAN = 62;

/** A mark with its context. No class position — that is a decision, see the web note. */
export function ParentResults() {
  const { child, index, accent, country } = useChild();
  const subjects = useSubjects();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  const scheme = gradingSchemeFor(country, child.classLevel);

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <Text style={s.headerTitle}>Results</Text>
        <Text style={s.headerSub}>{child.name} · Mock 1</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={[s.card, { backgroundColor: tint, borderColor: tint }]}>
          <Text style={[s.eyebrow, { color: "rgba(255,255,255,0.7)" }]}>MEAN GRADE</Text>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 12, marginTop: 6 }}>
            <Text style={{ fontSize: 38, fontWeight: "700", color: "#fff" }}>{gradeFor(child.mean, scheme)}</Text>
            <Text style={[s.mono, { color: "rgba(255,255,255,0.8)", fontSize: 14 }]}>{child.mean} marks</Text>
          </View>
          <Text style={{ fontSize: 12.5, lineHeight: 19, color: "rgba(255,255,255,0.85)", marginTop: 8 }}>
            {child.first} is above the class mean of {CLASS_MEAN}. Biology and Chemistry are strongest; History is the
            one to watch.
          </Text>
        </View>

        {subjects.map(([name, mark]) => (
          <View key={name} style={[s.card, { marginTop: 8, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: "500" }}>{name}</Text>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: t.appSurface.lineSoft, marginTop: 8, overflow: "hidden" }}>
                <View style={{ height: 6, borderRadius: 3, width: `${mark}%`, backgroundColor: mark >= 80 ? "#1B4D2E" : mark >= 65 ? "#2E7D4F" : "#F9A05C" }} />
              </View>
              <Text style={[s.faint, { marginTop: 6 }]}>{againstMean(mark, CLASS_MEAN)}</Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={[s.mono, { fontSize: 18 }]}>{mark}</Text>
              <Text style={{ fontSize: 12, fontWeight: "700", color: GRADE_INK[gradeFor(mark, scheme)] }}>
                {gradeFor(mark, scheme)}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
