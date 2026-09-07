import { useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { accentFor, s } from "../../theme";
import { MESSAGES, useChild } from "../../data";

export function ParentInbox() {
  const { index, accent } = useChild();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  const [openId, setOpenId] = useState<string | null>(null);
  const [read, setRead] = useState<Record<string, boolean>>({});
  const open = MESSAGES.find((m) => m.id === openId);

  if (open) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: tint }]}>
          <Text style={s.headerTitle}>Inbox</Text>
          <Text style={s.headerSub}>{open.from} · {open.when}</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <TouchableOpacity onPress={() => setOpenId(null)} style={{ ...s.row, minHeight: 44 }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>‹ All messages</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 19, fontWeight: "600", marginTop: 8, lineHeight: 26 }}>{open.subject}</Text>
          <Text style={[s.body, { marginTop: 16 }]}>{open.body}</Text>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <Text style={s.headerTitle}>Inbox</Text>
        <Text style={s.headerSub}>From the school and your child's teachers</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {MESSAGES.map((m) => {
          const unread = m.unread && !read[m.id];
          return (
            <TouchableOpacity
              key={m.id}
              onPress={() => { setRead((r) => ({ ...r, [m.id]: true })); setOpenId(m.id); }}
              style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", gap: 12 }]}
            >
              <View style={{ width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: unread ? tint : "#F1EDEC" }}>
                <Text style={{ fontSize: 13, color: unread ? "#fff" : "#6B605F" }}>
                  {m.who === "school" ? "\u25C8" : "\u270E"}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: unread ? "700" : "500" }}>{m.from}</Text>
                <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: unread ? "600" : "400", marginTop: 2 }}>{m.subject}</Text>
                <Text numberOfLines={2} style={[s.small, { marginTop: 4 }]}>{m.body.split("\n")[0]}</Text>
              </View>
              <Text style={s.faint}>{m.when}</Text>
            </TouchableOpacity>
          );
        })}
        <Text style={[s.faint, { marginTop: 12, lineHeight: 18 }]}>
          Fee reminders and same-day absences also arrive by SMS, because they are the two things a parent cannot
          afford to miss.
        </Text>
      </ScrollView>
    </View>
  );
}
