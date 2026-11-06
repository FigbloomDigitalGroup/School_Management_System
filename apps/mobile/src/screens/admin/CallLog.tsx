import { useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { callDuration, callOutcome, fetchSchoolCallLog, filterCallsByName, type Call, type CallTone } from "@figbloom/shared";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { useLoad } from "../../lib/useLoad";
import type { StaffSession } from "../../lib/staffSession";
import { accentFor, fontSize } from "../../theme";
import { Field } from "../../ui/Field";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { useTheme } from "../../ui/ThemeContext";

/**
 * The school's call log, newest first: who called whom, when, voice or video, for how long, and how it ended.
 * Never anything that was said.
 */
export function CallLog({ session }: { session: StaffSession }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  const { data, error, loading, refreshing, refresh, retry } = useLoad(() => fetchSchoolCallLog(session.tenantId), session.tenantId);
  const [nameFilter, setNameFilter] = useState("");
  const shown = data ? filterCallsByName(data, nameFilter) : [];

  const tone: Record<CallTone, { bg: string; ink: string }> = {
    ok: { bg: t.status.okBg, ink: t.status.okInk },
    info: { bg: t.status.infoBg, ink: t.status.infoInk },
    warn: { bg: t.status.warnBg, ink: t.status.warnInk },
    muted: { bg: t.status.mutedBg, ink: t.status.mutedInk },
  };

  function row(c: Call) {
    const outcome = callOutcome(c);
    const length = callDuration(c);
    const when = new Date(c.created_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    return (
      <View
        accessible
        accessibilityLabel={`${c.caller_name} called ${c.callee_name}, ${c.video ? "video" : "voice"}, ${outcome.label}${length ? `, ${length}` : ""}, ${when}`}
        style={[s.card, { marginBottom: 8, padding: 14 }]}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: fontSize.body, fontWeight: "500", color: t.appSurface.ink }}>{c.caller_name} to {c.callee_name}</Text>
          <View style={[s.pill, { backgroundColor: tone[outcome.tone].bg }]}>
            <Text style={[s.pillLabel, { color: tone[outcome.tone].ink }]}>{outcome.label}</Text>
          </View>
        </View>
        <Text style={[s.faint, { marginTop: 2 }]}>{when} · {c.video ? "Video" : "Voice"}{length ? ` · ${length}` : ""}</Text>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="Call log" sub="Who called whom, and for how long" color={a.deep} back />
      {error ? (
        <ErrorState title="Couldn't load the school's calls" body={error} onRetry={retry} />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(c) => c.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          ListHeaderComponent={
            <Field
              label="Filter by name"
              placeholder="The caller or the person called"
              value={nameFilter}
              onChangeText={setNameFilter}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ marginBottom: 12 }}
            />
          }
          ListEmptyComponent={
            loading || !data ? (
              <View style={{ gap: 8 }}>
                {[0, 1, 2, 3].map((i) => (
                  <View key={i} style={[s.card, { padding: 14, gap: 8 }]}>
                    <Skeleton width="65%" height={14} />
                    <Skeleton width="45%" height={11} />
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState title="No calls" body={nameFilter.trim() ? "No calls match this name." : "No one at the school has made a call yet."} />
            )
          }
          renderItem={({ item }) => row(item)}
        />
      )}
    </View>
  );
}
