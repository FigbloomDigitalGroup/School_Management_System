import { Linking, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { SUSPENDED_SCHOOL_BODY, SUSPENDED_SCHOOL_CONTACT, SUSPENDED_SCHOOL_TITLE } from "@figbloom/shared";
import { fontSize } from "../theme";
import { useTheme } from "./ThemeContext";

/**
 * "Your school's account is suspended." On sign-in, when Auth refuses a
 * banned account or the school picked is suspended, and after an open
 * session finds its school suspended. Never the reason (shared suspended.ts).
 */
export function SuspendedNotice({ style }: { style?: StyleProp<ViewStyle> }) {
  const { t } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="suspended-notice"
      style={[{ borderWidth: 1, borderColor: t.status.warnInk, borderRadius: t.radius.lg, backgroundColor: t.status.warnBg, padding: 14 }, style]}
    >
      <Text style={{ fontSize: fontSize.lead, fontWeight: "700", color: t.status.warnInk }}>{SUSPENDED_SCHOOL_TITLE}</Text>
      <Text style={{ fontSize: 14, lineHeight: 20, marginTop: 4, color: t.status.warnInk }}>{SUSPENDED_SCHOOL_BODY}</Text>
      <Text style={{ fontSize: 14, lineHeight: 20, marginTop: 4, color: t.status.warnInk }}>
        Figbloom support:{" "}
        <Text
          accessibilityRole="link"
          style={{ fontWeight: "600", textDecorationLine: "underline" }}
          onPress={() => { void Linking.openURL(`mailto:${SUSPENDED_SCHOOL_CONTACT}`).catch(() => {}); }}
        >
          {SUSPENDED_SCHOOL_CONTACT}
        </Text>
      </Text>
    </View>
  );
}
