/**
 * Whether this person administers the organization, and it is active.
 *
 * The database cuts a suspended organization's admins off from its schools
 * (my_organization_tenant_ids(), 20261026080000), but the functions here run
 * as the service role, where row-level security doesn't apply. Each one used
 * to check only for an organization_admins row, so a suspended organization's
 * admins could still create, delete and reset accounts in its schools
 * (FIG-1312). Same rule as the database: only 'active' counts. Fails closed.
 */
// deno-lint-ignore no-explicit-any
export async function administersOrganization(admin: any, profileId: string, organizationId: string | null | undefined): Promise<boolean> {
  if (!organizationId) return false;
  const { data: link, error } = await admin.from("organization_admins")
    .select("id").eq("profile_id", profileId).eq("organization_id", organizationId).maybeSingle();
  if (error || !link) return false;
  const { data: organization, error: orgError } = await admin.from("organizations")
    .select("status").eq("id", organizationId).maybeSingle();
  return !orgError && organization?.status === "active";
}

/**
 * Whether every organization this person administers is cut off, so they may
 * not start a new one either: a new organization starts 'active', and its
 * admin can add schools to it straight away, which would step round the
 * suspension. Someone with no organization at all isn't affected. Fails closed.
 */
// deno-lint-ignore no-explicit-any
export async function onlyAdministersInactiveOrganizations(admin: any, profileId: string): Promise<boolean> {
  const { data: links, error } = await admin.from("organization_admins").select("organization_id").eq("profile_id", profileId);
  if (error) return true;
  const ids = ((links ?? []) as { organization_id: string }[]).map((l) => l.organization_id);
  if (!ids.length) return false;
  const { data: active, error: orgError } = await admin.from("organizations").select("id").in("id", ids).eq("status", "active");
  return !!orgError || (active ?? []).length === 0;
}
