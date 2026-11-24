import { sendQueuedApiWrite } from "./api/queueApi";
import { onApi } from "./backend";
import { supabase } from "./supabase";
import { conflictKeyFor, writeErrorFrom, type QueuedWrite } from "./queue";

/**
 * Sends one queued write: to Supabase, or on an API build to the new API (api/queueApi.ts: each held write is a call with
 * its own idempotency key). The error says whether waiting can help (no answer, a server in trouble) or the server refused
 * the write, which the queue then sets aside instead of letting it block everything behind it.
 */
export async function sendQueuedWrite(w: QueuedWrite): Promise<void> {
  if (onApi()) return sendQueuedApiWrite(w);
  const { error, status } = await supabase().from(w.table).upsert(w.rows as never[], { onConflict: conflictKeyFor(w.table) });
  if (error) throw writeErrorFrom(error, status);
}
