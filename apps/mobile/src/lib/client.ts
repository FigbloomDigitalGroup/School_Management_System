import AsyncStorage from "@react-native-async-storage/async-storage";
import { initSupabase, loadFilesService, loadFunctionsService } from "@figbloom/shared";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../env";

/**
 * Same factory as web, RN's own storage adapter and no URL session
 * detection (there is no URL on a phone to read a session out of).
 */
export const client = initSupabase({
  url: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  storage: AsyncStorage,
  detectSessionInUrl: false,
});

// Where files are kept (Supabase Storage or S3: the database's files_service row), looked up straight away so public file
// addresses are right from the first screen. A failure is retried by the first file operation.
void loadFilesService().catch(() => {});
// Where the edge functions are (the server's edge runtime or AWS Lambda: the database's functions_service row). A call made
// before this is read goes the old way, which works too.
void loadFunctionsService().catch(() => {});
