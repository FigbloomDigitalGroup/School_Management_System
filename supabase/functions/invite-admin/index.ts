/**
 * Creates a staff account for a school: the first administrator during
 * onboarding (role: "school_admin", unchanged since this function's
 * original version), OR — new as of FIG-398 — a teacher or driver, added by
 * the school's own admin as routine day-to-day staffing rather than a
 * platform/org-owner-only action.
 *
 * Deploy: supabase functions deploy invite-admin
 *
 * Creating an auth user needs the service-role key, which must never reach
 * the browser — so the wizard inserts the `tenants` row itself (a super_admin
 * is allowed to by RLS) and calls this function only for the part that
 * actually needs elevated privileges.
 *
 * school_admin keeps real email + password, same as org_admin/super_admin —
 * they're onboarded through a real, one-time formal process that already
 * collects a real email, unlike teacher/driver who get added in bulk by the
 * school itself. teacher/driver instead get a school-assigned login_id
 * (FIG-396/397's "TC-0001"/"BD-0099" scheme) — no email, no SMTP dependency,
 * generated server-side from how many staff of that role this tenant
 * already has. Either way there is no real email/SMS provider wired up
 * locally, so the account is created outright with the same fixed dev
 * password every seeded account uses (see supabase/seed.ts and the
 * "Development logins" panel on the sign-in screen) — the credentials
 * (email+password, or login_id+password) are handed to the school directly.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { dialCodeFor } from "../_shared/countryDialCodes.ts";
import { formatLoginId, loginIdEmail, ROLE_ID_PREFIX } from "../_shared/loginId.ts";

const DEV_PASSWORD = "figbloom-dev";
const STAFF_ROLES = new Set(["school_admin", "teacher", "driver"]);

interface Body {
  tenant_id: string;
  full_name: string;
  role?: "school_admin" | "teacher" | "driver";
  staff_title?: string;
  /** Required when role is (the default) "school_admin" -- the login itself
   *  for that role. Optional contact info for teacher/driver, who sign in
   *  with an assigned login_id instead. */
  email?: string;
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

  const { data: callerProfile } = await admin
    .from("profiles").select("role, full_name, tenant_id").eq("id", user.id).maybeSingle();

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const role = body.role ?? "school_admin";
  if (!STAFF_ROLES.has(role)) return json({ error: "Unknown role." }, 400);

  // A real platform super_admin may always call this. An org_admin may too,
  // but only for a school that belongs to an organization they themselves
  // administer (FIG-373). New as of FIG-398: for a teacher/driver (never
  // the first school_admin -- there isn't one yet to have made the call),
  // the school's OWN school_admin may also call this -- routine staffing is
  // the school's own day-to-day task, not something that should need an org
  // owner or Figbloom staff every time. Every other caller role is rejected
  // immediately, before any tenant lookup.
  const callerCouldQualify = callerProfile?.role === "super_admin"
    || callerProfile?.role === "org_admin"
    || (role !== "school_admin" && callerProfile?.role === "school_admin");
  if (!callerCouldQualify) {
    return json({ error: "Only Figbloom staff, an organization's own admin, or (for staff other than the school's first administrator) the school's own admin, can add this account." }, 403);
  }

  const { tenant_id, full_name } = body;
  const staffTitle = body.staff_title?.trim();
  const phone = body.phone?.trim() || undefined;
  const email = body.email?.trim() || undefined;
  if (!tenant_id || !full_name?.trim()) {
    return json({ error: "A tenant and a name are required." }, 400);
  }
  if (role === "school_admin" && !email) {
    return json({ error: "The administrator's email is required." }, 400);
  }

  const { data: tenant, error: tenantErr } = await admin
    .from("tenants").select("id, name, slug, organization_id, country").eq("id", tenant_id).maybeSingle();
  if (tenantErr || !tenant) return json({ error: "That school could not be found." }, 404);

  let authorized = callerProfile!.role === "super_admin";
  if (!authorized && callerProfile!.role === "org_admin" && tenant.organization_id) {
    const { data: link } = await admin.from("organization_admins")
      .select("id").eq("profile_id", user.id).eq("organization_id", tenant.organization_id).maybeSingle();
    authorized = !!link;
  }
  if (!authorized && role !== "school_admin" && callerProfile!.role === "school_admin" && callerProfile!.tenant_id === tenant_id) {
    authorized = true;
  }
  if (!authorized) {
    return json({ error: "You do not administer this school." }, 403);
  }

  // Count-based sequence -- correct as long as staff rows are never hard-
  // deleted (true today; there is no remove-staff flow anywhere in the app).
  // A future removal flow would need max-existing-suffix instead, to avoid
  // ever reissuing a login_id that's already been handed out.
  const isIdBased = role !== "school_admin";
  let loginId: string | undefined;
  if (isIdBased) {
    const { data: existing } = await admin.from("profiles")
      .select("id").eq("tenant_id", tenant_id).eq("role", role);
    loginId = formatLoginId(ROLE_ID_PREFIX[role], (existing?.length ?? 0) + 1);
  }
  const loginEmail = isIdBased ? loginIdEmail(loginId!, tenant.slug) : email!;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: loginEmail,
    password: DEV_PASSWORD,
    email_confirm: true,
    phone: phone ? normalisePhone(phone, tenant.country) : undefined,
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
    role,
    full_name: full_name.trim(),
    email: isIdBased ? (email ?? null) : email,
    phone: phone ? normalisePhone(phone, tenant.country) : null,
    staff_title: role === "school_admin" ? (staffTitle || "Principal") : (staffTitle || null),
    login_id: loginId ?? null,
  });
  if (profileErr) {
    // Roll back the orphaned auth account rather than leaving a login with no profile.
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: profileErr.message }, 500);
  }

  const actorSuffix = callerProfile!.role === "super_admin" ? "Figbloom" : callerProfile!.role === "org_admin" ? "org admin" : "school admin";
  await admin.from("audit_events").insert({
    tenant_id,
    actor_label: callerProfile!.full_name ? `${callerProfile!.full_name} · ${actorSuffix}` : `Unknown · ${actorSuffix}`,
    event: role === "school_admin"
      ? `First administrator ${full_name.trim()} added for ${tenant.name}`
      : `${role === "teacher" ? "Teacher" : "Driver"} ${full_name.trim()} (${loginId}) added for ${tenant.name}`,
    category: "provisioning",
  });

  return isIdBased
    ? json({ ok: true, login_id: loginId, password: DEV_PASSWORD })
    : json({ ok: true, email: email!, password: DEV_PASSWORD });
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

/** "07xx xxx xxx" → "+2547xxxxxxxx"; leaves an already-international number alone.
 *  Defaults to Kenya, matching every real account today. */
export function normalisePhone(raw: string, country?: string | null): string {
  const { dialCode, localPrefixes } = dialCodeFor(country);
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith(dialCode)) return `+${digits}`;
  const prefix = localPrefixes.find((p) => digits.startsWith(p));
  if (prefix) return `+${dialCode}${digits.slice(prefix.length)}`;
  return `+${dialCode}${digits}`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
