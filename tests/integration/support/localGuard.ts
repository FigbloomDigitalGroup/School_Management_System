/**
 * The integration tests sign in as real seeded users and read real rows, so they may only ever talk to a
 * Supabase running on this machine. Every client the harness creates goes through this check first.
 *
 * Only the exact loopback host names pass. "127.0.0.1.example.com", "localhost.example.com", a LAN address
 * and any *.supabase.co host are refused, as is a URL like "http://127.0.0.1@example.com" (its host is
 * example.com).
 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function assertLocalSupabaseUrl(rawUrl: string | undefined): URL {
  if (!rawUrl) {
    throw new Error(
      "Refusing to run: SUPABASE_URL (or VITE_SUPABASE_URL) is not set. Copy .env.example to .env and fill it from `npx supabase start`.",
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Refusing to run: "${rawUrl}" is not a valid URL.`);
  }

  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to run integration tests against "${url.hostname}". Only a local Supabase (127.0.0.1 or localhost) is allowed: never point these tests at the demo or any production project.`,
    );
  }

  return url;
}
