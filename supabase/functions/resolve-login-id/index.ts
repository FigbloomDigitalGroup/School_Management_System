/**
 * Public, unauthenticated login_id lookup (FIG-401, part of the FIG-396
 * unified sign-in epic) -- given the school picked in search-schools and
 * the ID the person typed, resolves the account's name (shown back as a
 * confirmation, "Signing in as X") and the synthetic email the actual
 * signInWithPassword call should use. Never touches or returns a password
 * -- real authentication still happens client-side against Supabase Auth
 * directly; this only answers "which account, and what email is it under".
 *
 * Same pre-auth privileged-surface pattern as search-schools: RLS has no
 * anonymous SELECT on profiles, so this goes through the service-role key.
 *
 * Deploy: supabase functions deploy resolve-login-id --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { loginIdEmail } from "../_shared/loginId.ts";

const NOT_FOUND_MESSAGE = "We couldn't find that ID at this school. Check with the school office.";

interface Body {
  tenant_id: string;
  login_id: string;
}

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any }

export async function handle(req: Request, { admin }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

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
  if (!tenant || tenant.status !== "active") return json({ error: NOT_FOUND_MESSAGE }, 404);

  const { data: profile } = await admin.from("profiles")
    .select("full_name").eq("tenant_id", tenantId).eq("login_id", loginId).maybeSingle();
  if (!profile) return json({ error: NOT_FOUND_MESSAGE }, 404);

  return json({ ok: true, full_name: profile.full_name, email: loginIdEmail(loginId, tenant.slug) });
}

if (import.meta.main) {
  Deno.serve((req) => {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    return handle(req, { admin });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
