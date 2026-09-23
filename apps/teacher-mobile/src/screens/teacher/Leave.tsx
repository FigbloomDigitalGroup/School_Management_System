import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  cancelLeaveRequest, fetchMyLeaveRequests, formatShortDate, requestLeave,
  type LeaveRequest, type LeaveStatus,
} from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { TeacherSession } from "../../navigation";

const STATUS_LABEL: Record<LeaveStatus, string> = {
  pending: "Awaiting review", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled",
};
const STATUS_STYLE: Record<LeaveStatus, { bg: string; ink: string }> = {
  pending: { bg: t.brand.orangeSoft, ink: t.brand.orangeInk },
  approved: { bg: t.status.okBg, ink: t.status.okInk },
  rejected: { bg: t.appSurface.lineSoft, ink: t.appSurface.inkMuted },
  cancelled: { bg: t.appSurface.lineSoft, ink: t.appSurface.inkMuted },
};

/** Request time off, see the school's decision. Dates are plain YYYY-MM-DD
 *  text fields — no native date picker yet, to avoid a second new native
 *  dependency alongside FIG-492's image picker in the same pass. */
export function TeacherLeave({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  const [requests, setRequests] = useState<LeaveRequest[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMyLeaveRequests(session.profileId)
      .then((r) => { if (alive) setRequests(r); })
      .catch(() => { if (alive) setRequests([]); });
    return () => { alive = false; };
  }, [session.profileId, reloadKey]);

  async function submit() {
    if (!startsOn || !endsOn) { setStatus("Pick a start and end date."); return; }
    if (endsOn < startsOn) { setStatus("The end date is before the start date."); return; }
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
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>From</Text>
              <TextInput
                value={startsOn}
                onChangeText={setStartsOn}
                placeholder="YYYY-MM-DD"
                style={{ ...HIT, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, paddingHorizontal: 12, fontSize: 14, fontFamily: "monospace" }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>To</Text>
              <TextInput
                value={endsOn}
                onChangeText={setEndsOn}
                placeholder="YYYY-MM-DD"
                style={{ ...HIT, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, paddingHorizontal: 12, fontSize: 14, fontFamily: "monospace" }}
              />
            </View>
          </View>

          <View>
            <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Reason (optional)</Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="e.g. Family event out of town"
              multiline
              numberOfLines={3}
              style={{ borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, padding: 12, fontSize: 14, minHeight: 72, textAlignVertical: "top" }}
            />
          </View>

          <TouchableOpacity
            accessibilityRole="button"
            disabled={!startsOn || !endsOn || saving}
            onPress={() => void submit()}
            style={[s.primary, { ...HIT, backgroundColor: t.brand.orange, opacity: !startsOn || !endsOn || saving ? 0.6 : 1 }]}
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryLabel}>Request leave</Text>}
          </TouchableOpacity>
          {!!status && <Text style={s.small}>{status}</Text>}
        </View>

        <Text style={[s.eyebrow, { marginTop: 20, marginBottom: 8 }]}>YOUR REQUESTS</Text>
        {requests === null ? (
          <ActivityIndicator color={a.deep} />
        ) : requests.length === 0 ? (
          <Text style={s.faint}>Nothing requested yet.</Text>
        ) : (
          requests.map((r) => {
            const style = STATUS_STYLE[r.status];
            return (
              <View key={r.id} style={[s.card, { marginBottom: 8, padding: 12 }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13.5, fontWeight: "600" }}>
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
                  <TouchableOpacity accessibilityRole="button" onPress={() => void withdraw(r.id)} style={{ marginTop: 8 }}>
                    <Text style={{ fontSize: 12.5, fontWeight: "600", color: t.status.warnInk }}>Withdraw</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
