import { useState } from "react";
import { Alert, Switch, Text, View } from "react-native";
import { confirmFingerprint, fingerprintSupport, openFingerprintSettings } from "../lib/fingerprintUnlock";
import { s, t } from "../theme";
import { useFingerprintLock } from "./FingerprintLock";

/**
 * The "Unlock with fingerprint" switch, for an Account screen. The app cannot enrol a
 * fingerprint — that is the phone's own settings — so with none enrolled it sends the person there.
 * Turning it on or off both ask for the fingerprint, so a phone left open can't have the lock switched off.
 */
export function FingerprintSetting({ tint }: { tint: string }) {
  const { enabled, setEnabled } = useFingerprintLock();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function change(on: boolean) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const support = await fingerprintSupport();
      if (on && support === "unavailable") {
        setNote("This phone doesn't have a fingerprint sensor the app can use.");
        return;
      }
      if (on && support === "not_enrolled") {
        Alert.alert(
          "Set up a fingerprint first",
          "This phone has no fingerprint saved yet. Add one in the phone's settings, then come back and turn this on.",
          [{ text: "Not now", style: "cancel" }, { text: "Open settings", onPress: () => void openFingerprintSettings() }],
        );
        return;
      }
      // With the fingerprint gone from the phone there is nothing to ask for, and turning it off must still work.
      if (support === "ready" && !(await confirmFingerprint(on ? "Confirm your fingerprint to turn this on" : "Confirm your fingerprint to turn this off"))) return;
      await setEnabled(on);
    } catch {
      setNote("Could not change this just now. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Security</Text>
      <View style={s.card}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13.5, fontWeight: "500" }}>Unlock with fingerprint</Text>
            <Text style={s.faint}>Ask for your fingerprint when you open the app, and when you come back to it after a short break.</Text>
          </View>
          <Switch
            accessibilityLabel="Unlock with fingerprint"
            value={enabled}
            disabled={busy}
            onValueChange={(v) => void change(v)}
            trackColor={{ true: tint, false: "#DAD5D4" }}
            thumbColor="#fff"
          />
        </View>
        {!!note && <Text style={{ fontSize: 11.5, color: t.status.warnInk, marginTop: 8 }}>{note}</Text>}
      </View>
    </>
  );
}
