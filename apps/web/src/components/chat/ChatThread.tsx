import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import {
  CHAT_BODY_MAX, CHAT_OVERSIGHT_NOTICE, chatDayLabel, chatDraftBody, chatFileUrl, chatMimeForFile, chatRoleWord,
  fetchChatMessages, fetchConversationPeople, formatFileSize, groupMessagesByDay, markConversationRead, mergeMessage,
  pushChatMessage, removeUnsentChatFile, sendChatMessage, subscribeChatMessages, uploadChatFile,
  type ChatMessage, type ChatPerson,
} from "@figbloom/shared";
import { Avatar } from "../Avatar";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { UPLOAD_LIMIT_BYTES } from "../../lib/uploadLimit";
import { CHAT_READ_EVENT } from "../../lib/useChatUnread";

interface Props {
  conversationId: string;
  myId: string;
  tenantId: string;
  /** False once the pair may no longer talk: the thread stays readable but has no composer. */
  canReply: boolean;
  /** The office reading someone else's chat: no composer, no read marks, both names shown on bubbles. */
  oversight?: boolean;
  /** Called after the caller has read the thread, so lists and badges can refresh. */
  onRead?: () => void;
  /** Called after the caller sends, so the chat list can move this thread to the top. */
  onSent?: () => void;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * One conversation: header, the messages by day, and the composer. Shared by
 * every role's Chats screen and by the office's oversight view, which reads
 * the same thread without being in it.
 */
export function ChatThread({ conversationId, myId, tenantId, canReply, oversight, onRead, onSent }: Props) {
  const toast = useToast();
  const [people, setPeople] = useState<ChatPerson[] | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  // Marks the thread read, then lets the list and the sidebar badge catch up.
  const markRead = useRef(() => {});
  markRead.current = () => {
    void markConversationRead(conversationId)
      .then(() => { onReadRef.current?.(); window.dispatchEvent(new Event(CHAT_READ_EVENT)); })
      .catch(() => {});
  };

  useEffect(() => {
    let alive = true;
    setPeople(null);
    setMessages(null);
    setError(null);
    setDraft("");
    setFile(null);
    Promise.all([fetchConversationPeople(conversationId), fetchChatMessages(conversationId)])
      .then(([p, m]) => {
        if (!alive) return;
        setPeople(p);
        setMessages(m);
        if (!oversight) markRead.current();
      })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load this chat."); });
    const unsubscribe = subscribeChatMessages({ conversationId }, (m) => {
      if (!alive) return;
      setMessages((ms) => (ms ? mergeMessage(ms, m) : ms));
      // Reading it as it arrives: it never counts as unread.
      if (!oversight && m.senderId !== myId) markRead.current();
    });
    return () => { alive = false; unsubscribe(); };
  }, [conversationId, myId, oversight]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [messages?.length]);

  const byId = new Map((people ?? []).map((p) => [p.profileId, p]));
  const other = (people ?? []).find((p) => p.profileId !== myId) ?? null;

  function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!chatMimeForFile(f)) { toast("That kind of file can't be sent in a chat. Try a PDF, a picture, a document or a voice note.", "error"); return; }
    if (f.size > UPLOAD_LIMIT_BYTES) { toast(`That file is ${formatFileSize(f.size)}. The most a chat can take is ${formatFileSize(UPLOAD_LIMIT_BYTES)}.`, "error"); return; }
    setFile(f);
  }

  async function send() {
    const body = chatDraftBody(draft);
    if ((!body && !file) || sending) return;
    setSending(true);
    let uploaded: string | null = null;
    try {
      const attached = file ? await uploadChatFile(tenantId, conversationId, file, chatMimeForFile(file)!) : undefined;
      uploaded = attached?.path ?? null;
      const sent = await sendChatMessage(conversationId, body, attached);
      uploaded = null;
      setMessages((ms) => mergeMessage(ms ?? [], sent));
      setDraft("");
      setFile(null);
      void pushChatMessage(sent.id);
      onSent?.();
    } catch (err) {
      // Nothing half-sent: a file that went up without its message comes back out.
      if (uploaded) await removeUnsentChatFile(uploaded).catch(() => {});
      toast(err instanceof Error ? `Could not send: ${err.message}` : "Could not send.", "error");
    } finally {
      setSending(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  }

  if (error) {
    return (
      <div className="px-7 py-6">
        <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
          <span aria-hidden>✕</span>Could not load this chat: {error}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-white px-5 py-3">
        {!people ? (
          <Skeleton className="h-8 w-48" />
        ) : oversight ? (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold">{people.map((p) => p.name).join(" and ")}</div>
            <div className="text-[11.5px] text-ink-faint">{people.map((p) => chatRoleWord(p.role)).join(" · ")} · read-only</div>
          </div>
        ) : other ? (
          <>
            <Avatar id={other.profileId} name={other.name} url={other.avatarUrl} size={34} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold">{other.name}</div>
              <div className="text-[11.5px] text-ink-faint">{chatRoleWord(other.role)}</div>
            </div>
            {/* Call slot: the LiveKit calls work drops <CallButton profileId={other.profileId} /> here. */}
            <div data-slot="call" className="flex shrink-0 items-center gap-2" />
          </>
        ) : null}
      </header>

      <p className="border-b border-line-soft bg-[#FAFBFA] px-5 py-1.5 text-[11.5px] text-ink-faint">
        <span aria-hidden>◈ </span>{CHAT_OVERSIGHT_NOTICE}
      </p>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4" aria-live="polite">
        {!messages ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="ml-auto h-10 w-1/2" />
            <Skeleton className="h-10 w-3/5" />
          </div>
        ) : messages.length === 0 ? (
          <p className="mt-10 text-center text-[13px] text-ink-muted">
            {oversight ? "No messages in this chat." : "No messages yet. Say hello."}
          </p>
        ) : (
          groupMessagesByDay(messages).map((g) => (
            <section key={g.day}>
              <div className="my-3 text-center font-mono text-micro tracking-[0.12em] text-ink-faint">{chatDayLabel(g.day).toUpperCase()}</div>
              {g.messages.map((m) => {
                const mine = !oversight && m.senderId === myId;
                const sender = m.senderId ? byId.get(m.senderId) : undefined;
                return (
                  <div key={m.id} className={`mb-2 flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div
                      className="max-w-[min(520px,80%)] rounded-xl px-3 py-2 text-[13.5px] leading-relaxed"
                      style={mine ? { background: "var(--accent-deep)", color: "#fff" } : { background: "#F1F5F2" }}
                    >
                      {oversight && <div className="mb-0.5 text-[11px] font-semibold opacity-80">{sender?.name ?? "Former member"}</div>}
                      {m.filePath && <ChatFile message={m} mine={mine} />}
                      {m.body && <p className="whitespace-pre-line break-words">{m.body}</p>}
                      <div className={`mt-0.5 text-right text-[10.5px] ${mine ? "text-white/70" : "text-ink-faint"}`}>{time(m.createdAt)}</div>
                    </div>
                  </div>
                );
              })}
            </section>
          ))
        )}
        <div ref={bottom} />
      </div>

      {!oversight && (
        canReply ? (
          <div className="border-t border-line bg-white px-5 py-3">
            {file && (
              <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-muted">
                <span aria-hidden>📎</span>
                <span className="truncate">{file.name} · {formatFileSize(file.size)}</span>
                <button type="button" className="text-warn-ink hover:underline" onClick={() => setFile(null)} disabled={sending}>Remove</button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <input ref={fileInput} type="file" className="hidden" onChange={pickFile} />
              <Button type="button" onClick={() => fileInput.current?.click()} disabled={sending} aria-label="Attach a file">📎</Button>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
                maxLength={CHAT_BODY_MAX}
                rows={2}
                placeholder="Write a message"
                aria-label="Message"
                className="min-h-[42px] flex-1 resize-none rounded-md border border-[#D3DAD5] px-3 py-2 text-[13.5px] outline-none focus:border-forest"
              />
              <Button variant="primary" type="button" onClick={() => void send()} disabled={sending || (!chatDraftBody(draft) && !file)}>
                {sending ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        ) : (
          <p className="border-t border-line bg-white px-5 py-3 text-[12.5px] text-ink-muted">
            You can read this chat but can no longer reply: the school has changed who teaches this learner.
          </p>
        )
      )}
    </div>
  );
}

/** A picture shows inline; anything else is a link that opens a short-lived signed URL. */
function ChatFile({ message, mine }: { message: ChatMessage; mine: boolean }) {
  const isImage = message.mimeType?.startsWith("image/");
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage || !message.filePath) return;
    let alive = true;
    chatFileUrl(message.filePath).then((u) => { if (alive) setSrc(u); }).catch(() => {});
    return () => { alive = false; };
  }, [isImage, message.filePath]);

  async function open() {
    if (!message.filePath) return;
    // Opened before the await so popup blockers see it as the click's own window.
    const w = window.open("", "_blank");
    if (w) w.opener = null;
    try {
      const url = await chatFileUrl(message.filePath, message.fileName ?? undefined);
      if (w) w.location.href = url;
      else window.location.href = url;
    } catch {
      w?.close();
    }
  }

  if (isImage && src) {
    return (
      <button type="button" onClick={() => void open()} className="mb-1 block">
        <img src={src} alt={message.fileName ?? "Picture"} className="max-h-[260px] rounded-lg object-cover" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void open()}
      className={`mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] ${mine ? "bg-white/15" : "bg-white"}`}
    >
      <span aria-hidden>📎</span>
      <span className="min-w-0 truncate font-medium">{message.fileName}</span>
      {message.sizeBytes != null && <span className="shrink-0 opacity-70">{formatFileSize(message.sizeBytes)}</span>}
    </button>
  );
}
