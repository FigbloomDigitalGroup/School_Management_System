import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import {
  cancelLeaveRequest, fetchMyLeaveRequests, formatShortDate, requestLeave,
  type LeaveRequest, type LeaveStatus,
} from "@figbloom/shared";
import { accentFor, perScheme } from "../../theme";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { TeacherSession } from "../../navigation";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { useTheme } from "../../ui/ThemeContext";

const STATUS_LABEL: Record<LeaveStatus, string> = {
  pending: "Awaiting review", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled",
};
const STATUS_STYLE = perScheme((t): Record<LeaveStatus, { bg: string; ink: string }> => ({
  pending: { bg: t.brand.orangeSoft, ink: t.brand.orangeInk },
  approved: { bg: t.status.okBg, ink: t.status.okInk },
  rejected: { bg: t.appSurface.lineSoft, ink: t.appSurface.inkMuted },
  cancelled: { bg: t.appSurface.lineSoft, ink: t.appSurface.inkMuted },
}));

/** Request time off, see the school's decision. Dates are plain YYYY-MM-DD
 *  text fields — no native date picker yet, to avoid a second new native
 *  dependency alongside FIG-492's image picker in the same pass. */
export function TeacherLeave({ session }: { session: TeacherSession }) {
  const { t, s, accentInk, scheme } = useTheme();
  const a = accentFor(session.accent);
  const [requests, setRequests] = useState<LeaveRequest[] | null>(null);
  /** The list failed to load: not the same as "nothing requested", and it can be retried. */
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [dateError, setDateError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    fetchMyLeaveRequests(session.profileId)
      .then((r) => { if (alive) setRequests(r); })
      .catch(() => { if (alive) { setRequests([]); setFailed(true); } });
    return () => { alive = false; };
  }, [session.profileId, reloadKey]);

  async function submit() {
    if (!startsOn || !endsOn) { setStatus("Pick a start and end date."); return; }
    if (endsOn < startsOn) { setDateError("The end date is before the start date."); return; }
    setSaving(true);
    setStatus(null);
    try {
      await requestLeave({ tenantId: session.tenantId, teacherId: session.profileId, startsOn, endsOn, reason });
      setStartsOn("");
      setEndsOn("");
      setReason("");
      setReloadKey((k) => k + 1);
      setStatus("Leave requested — the principal will review it.");
    } catch (err) {
      setStatus(err instanceof Error ? `Could not request leave: ${err.message}` : "Could not request leave.");
    } finally {
      setSaving(false);
    }
  }

  async function withdraw(id: string) {
    try {
      await cancelLeaveRequest(id);
      setReloadKey((k) => k + 1);
    } catch {
      setStatus("Could not withdraw — check your connection and try again.");
    }
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="Leave" sub="Request time off" color={a.deep} back />

      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        <View style={[s.card, { gap: 10 }]}>
          <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
            <Field
              label="From"
              value={startsOn}
              onChangeText={(v) => { setStartsOn(v); setDateError(null); }}
              placeholder="YYYY-MM-DD"
              style={{ flex: 1 }}
            />
            <Field
              label="To"
              value={endsOn}
              onChangeText={(v) => { setEndsOn(v); setDateError(null); }}
              placeholder="YYYY-MM-DD"
              error={dateError ?? undefined}
              style={{ flex: 1 }}
            />
          </View>

          <Field
            label="Reason (optional)"
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. Family event out of town"
            multiline
          />

          <Button label="Request leave" loading={saving} disabled={!startsOn || !endsOn} onPress={() => void submit()} />
          {!!status && <Text accessibilityLiveRegion="polite" style={s.small}>{status}</Text>}
        </View>

        <Text style={[s.eyebrow, { marginTop: 20, marginBottom: 8 }]}>YOUR REQUESTS</Text>
        {requests === null ? (
          <ActivityIndicator color={accentInk(a.deep)} />
        ) : failed ? (
          <ErrorState title="Couldn't load your requests" onRetry={() => { setRequests(null); setReloadKey((k) => k + 1); }} />
        ) : requests.length === 0 ? (
          <EmptyState title="Nothing requested yet" body="Leave you ask for, and the school's decision on it, shows here." />
        ) : (
          requests.map((r) => {
            const style = STATUS_STYLE[scheme][r.status];
            return (
              <View key={r.id} style={[s.card, { marginBottom: 8, padding: 12 }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: "600" }}>
                      {formatShortDate(r.starts_on)} – {formatShortDate(r.ends_on)}
                    </Text>
                    {!!r.reason && <Text style={[s.faint, { marginTop: 2 }]}>{r.reason}</Text>}
                    {!!r.review_note && <Text style={[s.faint, { marginTop: 2, fontStyle: "italic" }]}>"{r.review_note}"</Text>}
                  </View>
                  <View style={[s.pill, { backgroundColor: style.bg }]}>
                    <Text style={[s.pillLabel, { color: style.ink }]}>{STATUS_LABEL[r.status]}</Text>
                  </View>
                </View>
                {r.status === "pending" && (
                  <Button variant="quiet" label="Withdraw" tint={t.status.warnInk} onPress={() => void withdraw(r.id)} style={{ alignSelf: "flex-start", marginTop: 4 }} />
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
