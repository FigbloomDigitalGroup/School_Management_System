/**
 * Figbloom Schools' side of the Figbloom platform's registration (design
 * 5.8). Called by pg_cron through pg_net (20261104900000, 20261104930000) and
 * by Figbloom staff by hand. Deployed with JWT verification off: the check
 * is this function's own. It accepts, compared in constant time:
 *
 *   PLATFORM_SYNC_KEY (a function secret, at least 32 characters): the key
 *     to use. pg_cron sends it from the Vault secret platform_service_key.
 *   any key the runtime injected: SUPABASE_SERVICE_ROLE_KEY (legacy) or a
 *     value in SUPABASE_SECRET_KEYS (sb_secret_...).
 *
 * in any of these headers:
 *
 *   x-platform-sync-key: <key>        (preferred: nothing in front rewrites it)
 *   Authorization: Bearer <key>
 *   apikey: <key>
 *
 * On Supabase Cloud the injected SUPABASE_SERVICE_ROLE_KEY did not match the
 * dashboard's legacy service_role key (2026-11-03), so PLATFORM_SYNC_KEY is
 * the one to rely on. A refusal logs what was presented (kind and length, a
 * JWT's public claims) and what is configured, never the keys.
 *
 * Actions (POST, JSON body):
 *   {"action":"sync"}                 send what is due in platform_sync_queue (every minute)
 *   {"action":"reconcile"}            ask the platform about organisations whose decision might have been missed (hourly; after switch-on only)
 *   {"action":"backfill"}             report what the backfill would do (a dry run: the default)
 *   {"action":"backfill","dry_run":false}  do it: create each lone school's own organisation, register every organisation with today's status, then every school
 *   {"action":"register_webhook"}     tell the platform to send decisions to platform-decisions (or {"url": "https://..."})
 *   {"action":"staff_backfill","school_id":"<tenants.id>"}  list the school's current staff (a dry run: the default)
 *   {"action":"staff_backfill","school_id":"...","dry_run":false}  queue schools.staff.created for each; the next sync sends them
 *                                    (409 while PLATFORM_STAFF_EVENTS_ENABLED is off, or the platform doesn't know the school)
 *   {"action":"register_event_webhook"}  tell the platform to send events (hr.employee.left, hr.leave.*) to platform-events (or {"url": "https://..."})
 *   {"action":"leave_history_import","school_id":"<tenants.id>"}  list the school's approved Schools leave not yet in HR (a dry run: the default)
 *   {"action":"leave_history_import","school_id":"...","dry_run":false}  send it to HR's leave history import and mark it exported
 *                                    (linked staff only; idempotent: a second run sends only what is left; needs HR_MY_HR_URL)
 *
 * The queue carries staff events too (20261105600000): sync sends them as
 * POST /events after the organisations and schools.
 *
 * Function secrets: PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET,
 * PLATFORM_TOKEN_URL, PLATFORM_API_URL (_shared/platformClient.ts); optional
 * PLATFORM_WEBHOOK_URL and PLATFORM_EVENTS_URL; HR_MY_HR_URL (HR's integration
 * base, as for my-hr) for leave_history_import. Without the first four, every
 * action but the dry runs answers 503 and nothing is sent; the queue waits.
 *
 * Deploy: supabase functions deploy platform-sync --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { describeKey, injectedServerKeys, matchesAnyKey } from "../_shared/serviceKeys.ts";
import { PlatformClient, platformConfigFromEnv, PlatformError } from "../_shared/platformClient.ts";
import { backfill, decisionWebhookUrl, eventWebhookUrl, processQueue, reconcile, staffBackfill } from "../_shared/platformSync.ts";
import { hrUrlFromEnv } from "../_shared/hrApi.ts";
import { HrImportError, leaveHistoryImport } from "../_shared/leaveHistory.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** null when the PLATFORM_* secrets aren't set. */
  client: PlatformClient | null;
  /** Environment: PLATFORM_SYNC_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SECRET_KEYS, SUPABASE_URL, PLATFORM_WEBHOOK_URL, PLATFORM_EVENTS_URL. */
  env?: { get(name: string): string | undefined };
  /** HR_MY_HR_URL (leave_history_import); defaults to the environment's. */
  hrUrl?: string | null;
  fetch?: typeof fetch;
}

export const MIN_SYNC_KEY_LENGTH = 32;

