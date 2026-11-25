import type { ChatMessage, ChatPerson, ConversationSummary } from "../chat";
import { NotOnApiError } from "../capabilities";
import type { Role } from "../types";
import { apiClient } from "./client";
import { familyChatDirectory, staffDirectory, type Directory, type DirectoryPerson } from "./directoryApi";
import { API_PAGE_LIMIT } from "./paging";
import { activeTenantId } from "./peopleApi";
import { POLL_MS, pollNewItems, startPolling } from "./poll";
import { settlePool } from "./pool";
import type { components } from "./schema";

/**
 * Chat on apps/api: the API side of chat.ts.
 *
 * What the API gives (apps/api/src/modules/communications/chat.ts), and what is done about the rest:
 *  - A conversation is two people. The list answers `peer_user_id` and `last_message_at`, no name, no last message, no unread
 *    count. The name comes from the staff directory when the person may read it (a school admin, the People area), else the
 *    chat is shown as "Someone at the school". The preview is the newest message of each of the 30 latest chats (one small
 *    request each). The unread count is not known, so it is 0 and the screens do not show one (chatCapabilities).
 *  - There is no list of people to start a chat with. Staff with an account are offered when the staff list is readable;
 *    otherwise the picker says it is not on the new system yet. Who may talk to whom is `may_talk` on the server: staff with
 *    staff, a parent with the school office; a refused pair is a 403 on the first message.
 *  - A message is text only (no files), newest first when listed, with no `since`: a thread is the newest 1,000 messages, and
 *    polling asks for the newest 50.
 *  - Nobody can read a chat they are not in, the office included: there is no oversight read.
 *  - There is no realtime, so `subscribeChatMessages` polls (poll.ts).
 */

type ApiConversation = components["schemas"]["ChatConversation"];
type ApiMessage = components["schemas"]["ChatMessage"];

export const UNKNOWN_PERSON = "Someone at the school";
/** The thread opens on the newest this many messages, as Supabase's thread read stopped at 1,000. */
export const THREAD_MESSAGES = 1_000;
/** A poll of an open thread asks for this many newest messages. */
export const POLL_MESSAGES = 50;
/** Chats whose last message is looked up for the list's preview. */
export const PREVIEW_CHATS = 30;

export function messageFromApi(m: ApiMessage): ChatMessage {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    body: m.body,
    filePath: null,
    fileName: null,
    mimeType: null,
    sizeBytes: null,
    createdAt: m.created_at,
  };
}

function conversationFrom(c: ApiConversation, person: DirectoryPerson | undefined, last: ApiMessage | undefined): ConversationSummary {
  return {
    id: c.id,
    otherId: c.peer_user_id ?? "",
    otherName: person?.name ?? UNKNOWN_PERSON,
    otherRole: person?.role ?? "staff",
    otherAvatarUrl: null,
    lastMessageAt: c.last_message_at ?? null,
    lastBody: last?.body ?? null,
    lastSenderId: last?.sender_id ?? null,
    unread: 0,
    canReply: true,
    nameKnown: person !== undefined,
  };
}

