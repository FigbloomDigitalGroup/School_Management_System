import { supabase } from "./supabase";
import { conflictKeyFor, writeErrorFrom, type QueuedWrite } from "./queue";

/**
 * Sends one queued write to Supabase. The error says whether waiting can help
 * (no answer, a server in trouble) or the server refused the rows, which the
 * queue then sets aside instead of letting it block everything behind it.
 */
export async function sendQueuedWrite(w: QueuedWrite): Promise<void> {
  const { error, status } = await supabase().from(w.table).upsert(w.rows as never[], { onConflict: conflictKeyFor(w.table) });
  if (error) throw writeErrorFrom(error, status);
}
