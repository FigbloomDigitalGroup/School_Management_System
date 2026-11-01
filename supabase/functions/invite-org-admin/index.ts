/**
 * Creates an org-admin account for a cross-tenant "organization" (FIG-331) —
 * a county/national government body, a constituency, or a private
 * group-owner spanning several otherwise-independent tenants. Also the
 * "invite a co-admin" path for an org that already exists (FIG-386): the
 * same organization can now be administered by more than one person, and a
 * person invited into a second organization keeps their one existing login
 * rather than getting a second account.
 *
 * Deploy: supabase functions deploy invite-org-admin
 *
 * Caller must be a real platform super_admin, OR an existing org_admin
 * inviting someone into an organization they themselves administer (checked
 * against the service-role client, never the caller's own claim) — mirrors
 * invite-admin/index.ts's caller-check shape exactly.
 *
 * Create-or-link: if the invited email already belongs to an org_admin
 * profile, no new auth account is created — just a new organization_admins
 * link row, so that person's one login now covers both organizations. If
 * the email belongs to some OTHER role (school_admin/parent/student/etc.),
 * that account can't be repurposed and the invite is rejected. Only a
 * genuinely new email creates a new account, with a random one-time
 * password that must be changed at first sign-in, shown once on screen and,
 * when Resend is set up (_shared/email.ts), emailed to them too — a failed
 * profile insert rolls back the orphaned auth account rather than leaving a
 * login with no profile. A failed email never undoes the account.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { failure } from "../_shared/failure.ts";
import { administersOrganization } from "../_shared/organizations.ts";
import { tempPassword } from "../_shared/tempPassword.ts";
import { actorName, deliverLoginDetails, emailContext, type EmailDeps, isDeliverable, resendMailer, signInPath } from "../_shared/email.ts";

interface Body {
  organization_id: string;
  full_name: string;
  email: string;
}

// deno-lint-ignore no-explicit-any
export interface Deps extends EmailDeps { admin: any; asUser: any }

export async function handle(req: Request, { admin, asUser, ...emailDeps }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  const { data: callerProfile } = await admin
    .from("profiles").select("role, full_name").eq("id", user.id).maybeSingle();
  if (callerProfile?.role !== "super_admin" && callerProfile?.role !== "org_admin") {
    return json({ error: "Only Figbloom staff, or an organization's own admin, can invite an organization admin." }, 403);
  }

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const { organization_id, full_name, email } = body;
  if (!organization_id || !full_name?.trim() || !email?.trim()) {
    return json({ error: "An organization, the admin's name and their email are all required." }, 400);
  }
  if (!isDeliverable(email)) return json({ error: "That email address doesn't look right." }, 400);

  const { data: organization, error: orgErr } = await admin
    .from("organizations").select("id, name, slug").eq("id", organization_id).maybeSingle();
  if (orgErr || !organization) return json({ error: "That organization could not be found." }, 404);

  let authorized = callerProfile.role === "super_admin";
  if (!authorized) {
    authorized = await administersOrganization(admin, user.id, organization_id);
  }
  if (!authorized) {
    return json({ error: "You do not administer this organization." }, 403);
  }

  const actorSuffix = callerProfile.role === "super_admin" ? "Figbloom" : "org admin";

  // Create-or-link: does this email already have an account?
  const { data: existingProfile } = await admin
    .from("profiles").select("id, role, full_name").eq("email", email.trim()).maybeSingle();

  if (existingProfile) {
    if (existingProfile.role !== "org_admin") {
      return json({ error: "That email already has a Figbloom account that isn't an organization admin — it can't be reused for this." }, 409);
    }
    const { data: existingLink } = await admin.from("organization_admins")
      .select("id").eq("profile_id", existingProfile.id).eq("organization_id", organization_id).maybeSingle();
    if (existingLink) {
      return json({ error: `${existingProfile.full_name} already administers this organization.` }, 409);
    }

    const { error: linkErr } = await admin.from("organization_admins").insert({
      profile_id: existingProfile.id,
      organization_id,
      added_by: user.id,
    });
    if (linkErr) return json(failure("invite-org-admin", "add them to the organization", linkErr), 500);

    await admin.from("audit_events").insert({
      tenant_id: null,
      actor_label: callerProfile.full_name ? `${callerProfile.full_name} · ${actorSuffix}` : `Figbloom ${actorSuffix}`,
      event: `${existingProfile.full_name} added as an existing admin for ${organization.name}`,
      category: "provisioning",
    });

    // Already has working credentials elsewhere — nothing new to hand over.
    return json({ ok: true, linkedExisting: true, email: email.trim() });
  }

  const password = tempPassword();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: email.trim(),
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    // Supabase's real message is "...has already been registered" — "been" sits
    // between the two words, so a plain "already registered" substring never matches.
    const already = createErr?.message?.toLowerCase().includes("already been registered");
    return json(already ? { error: "That email is already in use." } : failure("invite-org-admin", "create the account", createErr), already ? 409 : 500);
  }

  // tenant_id is null for org_admin, the same way it is for super_admin —
  // scope comes from organization_admins, not from profiles.
  const { error: profileErr } = await admin.from("profiles").insert({
    id: created.user.id,
    tenant_id: null,
    role: "org_admin",
    full_name: full_name.trim(),
    email: email.trim(),
    must_change_password: true,
  });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json(failure("invite-org-admin", "save the profile", profileErr), 500);
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
    return json(failure("invite-org-admin", "add them to the organization", linkErr), 500);
  }

  await admin.from("audit_events").insert({
    tenant_id: null,
    actor_label: callerProfile.full_name ? `${callerProfile.full_name} · ${actorSuffix}` : `Figbloom ${actorSuffix}`,
    event: `Org admin ${full_name.trim()} added for ${organization.name}`,
    category: "provisioning",
  });

  // The account exists now: whatever happens to the email, the password above is the way in.
  const emailed = await deliverLoginDetails(await emailContext(admin, emailDeps, user.id), email, {
    kind: "welcome",
    fullName: full_name.trim(),
    placeName: organization.name,
    login: email.trim(),
    loginIsId: false,
    password,
    signInPath: signInPath("org_admin", organization.slug),
    actor: actorName(callerProfile),
  });

  return json({ ok: true, linkedExisting: false, email: email.trim(), password, emailed });
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
    return handle(req, { admin, asUser, mailer: resendMailer() });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
