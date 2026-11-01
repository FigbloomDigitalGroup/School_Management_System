import { Text, View } from "react-native";

const SHADES = ["#8A3D08", "#1F4E79", "#1B4D2E", "#6B3F8A", "#8A1F4E", "#4E5F1F"];

/** A coloured circle with the person's initials; the colour follows their id, so it is the same every time. */
export function ChatAvatar({ id, name, size = 40 }: { id: string; name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: SHADES[hash % SHADES.length], alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#fff", fontWeight: "700", fontSize: size * 0.36 }}>{initials || "?"}</Text>
    </View>
  );
}
