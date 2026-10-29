import { useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { setMyPassword, supabase } from "@figbloom/shared";
import { HIT, s, t } from "../theme";

/**
 * The password the school handed over is only for getting in the first
 * time: until the person chooses their own, this is the only screen.
 * Every account created on someone's behalf starts with
 * must_change_password set (supabase/functions/_shared/tempPassword.ts).
 */
export function ChoosePassword({ profileId, fullName, loginId, onDone }: {
  profileId: string;
  fullName: string;
  loginId: string | null;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    if (password.length < 8) { setError("At least 8 characters."); return; }
    if (password !== confirm) { setError("The passwords don't match."); return; }
    setBusy(true);
    try {
      await setMyPassword(profileId, password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[s.screen, { justifyContent: "center", padding: 24 }]}>
      <Text style={{ fontSize: 22, fontWeight: "700", textAlign: "center" }}>Welcome, {fullName.split(" ")[0]}</Text>
      <Text style={[s.small, { textAlign: "center", marginTop: 4, marginBottom: 24 }]}>
        The password you were given is only for signing in the first time. Choose one only you know
        {loginId ? ` — you'll use it with ${loginId} from now on.` : "."}
      </Text>

      <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>New password</Text>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <TextInput
          secureTextEntry={!showPassword}
          autoComplete="new-password"
          value={password}
          onChangeText={setPassword}
          style={[fieldStyle(false), { flex: 1 }]}
        />
        <TouchableOpacity accessibilityRole="button" onPress={() => setShowPassword((v) => !v)} style={{ ...HIT, marginLeft: 8, justifyContent: "center" }}>
          <Text style={{ fontSize: 12.5, fontWeight: "600", color: t.appSurface.inkMuted }}>{showPassword ? "Hide" : "Show"}</Text>
        </TouchableOpacity>
      </View>
      <Text style={[s.faint, { marginTop: 6 }]}>At least 8 characters.</Text>

      <Text style={[s.small, { fontWeight: "600", marginTop: 14, marginBottom: 6 }]}>Type it again</Text>
      <TextInput
        secureTextEntry={!showPassword}
        autoComplete="new-password"
        value={confirm}
        onChangeText={setConfirm}
        style={fieldStyle(!!error)}
      />

      {!!error && <Text style={{ fontSize: 11.5, color: t.status.warnInk, marginTop: 8 }}>{error}</Text>}

      <TouchableOpacity
        accessibilityRole="button"
        disabled={busy || !password || !confirm}
        onPress={submit}
        style={[s.primary, { backgroundColor: t.brand.orange, marginTop: 20, opacity: busy || !password || !confirm ? 0.6 : 1 }]}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryLabel}>Save and continue</Text>}
      </TouchableOpacity>

      <TouchableOpacity accessibilityRole="button" onPress={() => void supabase().auth.signOut({ scope: "local" })} style={{ ...HIT, alignSelf: "center", justifyContent: "center", marginTop: 12 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: t.appSurface.inkMuted }}>Not you? Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

const fieldStyle = (hasError: boolean) => ({
  ...HIT,
  borderWidth: 1,
  borderColor: hasError ? t.status.warnInk : t.appSurface.line,
  borderRadius: 12,
  paddingHorizontal: 14,
  fontSize: 15,
});
