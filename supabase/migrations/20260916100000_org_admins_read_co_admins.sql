-- FIG-390: an org_admin needs to see WHO ELSE administers their own
-- organization (to build a co-admins list in their own console), not just
-- their own organization_admins row. organization_admins_read_own only ever
-- granted `profile_id = auth.uid()` — correct for "can I see my own
-- membership row", but it silently filtered out every other admin's row
-- too, which would make an org-facing "Admins" screen show only yourself.
--
-- The "which organizations do I administer" lookup has to go through a
-- security definer function, not a raw subquery on organization_admins
-- inline in this policy — a plain self-referencing subquery would
-- re-trigger this same policy's evaluation for its own SELECT and hit
-- Postgres's "infinite recursion detected in policy for relation" error.
-- my_organization_tenant_ids() (FIG-332) already uses this exact pattern
-- for the same reason.
create or replace function my_organization_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select organization_id from organization_admins where profile_id = auth.uid()
$$;

-- Narrowly scoped: this only reveals OTHER co-admins' rows within
-- organizations the caller themselves already administers, not any
-- broader access to organization_admins as a whole.
drop policy organization_admins_read_own on organization_admins;

create policy organization_admins_read_own on organization_admins for select
  using (
    is_super()
    or profile_id = auth.uid()
    or organization_id in (select my_organization_ids())
  );
