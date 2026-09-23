import AsyncStorage from "@react-native-async-storage/async-storage";
import { initSupabase } from "@figbloom/shared";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../env";

/**
 * Same factory as web and the parent/student/driver app, RN's own storage
 * adapter and no URL session detection (there is no URL on a phone to read
 * a session out of).
 */
export const client = initSupabase({
  url: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  storage: AsyncStorage,
  detectSessionInUrl: false,
});
