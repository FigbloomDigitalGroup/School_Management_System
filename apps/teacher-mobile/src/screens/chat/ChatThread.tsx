import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  CHAT_BODY_MAX, CHAT_OVERSIGHT_NOTICE, chatDayLabel, chatDraftBody, chatFileUrl, chatRoleWord, fetchChatMessages, formatFileSize,
  groupMessagesByDay, markConversationRead, mergeMessage, pushChatMessage, sendChatMessage, subscribeChatMessages,
  type ChatMessage, type Role,
} from "@figbloom/shared";
import { notifyChatRead } from "../../lib/chatUnread";
import { useChatSession } from "../../lib/chatSession";
import { s, t } from "../../theme";
import { ChatAvatar } from "./ChatAvatar";

interface ThreadParams {
  conversationId: string;
  name: string;
  role: Role;
  /** False once the pair may no longer talk: the thread stays readable but has no composer. */
  canReply: boolean;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** One conversation: header, the messages by day, and the composer. Files in a chat open in the phone's viewer; sending a file is done from the website for now. */
export function ChatThread({ tint }: { tint: string }) {
  const nav = useNavigation<any>();
  const { conversationId, name, role, canReply } = useRoute<any>().params as ThreadParams;
  const session = useChatSession();
  const myId = session?.profileId ?? null;
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);

  // Marks the thread read, then lets the badges catch up.
  const markRead = useRef(() => {});
  markRead.current = () => { void markConversationRead(conversationId).then(notifyChatRead).catch(() => {}); };

  useEffect(() => {
    if (!myId) return;
    let alive = true;
    setMessages(null);
    setError(null);
    fetchChatMessages(conversationId)
      .then((m) => { if (!alive) return; setMessages(m); markRead.current(); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load this chat."); });
    const unsubscribe = subscribeChatMessages({ conversationId }, (m) => {
      if (!alive) return;
      setMessages((ms) => (ms ? mergeMessage(ms, m) : ms));
      // Reading it as it arrives: it never counts as unread.
      if (m.senderId !== myId) markRead.current();
    });
    return () => { alive = false; unsubscribe(); };
  }, [conversationId, myId]);

  async function send() {
    const body = chatDraftBody(draft);
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const sent = await sendChatMessage(conversationId, body);
      setMessages((ms) => mergeMessage(ms ?? [], sent));
      setDraft("");
      void pushChatMessage(sent.id);
    } catch (err) {
      setSendError(err instanceof Error ? `Could not send: ${err.message}` : "Could not send.");
    } finally {
      setSending(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <TouchableOpacity accessibilityRole="button" onPress={() => nav.goBack()} style={{ paddingVertical: 6, marginBottom: 4 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: "rgba(255,255,255,0.85)" }}>‹ All chats</Text>
        </TouchableOpacity>
        <View style={[s.row, { gap: 10 }]}>
          <ChatAvatar id={conversationId} name={name} size={36} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={s.headerTitle}>{name}</Text>
            <Text style={s.headerSub}>{chatRoleWord(role)}</Text>
          </View>
        </View>
      </View>

      <Text style={[s.faint, { paddingHorizontal: 16, paddingVertical: 6, backgroundColor: t.appSurface.shell }]}>◈ {CHAT_OVERSIGHT_NOTICE}</Text>

      {error ? (
        <Text style={[s.small, { color: t.status.warnInk, padding: 16 }]}>Could not load this chat: {error}</Text>
      ) : !messages ? (
        <ActivityIndicator color={tint} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView
          ref={scroll}
          contentContainerStyle={{ padding: 16, flexGrow: 1 }}
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
          keyboardShouldPersistTaps="handled"
        >
          {messages.length === 0 ? (
            <Text style={[s.small, { textAlign: "center", marginTop: 40 }]}>No messages yet. Say hello.</Text>
          ) : (
            groupMessagesByDay(messages).map((g) => (
              <View key={g.day}>
                <Text style={[s.eyebrow, { textAlign: "center", marginVertical: 12 }]}>{chatDayLabel(g.day).toUpperCase()}</Text>
                {g.messages.map((m) => {
                  const mine = m.senderId === myId;
                  return (
                    <View key={m.id} style={{ marginBottom: 8, flexDirection: "row", justifyContent: mine ? "flex-end" : "flex-start" }}>
                      <View style={{ maxWidth: "82%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: mine ? tint : "#F1EDEC" }}>
                        {!!m.filePath && <ChatFile message={m} mine={mine} />}
                        {!!m.body && <Text selectable style={{ fontSize: 14.5, lineHeight: 21, color: mine ? "#fff" : t.appSurface.ink }}>{m.body}</Text>}
                        <Text style={{ marginTop: 2, fontSize: 10.5, textAlign: "right", color: mine ? "rgba(255,255,255,0.7)" : t.appSurface.inkFaint }}>{time(m.createdAt)}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            ))
          )}
        </ScrollView>
      )}

      {canReply ? (
        <View style={{ borderTopWidth: 1, borderTopColor: t.appSurface.line, backgroundColor: "#fff", padding: 10 }}>
          {!!sendError && <Text style={{ fontSize: 12, color: t.status.warnInk, marginBottom: 6 }}>{sendError}</Text>}
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              maxLength={CHAT_BODY_MAX}
              editable={!sending}
              placeholder="Write a message"
              placeholderTextColor={t.appSurface.inkFaint}
              accessibilityLabel="Message"
              style={{ flex: 1, maxHeight: 120, minHeight: 44, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14.5, color: t.appSurface.ink }}
            />
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Send"
              disabled={sending || !chatDraftBody(draft)}
              onPress={() => void send()}
              style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 14, backgroundColor: tint, alignItems: "center", justifyContent: "center", opacity: sending || !chatDraftBody(draft) ? 0.5 : 1 }}
            >
              {sending ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontWeight: "700" }}>Send</Text>}
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <Text style={[s.small, { borderTopWidth: 1, borderTopColor: t.appSurface.line, backgroundColor: "#fff", padding: 14 }]}>
          You can read this chat but can no longer reply: the school has changed who teaches this learner.
        </Text>
      )}
    </KeyboardAvoidingView>
  );
}

/** A file in a message opens through a short-lived signed link, in whatever the phone uses for it. */
function ChatFile({ message, mine }: { message: ChatMessage; mine: boolean }) {
  const [failed, setFailed] = useState(false);
  async function open() {
    if (!message.filePath) return;
    setFailed(false);
    try {
      await Linking.openURL(await chatFileUrl(message.filePath, message.fileName ?? undefined));
    } catch {
      setFailed(true);
    }
  }
  return (
    <TouchableOpacity accessibilityRole="link" accessibilityLabel={`Open ${message.fileName ?? "file"}`} onPress={() => void open()} style={{ minHeight: 40, marginBottom: 4, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 6, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: mine ? "rgba(255,255,255,0.15)" : "#fff" }}>
      <Text>📎</Text>
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "600", color: mine ? "#fff" : t.appSurface.ink }}>{message.fileName}</Text>
        <Text style={{ fontSize: 11, color: failed ? t.status.warnInk : mine ? "rgba(255,255,255,0.7)" : t.appSurface.inkFaint }}>
          {failed ? "Could not open it. Check your connection." : message.sizeBytes != null ? formatFileSize(message.sizeBytes) : "File"}
        </Text>
      </View>
    </TouchableOpacity>
  );
}
