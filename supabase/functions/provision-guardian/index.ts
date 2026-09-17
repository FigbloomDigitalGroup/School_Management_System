/**
 * Creates a parent/guardian account and links it to one or more existing
 * students (FIG-399, part of the FIG-396 epic) -- the real implementation
 * behind People.tsx's "Invite guardians" action, which was previously a
 * literal stub (a toast, no function behind it).
 *
 * Deploy: supabase functions deploy provision-guardian
 *
 * Shaped exactly like invite-admin's teacher/driver path: no email, no SMS
 * OTP -- a school-assigned login_id (FIG-397's "PT-0029" scheme) and a
 * synthetic Supabase auth address (loginIdEmail()) instead. Caller must be
 * super_admin, an org_admin administering this school's organization, or
 * the school's own school_admin -- the same three-way check invite-admin's
 * teacher/driver path uses (mirrors guardian_write's RLS shape, which this
 * function's service-role writes bypass, so the same logic is re-checked
 * here by hand rather than relied on).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { formatLoginId, loginIdEmail, ROLE_ID_PREFIX } from "../_shared/loginId.ts";

const DEV_PASSWORD = "figbloom-dev";
const RELATIONSHIPS = new Set(["mother", "father", "guardian"]);

interface StudentLink {
  student_id: string;
  relationship?: "mother" | "father" | "guardian";
  is_primary_payer?: boolean;
}

interface Body {
  tenant_id: string;
  full_name: string;
  students: StudentLink[];
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
  if (callerProfile?.role !== "super_admin" && callerProfile?.role !== "org_admin" && callerProfile?.role !== "school_admin") {
    return json({ error: "Only Figbloom staff, an organization's own admin, or the school's own admin, can add a guardian." }, 403);
  }

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const { tenant_id, full_name, students } = body;
  const phone = body.phone?.trim() || undefined;
  const email = body.email?.trim() || undefined;
  if (!tenant_id || !full_name?.trim() || !students?.length) {
    return json({ error: "A tenant, the guardian's name, and at least one learner are all required." }, 400);
  }
  for (const s of students) {
    if (s.relationship && !RELATIONSHIPS.has(s.relationship)) {
      return json({ error: `Unknown relationship "${s.relationship}".` }, 400);
    }
  }

  const { data: tenant, error: tenantErr } = await admin
    .from("tenants").select("id, name, slug, organization_id, country").eq("id", tenant_id).maybeSingle();
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

  // Every student must actually belong to this tenant -- a caller could
  // otherwise link a guardian here to a student at a school they don't
  // administer, by passing a foreign student_id alongside a tenant_id they
  // do control.
  const studentIds = students.map((s) => s.student_id);
  const { data: foundStudents } = await admin.from("students").select("id").eq("tenant_id", tenant_id).in("id", studentIds);
  const foundIds = new Set((foundStudents ?? []).map((s: { id: string }) => s.id));
  const missing = studentIds.filter((id) => !foundIds.has(id));
  if (missing.length) {
    return json({ error: "One or more learners do not belong to this school." }, 400);
  }

  const { data: existing } = await admin.from("profiles")
    .select("id").eq("tenant_id", tenant_id).eq("role", "parent");
  const loginId = formatLoginId(ROLE_ID_PREFIX.parent, (existing?.length ?? 0) + 1);
  const loginEmail = loginIdEmail(loginId, tenant.slug);

  // phone/email here are optional contact metadata only, stored on the
  // profile below -- not passed to createUser, since login_id+password (via
  // the synthetic loginEmail) is the actual credential, and a raw phone
  // string might not pass Supabase Auth's own phone-format validation for a
  // field that isn't even used for sign-in any more.
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
    role: "parent",
    full_name: full_name.trim(),
    email: email ?? null,
    phone: phone ?? null,
    login_id: loginId,
  });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: profileErr.message }, 500);
  }

  const { error: guardiansErr } = await admin.from("guardians").insert(
    students.map((s) => ({
      tenant_id,
      profile_id: created.user.id,
      student_id: s.student_id,
      relationship: s.relationship ?? "guardian",
      is_primary_payer: s.is_primary_payer ?? false,
    })),
  );
  if (guardiansErr) {
    await admin.from("profiles").delete().eq("id", created.user.id);
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: guardiansErr.message }, 500);
  }

  const actorSuffix = callerProfile.role === "super_admin" ? "Figbloom" : callerProfile.role === "org_admin" ? "org admin" : "school admin";
  await admin.from("audit_events").insert({
    tenant_id,
    actor_label: callerProfile.full_name ? `${callerProfile.full_name} · ${actorSuffix}` : `Unknown · ${actorSuffix}`,
    event: `Guardian ${full_name.trim()} (${loginId}) added, linked to ${students.length} learner${students.length === 1 ? "" : "s"}`,
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
