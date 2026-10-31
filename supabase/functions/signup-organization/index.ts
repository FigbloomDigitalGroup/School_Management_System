/**
 * Public, unauthenticated self-service signup (FIG-370) -- an organization
 * registers itself and is live straight away. It used to start 'pending'
 * until a super_admin approved it (FIG-375); approval is paused for now, so
 * new organizations are created 'active' and can add schools at once. To
 * switch approval back on, insert 'pending' here and in
 * create-organization: the Approve button and holding screen still exist.
 * This is the ONE genuinely public
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
 *
 * The address is proved before the account can be used (FIG-1337). It used
 * to be created already confirmed, so anyone could register an address they
 * didn't own, hold it, and see the real owner told "That email is already
 * in use". Now the account is created unconfirmed (auth.admin.generateLink,
 * type "signup"), and the confirmation link goes to the address by our own
 * mailer (Resend); nobody can sign in until it's followed. Whether the
 * address already had an account, the answer is the same "check your email":
 * an owner who already has an account gets a note that someone tried, and an
 * earlier sign-up that was never confirmed (so never usable, perhaps a
 * squatter's) is cleared and replaced. With no mailer configured, sign-up is
 * closed rather than leaving accounts nobody can confirm.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { callerKey, dbLimiter, type Limiter, overallKey, unlimited } from "../_shared/rateLimit.ts";
import { type Mailer, NO_MAILER, resendMailer } from "../_shared/email.ts";
import { signupEmail } from "../_shared/emailTemplates.ts";

/**
 * Signups one caller may make in the window. Each one creates a real account and
 * organization, so a script could fill the project with them; a person registering an
 * organization, even after a typo or two, never gets near this.
 */
const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW = "1 hour";
/** Sign-ups from everyone together, a day (FIG-1336). */
const OVERALL_SIGNUP_LIMIT = 50;
const OVERALL_SIGNUP_WINDOW = "1 day";
const TOO_MANY_MESSAGE = "Too many sign-up attempts from here. Wait a while and try again.";

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
export interface Deps {
  admin: any;
  /** Records an attempt by this caller and says whether it is still within its allowance. */
  withinLimit: Limiter;
  /** The same for the whole function, whoever asks. */
  withinOverall?: Limiter;
  /** Sends the confirmation (and the "someone tried" note). Without one, sign-up is closed. */
  mailer?: Mailer;
}

/** The answer to every sign-up that gets this far, whether or not the address had an account. */
const CHECK_EMAIL = { ok: true, confirm_email: true } as const;

