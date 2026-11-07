import { useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import {
  decideLeaveRequest, fetchAllLeaveRequests, formatShortDate, LEAVE_STATUS_LABEL, LEAVE_STATUS_TONE, splitLeaveRequests,
  type LeaveRequestRow, type LeaveTone,
} from "@figbloom/shared";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { useLoad } from "../../lib/useLoad";
import type { StaffSession } from "../../lib/staffSession";
import { accentFor, fontSize } from "../../theme";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { useTheme } from "../../ui/ThemeContext";

/** What the last decision did, said at the top until the next one. */
type Outcome = { kind: "done" | "failed"; text: string };

const dates = (r: Pick<LeaveRequestRow, "starts_on" | "ends_on">) => `${formatShortDate(r.starts_on)} – ${formatShortDate(r.ends_on)}`;

/**
 * Every leave request in the school, those awaiting review first: approve or reject a teacher's time off, with a note.
 * The teacher is told in the app either way, so each decision asks first. Schools whose leave runs in Figbloom HR keep
 * their requests there ("Leave to approve" is a separate screen); what HR decided shows here, marked, in the past requests.
 */
export function AdminLeave({ session }: { session: StaffSession }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  const { data, error, loading, refreshing, refresh, retry } = useLoad(() => fetchAllLeaveRequests(session.tenantId), session.tenantId);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const { pending, decided } = splitLeaveRequests(data ?? []);

  const tone: Record<LeaveTone, { bg: string; ink: string }> = {
    ok: { bg: t.status.okBg, ink: t.status.okInk },
    warn: { bg: t.brand.orangeSoft, ink: t.brand.orangeInk },
    muted: { bg: t.status.mutedBg, ink: t.status.mutedInk },
  };

  async function decide(r: LeaveRequestRow, status: "approved" | "rejected") {
    setBusyId(r.id);
    setOutcome(null);
    try {
      const { notifyError } = await decideLeaveRequest({ tenantId: session.tenantId, reviewerId: session.profileId, request: r, status, note: notes[r.id] ?? "" });
      setNotes((n) => { const next = { ...n }; delete next[r.id]; return next; });
      setOutcome(notifyError
        ? { kind: "failed", text: `Recorded, but ${r.teacherName} could not be notified: ${notifyError}` }
        : { kind: "done", text: `${status === "approved" ? "Approved" : "Rejected"}. ${r.teacherName} has been told.` });
      void refresh();
    } catch (err) {
      setOutcome({ kind: "failed", text: `Could not update: ${err instanceof Error ? err.message : "try again."}` });
    } finally {
      setBusyId(null);
    }
  }

  function confirm(r: LeaveRequestRow, status: "approved" | "rejected") {
    const verb = status === "approved" ? "Approve" : "Reject";
    Alert.alert(`${verb} ${r.teacherName}'s leave?`, `${dates(r)}. ${r.teacherName} is told in the app straight away.`, [
      { text: "Cancel", style: "cancel" },
      { text: verb, onPress: () => void decide(r, status) },
    ]);
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="Leave requests" sub="Approve or reject a teacher's time off" color={a.deep} back />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        {outcome && (
          <View
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={{
              borderWidth: 1, borderRadius: t.radius.lg, padding: 12, marginBottom: 14,
              borderColor: outcome.kind === "done" ? t.status.okDot : t.status.badLine,
              backgroundColor: outcome.kind === "done" ? t.status.okBg : t.status.badBg,
            }}
          >
            <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: outcome.kind === "done" ? t.status.okInk : t.status.badInk }}>{outcome.text}</Text>
          </View>
        )}

        {error ? (
          <ErrorState title="Couldn't load leave requests" body={error} onRetry={retry} />
        ) : loading || !data ? (
          <View style={{ gap: 8 }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={[s.card, { padding: 14, gap: 8 }]}>
                <Skeleton width="50%" height={14} />
                <Skeleton width="35%" height={11} />
              </View>
            ))}
          </View>
        ) : (
          <>
            <Text style={s.h2}>Awaiting review · {pending.length}</Text>
            {pending.length === 0 ? (
              <EmptyState title="Nothing awaiting review" body="Leave requests from teachers will show up here." />
            ) : (
              <View style={{ marginTop: 8, gap: 10 }}>
                {pending.map((r) => (
                  <View key={r.id} style={[s.card, { padding: 14 }]}>
                    <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{r.teacherName}</Text>
                    <Text style={[s.small, { marginTop: 2 }]}>{dates(r)}</Text>
                    {!!r.reason && <Text style={[s.faint, { marginTop: 2 }]}>{r.reason}</Text>}
                    <Field
                      label="Note (optional)"
                      placeholder="e.g. Cover arranged with Dan"
                      value={notes[r.id] ?? ""}
                      onChangeText={(text) => setNotes((n) => ({ ...n, [r.id]: text }))}
                      accessibilityLabel={`Note for ${r.teacherName}'s request`}
                      style={{ marginTop: 10 }}
                    />
                    <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
                      <Button variant="secondary" label="Reject" disabled={busyId !== null} onPress={() => confirm(r, "rejected")} style={{ flex: 1 }} />
                      <Button label="Approve" loading={busyId === r.id} disabled={busyId !== null} onPress={() => confirm(r, "approved")} style={{ flex: 1 }} />
                    </View>
                  </View>
                ))}
              </View>
            )}

            <Text style={[s.h2, { marginTop: 22 }]}>Past requests</Text>
            {decided.length === 0 ? (
              <View style={[s.card, { marginTop: 8 }]}><Text style={s.small}>Reviewed and withdrawn requests will show up here.</Text></View>
            ) : (
              <View style={{ marginTop: 8, gap: 8 }}>
                {decided.map((r) => (
                  <View key={r.id} style={[s.card, { padding: 14 }]}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: fontSize.body, fontWeight: "500", color: t.appSurface.ink }}>{r.teacherName}</Text>
                      <View style={[s.pill, { backgroundColor: tone[LEAVE_STATUS_TONE[r.status]].bg }]}>
                        <Text style={[s.pillLabel, { color: tone[LEAVE_STATUS_TONE[r.status]].ink }]}>
                          {LEAVE_STATUS_LABEL[r.status]}{r.source === "hr" ? " · Figbloom HR" : ""}
                        </Text>
                      </View>
                    </View>
                    <Text style={[s.small, { marginTop: 2 }]}>{dates(r)}</Text>
                    {!!r.review_note && <Text style={[s.faint, { marginTop: 2 }]}>{r.review_note}</Text>}
                  </View>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
