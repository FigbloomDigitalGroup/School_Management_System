import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { subscribeVisits, visitAlert } from "@figbloom/shared";
import { Tap } from "../ui/Tap";
import { X } from "lucide-react-native";
import { useTheme } from "../ui/ThemeContext";

/** How long an arrival stays on screen before it tucks itself away. */
const SHOW_MS = 12_000;

/**
 * Someone has come to see this teacher: a card over whatever screen is open,
 * with the same words the web pops up (visitAlert in shared). It is told only
 * while the app is open; a phone-in-pocket notification needs the push setup
 * the parent app has, which the teacher app doesn't yet. Tap to open Your
 * visitors.
 */
export function VisitAlerts({ tenantId, profileId, onOpen }: { tenantId: string; profileId: string; onOpen: () => void }) {
  const { t, s } = useTheme();
  const insets = useSafeAreaInsets();
  const [alert, setAlert] = useState<{ id: string; title: string; body: string } | null>(null);

  useEffect(() => {
    return subscribeVisits(tenantId, (v, isNew) => {
      const a = visitAlert(v, { profileId, role: "teacher" }, isNew);
      if (a) setAlert({ id: v.id, ...a });
    });
  }, [tenantId, profileId]);

  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(() => setAlert(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [alert]);

  if (!alert) return null;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 8, left: 12, right: 12, zIndex: 50 }}>
      <View style={[s.card, { flexDirection: "row", alignItems: "center", gap: 10, padding: 0, borderColor: t.brand.orange, borderWidth: 1.5, elevation: 8 }]} accessibilityRole="alert" accessibilityLiveRegion="assertive">
        <Tap accessibilityRole="button" accessibilityLabel={`${alert.title}. Open your visitors`} onPress={() => { setAlert(null); onOpen(); }} style={{ flex: 1, minHeight: 56, padding: 12, justifyContent: "center" }}>
          <Text style={{ fontSize: 14, fontWeight: "700", color: t.appSurface.ink }}>{alert.title}</Text>
          <Text numberOfLines={2} style={[s.small, { marginTop: 2 }]}>{alert.body}</Text>
        </Tap>
        <Tap accessibilityRole="button" accessibilityLabel="Dismiss" onPress={() => setAlert(null)} style={{ minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" }}>
          <X size={18} color={t.appSurface.inkMuted} />
        </Tap>
      </View>
    </View>
  );
}
