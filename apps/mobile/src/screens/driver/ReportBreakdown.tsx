import { useEffect, useState } from "react";
import { ActivityIndicator, Text, TextInput, View } from "react-native";
import { breakdownAffected, listTripRiders, reportBreakdown } from "@figbloom/shared";
import { s, t } from "../../theme";
import { Tap } from "../../ui/Tap";

/**
 * "The bus has broken down": the office gets an alert, and the families of
 * the children on board or still waiting get told (report_breakdown() on the
 * database decides who). Needs signal: with none, the screen says to call the
 * school office instead, as the web driver screen does.
 */
export function ReportBreakdown({ tripId, lat, lng }: { tripId: string; lat: number | null; lng: number | null }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [affected, setAffected] = useState<number | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // How many children's families this will reach, read when the panel opens; a failed read just leaves the count out.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    listTripRiders(tripId)
      .then((riders) => { if (alive) setAffected(breakdownAffected(riders).length); })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, tripId]);

  async function send() {
    setSending(true);
    setResult(null);
    try {
      const told = await reportBreakdown({ tripId, note: note.trim(), lat, lng });
      setResult({ ok: true, text: `The school has been told${told ? `, and the families of ${told === 1 ? "1 child" : `${told} children`}` : ""}.` });
      setOpen(false);
      setNote("");
    } catch (err) {
      const message = (err as { message?: string } | null)?.message;
      setResult({ ok: false, text: `${message ? `Could not report it: ${message}. ` : "Could not report the breakdown. "}If you have no signal, call the school office.` });
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <>
        {!!result && <Text style={{ marginTop: 12, fontSize: 12.5, lineHeight: 19, color: result.ok ? t.status.okInk : t.status.warnInk }}>{result.text}</Text>}
        <Tap
          accessibilityRole="button"
          onPress={() => { setResult(null); setOpen(true); }}
          style={{ minHeight: 48, marginTop: 16, borderRadius: 13, borderWidth: 1.5, borderColor: t.status.warnInk, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ fontSize: 15, fontWeight: "600", color: t.status.warnInk }}>Report a breakdown</Text>
        </Tap>
      </>
    );
  }

  return (
    <View style={{ marginTop: 16, borderRadius: 13, borderWidth: 1.5, borderColor: t.status.warnInk, padding: 14 }}>
      <Text style={{ fontSize: 15, fontWeight: "600" }}>The bus has broken down</Text>
      <Text style={[s.small, { marginTop: 4 }]}>
        The office is alerted
        {affected ? `, and the families of the ${affected === 1 ? "1 child" : `${affected} children`} on the bus or still waiting are told` : ""}.
        Families of children already dropped off are not.
      </Text>
      <Text style={{ marginTop: 10, fontSize: 12, fontWeight: "600", color: t.appSurface.inkMuted }}>What happened (optional)</Text>
      <TextInput
        value={note}
        onChangeText={setNote}
        maxLength={300}
        multiline
        editable={!sending}
        placeholder="Flat tyre near Imara Daima, waiting for help"
        placeholderTextColor={t.appSurface.inkFaint}
        accessibilityLabel="What happened"
        textAlignVertical="top"
        style={{ marginTop: 4, minHeight: 64, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: t.appSurface.ink }}
      />
      {!!result && !result.ok && <Text style={{ marginTop: 8, fontSize: 12.5, lineHeight: 19, color: t.status.warnInk }}>{result.text}</Text>}
      <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
        <Tap accessibilityRole="button" disabled={sending} onPress={() => setOpen(false)} style={{ flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: t.appSurface.line, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontWeight: "600", color: t.appSurface.inkMuted }}>Cancel</Text>
        </Tap>
        <Tap accessibilityRole="button" disabled={sending} onPress={() => void send()} style={{ flex: 1, minHeight: 48, borderRadius: 12, backgroundColor: t.status.warnInk, alignItems: "center", justifyContent: "center", opacity: sending ? 0.6 : 1 }}>
          {sending ? <ActivityIndicator color="#fff" /> : <Text style={{ fontWeight: "600", color: "#fff" }}>Tell the school</Text>}
        </Tap>
      </View>
    </View>
  );
}
