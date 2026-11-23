import { initSupabase, loadFilesService, loadFunctionsService } from "@figbloom/shared";

export const client = initSupabase({
  url: import.meta.env.VITE_SUPABASE_URL,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
});

// Where files are kept (Supabase Storage or S3: the database's files_service row), looked up straight away so public file
// addresses are right from the first screen. A failure is retried by the first file operation.
void loadFilesService().catch(() => {});
// Where the edge functions are (the server's edge runtime or AWS Lambda: the database's functions_service row). A call made
// before this is read goes the old way, which works too.
void loadFunctionsService().catch(() => {});
