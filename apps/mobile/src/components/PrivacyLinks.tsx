import { Linking, Text, TouchableOpacity, View } from "react-native";
import { DELETE_ACCOUNT_URL, PRIVACY_POLICY_URL } from "@figbloom/shared";
import { s, t } from "../theme";

const ROWS = [
  { label: "Privacy policy", note: "What the app collects, and why.", url: PRIVACY_POLICY_URL },
  { label: "Delete my account or data", note: "How to ask your school and us.", url: DELETE_ACCOUNT_URL },
];

/**
 * "Your data", for an Account screen: the privacy policy and the page on
 * deleting an account, the same two the store listings point to. Both open in
 * the phone's browser, so what is read there is always the current page.
 */
export function PrivacyLinks({ tint }: { tint: string }) {
  return (
    <>
      <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Your data</Text>
      <View style={[s.card, { padding: 0 }]}>
        {ROWS.map((r, i) => (
          <TouchableOpacity
            key={r.url}
            accessibilityRole="link"
            accessibilityLabel={r.label}
            onPress={() => void Linking.openURL(r.url).catch(() => {})}
            style={{
              minHeight: 56, padding: 14, flexDirection: "row", alignItems: "center", gap: 10,
              borderTopWidth: i ? 1 : 0, borderTopColor: t.appSurface.lineSoft,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13.5, fontWeight: "500" }}>{r.label}</Text>
              <Text style={s.faint}>{r.note}</Text>
            </View>
            <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>Open</Text>
          </TouchableOpacity>
        ))}
      </View>
    </>
  );
}
