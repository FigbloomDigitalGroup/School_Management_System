import { Text, View } from "react-native";
import { useCalls } from "./CallProvider";
import { useRunningLiveClasses } from "./useRunningLiveClasses";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";

/**
 * "Live now" for a learner or a parent: one card per live class running in their
 * (children's) classes, with Join. Nothing at all when none is. The website's
 * LiveClassBanner.
 */
export function LiveClassBanner({ tenantId, classIds, tint }: { tenantId: string; classIds: string[]; tint: string }) {
  const { t, s, accentInk } = useTheme();
  const running = useRunningLiveClasses(tenantId, classIds);
  const { joinClass, busy } = useCalls();
  if (running.length === 0) return null;
  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      {running.map((lc) => (
        <View key={lc.id} style={[s.card, { padding: 14, borderColor: accentInk(tint), flexDirection: "row", alignItems: "center", gap: 12 }]}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, backgroundColor: t.status.warnInk }}>
                <Text style={{ fontSize: 10.5, fontWeight: "800", color: "#fff", letterSpacing: 0.5 }}>LIVE</Text>
              </View>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, fontWeight: "600", color: t.appSurface.ink }}>{lc.title}</Text>
            </View>
            <Text style={[s.faint, { marginTop: 3 }]}>A live class in Figbloom. No other app needed.</Text>
          </View>
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`Join ${lc.title}`}
            disabled={busy}
            onPress={() => void joinClass(lc.id)}
            style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 12, backgroundColor: tint, alignItems: "center", justifyContent: "center", opacity: busy ? 0.5 : 1 }}
          >
            <Text style={{ fontWeight: "700", color: "#fff" }}>Join</Text>
          </Tap>
        </View>
      ))}
    </View>
  );
}
