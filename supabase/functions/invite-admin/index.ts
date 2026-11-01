/**
 * Creates a staff account for a school: the first administrator during
 * onboarding (role: "school_admin", unchanged since this function's
 * original version), OR — new as of FIG-398 — a teacher, driver or other
 * staff member (librarian, matron, guard, ...; 20261028100001), added by
 * the school's own admin as routine day-to-day staffing rather than a
 * platform/org-owner-only action. Since 20261031000000 a teacher or other
 * staff member holding the people admin area may add those too; only a full
 * admin path (Figbloom, the organization) ever creates an administrator.
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
 * already has. Either way the account is created outright with a random
 * one-time password (_shared/tempPassword.ts) that's returned once and shown
 * to whoever added them; must_change_password makes the person choose their
 * own at first sign-in. When there's a real address (the admin's login email,
 * or a teacher/driver/staff member's contact email) and Resend is set up
 * (_shared/email.ts), the same details are emailed to them as well, and the
 * response says whether that worked; a failed email never undoes the account.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { failure } from "../_shared/failure.ts";
import { administersOrganization } from "../_shared/organizations.ts";
import { dialCodeFor } from "../_shared/countryDialCodes.ts";
import { loginIdEmail, nextLoginId } from "../_shared/loginId.ts";
import { tempPassword } from "../_shared/tempPassword.ts";
import { holdsArea } from "../_shared/adminAreas.ts";
import { actorName, deliverLoginDetails, emailContext, type EmailDeps, isDeliverable, resendMailer, signInPath } from "../_shared/email.ts";

const STAFF_ROLES = new Set(["school_admin", "teacher", "driver", "staff"]);

const STAFF_WORD: Record<string, string> = { teacher: "Teacher", driver: "Driver", staff: "Staff member" };

interface Body {
  tenant_id: string;
  full_name: string;
  role?: "school_admin" | "teacher" | "driver" | "staff";
  staff_title?: string;
  /** Required when role is (the default) "school_admin" -- the login itself
   *  for that role. Optional contact info for teacher/driver, who sign in
   *  with an assigned login_id instead. */
  email?: string;
  phone?: string;
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
  // owner or Figbloom staff every time -- and so may a teacher or other staff
  // member holding the people area (20261031000000). Every other caller role
  // is rejected immediately, before any tenant lookup.
  const callerCouldQualify = callerProfile?.role === "super_admin"
    || callerProfile?.role === "org_admin"
    || (role !== "school_admin" && ["school_admin", "teacher", "staff"].includes(callerProfile?.role));
  if (!callerCouldQualify) {
    return json({ error: "Only Figbloom staff, an organization's own admin, or (for staff other than the school's first administrator) the school's office, can add this account." }, 403);
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
  // the sign-in details are emailed here, so a typo matters
  if (email && !isDeliverable(email)) {
    return json({ error: "That email address doesn't look right." }, 400);
  }

  const { data: tenant, error: tenantErr } = await admin
    .from("tenants").select("id, name, slug, organization_id, country").eq("id", tenant_id).maybeSingle();
  if (tenantErr || !tenant) return json({ error: "That school could not be found." }, 404);

  let authorized = callerProfile!.role === "super_admin";
  if (!authorized && callerProfile!.role === "org_admin") {
    authorized = await administersOrganization(admin, user.id, tenant.organization_id);
  }
  if (!authorized && role !== "school_admin" && callerProfile!.role === "school_admin" && callerProfile!.tenant_id === tenant_id) {
    authorized = true;
  }
  if (!authorized && role !== "school_admin" && await holdsArea(admin, { id: user.id, ...callerProfile }, tenant_id, "people")) {
    authorized = true;
  }
  if (!authorized) {
    return json({ error: "You do not administer this school." }, 403);
  }

  // One past the highest number already issued, not a count: delete-account
  // removes staff, and a count would then reissue an ID that still exists.
  const isIdBased = role !== "school_admin";
  let loginId: string | undefined;
  if (isIdBased) {
    try {
      loginId = await nextLoginId(admin, tenant_id, role);
    } catch (err) {
      console.error("invite-admin: could not number the account:", err instanceof Error ? err.message : err);
      return json({ error: "Could not create the account. Try again." }, 500);
    }
  }
  const loginEmail = isIdBased ? loginIdEmail(loginId!, tenant.slug) : email!;
  const password = tempPassword();

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: loginEmail,
    password,
    email_confirm: true,
    phone: phone ? normalisePhone(phone, tenant.country) : undefined,
    phone_confirm: phone ? true : undefined,
  });
  if (createErr || !created.user) {
    // Supabase's real message is "...has already been registered" — "been" sits
    // between the two words, so a plain "already registered" substring never matches.
    const already = createErr?.message?.toLowerCase().includes("already been registered");
    return json(already ? { error: "That email is already in use." } : failure("invite-admin", "create the account", createErr), already ? 409 : 500);
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
    // The handed-over password is only for getting in the first time (PasswordGate).
    must_change_password: true,
  });
  if (profileErr) {
    // Roll back the orphaned auth account rather than leaving a login with no profile.
    await admin.auth.admin.deleteUser(created.user.id);
    return json(failure("invite-admin", "save the profile", profileErr), 500);
  }

  const actorSuffix = callerProfile!.role === "super_admin" ? "Figbloom" : callerProfile!.role === "org_admin" ? "org admin"
    : callerProfile!.role === "school_admin" ? "school admin" : "people";
  await admin.from("audit_events").insert({
    tenant_id,
    actor_label: callerProfile!.full_name ? `${callerProfile!.full_name} · ${actorSuffix}` : `Unknown · ${actorSuffix}`,
    event: role === "school_admin"
      ? `First administrator ${full_name.trim()} added for ${tenant.name}`
      : `${STAFF_WORD[role]} ${full_name.trim()} (${role === "staff" && staffTitle ? `${staffTitle}, ` : ""}${loginId}) added for ${tenant.name}`,
    category: "provisioning",
  });

  // The account exists now: whatever happens to the email, the password above is the way in.
  const emailed = await deliverLoginDetails(await emailContext(admin, emailDeps, user.id), email, {
    kind: "welcome",
    fullName: full_name.trim(),
    placeName: tenant.name,
    login: isIdBased ? loginId! : email!,
    loginIsId: isIdBased,
    password,
    signInPath: signInPath(role, tenant.slug),
    actor: actorName(callerProfile!),
  });

  return isIdBased
    ? json({ ok: true, login_id: loginId, password, emailed })
    : json({ ok: true, email: email!, password, emailed });
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
