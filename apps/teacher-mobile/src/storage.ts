import AsyncStorage from "@react-native-async-storage/async-storage";
import { WriteQueue, sendQueuedWrite } from "@figbloom/shared";

/**
 * Same queue as the web, different store. A teacher's register survives a
 * force-quit because it is on disk, not in memory.
 */
export const queue = new WriteQueue(AsyncStorage, sendQueuedWrite);
