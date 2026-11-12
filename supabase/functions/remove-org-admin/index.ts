/**
 * Takes an organization admin out of an organization: the other half of
 * invite-org-admin. Until now an org admin, once invited, could never be
 * removed by anyone: there was no way to take their access back.
 *
 * Deploy: supabase functions deploy remove-org-admin
 *
 * Caller must be a real platform super_admin, OR an existing org_admin acting
 * on an organization they themselves administer (checked against the
 * service-role client, never the caller's own claim; a suspended organization's
 * admins are cut off, FIG-1312): the same shape as invite-org-admin. Nobody
 * removes themselves this way, which also means an org admin can never leave
 * their own organization with nobody to run it; only Figbloom staff can remove
 * the last one (and add another).
 *
 * What is removed is the person's link to THIS organization (organization_admins).
 * One login can administer several organizations (invite-org-admin links an
 * existing org admin rather than making a second account), so when they still
 * have another link the login stays and only this one goes. When this was
 * their last, the account goes with it, like delete-account does for staff: the
 * profile first, as its own plain query, so a row that still refers to them
 * (they added someone, say) comes back as a clean answer; then the login. A
 * profile that cannot be deleted is left with no organization at all, which
 * sees nothing: an org admin's reach comes only from organization_admins.
 *
 * Who did it is written to the audit log by name. If that cannot be written
 * the removal is put back, so there is never a removal nobody can account for
 * (the same rule invite-admin keeps for creating an account, FIG-1470).
 */

import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { failure } from "../_shared/failure.ts";
import { administersOrganization } from "../_shared/organizations.ts";

interface Body {
  organization_id: string;
  profile_id: string;
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
    .from("profiles").select("role, full_name").eq("id", user.id).maybeSingle();
  if (callerProfile?.role !== "super_admin" && callerProfile?.role !== "org_admin") {
    return json({ error: "Only Figbloom staff, or an organization's own admin, can remove an organization admin." }, 403);
  }

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const { organization_id, profile_id } = body;
  if (!organization_id || !profile_id) return json({ error: "An organization and an admin are both required." }, 400);
  if (profile_id === user.id) return json({ error: "You can't remove yourself. Ask another admin, or Figbloom." }, 400);

  const { data: organization, error: orgErr } = await admin
    .from("organizations").select("id, name").eq("id", organization_id).maybeSingle();
  if (orgErr || !organization) return json({ error: "That organization could not be found." }, 404);

  let authorized = callerProfile.role === "super_admin";
  if (!authorized) authorized = await administersOrganization(admin, user.id, organization_id);
  if (!authorized) return json({ error: "You do not administer this organization." }, 403);

  const { data: link } = await admin.from("organization_admins")
    .select("*").eq("profile_id", profile_id).eq("organization_id", organization_id).maybeSingle();
  if (!link) return json({ error: "That person is not an admin of this organization." }, 404);

  const { data: target } = await admin.from("profiles").select("id, role, full_name").eq("id", profile_id).maybeSingle();
  const name = target?.full_name ?? "An admin";

  const { error: unlinkErr } = await admin.from("organization_admins")
    .delete().eq("profile_id", profile_id).eq("organization_id", organization_id);
  if (unlinkErr) return json(failure("remove-org-admin", "remove them from the organization", unlinkErr), 500);

  const actorSuffix = callerProfile.role === "super_admin" ? "Figbloom" : "org admin";
  const { error: auditErr } = await admin.from("audit_events").insert({
    tenant_id: null,
    actor_label: callerProfile.full_name ? `${callerProfile.full_name} · ${actorSuffix}` : `Figbloom ${actorSuffix}`,
    event: `Org admin ${name} removed from ${organization.name}`,
    category: "provisioning",
  });
  if (auditErr) {
    const { error: restoreErr } = await admin.from("organization_admins").insert(link);
    if (restoreErr) console.error("remove-org-admin: could not put the link back after the audit entry failed:", restoreErr.message);
    return json(failure("remove-org-admin", "record the removal in the audit log", auditErr), 500);
  }

  // Still administering another organization: the login stays, only this link went.
  const { data: others, error: othersErr } = await admin.from("organization_admins")
    .select("id").eq("profile_id", profile_id);
  if (othersErr || (others ?? []).length > 0) {
    return json({ ok: true, removedAccount: false });
  }
  // A person who is not an org admin at all has no account of ours to take away.
  if (!target || target.role !== "org_admin") return json({ ok: true, removedAccount: false });

  const { error: deleteProfileErr } = await admin.from("profiles").delete().eq("id", profile_id);
  if (deleteProfileErr) {
    const blocked = deleteProfileErr.message?.toLowerCase().includes("foreign key") || deleteProfileErr.code === "23503";
    console.error("remove-org-admin: could not delete the profile:", deleteProfileErr.message);
    return json({
      ok: true,
      removedAccount: false,
      warning: blocked
        ? `${name} was removed from ${organization.name}. Their account has records on file so it was kept, but it can no longer see anything.`
        : `${name} was removed from ${organization.name}, but their account could not be deleted. It can no longer see anything.`,
    });
  }

  const { error: deleteUserErr } = await admin.auth.admin.deleteUser(profile_id);
  if (deleteUserErr) {
    console.error("remove-org-admin: could not delete the login:", deleteUserErr.message);
    return json({ ok: true, removedAccount: true, warning: `${name} was removed, but their login could not be fully deleted. Tell Figbloom if they can still sign in.` });
  }

  return json({ ok: true, removedAccount: true });
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
