import type { Tx } from "../../db/sql.js";
import { forbidden, notFound, validationError } from "../../http/errors.js";
import type { PageInfo } from "../../http/pagination.js";
import { pageQuery, type PageInput } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";

export interface Conversation {
  id: string;
  tenant_id: string;
  pair_key: string;
  created_by: string | null;
  created_at: string;
  last_message_at: string | null;
  peer_user_id?: string;
}

export interface ChatMessage {
  id: string;
  tenant_id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

export async function assertMayTalk(tx: Tx, tenantId: string, a: string, b: string): Promise<void> {
  const res = await tx.query<{ ok: boolean }>(`SELECT public.may_talk($1, $2, $3) AS ok`, [tenantId, a, b]);
  if (!res.rows[0]?.ok) throw forbidden("These users may not chat");
}

export async function startConversation(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; peerUserId: string },
): Promise<Conversation> {
  if (input.actorUserId === input.peerUserId) throw validationError("Cannot start a conversation with yourself");
  await assertMayTalk(tx, input.tenantId, input.actorUserId, input.peerUserId);
  const keyRes = await tx.query<{ k: string }>(`SELECT public.chat_pair_key($1, $2) AS k`, [
    input.actorUserId,
    input.peerUserId,
  ]);
  const pairKey = keyRes.rows[0]!.k;
  const existing = await tx.query<Conversation>(
    `SELECT id, tenant_id, pair_key, created_by, created_at, last_message_at
       FROM conversations WHERE tenant_id = $1 AND pair_key = $2`,
    [input.tenantId, pairKey],
  );
  if (existing.rows[0]) {
    await tx.query(
      `INSERT INTO conversation_members (conversation_id, tenant_id, user_id)
       VALUES ($1, $2, $3), ($1, $2, $4)
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [existing.rows[0].id, input.tenantId, input.actorUserId, input.peerUserId],
    );
    return { ...existing.rows[0], peer_user_id: input.peerUserId };
  }

  const conv = await tx.query<Conversation>(
    `INSERT INTO conversations (tenant_id, pair_key, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, pair_key) DO NOTHING
     RETURNING id, tenant_id, pair_key, created_by, created_at, last_message_at`,
    [input.tenantId, pairKey, input.actorUserId],
  );
  let row = conv.rows[0];
  const createdNow = Boolean(row);
  if (!row) {
    const raced = await tx.query<Conversation>(
      `SELECT id, tenant_id, pair_key, created_by, created_at, last_message_at
         FROM conversations WHERE tenant_id = $1 AND pair_key = $2`,
      [input.tenantId, pairKey],
    );
    row = raced.rows[0]!;
  }
  await tx.query(
    `INSERT INTO conversation_members (conversation_id, tenant_id, user_id)
     VALUES ($1, $2, $3), ($1, $2, $4)
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [row.id, input.tenantId, input.actorUserId, input.peerUserId],
  );
  if (createdNow) {
    await recordSecurityEvent(tx, {
      eventType: "communications.chat.started",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { conversationId: row.id, peerUserId: input.peerUserId },
    });
  }
  return { ...row, peer_user_id: input.peerUserId };
}

export async function listMyConversations(
  tx: Tx,
  input: { tenantId: string; userId: string; limit: number; rawCursor?: unknown },
): Promise<{ conversations: Conversation[]; page: PageInfo }> {
  const page: PageInput = { limit: input.limit, rawCursor: input.rawCursor };
  const inner = `SELECT c.id, c.tenant_id, c.pair_key, c.created_by, c.created_at, c.last_message_at,
            coalesce(c.last_message_at, c.created_at) AS sort_ts,
            m2.user_id AS peer_user_id
       FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $2
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id <> $2
      WHERE c.tenant_id = $1`;
  const res = await pageQuery<Conversation & { peer_user_id: string; sort_ts: string }>(
    tx,
    inner,
    [input.tenantId, input.userId],
    {
      name: "chat_conversations_activity_desc",
      expr: "q.sort_ts",
      type: "timestamptz",
      dir: "desc",
    },
    page,
  );
  const conversations = res.rows.map(({ page_key: _pk, sort_ts: _st, ...rest }) => rest);
  return { conversations, page: res.page };
}

async function assertMember(tx: Tx, tenantId: string, conversationId: string, userId: string): Promise<void> {
  const res = await tx.query(
    `SELECT 1 FROM conversation_members WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [tenantId, conversationId, userId],
  );
  if (!res.rows[0]) throw notFound("Conversation not found");
}

export async function listMessages(
  tx: Tx,
  input: { tenantId: string; conversationId: string; userId: string; limit: number; rawCursor?: unknown },
): Promise<{ messages: ChatMessage[]; page: PageInfo }> {
  await assertMember(tx, input.tenantId, input.conversationId, input.userId);
  const page: PageInput = { limit: input.limit, rawCursor: input.rawCursor };
  const inner = `SELECT id, tenant_id, conversation_id, sender_id, body, created_at
       FROM chat_messages
      WHERE tenant_id = $1 AND conversation_id = $2`;
  const res = await pageQuery<ChatMessage>(
    tx,
    inner,
    [input.tenantId, input.conversationId],
    {
      name: "chat_messages_created_desc",
      expr: "q.created_at",
      type: "timestamptz",
      dir: "desc",
    },
    page,
  );
  const messages = res.rows.map(({ page_key: _pk, ...rest }) => rest);
  return { messages, page: res.page };
}

export async function sendMessage(
  tx: Tx,
  input: { tenantId: string; conversationId: string; senderId: string; body: string },
): Promise<ChatMessage> {
  await assertMember(tx, input.tenantId, input.conversationId, input.senderId);
  const peer = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2`,
    [input.conversationId, input.senderId],
  );
  const peerId = peer.rows[0]?.user_id;
  if (!peerId) throw notFound("Conversation not found");
  await assertMayTalk(tx, input.tenantId, input.senderId, peerId);

  const body = input.body.trim();
  if (!body) throw validationError("body is required");
  const res = await tx.query<ChatMessage>(
    `INSERT INTO chat_messages (tenant_id, conversation_id, sender_id, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, tenant_id, conversation_id, sender_id, body, created_at`,
    [input.tenantId, input.conversationId, input.senderId, body],
  );
  await tx.query(`UPDATE conversations SET last_message_at = now() WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.conversationId,
  ]);
  return res.rows[0]!;
}

export async function markConversationRead(
  tx: Tx,
  input: { tenantId: string; conversationId: string; userId: string },
): Promise<void> {
  await assertMember(tx, input.tenantId, input.conversationId, input.userId);
  await tx.query(
    `UPDATE conversation_members SET last_read_at = now()
      WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [input.tenantId, input.conversationId, input.userId],
  );
}
