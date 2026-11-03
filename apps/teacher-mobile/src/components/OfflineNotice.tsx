import { Text, View } from "react-native";
import { Button } from "../ui/Button";
import { useTheme } from "../ui/ThemeContext";

export const NO_CONNECTION_TITLE = "No connection";
export const NO_CONNECTION_MESSAGE = "You are still signed in, but this phone cannot reach the school right now. Check your signal and try again.";
export const TRY_AGAIN = "Try again";

/**
 * Signed in on this phone, but the server cannot be reached (FIG-1487). This app's screens (rosters, registers,
 * marks) are all live data, so there is nothing saved to open; but the sign-in screen would be wrong: typing a
 * password would not work either, and the teacher is still signed in.
 */
export function NoConnection({ onRetry, retrying, onSignOut }: { onRetry: () => void; retrying: boolean; onSignOut: () => void }) {
  const { t, s } = useTheme();
  return (
    <View style={[s.screen, { alignItems: "center", justifyContent: "center", padding: 24 }]}>
      <Text accessibilityRole="header" style={{ color: t.appSurface.ink, fontSize: 18, fontWeight: "600", textAlign: "center" }}>{NO_CONNECTION_TITLE}</Text>
      <Text style={[s.small, { textAlign: "center", marginTop: 8, marginBottom: 20 }]}>{NO_CONNECTION_MESSAGE}</Text>
      <Button label={TRY_AGAIN} loading={retrying} onPress={onRetry} />
      <Button variant="quiet" label="Sign out" onPress={onSignOut} style={{ marginTop: 8 }} />
    </View>
  );
}
