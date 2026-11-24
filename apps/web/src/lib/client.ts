import {
  backendKindFrom, initBackend, initSupabase, loadFilesService, loadFunctionsService, setApiTokenStore,
} from "@figbloom/shared";
import { createWebTokenStore } from "./apiTokenStore";

/**
 * Which backend this build talks to, chosen when it is built (FIG-1890): VITE_BACKEND=api for the new API
 * (apps/api, at VITE_API_URL), anything else for Supabase. A build is one or the other: the two have separate accounts.
 */
export const BACKEND = backendKindFrom(import.meta.env.VITE_BACKEND);

if (BACKEND === "api") {
  initBackend({ kind: "api", apiUrl: import.meta.env.VITE_API_URL });
  setApiTokenStore(createWebTokenStore());
} else {
  initSupabase({
    url: import.meta.env.VITE_SUPABASE_URL,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  });

  // Where files are kept (Supabase Storage or S3: the database's files_service row), looked up straight away so public file
  // addresses are right from the first screen. A failure is retried by the first file operation.
  void loadFilesService().catch(() => {});
  // Where the edge functions are (the server's edge runtime or AWS Lambda: the database's functions_service row). A call made
  // before this is read goes the old way, which works too.
  void loadFunctionsService().catch(() => {});
}
