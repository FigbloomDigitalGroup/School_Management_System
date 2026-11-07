import { RefreshControl, ScrollView, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { VISIT_OUTCOME_LABEL, fetchSickBayBoard, visitClock, visitLearnerLine, visitWhen, type SickBayVisit } from "@figbloom/shared";
import { Section } from "../../components/AdminCards";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import type { StaffSession } from "../../lib/staffSession";
import { useLoad } from "../../lib/useLoad";
import { accentFor, fontSize } from "../../theme";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";
import type { OpenLearner } from "./People";

/**
 * The sick bay on the move, for the nurse and the principal: doses not given for over an hour (the alert), who is in
 * now, and today's visits. A learner opens their card (allergies and conditions first). Read only: logging a visit
 * and giving the medication round are on the web console. Pull down to read it again.
 */
export function SickBay({ session, onOpenLearner }: { session: StaffSession; onOpenLearner: (learner: OpenLearner) => void }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  const { data, error, loading, refreshing, refresh, retry } = useLoad(() => fetchSickBayBoard(session.tenantId), session.tenantId);

  const outcome = (v: SickBayVisit) => (v.outcome ? VISIT_OUTCOME_LABEL[v.outcome] : "Being seen");
  const open = (v: SickBayVisit) => onOpenLearner({ id: v.student_id, name: v.students?.full_name ?? "Learner", line: visitLearnerLine(v) });

  const visitRow = (v: SickBayVisit, when: string) => (
    <Tap
      key={v.id}
      accessibilityLabel={`${v.students?.full_name ?? "A learner"}, ${v.complaint}, ${outcome(v)}. Open their card`}
      onPress={() => open(v)}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}
    >
      <Text style={{ width: 52, fontSize: fontSize.small, fontWeight: "600", color: t.appSurface.inkMuted }}>{when}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{v.students?.full_name ?? "A learner"}</Text>
        <Text style={s.faint}>{[visitLearnerLine(v), `${v.complaint}${v.temperature_c != null ? ` · ${v.temperature_c}°C` : ""}`].filter(Boolean).join(" · ")}</Text>
        <Text style={[s.faint, { color: t.appSurface.inkMuted }]}>{outcome(v)}{v.time_out ? ` · out ${visitClock(v.time_out)}` : ""}</Text>
      </View>
      <ChevronRight size={18} color={t.appSurface.inkFaint} />
    </Tap>
  );

  return (
    <View style={s.screen}>
      <ScreenHeader title="Sick bay" sub="Who is in, and the medication round" color={a.deep} back />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        {error && !data ? (
          <ErrorState title="Couldn't load the sick bay" body={error} onRetry={retry} />
        ) : loading || !data ? (
          <View style={{ gap: 8 }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={[s.card, { padding: 14, gap: 8 }]}><Skeleton width="50%" height={14} /><Skeleton width="35%" height={11} /></View>
            ))}
          </View>
        ) : (
          <>
            {!!error && <Text style={[s.faint, { marginBottom: 8 }]}>Couldn't refresh: {error}</Text>}
            {data.overdue.length > 0 && (
              <View accessibilityRole="alert" style={{ borderWidth: 2, borderRadius: t.radius.lg, padding: 14, gap: 4, borderColor: t.status.warnInk, backgroundColor: t.status.warnBg }}>
                <Text style={{ fontSize: fontSize.body, fontWeight: "700", color: t.status.warnInk }}>
                  {data.overdue.length === 1 ? "1 dose" : `${data.overdue.length} doses`} not given for over an hour
                </Text>
                {data.overdue.slice(0, 20).map((d) => (
                  <Tap
                    key={`${d.schedule.id}-${d.time}`}
                    accessibilityLabel={`${d.time}, ${d.schedule.students?.full_name ?? "A learner"}, ${d.schedule.drug} ${d.schedule.dose}. Open their card`}
                    onPress={() => onOpenLearner({ id: d.schedule.student_id, name: d.schedule.students?.full_name ?? "Learner", line: visitLearnerLine(d.schedule) })}
                    style={{ paddingVertical: 4 }}
                  >
                    <Text style={{ fontSize: fontSize.small, color: t.status.warnInk }}>
                      {d.time} · {d.schedule.students?.full_name ?? "A learner"}: {d.schedule.drug} {d.schedule.dose}
                    </Text>
                  </Tap>
                ))}
              </View>
            )}

            <Section title={`In the sick bay now · ${data.open.length}`}>
              {data.open.length === 0 ? (
                <EmptyState title="Nobody in the sick bay" body="A learner who is logged in shows here until they leave." />
              ) : data.open.map((v) => visitRow(v, visitWhen(v.time_in)))}
            </Section>

            <Section title={`Today's visits · ${data.today.length}`}>
              {data.today.length === 0 ? (
                <EmptyState title="No visits yet today" body="Every visit logged today is listed here, with where the learner went." />
              ) : data.today.map((v) => visitRow(v, visitClock(v.time_in)))}
            </Section>

            <Text style={[s.faint, { marginTop: 16 }]}>Logging a visit, giving the medication round and approving families' requests are on the web console, with the same login.</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}
