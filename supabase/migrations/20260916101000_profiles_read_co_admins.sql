-- FIG-390 continued: fixing organization_admins_read_own alone wasn't
-- enough — the co-admins list embeds each row's `profiles` (full_name,
-- email), and profile_read_self only ever granted `id = auth.uid()`,
-- `is_super()`, or same-tenant staff. An org_admin reading another
-- org_admin's row (their own tenant_id is null, so the same-tenant branch
-- can never match) got PostgREST's embed silently resolving to null —
-- confirmed live: the organization_admins row was visible, but its joined
-- profiles came back null for every row except the caller's own.
--
-- Narrowly scoped to the same shape as the previous migration: only reveals
-- OTHER org_admins' profiles when they share an organization the caller
-- already administers, via the same my_organization_ids() security definer
-- helper (no direct organization_admins subquery here either, for the same
-- recursion reason).
drop policy profile_read_self on profiles;

create policy profile_read_self on profiles for select
  using (
    id = auth.uid()
    or is_super()
    or (tenant_id = my_tenant() and is_staff())
    or (
      role = 'org_admin'
      and id in (select profile_id from organization_admins where organization_id in (select my_organization_ids()))
    )
  );
