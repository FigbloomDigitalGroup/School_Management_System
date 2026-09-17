/**
 * Lets an already-signed-in org_admin spin up an ADDITIONAL organization —
 * the in-app counterpart to signup-organization/index.ts's public flow. No
 * new auth account is created (the caller already has one); this just adds
 * an organizations row and links the caller's existing profile to it as
 * admin, the same way invite-org-admin's create-or-link path links an
 * *invited* existing profile rather than making a new one.
 *
 * Deploy: supabase functions deploy create-organization
 *
 * New organizations start 'pending' regardless of who creates them —
 * treating "already an org_admin elsewhere" as no exemption from the same
 * one-click staff approval every self-registered org goes through (FIG-368/
 * FIG-375). This isn't just cosmetic: tenant_write_org_admin (FIG-369) only
 * lets an org's own admin create schools once that org's status = 'active',
 * so a pending org the caller just made is, correctly, not usable yet
 * either — the existing approval queue needs no changes to enforce this.
 *
 * Caller must already be an org_admin (any organization) — that's what a
 * "workspace" belongs to; other roles have no use for one.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";

const ORG_KINDS = new Set(["government", "county", "constituency", "group_owner"]);
const SLUG_RE = /^[a-z0-9-]{3,40}$/;
const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "auth", "console", "figbloom", "help", "login",
  "platform", "s", "org", "signin", "signup", "status", "support", "www",
]);

interface Body {
  name: string;
  slug: string;
  kind: string;
  county?: string;
  contact_email?: string;
  contact_phone?: string;
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
    .from("profiles").select("role, full_name, email").eq("id", user.id).maybeSingle();
  if (callerProfile?.role !== "org_admin") {
    return json({ error: "Only an organization admin can create a new organization." }, 403);
  }

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const name = body.name?.trim() ?? "";
  const slug = body.slug?.trim().toLowerCase() ?? "";
  const kind = body.kind ?? "";

  if (!name || name.length < 2) return json({ error: "Give the organization a name." }, 400);
  if (!SLUG_RE.test(slug)) return json({ error: "The address must be 3-40 characters, lowercase letters, numbers and hyphens only." }, 400);
  if (RESERVED_SLUGS.has(slug)) return json({ error: `"${slug}" is reserved by the platform.` }, 400);
  if (!ORG_KINDS.has(kind)) return json({ error: "Choose what kind of organization this is." }, 400);

  const { data: slugTaken } = await admin.from("organizations").select("id").eq("slug", slug).maybeSingle();
  if (slugTaken) return json({ error: `"${slug}" is already taken.` }, 409);

  const { data: organization, error: orgErr } = await admin.from("organizations").insert({
    name,
    slug,
    kind,
    status: "pending",
    county: body.county?.trim() || null,
    contact_name: callerProfile.full_name,
    contact_email: body.contact_email?.trim() || callerProfile.email,
    contact_phone: body.contact_phone?.trim() || null,
    created_by: user.id,
  }).select("id, name").single();
  if (orgErr || !organization) return json({ error: orgErr?.message ?? "Could not create the organization." }, 500);

  const { error: linkErr } = await admin.from("organization_admins").insert({
    profile_id: user.id,
    organization_id: organization.id,
    added_by: user.id,
  });
  if (linkErr) {
    await admin.from("organizations").delete().eq("id", organization.id);
    return json({ error: linkErr.message }, 500);
  }

  await admin.from("audit_events").insert({
    tenant_id: null,
    actor_label: `${callerProfile.full_name} · org admin`,
    event: `Organization "${organization.name}" created by existing org admin ${callerProfile.full_name}, pending approval`,
    category: "provisioning",
  });

  return json({ ok: true, slug });
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
