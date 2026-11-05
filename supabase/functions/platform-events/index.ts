/**
 * Events from the Figbloom platform's relay (SCHOOLS_HR_PHASE1_CONTRACT.md,
 * sections 1 and 3): another product's event, delivered to Schools because
 * Schools subscribes to it and is linked to the same customer. Today that is
 * one event, hr.employee.left: an exit for a Schools staff member was
 * completed in Figbloom HR, so Schools archives their account.
 *
 *   x-figbloom-event: hr.employee.left
 *   x-figbloom-delivery: <id, the same on every retry>
 *   x-figbloom-timestamp: <Unix seconds>
 *   x-figbloom-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
 *   {"event":{"type","id","occurred_at","source","platform_tenant_id","tenant_local_id",
 *             "data":{"employee_number","external_id","left_on"}},"delivered_at"}
 *
 * - The signature and timestamp (±5 minutes) are checked first, in constant
 *   time, against PLATFORM_WEBHOOK_SECRET, exactly as platform-decisions
 *   does; anything else is 401.
 * - tenant_local_id is the school (tenants.id) and external_id the person
 *   (profiles.id); the person must belong to that school, or it is refused
 *   (403 tenant_mismatch) and nothing changes. Nothing else in the body is
 *   followed; employee_number is recorded.
 * - Applied through platform_staff_left() (20261105600000): the archive
 *   Schools' own archive_staff() makes (archived, login banned, audit event
 *   naming HR), and not sent back to HR. Each delivery is applied once: a
 *   repeat is acknowledged without applying it again.
 * - 2xx only once it is applied (or already was); a database failure is 500,
 *   so the platform retries. A person Schools doesn't have is 404.
 * - Until PLATFORM_EVENTS_ENABLED (platform_settings) is on, an event is
 *   verified, recorded in platform_event_deliveries, logged and acknowledged,
 *   but not applied.
 * - A signed event of another type is acknowledged (202) and ignored.
 *
 * Deployed with JWT verification off (the platform sends no Supabase JWT;
 * config.toml says so too). Register its address (PLATFORM_EVENTS_URL,
 * <public functions URL>/platform-events) with platform-sync
 * {"action":"register_event_webhook"}.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyFigbloomWebhook } from "../_shared/platformWebhook.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 32 * 1024;
export const STAFF_LEFT = "hr.employee.left";

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** PLATFORM_WEBHOOK_SECRET. */
  secret: string | undefined;
  now?: () => number;
}

export async function eventsEnabled(admin: Deps["admin"]): Promise<boolean> {
  const { data, error } = await admin.rpc("platform_events_enabled");
  if (error) throw new Error(`could not read PLATFORM_EVENTS_ENABLED: ${error.message}`);
  return data === true;
}

export async function handle(req: Request, { admin, secret, now = Date.now }: Deps): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
  if (!secret) {
    console.error("platform-events: PLATFORM_WEBHOOK_SECRET is not set; refusing every delivery");
    return fail(401, "unauthorized", "The signature is missing or wrong.");
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, "too_large", "The body is too large.");
  const ok = await verifyFigbloomWebhook(secret, raw, req.headers.get("x-figbloom-signature"), req.headers.get("x-figbloom-timestamp"), now());
  if (!ok) return fail(401, "unauthorized", "The signature is missing or wrong, or the timestamp is too old.");

  const delivery = (req.headers.get("x-figbloom-delivery") ?? "").trim();
  if (!delivery || delivery.length > 200) return fail(400, "invalid_delivery", "x-figbloom-delivery is required.");

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = JSON.parse(raw); } catch { return fail(400, "invalid_json", "The body must be JSON."); }
  const event = body?.event;
  const type = typeof event?.type === "string" ? event.type : req.headers.get("x-figbloom-event") ?? "";
  const header = req.headers.get("x-figbloom-event");
  if (header && header !== type) return fail(400, "event_mismatch", "x-figbloom-event and event.type differ.");

  if (type !== STAFF_LEFT) {
    // signed by the platform, but nothing Schools handles: acknowledged so it isn't retried forever
    console.log(`platform-events: ignored ${type || "(no type)"} (delivery ${delivery})`);
    return json({ ok: true, applied: false, ignored: type }, 202);
  }

  const data = event?.data ?? {};
  const tenantId = event?.tenant_local_id;
  const profileId = data.external_id;
  const leftOn = data.left_on ?? null;
  const employeeNumber = typeof data.employee_number === "string" || typeof data.employee_number === "number" ? String(data.employee_number).slice(0, 100) : null;
  const eventId = typeof event?.id === "string" ? event.id.slice(0, 200) : null;
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) return fail(400, "invalid_tenant", "event.tenant_local_id must be a Schools school id.");
  if (typeof profileId !== "string" || !UUID.test(profileId)) return fail(400, "invalid_person", "data.external_id must be a Schools person id.");
  if (leftOn !== null && (typeof leftOn !== "string" || !DAY.test(leftOn) || Number.isNaN(Date.parse(leftOn)))) {
    return fail(400, "invalid_left_on", "data.left_on must be a date, YYYY-MM-DD.");
  }

  let enabled: boolean;
  try { enabled = await eventsEnabled(admin); } catch (err) { return internal("read the switch-on setting", err); }

  const { data: answer, error } = await admin.rpc("platform_staff_left", {
    p_delivery_id: delivery, p_event_id: eventId, p_tenant_id: tenantId, p_profile_id: profileId,
    p_left_on: leftOn, p_employee_number: employeeNumber, p_apply: enabled,
  });
  if (error) return internal("apply hr.employee.left", error);

  const outcome = answer?.outcome;
  const what = `hr.employee.left for ${profileId} at school ${tenantId} (employee ${employeeNumber ?? "?"}, delivery ${delivery})`;
  switch (outcome) {
    case "not_enabled":
      console.warn(`platform-events: ${what} received before switch-on (PLATFORM_EVENTS_ENABLED off); recorded, not applied`);
      return json({ ok: true, applied: false, reason: "events_not_enabled" });
    case "archived":
      console.log(`platform-events: ${what}: archived`);
      return json({ ok: true, applied: true, outcome });
    case "already_archived":
    case "duplicate":
      console.log(`platform-events: ${what}: ${outcome}`);
      return json({ ok: true, applied: false, outcome });
    case "not_found":
      console.warn(`platform-events: ${what}: no such person in Schools`);
      return fail(404, "person_not_found", "Schools has no person with that id.");
    case "tenant_mismatch":
      console.error(`platform-events: ${what}: the person belongs to another school; refused`);
      return fail(403, "tenant_mismatch", "That person does not belong to this school.");
    case "not_staff":
      console.error(`platform-events: ${what}: not a staff account; refused`);
      return fail(409, "not_staff", "That person is not a staff member.");
    default:
      return internal("apply hr.employee.left", `unexpected answer ${JSON.stringify(answer)}`);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

function internal(what: string, err: unknown): Response {
  const detail = err && typeof err === "object" && "message" in err ? (err as { message: unknown }).message : err;
  console.error(`platform-events: could not ${what}:`, detail ?? "no detail");
  return fail(500, "internal_error", `Could not ${what}. Try again.`);
}

if (import.meta.main) {
  Deno.serve((req) => {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    return handle(req, { admin, secret: Deno.env.get("PLATFORM_WEBHOOK_SECRET") });
  });
}
