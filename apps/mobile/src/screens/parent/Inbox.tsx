import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { accentFor } from "../../theme";
import { useChild, useMarkMessageRead, useMessages } from "../../data";
import { OwnerAttachments } from "../../components/MediaLinks";
import { MessageToSign } from "../../components/PendingSignatures";
import { Tap } from "../../ui/Tap";
import { BackLink } from "../../ui/BackLink";
import { PencilLine, School } from "lucide-react-native";
import { useTheme } from "../../ui/ThemeContext";

export function ParentInbox() {
  const { t, s, accentInk } = useTheme();
  const { index, accent } = useChild();
  const messages = useMessages();
  const markRead = useMarkMessageRead();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  const [openId, setOpenId] = useState<string | null>(null);
  const open = messages.find((m) => m.id === openId);

  if (open) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: tint }]}>
          <Text style={s.headerTitle}>Inbox</Text>
          <Text style={s.headerSub}>{open.from} · {open.when}</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <BackLink label="All messages" color={accentInk(tint)} onPress={() => setOpenId(null)} />
          <Text style={{ color: t.appSurface.ink, fontSize: 19, fontWeight: "600", marginTop: 8, lineHeight: 26 }}>{open.subject}</Text>
          <Text style={[s.body, { marginTop: 16 }]}>{open.body}</Text>
          <OwnerAttachments owner="announcement" id={open.id} tint={tint} />
          <MessageToSign announcementId={open.id} tint={tint} />
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
        {messages.map((m) => {
          const unread = m.unread;
          return (
            <Tap
              key={m.id}
              onPress={() => { markRead(m.id); setOpenId(m.id); }}
              style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", gap: 12 }]}
            >
              <View style={{ width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: unread ? tint : t.appSurface.lineSoft }}>
                {m.who === "school" ? <School size={18} color={unread ? "#fff" : t.appSurface.inkMuted} /> : <PencilLine size={18} color={unread ? "#fff" : t.appSurface.inkMuted} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: unread ? "700" : "500" }}>{m.from}</Text>
                <Text numberOfLines={1} style={{ color: t.appSurface.ink, fontSize: 13, fontWeight: unread ? "600" : "400", marginTop: 2 }}>{m.subject}</Text>
                <Text numberOfLines={2} style={[s.small, { marginTop: 4 }]}>{m.body.split("\n")[0]}</Text>
              </View>
              <Text style={s.faint}>{m.when}</Text>
            </Tap>
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
