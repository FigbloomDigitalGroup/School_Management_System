import { Text, View } from "react-native";
import { GRADE_INK, formatShortDate, type CbeLearningAreaResult } from "@figbloom/shared";
import { s, t } from "../theme";

/**
 * A learner's published CBE results: per learning area, the overall rubric
 * level, each strand's level and the teacher's comment — the mobile twin of
 * web's components/CbeResults.tsx. Levels carry their words as well as their
 * codes, because "ME2" means nothing to a parent on its own.
 */
export function CbeResults({ results, heading = "Learning areas" }: { results: CbeLearningAreaResult[]; heading?: string }) {
  if (!results.length) return null;
  return (
    <View>
      <Text style={[s.h2, { marginBottom: 8 }]}>{heading}</Text>
      {results.map((r) => (
        <View key={r.subjectId} style={[s.card, { marginBottom: 8, padding: 14 }]}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "600", color: t.appSurface.ink }}>{r.subjectName}</Text>
              <Text style={[s.faint, { marginTop: 2 }]}>{r.assessmentTitle} · {formatShortDate(r.assessedOn)}</Text>
            </View>
            {r.overall && (
              <View style={{ alignItems: "flex-end", maxWidth: 140 }}>
                <Text style={[s.mono, { fontSize: 20, fontWeight: "700", color: GRADE_INK[r.overall.code] }]}>{r.overall.code}</Text>
                <Text style={[s.faint, { marginTop: 4, textAlign: "right" }]}>{r.overall.label}</Text>
              </View>
            )}
          </View>
          <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: t.appSurface.lineSoft, gap: 6 }}>
            {r.strands.map((st) => (
              <View key={st.strandId} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <Text style={{ flex: 1, fontSize: 12.5, color: t.appSurface.ink }}>{st.name}</Text>
                <Text accessibilityLabel={st.label} style={[s.mono, { fontWeight: "600", color: GRADE_INK[st.code] }]}>{st.code}</Text>
              </View>
            ))}
          </View>
          {r.comment && (
            <Text style={[s.small, { marginTop: 12, backgroundColor: t.appSurface.page, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }]}>
              “{r.comment}”
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}
