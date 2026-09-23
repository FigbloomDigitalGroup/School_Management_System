import AsyncStorage from "@react-native-async-storage/async-storage";
import { WriteQueue, supabase, type QueuedWrite } from "@figbloom/shared";

/**
 * Same queue as the web, different store. A parent's half-finished payment or a
 * teacher's register survives a force-quit because it is on disk, not in memory.
 */
export const queue = new WriteQueue(AsyncStorage, async (w: QueuedWrite) => {
  const { error } = await supabase().from(w.table).upsert(w.rows as never[]);
  if (error) throw new Error(error.message);
});
