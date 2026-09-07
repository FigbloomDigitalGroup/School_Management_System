import { WriteQueue, supabase, type QueuedWrite } from "@figbloom/shared";

/** Web queue: localStorage behind the shared WriteQueue. */
export const queue = new WriteQueue(window.localStorage, async (w: QueuedWrite) => {
  const { error } = await supabase()
    .from(w.table)
    .upsert(w.rows as never[], { onConflict: w.table === "attendance" ? "student_id,taken_on" : undefined });
  if (error) throw new Error(error.message);
});

/** Try to drain whenever the browser says we are back. */
window.addEventListener("online", () => { void queue.flush(); });
