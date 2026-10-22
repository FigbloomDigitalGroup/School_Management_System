import { WriteQueue, conflictKeyFor, supabase, type QueuedWrite } from "@figbloom/shared";

/** Web queue: localStorage behind the shared WriteQueue. */
export const queue = new WriteQueue(window.localStorage, async (w: QueuedWrite) => {
  const { error } = await supabase()
    .from(w.table)
    .upsert(w.rows as never[], { onConflict: conflictKeyFor(w.table) });
  if (error) throw new Error(error.message);
});

/** Try to drain whenever the browser says we are back. */
window.addEventListener("online", () => { void queue.flush(); });
