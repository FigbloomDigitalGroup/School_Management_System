/**
 * Figbloom Schools' side of the Figbloom platform's registration (design
 * 5.8). Called by pg_cron through pg_net (20261104900000) and by Figbloom
 * staff by hand, always with the project's service-role key:
 *
 *   Authorization: Bearer <service-role key>
 *
 * compared in constant time with SUPABASE_SERVICE_ROLE_KEY (deployed with
 * JWT verification off, so the check is this function's own, and works for
 * the legacy JWT key and the newer secret keys alike).
 *
 * Actions (POST, JSON body):
 *   {"action":"sync"}                 send what is due in platform_sync_queue (every minute)
 *   {"action":"reconcile"}            ask the platform about organisations whose decision might have been missed (hourly; after switch-on only)
 *   {"action":"backfill"}             report what the backfill would do (a dry run: the default)
 *   {"action":"backfill","dry_run":false}  do it: create each lone school's own organisation, register every organisation with today's status, then every school
 *   {"action":"register_webhook"}     tell the platform to send decisions to platform-decisions (or {"url": "https://..."})
 *
 * Function secrets: PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET,
 * PLATFORM_TOKEN_URL, PLATFORM_API_URL (_shared/platformClient.ts); optional
 * PLATFORM_WEBHOOK_URL. Without the first four, every action but the dry run
 * answers 503 and nothing is sent; the queue waits.
 *
 * Deploy: supabase functions deploy platform-sync --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/daraja.ts";
import { PlatformClient, platformConfigFromEnv, PlatformError } from "../_shared/platformClient.ts";
import { backfill, decisionWebhookUrl, processQueue, reconcile } from "../_shared/platformSync.ts";

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** null when the PLATFORM_* secrets aren't set. */
  client: PlatformClient | null;
  /** SUPABASE_SERVICE_ROLE_KEY: the only key accepted. */
  serviceKey: string | undefined;
  env?: { get(name: string): string | undefined };
}

export async function handle(req: Request, { admin, client, serviceKey, env = Deno.env }: Deps): Promise<Response> {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!serviceKey || !bearer || !secretsMatch(bearer, serviceKey)) return fail(401, "unauthorized", "Use the project's service-role key.");
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  const raw = await req.text();
  if (raw.trim()) { try { body = JSON.parse(raw); } catch { return fail(400, "invalid_json", "The body must be JSON."); } }
  const action = body?.action ?? "sync";

  const needClient = () => fail(503, "platform_not_configured", "Set PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET, PLATFORM_TOKEN_URL and PLATFORM_API_URL first.");

  try {
    switch (action) {
      case "sync":
        if (!client) return needClient();
        return json(await processQueue(admin, client, { limit: clampLimit(body.limit) }));
      case "reconcile":
        if (!client) return needClient();
        return json(await reconcile(admin, client, { limit: clampLimit(body.limit) }));
      case "backfill": {
        const dryRun = body.dry_run !== false;
        if (!dryRun && !client) return needClient();
        return json(await backfill(admin, client, { dryRun }));
      }
      case "register_webhook": {
        if (!client) return needClient();
        const url = decisionWebhookUrl(env, body.url);
        if (!url) return fail(400, "invalid_url", "The webhook address must be an https URL (set PLATFORM_WEBHOOK_URL, or send url).");
        await client.putDecisionWebhook(url);
        return json({ ok: true, url });
      }
      default:
        return fail(400, "unknown_action", 'The action must be "sync", "reconcile", "backfill" or "register_webhook".');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`platform-sync: ${action} failed:`, message);
    if (err instanceof PlatformError) return fail(502, "platform_error", `The platform answered: ${err.code} (${err.status}).`);
    return fail(500, "internal_error", `Could not ${action}. Try again.`);
  }
}

const clampLimit = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

if (import.meta.main) {
  // one client per isolate, so its token is reused across calls
  const config = platformConfigFromEnv();
  const client = config ? new PlatformClient(config) : null;
  Deno.serve((req) => {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    return handle(req, { admin, client, serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") });
  });
}
