import { ScrollView, Text, TouchableOpacity } from "react-native";
import { accentFor, HIT, t } from "../theme";

interface PillItem {
  id: string;
  name: string;
}

/** A horizontal row of tap-to-select pills — the class/subject/exam
 *  picker every teacher screen needs, mobile has no room for a <select>. */
export function PillPicker({ items, selectedId, onPick, accent }: {
  items: PillItem[];
  selectedId: string | null;
  onPick: (id: string) => void;
  accent: string;
}) {
  const a = accentFor(accent);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }}>
      {items.map((item) => {
        const on = item.id === selectedId;
        return (
          <TouchableOpacity
            key={item.id}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onPick(item.id)}
            style={{
              ...HIT, borderRadius: 999, paddingHorizontal: 14, justifyContent: "center",
              backgroundColor: on ? a.deep : t.appSurface.lineSoft,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "600", color: on ? "#fff" : t.appSurface.inkMuted }}>{item.name}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}
