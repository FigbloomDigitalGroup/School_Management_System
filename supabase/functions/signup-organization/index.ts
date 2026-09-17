/**
 * Public, unauthenticated self-service signup (FIG-370) -- an organization
 * registers itself, starting in a 'pending' state until a super_admin
 * approves it with one click (FIG-375). This is the ONE genuinely public
 * privileged surface in the whole app: every other creation flow requires an
 * already-authenticated staff caller (invite-admin, invite-org-admin), this
 * one has no caller to check at all -- the person signing up has no account
 * yet. verify_jwt is off for this function (config.toml), since there is no
 * JWT to verify.
 *
 * Deploy: supabase functions deploy signup-organization --no-verify-jwt
 *
 * Modeled directly on invite-org-admin/index.ts's pattern -- same service-
 * role account creation, same profiles/organization_admins inserts, same
 * rollback-on-failure shape -- with two differences: it creates the
 * organizations row itself (invite-org-admin requires one to already exist),
 * and the signer sets their OWN password rather than getting the fixed dev
 * one, since this is the one case where the account holder is present, live,
 * typing their own credential in -- not receiving one from staff.
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
  admin_full_name: string;
  admin_email: string;
  admin_password: string;
}

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any }

export async function handle(req: Request, { admin }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const name = body.name?.trim() ?? "";
  const slug = body.slug?.trim().toLowerCase() ?? "";
  const kind = body.kind ?? "";
  const adminFullName = body.admin_full_name?.trim() ?? "";
  const adminEmail = body.admin_email?.trim().toLowerCase() ?? "";
  const adminPassword = body.admin_password ?? "";

  if (!name || name.length < 2) return json({ error: "Give the organization a name." }, 400);
  if (!SLUG_RE.test(slug)) return json({ error: "The address must be 3-40 characters, lowercase letters, numbers and hyphens only." }, 400);
  if (RESERVED_SLUGS.has(slug)) return json({ error: `"${slug}" is reserved by the platform.` }, 400);
  if (!ORG_KINDS.has(kind)) return json({ error: "Choose what kind of organization this is." }, 400);
  if (!adminFullName) return json({ error: "Your name is required." }, 400);
  if (!adminEmail || !adminEmail.includes("@")) return json({ error: "A valid email is required." }, 400);
  if (adminPassword.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

  const { data: slugTaken } = await admin.from("organizations").select("id").eq("slug", slug).maybeSingle();
  if (slugTaken) return json({ error: `"${slug}" is already taken.` }, 409);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: adminEmail,
    password: adminPassword,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    // Supabase's real message is "...has already been registered" -- "been" sits
    // between the two words, so a plain "already registered" substring never matches
    // (this exact bug was found and fixed in invite-admin/invite-org-admin earlier).
    const already = createErr?.message?.toLowerCase().includes("already been registered");
    return json({ error: already ? "That email is already in use." : (createErr?.message ?? "Could not create the account.") }, already ? 409 : 500);
  }

  const { data: organization, error: orgErr } = await admin.from("organizations").insert({
    name,
    slug,
    kind,
    status: "pending",
    county: body.county?.trim() || null,
    contact_name: adminFullName,
    contact_email: body.contact_email?.trim() || adminEmail,
    contact_phone: body.contact_phone?.trim() || null,
    created_by: null, // self-registered, not staff-created
  }).select("id, name").single();
  if (orgErr || !organization) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: orgErr?.message ?? "Could not create the organization." }, 500);
  }

  const { error: profileErr } = await admin.from("profiles").insert({
    id: created.user.id,
    tenant_id: null,
    role: "org_admin",
    full_name: adminFullName,
    email: adminEmail,
  });
  if (profileErr) {
    await admin.from("organizations").delete().eq("id", organization.id);
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: profileErr.message }, 500);
  }

  const { error: linkErr } = await admin.from("organization_admins").insert({
    profile_id: created.user.id,
    organization_id: organization.id,
    added_by: null, // self-registered, not staff-added
  });
  if (linkErr) {
    await admin.from("profiles").delete().eq("id", created.user.id);
    await admin.from("organizations").delete().eq("id", organization.id);
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: linkErr.message }, 500);
  }

  await admin.from("audit_events").insert({
    tenant_id: null,
    actor_label: `${adminFullName} · self-service signup`,
    event: `Organization "${organization.name}" self-registered, pending approval`,
    category: "provisioning",
  });

  return json({ ok: true, slug });
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
