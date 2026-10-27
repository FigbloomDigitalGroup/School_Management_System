import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform, RefreshControl, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  chatRoleWord, conversationPreview, fetchChatContacts, fetchMyConversations, startConversation, subscribeChatMessages,
  type ChatContact, type ConversationSummary,
} from "@figbloom/shared";
import { useChatSession } from "../../lib/chatSession";
import { s, t } from "../../theme";
import { ChatAvatar } from "./ChatAvatar";

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * The caller's own chats. "New chat" lists only the people the database says
 * this caller may talk to (my_chat_contacts), so nobody is offered a chat
 * that would then be refused.
 */
export function ChatList({ tint, blurb, empty }: { tint: string; blurb: string; empty: string }) {
  const nav = useNavigation<any>();
  const session = useChatSession();
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [picking, setPicking] = useState(false);

  const reload = useCallback(() => {
    return fetchMyConversations()
      .then((cs) => { setList(cs); setError(null); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load your chats."));
  }, []);

  // Back from a thread, the unread counts have changed.
  useFocusEffect(useCallback(() => { void reload(); }, [reload]));
  // A message in any of the caller's chats moves it up the list and bumps its count.
  useEffect(() => (session ? subscribeChatMessages({ tenantId: session.tenantId }, () => void reload()) : undefined), [session, reload]);

  function open(c: { id: string; otherName: string; otherRole: ConversationSummary["otherRole"]; canReply: boolean }) {
    nav.navigate("ChatThread", { conversationId: c.id, name: c.otherName, role: c.otherRole, canReply: c.canReply });
  }

  async function startWith(contact: ChatContact) {
    try {
      const id = await startConversation(contact.profileId);
      setPicking(false);
      void reload();
      open({ id, otherName: contact.name, otherRole: contact.role, canReply: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start that chat.");
      setPicking(false);
    }
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <TouchableOpacity accessibilityRole="button" onPress={() => nav.goBack()} style={{ paddingVertical: 6, marginBottom: 4 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: "rgba(255,255,255,0.85)" }}>‹ Back</Text>
        </TouchableOpacity>
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTitle}>Chats</Text>
            <Text style={s.headerSub}>{blurb}</Text>
          </View>
          <TouchableOpacity accessibilityRole="button" onPress={() => setPicking(true)} style={{ minHeight: 40, paddingHorizontal: 14, borderRadius: 12, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontWeight: "700", color: tint }}>New chat</Text>
          </TouchableOpacity>
        </View>
      </View>

      {error && <Text style={[s.small, { color: t.status.warnInk, padding: 16, paddingBottom: 0 }]}>{error}</Text>}

      {!list && !error ? (
        <ActivityIndicator color={tint} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={list ?? []}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ padding: 16, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={tint} onRefresh={() => { setRefreshing(true); void reload().finally(() => setRefreshing(false)); }} />}
          ListEmptyComponent={list ? (
            <View style={[s.card, { alignItems: "center", padding: 24 }]}>
              <Text style={{ fontSize: 15, fontWeight: "600" }}>No chats yet.</Text>
              <Text style={[s.small, { marginTop: 6, textAlign: "center" }]}>{empty}</Text>
            </View>
          ) : null}
          renderItem={({ item: c }) => (
            <TouchableOpacity accessibilityRole="button" onPress={() => open(c)} style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", gap: 12 }]}>
              <ChatAvatar id={c.otherId} name={c.otherName} />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, fontWeight: c.unread ? "700" : "500" }}>{c.otherName}</Text>
                  <Text style={s.faint}>{when(c.lastMessageAt)}</Text>
                </View>
                <Text style={s.faint}>{chatRoleWord(c.otherRole)}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
                  <Text numberOfLines={1} style={[s.small, { flex: 1 }]}>{session ? conversationPreview(c, session.profileId) : ""}</Text>
                  {c.unread > 0 && (
                    <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: t.brand.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }}>
                      <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>{c.unread}</Text>
                    </View>
                  )}
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      <ContactPicker visible={picking} tint={tint} onClose={() => setPicking(false)} onPick={(c) => void startWith(c)} />
    </View>
  );
}

function ContactPicker({ visible, tint, onClose, onPick }: { visible: boolean; tint: string; onClose: () => void; onPick: (c: ChatContact) => void }) {
  const [contacts, setContacts] = useState<ChatContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setError(null);
    fetchChatContacts().then(setContacts).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load contacts."));
  }, [visible]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (contacts ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q));
  }, [contacts, query]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[s.header, { backgroundColor: tint }]}>
          <Text style={[s.eyebrow, { color: "rgba(255,255,255,0.75)" }]}>CHATS</Text>
          <Text style={s.headerTitle}>Start a chat</Text>
          <Text style={s.headerSub}>Only people you're connected to through a learner are listed.</Text>
        </View>
        <View style={{ padding: 16, flex: 1 }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search by name, class or subject"
            placeholderTextColor={t.appSurface.inkFaint}
            accessibilityLabel="Search contacts"
            style={{ borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: t.appSurface.ink, backgroundColor: "#fff", marginBottom: 10 }}
          />
          {error ? (
            <Text style={[s.small, { color: t.status.warnInk }]}>{error}</Text>
          ) : !contacts ? (
            <ActivityIndicator color={tint} style={{ marginTop: 24 }} />
          ) : (
            <FlatList
              data={shown}
              keyExtractor={(c) => c.profileId}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={<Text style={[s.small, { textAlign: "center", marginTop: 24 }]}>{contacts.length ? "No one matches that search." : "There's no one you can chat with yet."}</Text>}
              renderItem={({ item: c }) => (
                <TouchableOpacity accessibilityRole="button" onPress={() => onPick(c)} style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 6 }}>
                  <ChatAvatar id={c.profileId} name={c.name} size={36} />
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "600" }}>{c.name}</Text>
                    <Text numberOfLines={1} style={s.faint}>{c.detail}</Text>
                  </View>
                </TouchableOpacity>
              )}
            />
          )}
          <TouchableOpacity accessibilityRole="button" onPress={onClose} style={{ minHeight: 48, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 14.5, fontWeight: "600", color: t.appSurface.inkMuted }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
