import { Text, View } from "react-native";
import { Button } from "../ui/Button";
import { useTheme } from "../ui/ThemeContext";

export const SAVED_COPY_MESSAGE = "No connection. You are seeing what was saved on this phone, which may be out of date.";
export const NO_CONNECTION_TITLE = "No connection";
export const NO_CONNECTION_MESSAGE = "You are still signed in, but this phone cannot reach the school right now. Check your signal and try again.";
export const TRY_AGAIN = "Try again";

/**
 * Over the app while it shows what the phone saved because the server could not be reached (FIG-1487): the
 * person is still signed in, so it says so and offers a retry instead of the sign-in screen.
 */
export function SavedCopyNotice({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 16, paddingRight: 4, backgroundColor: t.status.warnBg }}
    >
      <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 17, paddingVertical: 8, color: t.status.warnInk }}>{SAVED_COPY_MESSAGE}</Text>
      <Button variant="quiet" label={TRY_AGAIN} loading={retrying} onPress={onRetry} />
    </View>
  );
}

/**
 * Signed in on this phone, but the server cannot be reached and there is nothing saved to show (the first time
 * the app is opened after an update, a driver, whose screen needs the server). Not the sign-in screen: typing a
 * password would not work either, and the person is still signed in.
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
