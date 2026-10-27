/**
 * Sets a new temporary password on a school account that has forgotten its
 * own -- the other half of request-password-reset. Accounts that sign in
 * with a school ID have no mailbox to send a reset link to, so someone who
 * already looks after them does it instead:
 *  - Figbloom staff (super_admin), for any school account
 *  - the school's own admin, for anyone at their school
 *  - an org admin, for anyone at a school their organization owns
 *  - a parent, for their own child's learner login only
 *  - a teacher or other staff member holding the people admin area
 *    (20261030000000), for learners, parents, teachers, drivers and other
 *    staff at their school who hold no admin area themselves: taking over
 *    an account with more access than your own is never a password away
 *
 * Same temporary-password approach as invite-admin/provision-*: a random
 * one-time password (_shared/tempPassword.ts) returned once, to be handed
 * over directly, with must_change_password set so the person picks their
 * own at their next sign-in. Any open password_reset_requests for the
 * account are marked resolved.
 *
 * Deploy: supabase functions deploy reset-user-password
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { tempPassword } from "../_shared/tempPassword.ts";
import { holdsAnyArea, holdsArea } from "../_shared/adminAreas.ts";

interface Body {
  profile_id: string;
}

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any }

const NOT_YOURS = "You can't reset this person's password.";

export async function handle(req: Request, { admin, asUser }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  const { data: caller } = await admin
    .from("profiles").select("id, role, full_name, tenant_id").eq("id", user.id).maybeSingle();
  if (!caller || !["super_admin", "school_admin", "org_admin", "parent", "teacher", "staff"].includes(caller.role)) {
    return json({ error: "Only the school office, an organization admin, or a parent can reset a password." }, 403);
  }

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  const profileId = body.profile_id?.trim();
  if (!profileId) return json({ error: "Say whose password to reset." }, 400);
  if (profileId === user.id) return json({ error: "To change your own password, use your account page." }, 400);

  const { data: target } = await admin
    .from("profiles").select("id, role, full_name, tenant_id, login_id").eq("id", profileId).maybeSingle();
  // Accounts outside a school (org admins, Figbloom staff) have a real email and reset through the emailed link.
  if (!target || !target.tenant_id || target.role === "super_admin" || target.role === "org_admin") {
    return json({ error: "That account could not be found." }, 404);
  }

  let authorized = false;
  let actorSuffix = "";
  if (caller.role === "super_admin") {
    authorized = true;
    actorSuffix = "Figbloom";
  } else if (caller.role === "school_admin") {
    authorized = caller.tenant_id === target.tenant_id;
    actorSuffix = "school admin";
  } else if (caller.role === "org_admin") {
    const { data: tenant } = await admin.from("tenants").select("organization_id").eq("id", target.tenant_id).maybeSingle();
    if (tenant?.organization_id) {
      const { data: link } = await admin.from("organization_admins")
        .select("id").eq("profile_id", user.id).eq("organization_id", tenant.organization_id).maybeSingle();
      authorized = !!link;
    }
    actorSuffix = "org admin";
  } else if (caller.role === "parent" && target.role === "student") {
    // the learner record this login belongs to, then whether the caller is one of its guardians
    const { data: student } = await admin.from("students").select("id").eq("profile_id", target.id).maybeSingle();
    if (student) {
      const { data: guardian } = await admin.from("guardians")
        .select("id").eq("profile_id", user.id).eq("student_id", student.id).maybeSingle();
      authorized = !!guardian;
    }
    actorSuffix = "parent";
  } else if (caller.role === "teacher" || caller.role === "staff") {
    authorized = ["student", "parent", "teacher", "driver", "staff"].includes(target.role)
      && await holdsArea(admin, caller, target.tenant_id, "people")
      && !(await holdsAnyArea(admin, target.id));
    actorSuffix = "people";
  }
  if (!authorized) return json({ error: NOT_YOURS }, 403);

  const password = tempPassword();
  const { error: authErr } = await admin.auth.admin.updateUserById(target.id, { password });
  if (authErr) {
    console.error("reset-user-password: could not set the password:", authErr.message);
    return json({ error: "Could not reset the password. Try again." }, 500);
  }

  // The handed-over password is only for getting back in (PasswordGate asks for a new one).
  const { error: flagErr } = await admin.from("profiles").update({ must_change_password: true }).eq("id", target.id);
  if (flagErr) console.error("reset-user-password: could not flag must_change_password:", flagErr.message);

  const now = new Date().toISOString();
  const { error: resolveErr } = await admin.from("password_reset_requests")
    .update({ resolved_at: now, resolved_by: user.id }).eq("profile_id", target.id).is("resolved_at", null);
  if (resolveErr) console.error("reset-user-password: could not close the request:", resolveErr.message);

  await admin.from("audit_events").insert({
    tenant_id: target.tenant_id,
    actor_id: user.id,
    actor_label: `${caller.full_name ?? "Unknown"} · ${actorSuffix}`,
    event: `Password reset for ${target.full_name}${target.login_id ? ` (${target.login_id})` : ""}`,
    category: "access",
  });

  return json({ ok: true, password, login_id: target.login_id ?? null, full_name: target.full_name });
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
