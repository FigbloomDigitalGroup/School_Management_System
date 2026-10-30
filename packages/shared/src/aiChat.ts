import { supabase } from "./supabase";
import { invokeEdge } from "./edge";
import { attachmentName, CHAT_MAX_ATTACHMENTS, type ChatAttachment } from "./bloomAttachments";

/**
 * Bloom chat: a general AI assistant for the office and teachers. The reply
 * comes from the ai-assist edge function's "chat" task, which stores nothing;
 * the conversation is saved here, as the person, in their own ai_chats /
 * ai_chat_messages rows (20261027060000_ai_chat_workspace.sql), which only
 * they can read.
 *
 * Bloom can search the web for chat (20261029100000_bloom_web_search.sql):
 * an answer then carries its sources, saved with it, and [^n] markers in its
 * text where it cites the nth one. The per-chat "Search the web" toggle is
 * ai_chats.web_search.
 *
 * A question can carry files (bloomAttachments.ts): they go to the edge
 * function with that question only, and the saved message keeps just their
 * names (ai_chat_messages.attachments, 20261102100000_bloom_chat_attachments.sql).
 */

export interface AiChat { id: string; title: string; updated_at: string; web_search: boolean }
export interface AiChatTurn { role: "user" | "assistant"; content: string }
/** A page an answer cites. */
export interface AiChatSource { title: string; url: string }
/** A saved turn. `attachments` are the names of files sent with a question; their content isn't kept. */
export interface AiChatMessage extends AiChatTurn { id: string; created_at: string; sources: AiChatSource[]; attachments: string[] }
export interface AiChatReply { text: string; sources: AiChatSource[] }

/** Mirrors the ai_chat_messages.sources check and the edge function's cap. */
const MAX_SOURCES = 20;

/**
 * Sources as the edge function sent them or a saved row holds them, cut down
 * to what's safe to show: http(s) addresses only (never javascript: or data:)
 * and a title of plain text. Their order is kept, since [^n]
 * markers count from it; an entry that isn't safe becomes a gap the screen
 * leaves out, so the numbers after it still match.
 */
export function parseChatSources(raw: unknown): AiChatSource[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_SOURCES).map((s): AiChatSource => {
    const url = typeof s?.url === "string" ? s.url.trim() : "";
    if (url.length > 2000 || !/^https?:\/\/[^\s/?#]+[^\s]*$/i.test(url)) return { title: "", url: "" };
    const title = typeof s?.title === "string" ? s.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    return { title: title || sourceHost(url), url };
  });
}

/** "www.education.go.ke" -> "education.go.ke", for a chip's small print. */
export function sourceHost(url: string): string {
  return (/^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url)?.[1] ?? "").replace(/^www\./i, "").toLowerCase();
}

/** A long answer, or a busy model, can take a while. */
const CHAT_TIMEOUT_MS = 120_000;
/** Mirrors the edge function's per-message cap (tasks.ts CHAT_MAX_CHARS). */
export const CHAT_MESSAGE_MAX = 12_000;
/** Turns sent with each question; the edge function keeps the newest within its own size cap. */
const CHAT_SEND_TURNS = 40;

/**
 * Bloom's next reply. `tenantId` lets an org admin acting inside a member
 * school use that school's Bloom; for everyone else the function ignores it.
 * `webSearch: false` (the chat's toggle off) means Bloom can't search; on, it
 * still can't if the school has switched web search off. `attachments` go
 * with the last question.
 */
export async function askBloomChat(
  turns: AiChatTurn[], opts: { tenantId?: string; signal?: AbortSignal; webSearch?: boolean; attachments?: ChatAttachment[] } = {},
): Promise<AiChatReply> {
  const attachments = (opts.attachments ?? []).map((a) => a.kind === "text"
    ? { name: a.name, kind: a.kind, text: a.text }
    : { name: a.name, kind: a.kind, data: a.data });
  const { result } = await invokeEdge<{ result: { text: string; sources?: unknown } }>(
    "ai-assist",
    {
      task: "chat",
      payload: { messages: turns.slice(-CHAT_SEND_TURNS), webSearch: opts.webSearch !== false, ...(attachments.length ? { attachments } : {}) },
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts.signal },
  );
  return { text: result.text, sources: parseChatSources(result.sources) };
}

