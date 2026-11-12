import { RefreshControl, ScrollView, Text, View } from "react-native";
import { awayFromRegister, fetchClassRegister, MARK_LABEL, registerDayLabel } from "@figbloom/shared";
import { MARK_TONE } from "../../components/markTone";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { useLoad } from "../../lib/useLoad";
import type { StaffSession } from "../../lib/staffSession";
import { accentFor, fontSize } from "../../theme";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { useTheme } from "../../ui/ThemeContext";
import type { OpenRegister } from "./Overview";

/**
 * Who was not in class on a day, and why: late arrivals, absences and excusals. Learners marked present are left
 * off, because a principal's next question after seeing a class that is not fully present is always "who,
 * exactly". Read only; opened from a class's row on the admin Home.
 */
export function ClassRegister({ session, route }: { session: StaffSession; route: { params?: OpenRegister } }) {
  const { t, s, scheme } = useTheme();
  const a = accentFor(session.accent);
  const params = route.params;
  const { data, error, loading, refreshing, refresh, retry } = useLoad(
    params ? () => fetchClassRegister(params.classId, params.date) : null,
    params ? `${params.classId}:${params.date}` : "none",
  );

  if (!params) {
    return (
      <View style={s.screen}>
        <ScreenHeader title="Register" color={a.deep} back />
        <ErrorState title="No class chosen" body="Go back and pick a class from the list." />
      </View>
    );
  }

  const away = data ? awayFromRegister(data) : [];
  return (
    <View style={s.screen}>
      <ScreenHeader title={params.className} sub={`Who wasn't here · ${registerDayLabel(params.date)}`} color={a.deep} back />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        {error ? (
          <ErrorState title="Couldn't load this register" body={error} onRetry={retry} />
        ) : loading || !data ? (
          [0, 1, 2].map((i) => (
            <View key={i} style={[s.card, { padding: 14, gap: 8 }]}>
              <Skeleton width="55%" height={14} />
              <Skeleton width="30%" height={11} />
            </View>
          ))
        ) : away.length === 0 ? (
          <EmptyState title="Everyone was here" body={`Everyone in ${params.className} was present and on time.`} />
        ) : (
          <>
            <Text style={s.faint}>Learners marked present are left off this list: only late arrivals, absences and excusals show here.</Text>
            {away.map((r) => (
              <View
                key={r.id}
                accessible
                accessibilityLabel={`${r.name}, admission ${r.admissionNo}, ${MARK_LABEL[r.mark]}`}
                style={[s.card, { padding: 12, flexDirection: "row", alignItems: "center", gap: 12 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ fontSize: fontSize.body, fontWeight: "500", color: t.appSurface.ink }}>{r.name}</Text>
                  <Text style={[s.mono, { color: t.appSurface.inkFaint, marginTop: 2 }]}>ADM {r.admissionNo}</Text>
                </View>
                <View style={[s.pill, { backgroundColor: MARK_TONE[scheme][r.mark].bg }]}>
                  <Text style={[s.pillLabel, { color: MARK_TONE[scheme][r.mark].ink }]}>{MARK_LABEL[r.mark]}</Text>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}