async function conversationPage(tenantId: string, cursor: string | undefined, signal?: AbortSignal) {
  return apiClient().get("/v1/tenants/{tenantId}/chat/conversations", {
    path: { tenantId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId, signal,
  });
}

/** Every conversation of the caller, newest activity first (the order the API gives). */
async function listConversations(tenantId: string): Promise<ApiConversation[]> {
  const all: ApiConversation[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await conversationPage(tenantId, cursor);
    all.push(...r.conversations);
    cursor = r.page.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return all;
}

async function newestMessages(tenantId: string, conversationId: string, limit: number, signal?: AbortSignal): Promise<ApiMessage[]> {
  const r = await apiClient().get("/v1/tenants/{tenantId}/chat/conversations/{conversationId}/messages", {
    path: { tenantId, conversationId }, query: { limit }, tenantId, signal,
  });
  return r.messages;
}

function chatDirectoryFor(tenantId: string, role?: Role): Promise<Directory | null> {
  return role === "parent" ? familyChatDirectory(tenantId) : staffDirectory(tenantId);
}

export async function apiFetchMyConversations(role?: Role): Promise<ConversationSummary[]> {
  const tenantId = activeTenantId();
  const [conversations, directory] = await Promise.all([listConversations(tenantId), chatDirectoryFor(tenantId, role)]);
  const withMessages = conversations.filter((c) => c.last_message_at).slice(0, PREVIEW_CHATS);
  const lasts = await settlePool(withMessages, 4, async (c) => (await newestMessages(tenantId, c.id, 1))[0]);
  const lastOf = new Map<string, ApiMessage | undefined>();
  withMessages.forEach((c, i) => { const r = lasts[i]; if (r?.ok) lastOf.set(c.id, r.value); });
  return conversations.map((c) => conversationFrom(c, c.peer_user_id ? directory?.get(c.peer_user_id) : undefined, lastOf.get(c.id)));
}

export interface ApiChatContact {
  userId: string;
  name: string;
  role: Role;
  title: string | null;
}

/** The staff this person may start a chat with: those with an account, other than themselves. */
export async function apiFetchChatContacts(role?: Role): Promise<ApiChatContact[]> {
  const tenantId = activeTenantId();
  const directory = await chatDirectoryFor(tenantId, role);
  if (!directory) throw new NotOnApiError("A list of people to chat with");
  const me = apiClient().session()?.userId;
  return [...directory.values()]
    .filter((p) => p.active && p.userId !== me)
    .map((p) => ({ userId: p.userId, name: p.name, role: p.role, title: p.title }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function apiStartConversation(peerUserId: string): Promise<string> {
  const tenantId = activeTenantId();
  const r = await apiClient().post("/v1/tenants/{tenantId}/chat/conversations", { path: { tenantId }, body: { peer_user_id: peerUserId }, tenantId });
  return r.conversation.id;
}

/** The other person of a chat. (The API has no "one conversation" read, so this finds it in the caller's list.) */
export async function apiFetchConversationPeople(conversationId: string, role?: Role): Promise<ChatPerson[]> {
  const tenantId = activeTenantId();
  const [conversations, directory] = await Promise.all([listConversations(tenantId), chatDirectoryFor(tenantId, role)]);
  const c = conversations.find((x) => x.id === conversationId);
  if (!c?.peer_user_id) return [];
  const person = directory?.get(c.peer_user_id);
  return [{ profileId: c.peer_user_id, name: person?.name ?? UNKNOWN_PERSON, role: person?.role ?? "staff", avatarUrl: null }];
}

/** The newest THREAD_MESSAGES messages, oldest first. */
export async function apiFetchChatMessages(conversationId: string): Promise<ChatMessage[]> {
  const tenantId = activeTenantId();
  const all: ApiMessage[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50 && all.length < THREAD_MESSAGES; i++) {
    const r = await apiClient().get("/v1/tenants/{tenantId}/chat/conversations/{conversationId}/messages", {
      path: { tenantId, conversationId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId,
    });
    all.push(...r.messages);
    cursor = r.page.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return all.slice(0, THREAD_MESSAGES).reverse().map(messageFromApi);
}

export async function apiSendChatMessage(conversationId: string, body: string | null, hasFile: boolean): Promise<ChatMessage> {
  if (hasFile) throw new NotOnApiError("Sending a file in a chat");
  const text = body?.trim();
  if (!text) throw new Error("Write a message first.");
  const tenantId = activeTenantId();
  const r = await apiClient().post("/v1/tenants/{tenantId}/chat/conversations/{conversationId}/messages", {
    path: { tenantId, conversationId }, body: { body: text }, tenantId,
  });
  return messageFromApi(r.message);
}

export async function apiMarkConversationRead(conversationId: string): Promise<void> {
  const tenantId = activeTenantId();
  await apiClient().post("/v1/tenants/{tenantId}/chat/conversations/{conversationId}/read", { path: { tenantId, conversationId }, tenantId });
}

// ---------------------------------------------------------------- polling

/** One open thread: its newest messages every few seconds. The first answer is reported too, so a message that came in while the thread was loading is not lost; a thread ignores the ones it has. */
export function apiPollThread(conversationId: string, onInsert: (m: ChatMessage) => void): () => void {
  const tenantId = activeTenantId();
  return pollNewItems(
    async (signal) => (await newestMessages(tenantId, conversationId, POLL_MESSAGES, signal)).reverse().map(messageFromApi),
    (m) => m.id,
    onInsert,
    { intervalMs: POLL_MS.thread, emitFirst: true },
  );
}

/**
 * Any chat of the school's caller: when a conversation's `last_message_at` moves, its newest message is read and
 * reported. Used by the chat list, which only wants to reload.
 */
export function apiPollActivity(tenantId: string, onInsert: (m: ChatMessage) => void): () => void {
  let known: Map<string, string | null> | null = null;
  return startPolling(async (signal) => {
    const page = await conversationPage(tenantId, undefined, signal);
    const next = new Map(page.conversations.map((c) => [c.id, c.last_message_at ?? null] as const));
    if (known) {
      for (const c of page.conversations) {
        if (!c.last_message_at || known.get(c.id) === c.last_message_at) continue;
        const [latest] = await newestMessages(tenantId, c.id, 1, signal);
        if (signal.aborted) return;
        if (latest) onInsert(messageFromApi(latest));
      }
    }
    known = next;
  }, { intervalMs: POLL_MS.live });
}
