import { supabase } from "./supabase";
import { invokeEdge } from "./edge";

/**
 * Bloom chat: a general AI assistant for the office and teachers. The reply
 * comes from the ai-assist edge function's "chat" task, which stores nothing;
 * the conversation is saved here, as the person, in their own ai_chats /
 * ai_chat_messages rows (20261027060000_ai_chat_workspace.sql), which only
 * they can read.
 */

export interface AiChat { id: string; title: string; updated_at: string }
export interface AiChatTurn { role: "user" | "assistant"; content: string }
export interface AiChatMessage extends AiChatTurn { id: string; created_at: string }

/** A long answer, or a busy model, can take a while. */
const CHAT_TIMEOUT_MS = 120_000;
/** Mirrors the edge function's per-message cap (tasks.ts CHAT_MAX_CHARS). */
export const CHAT_MESSAGE_MAX = 12_000;
/** Turns sent with each question; the edge function keeps the newest within its own size cap. */
const CHAT_SEND_TURNS = 40;

/**
 * Bloom's next reply. `tenantId` lets an org admin acting inside a member
 * school use that school's Bloom; for everyone else the function ignores it.
 */
export async function askBloomChat(turns: AiChatTurn[], opts: { tenantId?: string; signal?: AbortSignal } = {}): Promise<string> {
  const { result } = await invokeEdge<{ result: { text: string } }>(
    "ai-assist",
    { task: "chat", payload: { messages: turns.slice(-CHAT_SEND_TURNS) }, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) },
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts.signal },
  );
  return result.text;
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
  const { data, error } = await supabase().from("ai_chats").select("id, title, updated_at").order("updated_at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as AiChat[];
}

export async function fetchAiChatMessages(chatId: string): Promise<AiChatMessage[]> {
  const { data, error } = await supabase().from("ai_chat_messages")
    .select("id, role, content, created_at").eq("chat_id", chatId).order("created_at").order("id");
  if (error) throw new Error(error.message);
  return (data ?? []) as AiChatMessage[];
}

export async function createAiChat(tenantId: string, title: string): Promise<AiChat> {
  const { data, error } = await supabase().from("ai_chats")
    .insert({ tenant_id: tenantId, title: title.slice(0, 120) || "New chat" }).select("id, title, updated_at").single();
  if (error) throw new Error(error.message);
  return data as AiChat;
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
export async function saveAiChatTurns(chatId: string, turns: AiChatTurn[]): Promise<AiChatMessage[]> {
  if (!turns.length) return [];
  const base = Date.now();
  const { data, error } = await supabase().from("ai_chat_messages").insert(
    turns.map((t, i) => ({ chat_id: chatId, role: t.role, content: t.content, created_at: new Date(base + i).toISOString() })),
  ).select("id, role, content, created_at");
  if (error) throw new Error(error.message);
  return ((data ?? []) as AiChatMessage[]).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Drops the last answer (Regenerate), so the question can be asked again. */
export async function deleteAiChatMessage(messageId: string): Promise<void> {
  const { error } = await supabase().from("ai_chat_messages").delete().eq("id", messageId);
  if (error) throw new Error(error.message);
}
