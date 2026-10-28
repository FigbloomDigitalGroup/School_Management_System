import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Platform, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  askBloomChat, attachmentLabel, CHAT_MAX_ATTACHMENTS, CHAT_MESSAGE_MAX, chatTitleFrom, createAiChat, deleteAiChat, EdgeError,
  fetchAiChatMessages, fetchAiChats, fetchAiStatus, formatFileSize, saveAiChatTurns, setAiChatWebSearch, sourceHost,
  type AiChat, type AiChatSource, type AiChatTurn, type AiStatus, type ChatAttachment,
} from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { Markdown } from "../../components/Markdown";
import { ScreenHeader } from "../../components/ScreenHeader";
import { BLOOM_FILE_TYPES, readBloomAttachment } from "../../lib/bloomFiles";
import { pickFile } from "../../lib/pickFile";
import type { TeacherSession } from "../../navigation";

const STARTERS = [
  "Draft a circular to parents about half term",
  "Plan a 40-minute Grade 7 lesson on fractions",
  "Explain the CBE assessment rubric levels simply",
  "Translate this notice into Kiswahili:",
];

const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/**
 * Bloom, the general AI assistant for teachers, as on the website's Bloom
 * page: your saved chats (private to you), and a chat where Bloom may search
 * the web (a toggle, remembered per chat) and read up to three files you add
 * with a question. A reply comes from the ai-assist "chat" task; the chat is
 * saved as you. Downloading an answer as PDF or Word, saving to Google Drive,
 * regenerating an answer and importing an exam paper are on the website.
 */
