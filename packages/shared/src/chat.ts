import { supabase } from "./supabase";
import { mimeForFile, safeFileName } from "./materials";
import type { Role } from "./types";
import { uploadFile } from "./storageUpload";
import type { UploadableFile } from "./uploads";

/**
 * One-to-one chats between families and the school, and between staff
 * (supabase/migrations/20261027020000_chat.sql). Who may talk to whom is
 * decided by the database (may_talk, the same rule calls use;
 * 20261028200000): staff with staff, a parent with their own child, their
 * child's teachers, or the school office. These helpers only
 * call the functions and tables it exposes. The school's administrators can
 * read every chat, which the screens say on every thread (CHAT_OVERSIGHT_NOTICE).
 */

export const CHAT_FILES_BUCKET = "chat-files";
export const CHAT_BODY_MAX = 4000;

export const CHAT_OVERSIGHT_NOTICE = "The school's administrators can read this chat.";

export interface ChatContact {
  profileId: string;
  name: string;
  role: Role;
  avatarUrl: string | null;
  /** Why this person is here: "Amani's class teacher", "Parent of Baraka (Form 2 East)". */
  detail: string;
}

export interface ConversationSummary {
  id: string;
  otherId: string;
  otherName: string;
  otherRole: Role;
  otherAvatarUrl: string | null;
  lastMessageAt: string | null;
  lastBody: string | null;
  lastSenderId: string | null;
  unread: number;
  /** False once the pair may no longer talk (a teacher moved off the class): the thread is read-only. */
  canReply: boolean;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string | null;
  body: string | null;
  filePath: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

export interface ChatPerson {
  profileId: string;
  name: string;
  role: Role;
  avatarUrl: string | null;
}

/** A conversation as the office's oversight screen lists it. */
export interface SchoolConversation {
  id: string;
  a: Pick<ChatPerson, "profileId" | "name" | "role">;
  b: Pick<ChatPerson, "profileId" | "name" | "role">;
  lastMessageAt: string;
  messageCount: number;
  lastBody: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  body: string | null;
  file_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
}

const MESSAGE_COLUMNS = "id, conversation_id, sender_id, body, file_path, file_name, mime_type, size_bytes, created_at";

export function messageFromRow(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    body: r.body,
    filePath: r.file_path,
    fileName: r.file_name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------- pure helpers

// The chat-files bucket's allow-list: a narrower set than learning-media's.
const CHAT_MIME_TYPES = new Set([
  "application/pdf", "text/plain", "text/csv", "application/rtf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet",
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/webm", "video/quicktime", "video/3gpp",
  "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/ogg", "audio/webm",
]);

/** The type to upload a file as, or null when the chat bucket won't take it. */
export function chatMimeForFile(file: { name: string; type?: string }): string | null {
  const mime = mimeForFile(file);
  return mime && CHAT_MIME_TYPES.has(mime) ? mime : null;
}

/** Where a chat file lives. The database checks it's under the conversation's own folder. */
export function chatFilePath(tenantId: string, conversationId: string, fileName: string): string {
  return `${tenantId}/${conversationId}/${Date.now()}-${safeFileName(fileName)}`;
}

/** What a draft would send: trimmed text, or null when there's nothing to say. */
export function chatDraftBody(text: string): string | null {
  const t = text.trim();
  return t ? t : null;
}

/** One line under a name in the chat list: "You: see you Friday", or the file's name. */
export function conversationPreview(c: Pick<ConversationSummary, "lastBody" | "lastSenderId">, myId: string): string {
  if (!c.lastBody) return "No messages yet";
  const line = c.lastBody.split("\n")[0] ?? "";
  return c.lastSenderId === myId ? `You: ${line}` : line;
}

const ROLE_WORD: Partial<Record<Role, string>> = {
  school_admin: "School office",
  teacher: "Teacher",
  driver: "Driver",
  parent: "Parent",
  student: "Learner",
};

export function chatRoleWord(role: Role): string {
  return ROLE_WORD[role] ?? "Staff";
}

/** Local calendar day, for the "Today" / "Mon 21 Oct" separators in a thread. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Messages in order, split wherever the day changes. */
export function groupMessagesByDay<T extends Pick<ChatMessage, "createdAt">>(messages: T[]): { day: string; messages: T[] }[] {
  const out: { day: string; messages: T[] }[] = [];
  for (const m of messages) {
    const key = dayKey(m.createdAt);
    const last = out[out.length - 1];
    if (last && last.messages[0] && dayKey(last.messages[0].createdAt) === key) last.messages.push(m);
    else out.push({ day: m.createdAt, messages: [m] });
  }
  return out;
}

export function chatDayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (dayKey(iso) === dayKey(now.toISOString())) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Yesterday";
  return d.toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Adds a message that arrived over Realtime, once, keeping time order. */
export function mergeMessage(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  if (list.some((x) => x.id === m.id)) return list;
  return [...list, m].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------------------------------------------------------------- data

export async function fetchChatContacts(): Promise<ChatContact[]> {
  const { data, error } = await supabase().rpc("my_chat_contacts");
  if (error) throw new Error(error.message);
  return ((data ?? []) as { profile_id: string; full_name: string; role: Role; avatar_url: string | null; detail: string }[])
    .map((r) => ({ profileId: r.profile_id, name: r.full_name, role: r.role, avatarUrl: r.avatar_url, detail: r.detail }));
}

export async function fetchMyConversations(): Promise<ConversationSummary[]> {
  const { data, error } = await supabase().rpc("my_conversations");
  if (error) throw new Error(error.message);
  return ((data ?? []) as {
    conversation_id: string; other_id: string; other_name: string; other_role: Role; other_avatar_url: string | null;
    last_message_at: string | null; last_body: string | null; last_sender_id: string | null; unread: number; can_reply: boolean;
  }[]).map((r) => ({
    id: r.conversation_id,
    otherId: r.other_id,
    otherName: r.other_name,
    otherRole: r.other_role,
    otherAvatarUrl: r.other_avatar_url,
    lastMessageAt: r.last_message_at,
    lastBody: r.last_body,
    lastSenderId: r.last_sender_id,
    unread: r.unread,
    canReply: r.can_reply,
  }));
}

/** The caller's chat with this person, created the first time. Refused unless the pair may talk. */
export async function startConversation(otherProfileId: string): Promise<string> {
  const { data, error } = await supabase().rpc("start_conversation", { p_other: otherProfileId });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function fetchConversationPeople(conversationId: string): Promise<ChatPerson[]> {
  const { data, error } = await supabase().rpc("conversation_people", { p_conversation_id: conversationId });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { profile_id: string; full_name: string; role: Role; avatar_url: string | null }[])
    .map((r) => ({ profileId: r.profile_id, name: r.full_name, role: r.role, avatarUrl: r.avatar_url }));
}

export async function fetchChatMessages(conversationId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase()
    .from("chat_messages").select(MESSAGE_COLUMNS)
    .eq("conversation_id", conversationId)
    .order("created_at")
    .limit(1000);
  if (error) throw new Error(error.message);
  return ((data ?? []) as MessageRow[]).map(messageFromRow);
}

export interface ChatFileDraft { path: string; name: string; mimeType: string; sizeBytes: number }

export async function sendChatMessage(conversationId: string, body: string | null, file?: ChatFileDraft): Promise<ChatMessage> {
  const { data, error } = await supabase()
    .from("chat_messages")
    .insert({
      conversation_id: conversationId,
      body,
      file_path: file?.path ?? null,
      file_name: file?.name ?? null,
      mime_type: file?.mimeType ?? null,
      size_bytes: file?.sizeBytes ?? null,
    })
    .select(MESSAGE_COLUMNS)
    .single<MessageRow>();
  if (error) throw new Error(error.message);
  return messageFromRow(data);
}

/** Puts a file in the conversation's folder before its message is sent. */
export async function uploadChatFile(tenantId: string, conversationId: string, file: Blob & { name: string }, mimeType: string): Promise<ChatFileDraft> {
  return uploadChatBlob(tenantId, conversationId, { blob: file, name: file.name, mimeType });
}

/** The same, for a file the phone has read into a Blob (React Native has no File to give a name). */
export async function uploadChatBlob(tenantId: string, conversationId: string, file: UploadableFile): Promise<ChatFileDraft> {
  const path = chatFilePath(tenantId, conversationId, file.name);
  await uploadFile(CHAT_FILES_BUCKET, path, file);
  return { path, name: file.name, mimeType: file.mimeType, sizeBytes: file.blob.size };
}

/** Takes back a file whose message never got sent. */
export async function removeUnsentChatFile(path: string): Promise<void> {
  await supabase().storage.from(CHAT_FILES_BUCKET).remove([path]);
}

export async function chatFileUrl(path: string, download?: string): Promise<string> {
  const { data, error } = await supabase().storage
    .from(CHAT_FILES_BUCKET)
    .createSignedUrl(path, 3600, download ? { download } : undefined);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

export async function markConversationRead(conversationId: string): Promise<void> {
  const { error } = await supabase().rpc("mark_conversation_read", { p_conversation_id: conversationId });
  if (error) throw new Error(error.message);
}

export async function fetchChatUnreadCount(): Promise<number> {
  const { data, error } = await supabase().rpc("my_chat_unread_count");
  if (error) throw new Error(error.message);
  return (data as number | null) ?? 0;
}

/** Asks the chat-push edge function to tell the other person's phone. Best effort: a chat still works without push. */
export async function pushChatMessage(messageId: string): Promise<void> {
  await supabase().functions.invoke("chat-push", { body: { message_id: messageId } }).catch(() => {});
}

export async function fetchSchoolConversations(tenantId: string, studentId?: string | null): Promise<SchoolConversation[]> {
  const { data, error } = await supabase().rpc("school_conversations", { p_tenant_id: tenantId, p_student_id: studentId ?? null });
  if (error) throw new Error(error.message);
  return ((data ?? []) as {
    conversation_id: string; a_id: string; a_name: string; a_role: Role; b_id: string; b_name: string; b_role: Role;
    last_message_at: string; message_count: number; last_body: string | null;
  }[]).map((r) => ({
    id: r.conversation_id,
    a: { profileId: r.a_id, name: r.a_name, role: r.a_role },
    b: { profileId: r.b_id, name: r.b_name, role: r.b_role },
    lastMessageAt: r.last_message_at,
    messageCount: r.message_count,
    lastBody: r.last_body,
  }));
}

/**
 * New messages the caller can read (RLS decides), live. With a conversation
 * id, just that thread; without, everything in the school the caller can see,
 * which is what the sidebar badge listens to.
 */
export function subscribeChatMessages(
  scope: { conversationId: string } | { tenantId: string },
  onInsert: (m: ChatMessage) => void,
): () => void {
  const filter = "conversationId" in scope ? `conversation_id=eq.${scope.conversationId}` : `tenant_id=eq.${scope.tenantId}`;
  const channel = supabase()
    .channel(`chat-${filter}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages", filter }, (payload) => onInsert(messageFromRow(payload.new as MessageRow)))
    .subscribe();
  return () => { void supabase().removeChannel(channel); };
}
