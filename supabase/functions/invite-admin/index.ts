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

import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { failure } from "../_shared/failure.ts";
import { administersOrganization } from "../_shared/organizations.ts";
import { dialCodeFor } from "../_shared/countryDialCodes.ts";
import { loginIdEmail, nextLoginId } from "../_shared/loginId.ts";
import { tempPassword } from "../_shared/tempPassword.ts";
import { accountNotMade, undoAccount } from "../_shared/undoAccount.ts";
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

  // The phone is a contact detail, kept on the profile only. Nobody signs in
  // with it (there is no SMS/OTP sign-in), and auth.users.phone is unique, so
  // putting it there stopped one person -- a teacher at two schools -- from
  // having an account at each with the same number. The same goes for a
  // teacher/driver/staff member's real email: their auth email is the
  // synthetic per-account login address, so the real one (profiles.email) may
  // repeat across accounts too. Only a school_admin's email is its login, and
  // so unique.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: loginEmail,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    const clash = accountClash(createErr, isIdBased ? loginId : undefined);
    return json(clash ?? failure("invite-admin", "create the account", createErr), clash ? 409 : 500);
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
    const left = await undoAccount("invite-admin", admin, created.user.id, []);
    return json(accountNotMade("invite-admin", "save the profile", profileErr, left, loginId ?? undefined), 500);
  }

  const actorSuffix = callerProfile!.role === "super_admin" ? "Figbloom" : callerProfile!.role === "org_admin" ? "org admin"
    : callerProfile!.role === "school_admin" ? "school admin" : "people";
  // The audit entry is the record of who made this account: without it the account is taken back out (FIG-1470).
  const { error: auditErr } = await admin.from("audit_events").insert({
    tenant_id,
    actor_label: callerProfile!.full_name ? `${callerProfile!.full_name} · ${actorSuffix}` : `Unknown · ${actorSuffix}`,
    event: role === "school_admin"
      ? `First administrator ${full_name.trim()} added for ${tenant.name}`
      : `${STAFF_WORD[role]} ${full_name.trim()} (${role === "staff" && staffTitle ? `${staffTitle}, ` : ""}${loginId}) added for ${tenant.name}`,
    category: "provisioning",
  });
  if (auditErr) {
    const left = await undoAccount("invite-admin", admin, created.user.id, []);
    return json(accountNotMade("invite-admin", "record the new login in the audit log", auditErr, left, loginId ?? undefined), 500);
  }

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

/**
 * A createUser error that is a genuine clash with another account, as a
 * sentence for whoever is adding them (answered 409), or null for anything
 * else (a 500 with the generic "Try again"). Supabase Auth gives a `code`
 * ("email_exists", "phone_exists") on newer versions and only a message on
 * older ones; its email message is "...has already been registered" ("been"
 * sits between the words, so "already registered" alone never matches it),
 * its phone one "Phone number already registered by another user".
 */
export function accountClash(err: unknown, loginId?: string): { error: string } | null {
  const e = (err && typeof err === "object" ? err : {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (code === "phone_exists" || (message.includes("phone") && message.includes("already registered"))) {
    // createUser is no longer given a phone, so this only guards a future change.
    return { error: "This phone number is already used by another account." };
  }
  if (code === "email_exists" || code === "user_already_exists" || message.includes("already been registered")) {
    // For a login-ID account the auth email is its own synthetic address, so a
    // clash means that login ID was taken a moment ago, not that the contact email is.
    return loginId
      ? { error: `Login ID ${loginId} was taken by another account a moment ago. Add them again to get the next one.` }
      : { error: "That email is already in use by another account." };
  }
  return null;
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