export function TeacherBloom({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  // undefined: still asking. null: the school has no settings row to read.
  const [status, setStatus] = useState<AiStatus | null | undefined>(undefined);
  const [chats, setChats] = useState<AiChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /** null: the list. "new": a chat not started yet. Otherwise the chat that is open. */
  const [open, setOpen] = useState<AiChat | "new" | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchAiStatus(session.tenantId), fetchAiChats()])
      .then(([st, list]) => { if (alive) { setStatus(st); setChats(list); setError(null); } })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load Bloom."); });
    return () => { alive = false; };
  }, [session.tenantId, reloadKey]);

  if (open) {
    return (
      <BloomThread
        key={open === "new" ? "new" : open.id}
        chat={open}
        session={session}
        tint={a.deep}
        webSearchAllowed={status?.webSearchEnabled !== false}
        onBack={() => { setOpen(null); setReloadKey((k) => k + 1); }}
      />
    );
  }

  function confirmDelete(c: AiChat) {
    Alert.alert("Delete this chat?", c.title, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: () => {
          deleteAiChat(c.id)
            .then(() => setReloadKey((k) => k + 1))
            .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not delete that chat."));
        },
      },
    ]);
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="Bloom" sub="Your AI assistant. Your chats are private to you." color={a.deep} back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        {error ? (
          <View style={s.card}><Text style={[s.small, { color: t.status.warnInk }]}>{error}</Text></View>
        ) : status === undefined || !chats ? (
          <ActivityIndicator color={a.deep} style={{ marginTop: 32 }} />
        ) : status && !status.aiEnabled ? (
          <View style={[s.card, { padding: 16 }]}>
            <Text style={[s.h2, { marginBottom: 4 }]}>Bloom is off</Text>
            <Text style={s.small}>Bloom is turned off for this school. The school office can turn it on in School settings.</Text>
          </View>
        ) : (
          <>
            <TouchableOpacity accessibilityRole="button" onPress={() => setOpen("new")} style={[s.primary, { backgroundColor: a.deep }]}>
              <Text style={s.primaryLabel}>New chat</Text>
            </TouchableOpacity>
            {chats.length === 0 ? (
              <View style={[s.card, { padding: 16 }]}>
                <Text style={s.small}>No chats yet. Ask Bloom to draft a notice, plan a lesson, explain a topic or read a document.</Text>
              </View>
            ) : (
              chats.map((c) => (
                <View key={c.id} style={[s.card, { padding: 0, flexDirection: "row", alignItems: "center" }]}>
                  <TouchableOpacity accessibilityRole="button" onPress={() => setOpen(c)} style={{ flex: 1, minHeight: 56, padding: 14 }}>
                    <Text numberOfLines={1} style={{ fontSize: 14.5, fontWeight: "600", color: t.appSurface.ink }}>{c.title}</Text>
                    <Text style={s.faint}>{dayOf(c.updated_at)}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete ${c.title}`} onPress={() => confirmDelete(c)} style={{ minHeight: 56, paddingHorizontal: 14, justifyContent: "center" }}>
                    <Text style={{ fontSize: 13, fontWeight: "600", color: t.status.warnInk }}>Delete</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * A turn on screen. A saved one carries its row id; an answer from a web
 * search carries its sources; a question shows the names of the files sent with
 * it and, while the screen is open, holds the files themselves (`files`), which
 * are never saved.
 */
interface Turn extends AiChatTurn { id?: string; sources?: AiChatSource[]; attachments?: string[]; files?: ChatAttachment[] }

function BloomThread({ chat: initial, session, tint, webSearchAllowed, onBack }: {
  chat: AiChat | "new";
  session: TeacherSession;
  tint: string;
  webSearchAllowed: boolean;
  onBack: () => void;
}) {
  const initialId = initial === "new" ? null : initial.id;
  const [chat, setChat] = useState<AiChat | null>(initial === "new" ? null : initial);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(initialId !== null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [webSearch, setWebSearch] = useState(initial === "new" ? true : initial.web_search !== false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<ScrollView>(null);

  // Leaving the screen mid-answer stops waiting for it.
  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (!initialId) return;
    let alive = true;
    fetchAiChatMessages(initialId)
      .then((m) => { if (alive) setTurns(m); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not open that chat."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [initialId]);

  /** Takes effect from the next question; remembered with the chat once there is one. */
  function toggleWebSearch(on: boolean) {
    setWebSearch(on);
    if (chat) setAiChatWebSearch(chat.id, on).catch(() => setError("Could not save that setting."));
  }

  /**
   * Asks Bloom with `history` (ending on the question) and saves the question
   * with the answer. On failure or Stop the screen goes back to `before` and the
   * question goes back into the box, with its files.
   */
  async function ask(history: Turn[], before: Turn[], question: Turn) {
    setTurns(history);
    setBusy(true);
    setError("");
    const controller = new AbortController();
    abort.current = controller;
    let current = chat;
    let created = false;
    try {
      if (!current) {
        current = await createAiChat(session.tenantId, chatTitleFrom(question.content), webSearch);
        created = true;
        setChat(current);
      }
      const reply = await askBloomChat(history.map(({ role, content }) => ({ role, content })), {
        signal: controller.signal, webSearch, attachments: question.files,
      });
      const answer: Turn = { role: "assistant", content: reply.text || "(Bloom gave an empty answer. Try again.)", sources: reply.sources };
      setTurns([...history, answer]);
      try {
        const saved: Turn[] = await saveAiChatTurns(current.id, [question, answer]);
        setTurns([...history.slice(0, -1), ...saved]);
      } catch {
        setError("Bloom answered, but the chat couldn't be saved. Copy anything you need.");
      }
    } catch (err) {
      setTurns(before);
      setDraft(question.content);
      setAttachments(question.files ?? []);
      if (created && current) {
        // Nothing was said in it: don't leave an empty chat in the list.
        await deleteAiChat(current.id).catch(() => {});
        setChat(null);
      }
      if (!(err instanceof EdgeError && err.cancelled)) setError(err instanceof Error ? err.message : "Bloom didn't answer. Try again.");
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }

  function send() {
    const content = draft.trim();
    if (!content || busy) return;
    const question: Turn = {
      role: "user", content: content.slice(0, CHAT_MESSAGE_MAX),
      ...(attachments.length ? { attachments: attachments.map((x) => x.name), files: attachments } : {}),
    };
    setDraft("");
    setAttachments([]);
    void ask([...turns, question], turns, question);
  }

  async function attach() {
    if (attaching || busy) return;
    if (attachments.length >= CHAT_MAX_ATTACHMENTS) { setError(`Bloom can read up to ${CHAT_MAX_ATTACHMENTS} files with one question.`); return; }
    setAttaching(true);
    setError("");
    try {
      const picked = await pickFile("document", BLOOM_FILE_TYPES);
      if (!picked) return;
      const file = await readBloomAttachment(picked, attachments);
      setAttachments((cur) => [...cur, file]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that file.");
    } finally {
      setAttaching(false);
    }
  }

  const canSend = !busy && !!draft.trim();

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <TouchableOpacity accessibilityRole="button" onPress={onBack} style={{ paddingVertical: 6, marginBottom: 4 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: "rgba(255,255,255,0.85)" }}>‹ All chats</Text>
        </TouchableOpacity>
        <Text numberOfLines={1} style={s.headerTitle}>{chat?.title ?? "New chat"}</Text>
        <Text style={s.headerSub}>Bloom is an AI and can get things wrong. Read and edit before you save or send.</Text>
      </View>

      <ScrollView
        ref={scroll}
        contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <ActivityIndicator color={tint} style={{ marginTop: 32 }} />
        ) : (
          <>
            {turns.length === 0 && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {STARTERS.map((q) => (
                  <TouchableOpacity
                    key={q}
                    accessibilityRole="button"
                    onPress={() => setDraft(q)}
                    style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: t.appSurface.line, backgroundColor: "#fff" }}
                  >
                    <Text style={{ fontSize: 13, color: t.appSurface.ink }}>{q}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {turns.map((m, i) => (
              m.role === "user" ? (
                <View key={m.id ?? `u${i}`} style={{ alignSelf: "flex-end", maxWidth: "86%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: tint }}>
                  {m.attachments?.map((name) => <Text key={name} numberOfLines={1} style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", marginBottom: 2 }}>{attachmentLabel(name)}</Text>)}
                  <Text selectable style={{ fontSize: 14.5, lineHeight: 21, color: "#fff" }}>{m.content}</Text>
                </View>
              ) : (
                <View key={m.id ?? `a${i}`} style={[s.card, { alignSelf: "flex-start", maxWidth: "96%", padding: 12 }]}>
                  <Markdown source={m.content} sources={m.sources} tint={tint} />
                  {!!m.sources?.some((x) => x.url) && (
                    <View style={{ marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: t.appSurface.lineSoft, gap: 2 }}>
                      <Text style={s.eyebrow}>SOURCES</Text>
                      {m.sources.map((src, n) => !!src.url && (
                        <TouchableOpacity key={n} accessibilityRole="link" onPress={() => { void Linking.openURL(src.url).catch(() => {}); }} style={{ minHeight: 36, justifyContent: "center" }}>
                          <Text numberOfLines={2} style={{ fontSize: 12.5, color: tint }}>{n + 1}. {src.title} · {sourceHost(src.url)}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
              )
            ))}
            {busy && (
              <View style={[s.card, { alignSelf: "flex-start", padding: 12, flexDirection: "row", alignItems: "center", gap: 10 }]}>
                <ActivityIndicator color={tint} />
                <Text style={s.faint}>Bloom is thinking…</Text>
              </View>
            )}
          </>
        )}
        {!!error && <Text style={{ fontSize: 12.5, color: t.status.warnInk }}>{error}</Text>}
      </ScrollView>

      <View style={{ borderTopWidth: 1, borderTopColor: t.appSurface.line, backgroundColor: "#fff", padding: 10, gap: 6 }}>
        {webSearchAllowed && (
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 13, color: t.appSurface.ink }}>Search the web</Text>
            <Switch value={webSearch} onValueChange={toggleWebSearch} disabled={busy} accessibilityLabel="Search the web" trackColor={{ true: tint }} />
          </View>
        )}
        {attachments.map((f, i) => (
          <View key={`${f.name}-${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text numberOfLines={1} style={[s.small, { flex: 1, color: t.appSurface.ink }]}>{attachmentLabel(f.name)} · {formatFileSize(f.size)}</Text>
            <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => setAttachments((cur) => cur.filter((_, k) => k !== i))} style={{ minHeight: 36, justifyContent: "center" }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: t.status.warnInk }}>Remove</Text>
            </TouchableOpacity>
          </View>
        ))}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Add a PDF, Word or text file for Bloom to read"
            disabled={busy || attaching}
            onPress={() => void attach()}
            style={{ width: 44, minHeight: 44, borderRadius: 14, borderWidth: 1, borderColor: t.appSurface.line, alignItems: "center", justifyContent: "center", opacity: busy || attaching ? 0.5 : 1 }}
          >
            {attaching ? <ActivityIndicator color={tint} /> : <Text style={{ fontSize: 18 }}>📎</Text>}
          </TouchableOpacity>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={CHAT_MESSAGE_MAX}
            editable={!busy}
            placeholder="Ask Bloom"
            placeholderTextColor={t.appSurface.inkFaint}
            accessibilityLabel="Your question"
            style={{ flex: 1, maxHeight: 140, minHeight: 44, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14.5, color: t.appSurface.ink }}
          />
          {busy ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Stop"
              onPress={() => abort.current?.abort()}
              style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 14, borderWidth: 1, borderColor: t.appSurface.line, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ fontWeight: "700", color: t.appSurface.ink }}>Stop</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Send"
              disabled={!canSend}
              onPress={send}
              style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 14, backgroundColor: tint, alignItems: "center", justifyContent: "center", opacity: canSend ? 1 : 0.5 }}
            >
              <Text style={{ color: "#fff", fontWeight: "700" }}>Send</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
