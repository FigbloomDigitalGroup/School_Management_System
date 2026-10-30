import { Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useChatSession } from "../lib/chatSession";
import { useChatUnread } from "../lib/chatUnread";
import { s, t } from "../theme";
import { Tap } from "../ui/Tap";
import { OpenLabel } from "../ui/OpenLabel";

/** The way into Chats from a home screen: a card with the unread count, since the tab bar is already full. */
export function ChatsCard({ tint, blurb }: { tint: string; blurb: string }) {
  const nav = useNavigation<any>();
  const session = useChatSession();
  const unread = useChatUnread(session?.tenantId ?? null);
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={unread ? `Chats, ${unread} unread` : "Chats"}
      onPress={() => nav.navigate("Chats")}
      style={[s.card, { marginTop: 10, padding: 14 }]}
    >
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <View style={[s.row, { gap: 8 }]}>
          <Text style={s.eyebrow}>CHATS</Text>
          {unread > 0 && (
            <View style={{ minWidth: 18, height: 18, borderRadius: 9, backgroundColor: t.brand.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 }}>
              <Text style={{ color: "#fff", fontSize: 10.5, fontWeight: "700" }}>{unread}</Text>
            </View>
          )}
        </View>
        <OpenLabel tint={tint} />
      </View>
      <Text style={[s.small, { marginTop: 4 }]}>{blurb}</Text>
    </Tap>
  );
}
