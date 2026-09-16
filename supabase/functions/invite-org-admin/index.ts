/**
 * Creates an org-admin account for a cross-tenant "organization" (FIG-331) —
 * a county/national government body, a constituency, or a private
 * group-owner spanning several otherwise-independent tenants.
 *
 * Deploy: supabase functions deploy invite-org-admin
 *
 * A direct copy of invite-admin/index.ts's pattern: only a real platform
 * super_admin may call this (checked against the service-role client, never
 * the caller's own claim), the auth account is created outright with a
 * fixed dev password (no email/SMS provider wired up locally — see
 * invite-admin's own docstring for why), and a failed profile insert rolls
 * back the orphaned auth account rather than leaving a login with no profile.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";

const DEV_PASSWORD = "figbloom-dev";

interface Body {
  organization_id: string;
  full_name: string;
  email: string;
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
    .from("profiles").select("role, full_name").eq("id", user.id).maybeSingle();
  if (callerProfile?.role !== "super_admin") {
    return json({ error: "Only Figbloom staff can create an organization admin." }, 403);
  }

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const { organization_id, full_name, email } = body;
  if (!organization_id || !full_name?.trim() || !email?.trim()) {
    return json({ error: "An organization, the admin's name and their email are all required." }, 400);
  }

  const { data: organization, error: orgErr } = await admin
    .from("organizations").select("id, name").eq("id", organization_id).maybeSingle();
  if (orgErr || !organization) return json({ error: "That organization could not be found." }, 404);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: email.trim(),
    password: DEV_PASSWORD,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    // Supabase's real message is "...has already been registered" — "been" sits
    // between the two words, so a plain "already registered" substring never matches.
    const already = createErr?.message?.toLowerCase().includes("already been registered");
    return json({ error: already ? "That email is already in use." : (createErr?.message ?? "Could not create the account.") }, already ? 409 : 500);
  }

  // tenant_id is null for org_admin, the same way it is for super_admin —
  // scope comes from organization_admins, not from profiles.
  const { error: profileErr } = await admin.from("profiles").insert({
    id: created.user.id,
    tenant_id: null,
    role: "org_admin",
    full_name: full_name.trim(),
    email: email.trim(),
  });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: profileErr.message }, 500);
  }

  const { error: linkErr } = await admin.from("organization_admins").insert({
    profile_id: created.user.id,
    organization_id,
    added_by: user.id,
  });
  if (linkErr) {
    // Roll back both the profile and the auth account — an org_admin with no
    // organization_admins row can see nothing, so a half-created account here
    // is just as orphaned as a profile-less auth account is in invite-admin.
    await admin.from("profiles").delete().eq("id", created.user.id);
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: linkErr.message }, 500);
  }

  await admin.from("audit_events").insert({
    tenant_id: null,
    actor_label: callerProfile.full_name ? `${callerProfile.full_name} · Figbloom` : "Figbloom staff",
    event: `Org admin ${full_name.trim()} added for ${organization.name}`,
    category: "provisioning",
  });

  return json({ ok: true, email: email.trim(), password: DEV_PASSWORD });
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
