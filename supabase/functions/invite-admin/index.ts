/**
 * Creates the first administrator account for a newly onboarded school.
 *
 * Deploy: supabase functions deploy invite-admin
 *
 * Creating an auth user needs the service-role key, which must never reach
 * the browser — so the wizard inserts the `tenants` row itself (a super_admin
 * is allowed to by RLS) and calls this function only for the part that
 * actually needs elevated privileges.
 *
 * There is no real email/SMS provider wired up locally, so the account is
 * created outright with the same fixed dev password every seeded account
 * uses (see supabase/seed.ts and the "Development logins" panel on the
 * sign-in screen) — the platform admin hands those credentials to the
 * school directly. A real deployment would swap this for
 * auth.admin.inviteUserByEmail() once SMTP/SMS are configured.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";

const DEV_PASSWORD = "figbloom-dev";

interface Body {
  tenant_id: string;
  full_name: string;
  staff_title: string;
  email: string;
  phone?: string;
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

  // A real platform super_admin may always call this. An org_admin may too,
  // but only for a school that belongs to an organization they themselves
  // administer (FIG-373) — checked below once we know which tenant this is,
  // never trusting the caller's own claim either way. Every other role is
  // rejected immediately, before any tenant lookup, same as before this
  // ticket — the narrower org_admin path only adds a possibility, it never
  // removes the instant-403 for a role that could never qualify.
  const { data: callerProfile } = await admin
    .from("profiles").select("role, full_name").eq("id", user.id).maybeSingle();
  if (callerProfile?.role !== "super_admin" && callerProfile?.role !== "org_admin") {
    return json({ error: "Only Figbloom staff, or an organization's own admin, can add a school administrator." }, 403);
  }

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const { tenant_id, full_name, staff_title, email } = body;
  const phone = body.phone?.trim() || undefined;
  if (!tenant_id || !full_name?.trim() || !email?.trim()) {
    return json({ error: "A tenant, the administrator's name and their email are all required." }, 400);
  }

  const { data: tenant, error: tenantErr } = await admin
    .from("tenants").select("id, name, organization_id").eq("id", tenant_id).maybeSingle();
  if (tenantErr || !tenant) return json({ error: "That school could not be found." }, 404);

  let authorized = callerProfile.role === "super_admin";
  if (!authorized && tenant.organization_id) {
    const { data: link } = await admin.from("organization_admins")
      .select("id").eq("profile_id", user.id).eq("organization_id", tenant.organization_id).maybeSingle();
    authorized = !!link;
  }
  if (!authorized) {
    return json({ error: "You do not administer this school's organization." }, 403);
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: email.trim(),
    password: DEV_PASSWORD,
    email_confirm: true,
    phone: phone ? normalisePhone(phone) : undefined,
    phone_confirm: phone ? true : undefined,
  });
  if (createErr || !created.user) {
    // Supabase's real message is "...has already been registered" — "been" sits
    // between the two words, so a plain "already registered" substring never matches.
    const already = createErr?.message?.toLowerCase().includes("already been registered");
    return json({ error: already ? "That email is already in use." : (createErr?.message ?? "Could not create the account.") }, already ? 409 : 500);
  }

  const { error: profileErr } = await admin.from("profiles").insert({
    id: created.user.id,
    tenant_id,
    role: "school_admin",
    full_name: full_name.trim(),
    email: email.trim(),
    phone: phone ? normalisePhone(phone) : null,
    staff_title: staff_title?.trim() || "Principal",
  });
  if (profileErr) {
    // Roll back the orphaned auth account rather than leaving a login with no profile.
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: profileErr.message }, 500);
  }

  const actorSuffix = callerProfile.role === "super_admin" ? "Figbloom" : "org admin";
  await admin.from("audit_events").insert({
    tenant_id,
    actor_label: callerProfile.full_name ? `${callerProfile.full_name} · ${actorSuffix}` : `Unknown · ${actorSuffix}`,
    event: `First administrator ${full_name.trim()} added for ${tenant.name}`,
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

/** "07xx xxx xxx" → "+2547xxxxxxxx"; leaves an already-international number alone. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("254")) return `+${digits}`;
  if (digits.startsWith("0")) return `+254${digits.slice(1)}`;
  return `+254${digits}`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
