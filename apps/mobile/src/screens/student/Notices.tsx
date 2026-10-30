import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { accentFor, s } from "../../theme";
import { useStudentData } from "../../studentData";
import { OwnerAttachments } from "../../components/MediaLinks";
import { Tap } from "../../ui/Tap";
import { BackLink } from "../../ui/BackLink";
import { School } from "lucide-react-native";

export function StudentNotices() {
  const { data, accent, markNoticeRead } = useStudentData();
  const a = accentFor(accent);
  const [openId, setOpenId] = useState<string | null>(null);
  const notices = data.notices;
  const open = notices.find((n) => n.id === openId);

  if (open) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: a.deep }]}>
          <Text style={s.headerTitle}>Notices</Text>
          <Text style={s.headerSub}>{open.from} · {open.when}</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <BackLink label="All notices" color={a.deep} onPress={() => setOpenId(null)} />
          <Text style={{ fontSize: 19, fontWeight: "600", marginTop: 8, lineHeight: 26 }}>{open.subject}</Text>
          <Text style={[s.body, { marginTop: 16 }]}>{open.body}</Text>
          <OwnerAttachments owner="announcement" id={open.id} tint={a.deep} />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Notices</Text>
        <Text style={s.headerSub}>From the school and your teachers</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {notices.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={s.small}>Announcements from your teachers and the school office will appear here.</Text>
          </View>
        ) : (
          notices.map((n) => {
            const unread = n.unread;
            return (
              <Tap
                key={n.id}
                onPress={() => { markNoticeRead(n.id); setOpenId(n.id); }}
                style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", gap: 12 }]}
              >
                <View style={{ width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: unread ? a.deep : "#F1EDEC" }}>
                  <School size={18} color={unread ? "#fff" : "#6B605F"} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: unread ? "700" : "500" }}>{n.from}</Text>
                  <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: unread ? "600" : "400", marginTop: 2 }}>{n.subject}</Text>
                  <Text numberOfLines={2} style={[s.small, { marginTop: 4 }]}>{n.body.split("\n")[0]}</Text>
                </View>
                <Text style={s.faint}>{n.when}</Text>
              </Tap>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