export async function handle(req: Request, { admin, withinLimit, withinOverall = unlimited, mailer = NO_MAILER }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!(await withinLimit(await callerKey(req, "signup-organization")))) return json({ error: TOO_MANY_MESSAGE }, 429);
  if (!(await withinOverall(await overallKey("signup-organization")))) return json({ error: TOO_MANY_MESSAGE }, 429);

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

  if (!mailer.configured) {
    console.error("signup-organization: no mailer (RESEND_API_KEY / EMAIL_FROM), so nobody could confirm a sign-up");
    return json({ error: "Sign-up isn't available right now. Email hello@figbloom.org and we'll set you up." }, 503);
  }
  const signInUrl = mailer.appUrl ? `${mailer.appUrl}/signin` : null;

  // An address that already has an account: same answer as a new one, a note to the owner
  const { data: existing } = await admin.from("profiles").select("id, full_name").eq("email", adminEmail).maybeSingle();
  if (existing) {
    const { data: found } = await admin.auth.admin.getUserById(existing.id);
    if (found?.user?.email_confirmed_at) {
      await mailer.send({ to: adminEmail, ...signupEmail({ kind: "taken", fullName: existing.full_name ?? adminFullName, orgName: name, link: signInUrl }) })
        .catch((err) => console.error("signup-organization: could not send the note:", err));
      return json(CHECK_EMAIL);
    }
    // never confirmed, so never usable: an unfinished sign-up, or someone holding the address
    if (!(await clearUnconfirmed(admin, existing.id))) return json({ error: "Could not create the account. Try again." }, 500);
  }

  const { data: link, error: linkGenErr } = await admin.auth.admin.generateLink({
    type: "signup",
    email: adminEmail,
    password: adminPassword,
    options: signInUrl ? { redirectTo: signInUrl } : undefined,
  });
  const created = link?.user ? { user: link.user } : null;
  const actionLink: string | null = link?.properties?.action_link ?? null;
  if (linkGenErr || !created || !actionLink) {
    // an Auth account with no profile (an earlier sign-up that failed half-way): same answer, nothing sent
    const already = linkGenErr?.message?.toLowerCase().includes("already been registered");
    if (already) return json(CHECK_EMAIL);
    console.error("signup-organization: could not create the account:", linkGenErr?.message ?? "no link");
    return json({ error: "Could not create the account. Try again." }, 500);
  }

  const { data: organization, error: orgErr } = await admin.from("organizations").insert({
    name,
    slug,
    kind,
    status: "active", // no approval step for now: see the header
    county: body.county?.trim() || null,
    contact_name: adminFullName,
    contact_email: body.contact_email?.trim() || adminEmail,
    contact_phone: body.contact_phone?.trim() || null,
    created_by: null, // self-registered, not staff-created
  }).select("id, name").single();
  if (orgErr || !organization) {
    await admin.auth.admin.deleteUser(created.user.id);
    console.error("signup-organization: could not create the organization:", orgErr?.message);
    return json({ error: "Could not create the organization. Try again." }, 500);
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
    console.error("signup-organization: could not create the profile:", profileErr.message);
    return json({ error: "Could not finish creating the account. Try again." }, 500);
  }

  const { error: adminLinkErr } = await admin.from("organization_admins").insert({
    profile_id: created.user.id,
    organization_id: organization.id,
    added_by: null, // self-registered, not staff-added
  });
  if (adminLinkErr) {
    await admin.from("profiles").delete().eq("id", created.user.id);
    await admin.from("organizations").delete().eq("id", organization.id);
    await admin.auth.admin.deleteUser(created.user.id);
    console.error("signup-organization: could not link the administrator:", adminLinkErr.message);
    return json({ error: "Could not finish creating the account. Try again." }, 500);
  }

  // the confirmation: without it the account can't be used, so a failed send undoes the sign-up
  const sent = await mailer.send({ to: adminEmail, ...signupEmail({ kind: "confirm", fullName: adminFullName, orgName: organization.name, link: actionLink }) })
    .catch((err) => ({ status: "failed" as const, reason: err instanceof Error ? err.message : String(err) }));
  if (sent.status !== "sent") {
    await clearUnconfirmed(admin, created.user.id);
    console.error("signup-organization: could not send the confirmation:", "reason" in sent ? sent.reason : sent.status);
    return json({ error: "We couldn't send the confirmation email. Check the address and try again." }, 502);
  }

  await admin.from("audit_events").insert({
    tenant_id: null,
    actor_label: `${adminFullName} · self-service signup`,
    event: `Organization "${organization.name}" self-registered (email to confirm)`,
    category: "provisioning",
  });

  return json(CHECK_EMAIL);
}

/**
 * Removes a sign-up that was never confirmed: the organizations it registered
 * (only while they have no schools), the profile and the Auth account. False
 * if any step failed, leaving the rest for the next attempt.
 */
// deno-lint-ignore no-explicit-any
async function clearUnconfirmed(admin: any, profileId: string): Promise<boolean> {
  const { data: links } = await admin.from("organization_admins").select("organization_id").eq("profile_id", profileId);
  for (const { organization_id } of (links ?? []) as { organization_id: string }[]) {
    const { data: schools } = await admin.from("tenants").select("id").eq("organization_id", organization_id).limit(1);
    const { data: org } = await admin.from("organizations").select("id, created_by").eq("id", organization_id).maybeSingle();
    if (org && org.created_by === null && !(schools ?? []).length) {
      await admin.from("organization_admins").delete().eq("organization_id", organization_id);
      await admin.from("organizations").delete().eq("id", organization_id);
    }
  }
  await admin.from("organization_admins").delete().eq("profile_id", profileId);
  await admin.from("profiles").delete().eq("id", profileId);
  const { error } = await admin.auth.admin.deleteUser(profileId);
  if (error) { console.error("signup-organization: could not clear an unconfirmed sign-up:", error.message); return false; }
  return true;
}

if (import.meta.main) {
  Deno.serve((req) => {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    return handle(req, {
      admin,
      withinLimit: dbLimiter(admin, "signup-organization", SIGNUP_LIMIT, SIGNUP_WINDOW),
      withinOverall: dbLimiter(admin, "signup-organization", OVERALL_SIGNUP_LIMIT, OVERALL_SIGNUP_WINDOW),
      mailer: resendMailer(),
    });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
