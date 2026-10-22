/**
 * Every function a browser calls directly (via supabase.functions.invoke)
 * needs these on every response, or the browser's CORS preflight blocks the
 * real request before it ever reaches the function. Functions only ever
 * called server-to-server (mpesa-callback, by Safaricom) don't need this.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
