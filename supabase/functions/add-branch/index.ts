/**
 * Lets a school's own school_admin open a second branch (FIG-405) — until
 * now, creating an organization was either staff-only (Platform >
 * Organizations) or something only an EXISTING org_admin could self-service
 * (create-organization/index.ts). A school_admin had no path at all: their
 * account is a single tenant_id, and there was no button anywhere that let
 * them become a multi-school owner.
 *
 * Deploy: supabase functions deploy add-branch
 *
 * This is deliberately a SEPARATE org_admin login (a distinct email +
 * password), not a promotion of the caller's own school_admin account --
 * their existing account keeps running just this one school day to day, the
 * same as it always has, while the new login manages the group and can add
 * more branches to it (the school just created here is that organization's
 * first member).
 *
 * New organizations start 'pending', same as create-organization's
 * self-service path -- tenant_write_org_admin only lets an org's own admin
 * create MORE schools once the org is 'active', so a pending org from this
 * flow is, correctly, not usable for that yet either. The one branch it
 * already has (this caller's own school) stays fully usable regardless --
 * being a member of a pending org changes nothing about the school itself.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";

const DEV_PASSWORD = "figbloom-dev";
const ORG_KINDS = new Set(["government", "county", "constituency", "group_owner"]);
const SLUG_RE = /^[a-z0-9-]{3,40}$/;
const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "auth", "console", "figbloom", "help", "login",
  "platform", "s", "org", "signin", "signup", "status", "support", "www",
]);

interface Body {
  org_name: string;
  org_slug: string;
  admin_full_name: string;
  admin_email: string;
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
    .from("profiles").select("role, full_name, tenant_id").eq("id", user.id).maybeSingle();
  if (callerProfile?.role !== "school_admin" || !callerProfile.tenant_id) {
    return json({ error: "Only a school's own administrator can open another branch." }, 403);
  }

  const { data: tenant, error: tenantErr } = await admin
    .from("tenants").select("id, name, organization_id").eq("id", callerProfile.tenant_id).maybeSingle();
  if (tenantErr || !tenant) return json({ error: "Your school could not be found." }, 404);
  if (tenant.organization_id) {
    return json({ error: "Your school already belongs to an organization — ask its admin to add branches instead." }, 409);
  }

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const orgName = body.org_name?.trim() ?? "";
  const orgSlug = body.org_slug?.trim().toLowerCase() ?? "";
  const adminName = body.admin_full_name?.trim() ?? "";
  const adminEmail = body.admin_email?.trim() ?? "";

  if (!orgName || orgName.length < 2) return json({ error: "Give the group of schools a name." }, 400);
  if (!SLUG_RE.test(orgSlug)) return json({ error: "The address must be 3-40 characters, lowercase letters, numbers and hyphens only." }, 400);
  if (RESERVED_SLUGS.has(orgSlug)) return json({ error: `"${orgSlug}" is reserved by the platform.` }, 400);
  if (!adminName || !adminEmail) return json({ error: "The group admin's name and email are both required." }, 400);

  const { data: slugTaken } = await admin.from("organizations").select("id").eq("slug", orgSlug).maybeSingle();
  if (slugTaken) return json({ error: `"${orgSlug}" is already taken.` }, 409);

  const { data: emailTaken } = await admin.from("profiles").select("id").eq("email", adminEmail).maybeSingle();
  if (emailTaken) return json({ error: "That email already has a Figbloom account — use a different one for the new group admin login." }, 409);

  const { data: organization, error: orgErr } = await admin.from("organizations").insert({
    name: orgName,
    slug: orgSlug,
    kind: "group_owner",
    status: "pending",
    contact_name: adminName,
    contact_email: adminEmail,
    created_by: user.id,
  }).select("id, name, slug").single();
  if (orgErr || !organization) return json({ error: orgErr?.message ?? "Could not create the organization." }, 500);

  const { error: tenantLinkErr } = await admin.from("tenants").update({ organization_id: organization.id }).eq("id", tenant.id);
  if (tenantLinkErr) {
    await admin.from("organizations").delete().eq("id", organization.id);
    return json({ error: tenantLinkErr.message }, 500);
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: adminEmail,
    password: DEV_PASSWORD,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    await admin.from("tenants").update({ organization_id: null }).eq("id", tenant.id);
    await admin.from("organizations").delete().eq("id", organization.id);
    const already = createErr?.message?.toLowerCase().includes("already been registered");
    return json({ error: already ? "That email is already in use." : (createErr?.message ?? "Could not create the account.") }, already ? 409 : 500);
  }

  const { error: profileErr } = await admin.from("profiles").insert({
    id: created.user.id,
    tenant_id: null,
    role: "org_admin",
    full_name: adminName,
    email: adminEmail,
  });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    await admin.from("tenants").update({ organization_id: null }).eq("id", tenant.id);
    await admin.from("organizations").delete().eq("id", organization.id);
    return json({ error: profileErr.message }, 500);
  }

  const { error: linkErr } = await admin.from("organization_admins").insert({
    profile_id: created.user.id,
    organization_id: organization.id,
    added_by: user.id,
  });
  if (linkErr) {
    await admin.from("profiles").delete().eq("id", created.user.id);
    await admin.auth.admin.deleteUser(created.user.id);
    await admin.from("tenants").update({ organization_id: null }).eq("id", tenant.id);
    await admin.from("organizations").delete().eq("id", organization.id);
    return json({ error: linkErr.message }, 500);
  }

  await admin.from("audit_events").insert({
    tenant_id: tenant.id,
    actor_label: `${callerProfile.full_name} · school admin`,
    event: `${tenant.name} opened a new branch group "${organization.name}", pending approval`,
    category: "provisioning",
  });

  return json({ ok: true, org_slug: organization.slug, email: adminEmail, password: DEV_PASSWORD });
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
