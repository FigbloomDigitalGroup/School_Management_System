/**
 * Removes a staff account (teacher/driver/school_admin) entirely -- confirmed
 * live: People.tsx had insert/update for staff but no delete path anywhere,
 * the same gap students had before FIG-407.
 *
 * Deploy: supabase functions deploy delete-account
 *
 * Two-step on purpose, not a single deleteUser() call: `profiles` is
 * deleted FIRST, as its own plain query, so a real foreign-key violation
 * (attendance.taken_by / marks.entered_by / assignments.set_by /
 * student_documents.staff_id are all `on delete restrict` -- a teacher
 * with real history literally cannot be removed at the database level)
 * comes back as a clean, well-understood error to translate for the admin,
 * rather than surfacing however GoTrue happens to handle a cascade failure
 * triggered from inside its own auth.users delete. Only once the profile
 * is actually gone does the login itself get removed -- at that point
 * nothing references it, so it's a plain, unconditional delete.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";

const REMOVABLE_ROLES = new Set(["teacher", "driver", "school_admin"]);

interface Body {
  tenant_id: string;
  profile_id: string;
}

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any }

export async function handle(req: Request, { admin, asUser }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  const { data: callerProfile } = await admin
    .from("profiles").select("role, tenant_id").eq("id", user.id).maybeSingle();
  if (callerProfile?.role !== "super_admin" && callerProfile?.role !== "org_admin" && callerProfile?.role !== "school_admin") {
    return json({ error: "Only Figbloom staff, an organization's own admin, or the school's own admin, can remove a staff account." }, 403);
  }

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const { tenant_id, profile_id } = body;
  if (!tenant_id || !profile_id) return json({ error: "A tenant and a staff member are both required." }, 400);
  if (profile_id === user.id) return json({ error: "You can't remove your own account this way." }, 400);

  const { data: tenant, error: tenantErr } = await admin
    .from("tenants").select("id, organization_id").eq("id", tenant_id).maybeSingle();
  if (tenantErr || !tenant) return json({ error: "That school could not be found." }, 404);

  let authorized = callerProfile.role === "super_admin";
  if (!authorized && callerProfile.role === "org_admin" && tenant.organization_id) {
    const { data: link } = await admin.from("organization_admins")
      .select("id").eq("profile_id", user.id).eq("organization_id", tenant.organization_id).maybeSingle();
    authorized = !!link;
  }
  if (!authorized && callerProfile.role === "school_admin" && callerProfile.tenant_id === tenant_id) {
    authorized = true;
  }
  if (!authorized) {
    return json({ error: "You do not administer this school." }, 403);
  }

  const { data: target } = await admin.from("profiles")
    .select("id, tenant_id, role, full_name").eq("id", profile_id).maybeSingle();
  if (!target || target.tenant_id !== tenant_id || !REMOVABLE_ROLES.has(target.role)) {
    return json({ error: "That staff member does not belong to this school." }, 400);
  }

  const { error: deleteProfileErr } = await admin.from("profiles").delete().eq("id", profile_id);
  if (deleteProfileErr) {
    const blocked = deleteProfileErr.message?.toLowerCase().includes("foreign key") || deleteProfileErr.code === "23503";
    return json({
      error: blocked
        ? `${target.full_name} already has attendance, marks, assignments or other records on file — they can't be removed. Reassign or clear those first if this account genuinely needs to go.`
        : deleteProfileErr.message,
    }, blocked ? 409 : 500);
  }

  const { error: deleteUserErr } = await admin.auth.admin.deleteUser(profile_id);
  if (deleteUserErr) {
    // The record they'll see on every screen is already gone; the login
    // itself failing to delete is a lesser, cleanup-later problem, not one
    // worth reporting as if nothing happened.
    return json({ ok: true, warning: `${target.full_name} was removed, but their login could not be fully deleted: ${deleteUserErr.message}` });
  }

  return json({ ok: true });
}

if (import.meta.main) {
  Deno.serve((req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    return handle(req, { admin, asUser });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
