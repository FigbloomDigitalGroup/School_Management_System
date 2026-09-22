import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { fetchTeacherNotices, markNoticeRead, subscribeAnnouncements, type NoticeInfo } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import type { TeacherSession } from "../../navigation";

const NOTICE_POLL_MS = 20_000;

/**
 * List-then-detail, same pattern as the mobile parent Inbox — a phone has
 * no room for web's side-by-side master-detail. Whole-school announcements
 * plus anything sent to this teacher personally. Streams live
 * (subscribeAnnouncements) with a poll as fallback, same as web.
 */
export function TeacherNotices({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  const [notices, setNotices] = useState<NoticeInfo[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const loadedOnce = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchTeacherNotices(session.profileId)
        .then((fresh) => { if (alive) { loadedOnce.current = true; setNotices(fresh); } })
        .catch(() => { if (alive && !loadedOnce.current) setNotices([]); });
    };
    load();
    const id = setInterval(load, NOTICE_POLL_MS);
    const unsubscribe = subscribeAnnouncements(session.tenantId, load);
    return () => { alive = false; clearInterval(id); unsubscribe(); };
  }, [session.profileId, session.tenantId]);

  function open(id: string) {
    setOpenId(id);
    setNotices((ns) => {
      if (!ns) return ns;
      const target = ns.find((n) => n.id === id);
      if (!target?.unread) return ns;
      void markNoticeRead(session.profileId, id).catch(() => {});
      return ns.map((n) => (n.id === id ? { ...n, unread: false } : n));
    });
  }

  if (!notices) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={a.deep} />
      </View>
    );
  }

  const selected = notices.find((n) => n.id === openId) ?? null;

  if (selected) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: a.deep }]}>
          <Text style={s.headerTitle}>Notices</Text>
          <Text style={s.headerSub}>{selected.from} · {selected.when}</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <TouchableOpacity accessibilityRole="button" onPress={() => setOpenId(null)} style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: a.deep }}>‹ All notices</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 18, fontWeight: "600", marginTop: 8, lineHeight: 25 }}>{selected.subject}</Text>
          <Text style={[s.body, { marginTop: 14 }]}>{selected.body}</Text>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Notices</Text>
        <Text style={s.headerSub}>
          {notices.length === 0 ? "Nothing here yet" : `${notices.length} notice${notices.length === 1 ? "" : "s"}`}
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {notices.length === 0 ? (
          <View style={s.card}><Text style={s.small}>Announcements from the school office will appear here.</Text></View>
        ) : (
          notices.map((n) => (
            <TouchableOpacity
              key={n.id}
              accessibilityRole="button"
              onPress={() => open(n.id)}
              style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", gap: 10 }]}
            >
              {n.unread && <View style={{ width: 7, height: 7, borderRadius: 4, marginTop: 6, backgroundColor: t.brand.orange }} />}
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: n.unread ? "700" : "500", flex: 1 }}>{n.subject}</Text>
                  <Text style={s.faint}>{n.when}</Text>
                </View>
                <Text style={s.faint}>{n.from}</Text>
                <Text numberOfLines={2} style={[s.small, { marginTop: 4 }]}>{n.body.split("\n")[0]}</Text>
              </View>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
}
