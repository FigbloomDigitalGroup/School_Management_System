/**
 * Public, unauthenticated school search (FIG-401, part of the FIG-396
 * unified sign-in epic) -- the "type your school's name" step of the new
 * sign-in flow. There is no anonymous SELECT policy on tenants (every RLS
 * branch resolves through auth.uid(), which is null pre-auth -- see
 * tenant_read_own), so this goes through the service-role key, same as
 * every other pre-auth privileged surface in this app (signup-organization,
 * create-organization).
 *
 * Deliberately narrow: only id/name/slug/county come back, never the full
 * tenants row (plan, licensed_seats, moe_registration, etc.) -- a blanket
 * anon RLS grant would have exposed all of that to anyone, not just these
 * four fields.
 *
 * Deploy: supabase functions deploy search-schools --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { callerKey, dbLimiter, type Limiter } from "../_shared/rateLimit.ts";
import { SIGN_IN_STATUSES } from "../_shared/signInStatuses.ts";

const RESULT_LIMIT = 8;

/**
 * Searches one caller may make in the window. The picker searches as people type, and a
 * whole school's learners can sit behind one address on the first morning, so this is a
 * ceiling against scripts and floods, not a fence around a person.
 */
const SEARCH_LIMIT = 200;
const SEARCH_WINDOW = "10 minutes";
const TOO_MANY_MESSAGE = "Too many searches. Wait a few minutes and try again.";

interface Body {
  query: string;
}

interface SchoolResult {
  id: string;
  name: string;
  slug: string;
  county: string | null;
}

// deno-lint-ignore no-explicit-any
export interface Deps {
  admin: any;
  /** Records a search by this caller and says whether it is still within its allowance. */
  withinLimit: Limiter;
}

export async function handle(req: Request, { admin, withinLimit }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!(await withinLimit(await callerKey(req, "search-schools")))) return json({ error: TOO_MANY_MESSAGE }, 429);

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const query = body.query?.trim() ?? "";
  if (query.length < 2) return json({ schools: [] });

  // Escape ilike's own wildcards so a school literally named "50% Off" or
  // "St. Mary's_Academy" doesn't turn into a pattern -- % and _ are the only
  // two ilike special characters.
  const escaped = query.replace(/[%_]/g, (c) => `\\${c}`);

  const { data, error } = await admin
    .from("tenants")
    .select("id, name, slug, county")
    .in("status", SIGN_IN_STATUSES)
    .ilike("name", `%${escaped}%`)
    .order("name")
    .limit(RESULT_LIMIT);
  if (error) {
    // The database's own message can name tables and columns: keep it in the log, not the response.
    console.error("search-schools: query failed:", error.message);
    return json({ error: "Could not search schools. Try again." }, 500);
  }

  return json({ schools: (data ?? []) as SchoolResult[] });
}

if (import.meta.main) {
  Deno.serve((req) => {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    return handle(req, { admin, withinLimit: dbLimiter(admin, "search-schools", SEARCH_LIMIT, SEARCH_WINDOW) });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
