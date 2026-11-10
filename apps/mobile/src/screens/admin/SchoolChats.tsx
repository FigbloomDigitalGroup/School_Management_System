import { useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { chatRoleWord, fetchSchoolConversations, filterSchoolConversations, schoolChatTitle, type SchoolConversation } from "@figbloom/shared";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { useLoad } from "../../lib/useLoad";
import type { StaffSession } from "../../lib/staffSession";
import { accentFor, fontSize } from "../../theme";
import { Field } from "../../ui/Field";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";
import { ChatAvatar } from "../chat/ChatAvatar";

/** What opens a chat in the school's list: the thread screen's own parameters, as an oversight thread. */
export interface OpenSchoolChat { conversationId: string; name: string; subtitle: string; canReply: false; oversight: true; backLabel: string }

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/**
 * Every chat in the school, read only: the office can read them but not join. Families and teachers are told on every
 * thread that the office can read it. Opens a chat as an oversight thread (both names on the bubbles, no composer).
 */
export function SchoolChats({ session, onOpen }: { session: StaffSession; onOpen: (chat: OpenSchoolChat) => void }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  const { data, error, loading, refreshing, refresh, retry } = useLoad(() => fetchSchoolConversations(session.tenantId), session.tenantId);
  const [nameFilter, setNameFilter] = useState("");
  const shown = data ? filterSchoolConversations(data, nameFilter) : [];

  function open(c: SchoolConversation) {
    onOpen({
      conversationId: c.id,
      name: schoolChatTitle(c),
      subtitle: `${chatRoleWord(c.a.role)} · ${chatRoleWord(c.b.role)} · read only`,
      canReply: false,
      oversight: true,
      backLabel: "All school chats",
    });
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="All school chats" sub="Every chat in the school. You can read them, not join." color={a.deep} back />
      {error ? (
        <ErrorState title="Couldn't load the school's chats" body={error} onRetry={retry} />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(c) => c.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          ListHeaderComponent={
            <Field
              label="Filter by name"
              placeholder="Either person in the chat"
              value={nameFilter}
              onChangeText={setNameFilter}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ marginBottom: 12 }}
            />
          }
          ListEmptyComponent={
            loading || !data ? (
              <View style={{ gap: 8 }}>
                {[0, 1, 2, 3].map((i) => (
                  <View key={i} style={[s.card, { padding: 14, gap: 8 }]}>
                    <Skeleton width="60%" height={14} />
                    <Skeleton width="40%" height={11} />
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState title="No chats" body={nameFilter.trim() ? "No chats match this name." : "No one at the school has chatted yet."} />
            )
          }
          renderItem={({ item: c }) => (
            <Tap
              accessibilityLabel={`${schoolChatTitle(c)}, ${c.messageCount} ${c.messageCount === 1 ? "message" : "messages"}`}
              onPress={() => open(c)}
              style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", gap: 12, alignItems: "center" }]}
            >
              <ChatAvatar id={c.a.profileId} name={c.a.name} />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: fontSize.body, fontWeight: "500", color: t.appSurface.ink }}>{schoolChatTitle(c)}</Text>
                  <Text style={s.faint}>{day(c.lastMessageAt)}</Text>
                </View>
                <Text style={s.faint}>
                  {chatRoleWord(c.a.role)} · {chatRoleWord(c.b.role)} · {c.messageCount} {c.messageCount === 1 ? "message" : "messages"}
                </Text>
                {!!c.lastBody && <Text numberOfLines={1} style={[s.small, { marginTop: 2 }]}>{c.lastBody.split("\n")[0]}</Text>}
              </View>
              <ChevronRight size={16} color={t.appSurface.inkFaint} />
            </Tap>
          )}
        />
      )}
    </View>
  );
}
