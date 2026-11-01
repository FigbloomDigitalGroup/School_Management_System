/**
 * Creates a login for an existing learner record (FIG-402) -- until now,
 * "Add a learner" in People.tsx only ever inserted a row into `students`
 * (admission_no, full_name, class_id, ...) with no auth account and no
 * `profile_id`, so no student has ever been able to sign in: there was
 * simply no code path that created the credential. Teacher/driver
 * (invite-admin) and parent (provision-guardian) both already do this;
 * this is the same shape for the one role that was missing it.
 *
 * Deploy: supabase functions deploy provision-student
 *
 * Same login_id + synthetic-email scheme as every other non-email role
 * (FIG-396/397's "ST-0001"), same random one-time password that must be
 * changed at first sign-in, same caller check as
 * invite-admin/provision-guardian (a full admin, or since 20261031000000 a
 * teacher or other staff member holding the people admin area).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { failure } from "../_shared/failure.ts";
import { administersOrganization } from "../_shared/organizations.ts";
import { holdsArea } from "../_shared/adminAreas.ts";
import { loginIdEmail, nextLoginId } from "../_shared/loginId.ts";
import { tempPassword } from "../_shared/tempPassword.ts";

interface Body {
  tenant_id: string;
  student_id: string;
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
  if (!["super_admin", "org_admin", "school_admin", "teacher", "staff"].includes(callerProfile?.role)) {
    return json({ error: "Only Figbloom staff, an organization's own admin, or the school's office, can create a learner's login." }, 403);
  }

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const { tenant_id, student_id } = body;
  if (!tenant_id || !student_id) return json({ error: "A tenant and a learner are both required." }, 400);

  const { data: tenant, error: tenantErr } = await admin
    .from("tenants").select("id, name, slug, organization_id").eq("id", tenant_id).maybeSingle();
  if (tenantErr || !tenant) return json({ error: "That school could not be found." }, 404);

  let authorized = callerProfile.role === "super_admin";
  if (!authorized && callerProfile.role === "org_admin") {
    authorized = await administersOrganization(admin, user.id, tenant.organization_id);
  }
  if (!authorized && callerProfile.role === "school_admin" && callerProfile.tenant_id === tenant_id) {
    authorized = true;
  }
  if (!authorized && await holdsArea(admin, { id: user.id, ...callerProfile }, tenant_id, "people")) {
    authorized = true;
  }
  if (!authorized) {
    return json({ error: "You do not administer this school." }, 403);
  }

  const { data: student } = await admin.from("students")
    .select("id, tenant_id, full_name, profile_id").eq("id", student_id).maybeSingle();
  if (!student || student.tenant_id !== tenant_id) {
    return json({ error: "That learner does not belong to this school." }, 400);
  }
  if (student.profile_id) {
    return json({ error: "This learner already has a login." }, 409);
  }

  let loginId: string;
  try {
    loginId = await nextLoginId(admin, tenant_id, "student");
  } catch (err) {
    console.error("provision-student: could not number the account:", err instanceof Error ? err.message : err);
    return json({ error: "Could not create the account. Try again." }, 500);
  }
  const loginEmail = loginIdEmail(loginId, tenant.slug);
  const password = tempPassword();

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: loginEmail,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    return json(failure("provision-student", "create the account", createErr), 500);
  }

  const { error: profileErr } = await admin.from("profiles").insert({
    id: created.user.id,
    tenant_id,
    role: "student",
    full_name: student.full_name,
    login_id: loginId,
    must_change_password: true,
  });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json(failure("provision-student", "save the profile", profileErr), 500);
  }

  const { error: linkErr } = await admin.from("students")
    .update({ profile_id: created.user.id }).eq("id", student_id);
  if (linkErr) {
    await admin.from("profiles").delete().eq("id", created.user.id);
    await admin.auth.admin.deleteUser(created.user.id);
    return json(failure("provision-student", "link the login to the learner", linkErr), 500);
  }

  const actorSuffix = callerProfile.role === "super_admin" ? "Figbloom" : callerProfile.role === "org_admin" ? "org admin"
    : callerProfile.role === "school_admin" ? "school admin" : "people";
  await admin.from("audit_events").insert({
    tenant_id,
    actor_label: callerProfile.full_name ? `${callerProfile.full_name} · ${actorSuffix}` : `Unknown · ${actorSuffix}`,
    event: `Login created for learner ${student.full_name} (${loginId})`,
    category: "provisioning",
  });

  return json({ ok: true, login_id: loginId, password });
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
