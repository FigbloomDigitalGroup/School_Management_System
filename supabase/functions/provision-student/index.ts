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
 * (FIG-396/397's "ST-0001"), same fixed dev password, same three-way
 * caller check as invite-admin/provision-guardian.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { formatLoginId, loginIdEmail, ROLE_ID_PREFIX } from "../_shared/loginId.ts";

const DEV_PASSWORD = "figbloom-dev";

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
  if (callerProfile?.role !== "super_admin" && callerProfile?.role !== "org_admin" && callerProfile?.role !== "school_admin") {
    return json({ error: "Only Figbloom staff, an organization's own admin, or the school's own admin, can create a learner's login." }, 403);
  }

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const { tenant_id, student_id } = body;
  if (!tenant_id || !student_id) return json({ error: "A tenant and a learner are both required." }, 400);

  const { data: tenant, error: tenantErr } = await admin
    .from("tenants").select("id, name, slug, organization_id").eq("id", tenant_id).maybeSingle();
  if (tenantErr || !tenant) return json({ error: "That school could not be found." }, 404);

  let authorized = callerProfile.role === "super_admin";
  if (!authorized && callerProfile.role === "org_admin" && tenant.organization_id) {
    const { data: link } = await admin.from("organization_admins")
      .select("id").eq("profile_id", user.id).eq("organization_id", tenant.organization_id).maybeSingle();
    authorized = !!link;
  }
  if (!authorized && callerProfile.role === "school_admin" && callerProfile.tenant_id === tenant_id) {
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

  const { data: existing } = await admin.from("profiles")
    .select("id").eq("tenant_id", tenant_id).eq("role", "student");
  const loginId = formatLoginId(ROLE_ID_PREFIX.student, (existing?.length ?? 0) + 1);
  const loginEmail = loginIdEmail(loginId, tenant.slug);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: loginEmail,
    password: DEV_PASSWORD,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    return json({ error: createErr?.message ?? "Could not create the account." }, 500);
  }

  const { error: profileErr } = await admin.from("profiles").insert({
    id: created.user.id,
    tenant_id,
    role: "student",
    full_name: student.full_name,
    login_id: loginId,
  });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: profileErr.message }, 500);
  }

  const { error: linkErr } = await admin.from("students")
    .update({ profile_id: created.user.id }).eq("id", student_id);
  if (linkErr) {
    await admin.from("profiles").delete().eq("id", created.user.id);
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: linkErr.message }, 500);
  }

  const actorSuffix = callerProfile.role === "super_admin" ? "Figbloom" : callerProfile.role === "org_admin" ? "org admin" : "school admin";
  await admin.from("audit_events").insert({
    tenant_id,
    actor_label: callerProfile.full_name ? `${callerProfile.full_name} · ${actorSuffix}` : `Unknown · ${actorSuffix}`,
    event: `Login created for learner ${student.full_name} (${loginId})`,
    category: "provisioning",
  });

  return json({ ok: true, login_id: loginId, password: DEV_PASSWORD });
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
