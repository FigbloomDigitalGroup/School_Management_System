import { Text, View } from "react-native";
import { useCalls } from "./CallProvider";
import { RIPPLE_ON_DARK } from "../ui/color";
import { Tap } from "../ui/Tap";

/**
 * Voice and video buttons for the other person in a chat, for the thread's
 * coloured header. Whether this pair may call is the server's to say (call-token
 * answers in words when not); the buttons just ask.
 */
export function CallButtons({ otherId, name }: { otherId: string; name: string }) {
  const { call, busy } = useCalls();
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {([["Call", false], ["Video", true]] as const).map(([label, video]) => (
        <Tap
          key={label}
          accessibilityRole="button"
          accessibilityLabel={`${video ? "Video call" : "Call"} ${name}`}
          disabled={busy}
          onPress={() => void call(otherId, video)}
          ripple={RIPPLE_ON_DARK}
          style={{ minHeight: 40, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: "rgba(255,255,255,0.6)", alignItems: "center", justifyContent: "center", opacity: busy ? 0.5 : 1 }}
        >
          <Text style={{ fontSize: 13, fontWeight: "600", color: "#fff" }}>{label}</Text>
        </Tap>
      ))}
    </View>
  );
}