/** A sidebar title from the first question: its first line, cut at a word. */
export function chatTitleFrom(question: string): string {
  const line = question.trim().split(/\r?\n/).find((l) => l.trim())?.trim().replace(/\s+/g, " ") ?? "";
  if (!line) return "New chat";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}

// ------------------------------------------------------------------ saved chats

export async function fetchAiChats(): Promise<AiChat[]> {
  const { data, error } = await supabase().from("ai_chats").select("id, title, updated_at, web_search").order("updated_at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as AiChat[];
}

type MessageRow = Omit<AiChatMessage, "sources" | "attachments"> & { sources: unknown; attachments: unknown };

/** Attachment names as a saved row holds them: text only, at most CHAT_MAX_ATTACHMENTS. */
export function parseAttachmentNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is string => typeof n === "string" && n.trim() !== "").slice(0, CHAT_MAX_ATTACHMENTS).map(attachmentName);
}

const asMessage = (r: MessageRow): AiChatMessage => ({ ...r, sources: parseChatSources(r.sources), attachments: parseAttachmentNames(r.attachments) });
const MESSAGE_COLUMNS = "id, role, content, created_at, sources, attachments";

export async function fetchAiChatMessages(chatId: string): Promise<AiChatMessage[]> {
  const { data, error } = await supabase().from("ai_chat_messages")
    .select(MESSAGE_COLUMNS).eq("chat_id", chatId).order("created_at").order("id");
  if (error) throw new Error(error.message);
  return ((data ?? []) as MessageRow[]).map(asMessage);
}

export async function createAiChat(tenantId: string, title: string, webSearch = true): Promise<AiChat> {
  const { data, error } = await supabase().from("ai_chats")
    .insert({ tenant_id: tenantId, title: title.slice(0, 120) || "New chat", web_search: webSearch })
    .select("id, title, updated_at, web_search").single();
  if (error) throw new Error(error.message);
  return data as AiChat;
}

/** Remembers the chat's "Search the web" toggle. */
export async function setAiChatWebSearch(chatId: string, on: boolean): Promise<void> {
  const { error } = await supabase().from("ai_chats").update({ web_search: on }).eq("id", chatId);
  if (error) throw new Error(error.message);
}

export async function renameAiChat(chatId: string, title: string): Promise<void> {
  const t = title.trim().slice(0, 120);
  if (!t) throw new Error("Give the chat a name.");
  const { error } = await supabase().from("ai_chats").update({ title: t }).eq("id", chatId);
  if (error) throw new Error(error.message);
}

export async function deleteAiChat(chatId: string): Promise<void> {
  const { error } = await supabase().from("ai_chats").delete().eq("id", chatId);
  if (error) throw new Error(error.message);
}

/** Saves turns in order; created_at is stamped one millisecond apart so a question always sorts before its answer. */
export async function saveAiChatTurns(chatId: string, turns: (AiChatTurn & { sources?: AiChatSource[]; attachments?: string[] })[]): Promise<AiChatMessage[]> {
  if (!turns.length) return [];
  const base = Date.now();
  const { data, error } = await supabase().from("ai_chat_messages").insert(
    turns.map((t, i) => ({
      chat_id: chatId, role: t.role, content: t.content, created_at: new Date(base + i).toISOString(),
      // an answer's sources, so the saved chat shows them too; null when it has none
      sources: t.sources?.length ? t.sources : null,
      // a question's file names, never their content; null when it had none
      attachments: t.role === "user" && t.attachments?.length ? t.attachments.slice(0, CHAT_MAX_ATTACHMENTS).map(attachmentName) : null,
    })),
  ).select(MESSAGE_COLUMNS);
  if (error) throw new Error(error.message);
  return ((data ?? []) as MessageRow[]).map(asMessage).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Drops the last answer (Regenerate), so the question can be asked again. */
export async function deleteAiChatMessage(messageId: string): Promise<void> {
  const { error } = await supabase().from("ai_chat_messages").delete().eq("id", messageId);
  if (error) throw new Error(error.message);
}
