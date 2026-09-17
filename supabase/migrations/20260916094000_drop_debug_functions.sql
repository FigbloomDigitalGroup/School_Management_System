-- Removes three temporary debug functions used to diagnose FIG-369's RLS
-- policy live (never part of the product, only existed to isolate whether a
-- failing insert was the WITH CHECK itself or a separate RETURNING/SELECT
-- visibility issue -- it was the latter, see the FIG-369 PR description).
drop function if exists debug_org_admin_check(uuid);
drop function if exists debug_list_tenant_policies();
drop function if exists debug_check_expr(uuid);