/** The keys platform-sync accepts: PLATFORM_SYNC_KEY (when long enough), and every server key the runtime injected. */
export function acceptedKeys(env: { get(name: string): string | undefined }): string[] {
  const keys = injectedServerKeys(env);
  const own = env.get("PLATFORM_SYNC_KEY")?.trim();
  if (own && own.length >= MIN_SYNC_KEY_LENGTH) keys.unshift(own);
  else if (own) console.error(`platform-sync: PLATFORM_SYNC_KEY is shorter than ${MIN_SYNC_KEY_LENGTH} characters; ignoring it`);
  return keys;
}

export function authorized(req: Request, env: { get(name: string): string | undefined }): boolean {
  const presented = [
    req.headers.get("x-platform-sync-key")?.trim(),
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim(),
    req.headers.get("apikey")?.trim(),
  ];
  const keys = acceptedKeys(env);
  let ok = false;
  for (const p of presented) ok = matchesAnyKey(p, keys) || ok;
  if (!ok) {
    console.warn(`platform-sync: refused. Presented: x-platform-sync-key ${describeKey(presented[0])}; bearer ${describeKey(presented[1])}; apikey ${describeKey(presented[2])}. ` +
      `Configured: PLATFORM_SYNC_KEY ${env.get("PLATFORM_SYNC_KEY") ? "set" : "not set"}, SUPABASE_SERVICE_ROLE_KEY ${describeKey(env.get("SUPABASE_SERVICE_ROLE_KEY"))}, ` +
      `SUPABASE_SECRET_KEYS ${injectedServerKeys(env).length - (env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ? 1 : 0)} key(s).`);
  }
  return ok;
}

export async function handle(req: Request, { admin, client, env = Deno.env, hrUrl, fetch: fetchFn }: Deps): Promise<Response> {
  if (!authorized(req, env)) return fail(401, "unauthorized", "Send PLATFORM_SYNC_KEY (x-platform-sync-key or Authorization: Bearer), or the project's service-role or secret key.");
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
      case "staff_backfill": {
        if (typeof body.school_id !== "string" || !UUID.test(body.school_id)) return fail(400, "invalid_school", "school_id must be a school's id.");
        const dryRun = body.dry_run !== false;
        try {
          return json(await staffBackfill(admin, { schoolId: body.school_id, dryRun }));
        } catch (err) {
          if (err instanceof Error && /no school/.test(err.message)) return fail(404, "school_not_found", "Schools has no school with that id.");
          if (err instanceof Error && /staff_events_disabled/.test(err.message)) {
            return fail(409, "staff_events_disabled", "Sending staff events is switched off on this database (platform_settings PLATFORM_STAFF_EVENTS_ENABLED). Nothing was queued; the dry run still lists.");
          }
          if (err instanceof Error && /school_not_linked/.test(err.message)) {
            return fail(409, "school_not_linked", "The platform doesn't know this school yet (its registration hasn't been delivered). Nothing was queued; run sync first.");
          }
          throw err;
        }
      }
      case "register_event_webhook": {
        if (!client) return needClient();
        const url = eventWebhookUrl(env, body.url);
        if (!url) return fail(400, "invalid_url", "The event webhook address must be an https URL (set PLATFORM_EVENTS_URL, or send url).");
        await client.putEventWebhook(url);
        return json({ ok: true, url });
      }
      case "leave_history_import": {
        if (typeof body.school_id !== "string" || !UUID.test(body.school_id)) return fail(400, "invalid_school", "school_id must be a school's id.");
        const dryRun = body.dry_run !== false;
        try {
          return json(await leaveHistoryImport(admin, {
            schoolId: body.school_id, dryRun, client, hrUrl: hrUrl === undefined ? hrUrlFromEnv(env) : hrUrl, fetch: fetchFn,
          }));
        } catch (err) {
          if (err instanceof HrImportError) {
            return fail(502, "hr_error", `Figbloom HR's leave history import answered ${err.status}${err.code ? ` ${err.code}` : ""}. ${err.marked} record(s) were marked exported before it; run it again to send the rest.`);
          }
          if (err instanceof Error && /no school/.test(err.message)) return fail(404, "school_not_found", "Schools has no school with that id.");
          if (err instanceof Error && err.message === "hr_not_configured") {
            return fail(503, "hr_not_configured", "Set PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET, PLATFORM_TOKEN_URL, PLATFORM_API_URL and HR_MY_HR_URL first. The dry run still lists.");
          }
          if (err instanceof Error && err.message === "school_not_linked") {
            return fail(409, "school_not_linked", "The platform doesn't know this school yet (its registration hasn't been delivered). Nothing was sent.");
          }
          throw err;
        }
      }
      default:
        return fail(400, "unknown_action",
          'The action must be "sync", "reconcile", "backfill", "register_webhook", "staff_backfill", "register_event_webhook" or "leave_history_import".');
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
    return handle(req, { admin, client });
  });
}
