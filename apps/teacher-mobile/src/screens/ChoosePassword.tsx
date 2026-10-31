import { useRef, useState } from "react";
import { ScrollView, Text, TextInput } from "react-native";
import { setMyPassword, supabase } from "@figbloom/shared";
import { fontSize } from "../theme";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { useTheme } from "../ui/ThemeContext";

/** Which field an error belongs to, so it is shown under that field and not as a line of its own. */
type Problem = { on: "password" | "confirm" | "form"; text: string };

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
  const { t, s } = useTheme();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<TextInput>(null);

  async function submit() {
    setProblem(null);
    if (password.length < 8) { setProblem({ on: "password", text: "At least 8 characters." }); return; }
    if (password !== confirm) { setProblem({ on: "confirm", text: "The passwords don't match." }); return; }
    setBusy(true);
    try {
      await setMyPassword(profileId, password);
      onDone();
    } catch (err) {
      setProblem({ on: "form", text: err instanceof Error ? err.message : "Could not set the password." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ fontSize: fontSize.header, fontWeight: "700", textAlign: "center", color: t.appSurface.ink }}>Welcome, {fullName.split(" ")[0]}</Text>
      <Text style={[s.small, { textAlign: "center", marginTop: 4, marginBottom: 24 }]}>
        The password you were given is only for signing in the first time. Choose one only you know
        {loginId ? ` — you'll use it with ${loginId} from now on.` : "."}
      </Text>

      <Field
        label="New password"
        secret
        autoComplete="new-password"
        returnKeyType="next"
        submitBehavior="submit"
        value={password}
        onChangeText={(v) => { setPassword(v); if (problem?.on === "password") setProblem(null); }}
        onSubmitEditing={() => confirmRef.current?.focus()}
        hint="At least 8 characters."
        error={problem?.on === "password" ? problem.text : undefined}
      />

      <Field
        ref={confirmRef}
        label="Type it again"
        secret
        autoComplete="new-password"
        returnKeyType="go"
        value={confirm}
        onChangeText={(v) => { setConfirm(v); if (problem?.on === "confirm") setProblem(null); }}
        onSubmitEditing={() => { if (password && confirm && !busy) void submit(); }}
        error={problem?.on === "confirm" ? problem.text : undefined}
        style={{ marginTop: 14 }}
      />

      {problem?.on === "form" && (
        <Text accessibilityLiveRegion="polite" style={{ fontSize: fontSize.caption, color: t.status.warnInk, marginTop: 8 }}>{problem.text}</Text>
      )}

      <Button label="Save and continue" loading={busy} disabled={!password || !confirm} onPress={submit} style={{ marginTop: 20 }} />

      <Button variant="quiet" tint={t.appSurface.inkMuted} label="Not you? Sign out" onPress={() => void supabase().auth.signOut({ scope: "local" })} style={{ alignSelf: "center", marginTop: 12 }} />
    </ScrollView>
  );
}
