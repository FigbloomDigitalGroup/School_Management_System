import { useState } from "react";
import { Linking, RefreshControl, ScrollView, Text, View } from "react-native";
import { RELATIONSHIP_WORD, fetchLearnerGuardians, fetchStudentHealth, guardianCalls } from "@figbloom/shared";
import { HealthAlerts } from "../../components/HealthAlerts";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import type { StaffSession } from "../../lib/staffSession";
import { useLoad } from "../../lib/useLoad";
import { accentFor, fontSize } from "../../theme";
import { Button } from "../../ui/Button";
import { useTheme } from "../../ui/ThemeContext";
import type { OpenLearner } from "./People";

/**
 * One learner, for the office on the move: what to know before giving them anything (allergies, conditions, what they
 * take), and the people to call about them, each number a tap away on the phone's dialer. The two are read apart, so a
 * person the database lets read only one of them still sees it.
 */
export function LearnerCard({ session, learner }: { session: StaffSession; learner: OpenLearner }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  // wrapped: a learner with no record answers null, which useLoad would read as "no answer yet"
  const health = useLoad(() => fetchStudentHealth(learner.id).then((record) => ({ record })), `health:${learner.id}`);
  const guardians = useLoad(() => fetchLearnerGuardians(learner.id), `guardians:${learner.id}`);
  const [problem, setProblem] = useState<string | null>(null);

  async function call(url: string, who: string) {
    setProblem(null);
    try {
      await Linking.openURL(url);
    } catch {
      setProblem(`Could not start the call to ${who}.`);
    }
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title={learner.name} sub={learner.line || "Learner"} color={a.deep} back />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 12 }}
        refreshControl={<RefreshControl refreshing={health.refreshing || guardians.refreshing} onRefresh={() => void Promise.all([health.refresh(), guardians.refresh()])} />}
      >
        {!!problem && <Text accessibilityRole="alert" style={{ fontSize: fontSize.small, color: t.status.badInk }}>{problem}</Text>}

        <Text style={s.h2}>Allergies and conditions</Text>
        {health.error && !health.loading ? (
          <View style={s.card}>
            <Text style={s.small}>Couldn't read their health record: {health.error}</Text>
            <Button variant="secondary" label="Try again" onPress={health.retry} style={{ marginTop: 10, alignSelf: "flex-start" }} />
          </View>
        ) : health.loading ? (
          <View style={[s.card, { gap: 8 }]}><Skeleton width="60%" height={14} /><Skeleton width="40%" height={12} /></View>
        ) : (
          <HealthAlerts health={health.data?.record ?? null} />
        )}

        <Text style={[s.h2, { marginTop: 6 }]}>People to call</Text>
        {guardians.error && !guardians.loading ? (
          <View style={s.card}>
            <Text style={s.small}>Couldn't read their guardians: {guardians.error}</Text>
            <Button variant="secondary" label="Try again" onPress={guardians.retry} style={{ marginTop: 10, alignSelf: "flex-start" }} />
          </View>
        ) : guardians.loading ? (
          <View style={[s.card, { gap: 8 }]}><Skeleton width="50%" height={14} /><Skeleton width="35%" height={12} /></View>
        ) : (guardians.data ?? []).length === 0 ? (
          <View style={s.card}><Text style={s.small}>No guardian is on file for {learner.name}.</Text></View>
        ) : (
          (guardians.data ?? []).map((g) => {
            const calls = guardianCalls(g, session.country);
            return (
              <View key={g.profile_id} accessibilityLabel={`${g.full_name}, ${RELATIONSHIP_WORD[g.relationship]}`} style={[s.card, { gap: 8 }]}>
                <View>
                  <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{g.full_name}</Text>
                  <Text style={s.faint}>{RELATIONSHIP_WORD[g.relationship]}</Text>
                </View>
                {calls.length === 0 ? (
                  <Text style={s.small}>No phone number on file.</Text>
                ) : (
                  calls.map((c) => (
                    <Button
                      key={c.which}
                      label={`Call ${c.number}`}
                      variant={c.which === "phone" ? "primary" : "secondary"}
                      accessibilityHint={`Calls ${g.full_name}${c.which === "alt" ? " on their other number" : ""} on the phone's dialer`}
                      onPress={() => void call(c.url, g.full_name)}
                    />
                  ))
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
