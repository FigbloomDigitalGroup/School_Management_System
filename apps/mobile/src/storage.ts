import AsyncStorage from "@react-native-async-storage/async-storage";
import { WriteQueue, sendQueuedWrite } from "@figbloom/shared";

/**
 * Same queue as the web, different store. A driver's GPS pings survive a
 * force-quit because they are on disk, not in memory.
 */
export const queue = new WriteQueue(AsyncStorage, sendQueuedWrite);
