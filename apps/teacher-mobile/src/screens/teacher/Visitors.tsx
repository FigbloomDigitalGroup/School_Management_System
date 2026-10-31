import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from "react-native";
import { visitHostLabel, visitQueue, VISIT_STATUS_LABEL, type Visit, type VisitStatus } from "@figbloom/shared";
import { accentFor, perScheme } from "../../theme";
import { ScreenHeader } from "../../components/ScreenHeader";
import { useDayVisits } from "../../lib/useDayVisits";
import type { TeacherSession } from "../../navigation";
import { useTheme } from "../../ui/ThemeContext";

const TONE = perScheme((t): Record<VisitStatus, { bg: string; ink: string }> => ({
  expected: { bg: t.status.infoBg, ink: t.status.infoInk },
  at_reception: { bg: t.status.warnBg, ink: t.status.warnInk },
  with_host: { bg: t.status.okBg, ink: t.status.okInk },
  left: { bg: t.status.mutedBg, ink: t.status.mutedInk },
}));

const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");

/**
 * Anyone who asks for this teacher at the gate or reception today, live: the
 * same list as the web's "Your visitors". Reception brings them along; this
 * only tells the teacher. Contact details stay with the desk. A new arrival
 * also pops up over whatever screen is open (VisitAlerts).
 */
export function TeacherVisitors({ session }: { session: TeacherSession }) {
  const { t, s, accentInk } = useTheme();
  const a = accentFor(session.accent);
  const { visits, error, reload } = useDayVisits(session.tenantId);
  const here = visits ? visitQueue(visits) : [];
  const gone = (visits ?? []).filter((v) => v.status === "left");

  return (
    <View style={s.screen}>
      <ScreenHeader title="Your visitors" sub="Gate & reception, today" color={a.deep} back />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={accentInk(a.deep)} />}
      >
        {error && !visits ? (
          <View style={s.card}><Text style={[s.small, { color: t.status.warnInk }]}>Could not load your visitors: {error}</Text></View>
        ) : !visits ? (
          <ActivityIndicator color={accentInk(a.deep)} style={{ marginTop: 32 }} />
        ) : visits.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={{ color: t.appSurface.ink, fontSize: 15, fontWeight: "600" }}>No visitors for you today</Text>
            <Text style={[s.small, { marginTop: 6, textAlign: "center" }]}>When someone asks for you at the gate, they appear here and you're told straight away.</Text>
          </View>
        ) : (
          <>
            {here.length > 0 && <Text style={s.eyebrow}>HERE NOW · {here.length}</Text>}
            {here.map((v) => <VisitCard key={v.id} visit={v} />)}
            {gone.length > 0 && <Text style={[s.eyebrow, { marginTop: here.length ? 8 : 0 }]}>EARLIER TODAY · {gone.length}</Text>}
            {gone.map((v) => <VisitCard key={v.id} visit={v} />)}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function VisitCard({ visit: v }: { visit: Visit }) {
  const { t, s, scheme } = useTheme();
  const tone = TONE[scheme][v.status];
  return (
    <View style={[s.card, { padding: 14, opacity: v.status === "left" ? 0.7 : 1 }]}>
      <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start", gap: 8 }]}>
        <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: t.appSurface.ink }}>{v.visitor_name}</Text>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <View style={[s.pill, { backgroundColor: tone.bg }]}>
            <Text style={[s.pillLabel, { color: tone.ink }]}>{VISIT_STATUS_LABEL[v.status]}</Text>
          </View>
          {v.escalated && (
            <View style={[s.pill, { backgroundColor: t.status.warnBg }]}>
              <Text style={[s.pillLabel, { color: t.status.warnInk }]}>Principal's office</Text>
            </View>
          )}
        </View>
      </View>
      <Text style={[s.small, { marginTop: 4, color: t.appSurface.ink }]}>Here to see {visitHostLabel(v)}</Text>
      {!!v.purpose && <Text style={[s.small, { marginTop: 2 }]}>{v.purpose}</Text>}
      <Text style={[s.mono, { marginTop: 8, color: t.appSurface.inkFaint }]}>In {clock(v.arrived_at)} · out {clock(v.left_at)}</Text>
    </View>
  );
}
