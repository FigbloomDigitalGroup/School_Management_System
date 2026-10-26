/**
 * Public, unauthenticated login_id lookup (FIG-401, part of the FIG-396
 * unified sign-in epic) -- given the school picked in search-schools and
 * the ID the person typed, resolves a masked version of the account's name
 * (shown back as a confirmation, "Signing in as Esther H.") and the
 * synthetic email the actual signInWithPassword call should use. Never
 * touches or returns a password -- real authentication still happens
 * client-side against Supabase Auth directly; this only answers "which
 * account, and what email is it under".
 *
 * Login IDs are sequential and this answers anyone, so it returns only a
 * masked name (first name and the last name's initial) and limits how often
 * one caller can ask -- otherwise a script could list a school's whole roll,
 * learners included.
 *
 * Same pre-auth privileged-surface pattern as search-schools: RLS has no
 * anonymous SELECT on profiles, so this goes through the service-role key.
 *
 * Deploy: supabase functions deploy resolve-login-id --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { loginIdEmail } from "../_shared/loginId.ts";
import { maskName } from "../_shared/maskName.ts";
import { canSignIn } from "../_shared/signInStatuses.ts";

/** Lookups one caller may make in the window. A person fixing a typo makes a handful. */
const LOOKUP_LIMIT = 30;
const LOOKUP_WINDOW = "10 minutes";
const TOO_MANY_MESSAGE = "Too many attempts. Wait a few minutes and try again.";

const NOT_FOUND_MESSAGE = "We couldn't find that ID at this school. Check with the school office.";

interface Body {
  tenant_id: string;
  login_id: string;
}

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** Records a lookup by this caller and says whether it is still within its allowance. */
  withinLimit: (callerKey: string) => Promise<boolean>;
}

/** Who is asking: a hash of the caller's address, so the limit works without keeping the address itself. */
export async function callerKey(req: Request): Promise<string> {
  const ip = req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`resolve-login-id:${ip}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handle(req: Request, { admin, withinLimit }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!(await withinLimit(await callerKey(req)))) return json({ error: TOO_MANY_MESSAGE }, 429);

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const tenantId = body.tenant_id?.trim();
  const rawLoginId = body.login_id?.trim();
  if (!tenantId || !rawLoginId) return json({ error: "A school and an ID are both required." }, 400);

  // login_id is always generated uppercase (formatLoginId's ROLE_ID_PREFIX
  // values are all uppercase) -- normalise what was typed the same way so
  // sign-in doesn't care about case.
  const loginId = rawLoginId.toUpperCase();

  const { data: tenant } = await admin.from("tenants").select("slug, status").eq("id", tenantId).maybeSingle();
  if (!tenant || !canSignIn(tenant.status)) return json({ error: NOT_FOUND_MESSAGE }, 404);

  const { data: profile } = await admin.from("profiles")
    .select("full_name").eq("tenant_id", tenantId).eq("login_id", loginId).maybeSingle();
  if (!profile) return json({ error: NOT_FOUND_MESSAGE }, 404);

  return json({ ok: true, display_name: maskName(profile.full_name), email: loginIdEmail(loginId, tenant.slug) });
}

if (import.meta.main) {
  Deno.serve((req) => {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    return handle(req, {
      admin,
      // If the limiter itself fails, let the lookup through: sign-in matters more than the limit.
      withinLimit: async (key) => {
        const { data, error } = await admin.rpc("note_login_lookup", { p_key: key, p_limit: LOOKUP_LIMIT, p_window: LOOKUP_WINDOW });
        if (error) { console.error("resolve-login-id: rate limiter failed:", error.message); return true; }
        return data !== false;
      },
    });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
