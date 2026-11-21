/**
 * Organisation decisions from the Figbloom platform (design 5.8): when
 * Figbloom staff approve, reject, suspend or reactivate an organisation in
 * the console, the platform POSTs the decision here, signed, and retries
 * until it gets a 2xx.
 *
 *   x-figbloom-event: organization.status_changed
 *   x-figbloom-delivery: <id, the same on every retry>
 *   x-figbloom-timestamp: <Unix seconds>
 *   x-figbloom-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
 *   {"organization":{"id","local_id","status","status_reason"},"decided_by","decided_at"}
 *
 * - The signature and timestamp (±5 minutes) are checked first, in constant
 *   time, against PLATFORM_WEBHOOK_SECRET; anything else is 401.
 * - Only the organisation's local id (Schools' own id) and status decide
 *   what happens. The reason, decided_by and decided_at are recorded (the
 *   reason for the schools to read, decided_by for Figbloom staff only) and
 *   decided_at orders decisions; nothing else in the body is followed.
 * - Applied through platform_apply_organization_decision(): organizations.status,
 *   the column Schools' own console sets and every check reads. A repeated
 *   delivery, or a decision older than the last one applied, is acknowledged
 *   without applying it again.
 * - 2xx only once it is applied (or already was); a database failure is 500,
 *   so the platform retries. An organisation Schools doesn't have is 404.
 * - Until PLATFORM_DECISIONS_ENABLED is on, a decision is verified and
 *   acknowledged but not applied (Schools' own console still decides); the
 *   organisation is flagged, so the first reconcile after switch-on checks it.
 *
 * Deploy: supabase functions deploy platform-decisions --no-verify-jwt
 * (the platform sends no Supabase JWT; config.toml says so too).
 */

import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { verifyFigbloomWebhook } from "../_shared/platformWebhook.ts";
import { decisionsEnabled } from "../_shared/platformSync.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["pending", "active", "suspended", "rejected"]);
const MAX_BODY = 16 * 1024;

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** PLATFORM_WEBHOOK_SECRET. */
  secret: string | undefined;
  now?: () => number;
}

export async function handle(req: Request, { admin, secret, now = Date.now }: Deps): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
  if (!secret) {
    console.error("platform-decisions: PLATFORM_WEBHOOK_SECRET is not set; refusing every delivery");
    return fail(401, "unauthorized", "The signature is missing or wrong.");
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, "too_large", "The body is too large.");
  const ok = await verifyFigbloomWebhook(secret, raw, req.headers.get("x-figbloom-signature"), req.headers.get("x-figbloom-timestamp"), now());
  if (!ok) return fail(401, "unauthorized", "The signature is missing or wrong, or the timestamp is too old.");

  const event = req.headers.get("x-figbloom-event") ?? "organization.status_changed";
  if (event !== "organization.status_changed") {
    // signed by the platform, but nothing this function handles: acknowledged so it isn't retried forever
    return json({ ok: true, applied: false, ignored: event }, 202);
  }
  const delivery = (req.headers.get("x-figbloom-delivery") ?? "").trim();
  if (!delivery || delivery.length > 100) return fail(400, "invalid_delivery", "x-figbloom-delivery is required.");

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = JSON.parse(raw); } catch { return fail(400, "invalid_json", "The body must be JSON."); }
  const localId = body?.organization?.local_id;
  const status = body?.organization?.status;
  if (typeof localId !== "string" || !UUID.test(localId)) return fail(400, "invalid_organization", "organization.local_id must be a Schools organisation id.");
  if (typeof status !== "string" || !STATUSES.has(status)) return fail(400, "invalid_status", "organization.status must be pending, active, suspended or rejected.");
  const reason = typeof body.organization.status_reason === "string" ? body.organization.status_reason.slice(0, 500) : null;
  const decidedBy = typeof body.decided_by === "string" ? body.decided_by.slice(0, 200) : "platform";
  const decidedAt = typeof body.decided_at === "string" && !Number.isNaN(Date.parse(body.decided_at)) ? new Date(body.decided_at).toISOString() : null;

  let enabled: boolean;
  try { enabled = await decisionsEnabled(admin); } catch (err) { return internal("read the switch-on setting", err); }

  if (!enabled) {
    const { error } = await admin.rpc("platform_note_unapplied_delivery", { p_delivery_id: delivery, p_organization_id: localId });
    if (error) return internal("note the delivery", error);
    console.warn(`platform-decisions: ${status} for organisation ${localId} (delivery ${delivery}) received before switch-on; not applied`);
    return json({ ok: true, applied: false, reason: "decisions_not_enabled" });
  }

  const { data, error } = await admin.rpc("platform_apply_organization_decision", {
    p_organization_id: localId, p_status: status, p_reason: reason, p_decided_by: decidedBy,
    p_decided_at: decidedAt, p_delivery_id: delivery, p_source: "webhook",
  });
  if (error) return internal("apply the decision", error);

  switch (data?.outcome) {
    case "applied":
    case "unchanged":
      return json({ ok: true, applied: true, outcome: data.outcome, status: data.status });
    case "duplicate":
    case "stale":
      return json({ ok: true, applied: false, outcome: data.outcome });
    case "not_found":
      console.warn(`platform-decisions: no organisation ${localId} in Schools (delivery ${delivery})`);
      return fail(404, "organization_not_found", "Schools has no organisation with that id.");
    default:
      return internal("apply the decision", `unexpected answer ${JSON.stringify(data)}`);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

function internal(what: string, err: unknown): Response {
  const detail = err && typeof err === "object" && "message" in err ? (err as { message: unknown }).message : err;
  console.error(`platform-decisions: could not ${what}:`, detail ?? "no detail");
  return fail(500, "internal_error", `Could not ${what}. Try again.`);
}

if (import.meta.main) {
  Deno.serve((req) => {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    return handle(req, { admin, secret: Deno.env.get("PLATFORM_WEBHOOK_SECRET") });
  });
}
