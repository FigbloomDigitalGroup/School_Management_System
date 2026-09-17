-- FIG-369 (FIG-368 foundation): schema for self-service organization + school
-- signup. Two independent pieces:
--
-- 1. organizations.status gains 'pending' -- the state a self-registered org
--    starts in until a super_admin approves it with one click.
-- 2. tenant_write_org_admin: lets an *approved* org's own admin create schools
--    under their own organization, without needing a super_admin every time.
--    Purely additive -- does not touch tenant_write_super or
--    organization_write_super, both of which stay is_super()-only. Org
--    creation itself for self-service goes through a new edge function using
--    the service-role key (same privileged-path pattern as every other
--    creation flow already in the app), not a relaxed RLS policy -- the
--    browser client never gets permission to insert into organizations.

-- Drop the existing inline check on organizations.status dynamically, since
-- an unnamed check constraint's auto-generated name isn't guaranteed and
-- guessing it wrong would silently leave the old, narrower check in place.
do $$
declare
  con text;
begin
  select conname into con from pg_constraint
    where conrelid = 'organizations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%';
  if con is not null then
    execute format('alter table organizations drop constraint %I', con);
  end if;
end $$;

alter table organizations add constraint organizations_status_check
  check (status in ('pending', 'active', 'suspended'));

create policy tenant_write_org_admin on tenants for insert
  with check (
    is_org_admin()
    and organization_id in (select organization_id from organization_admins where profile_id = auth.uid())
    and organization_id in (select id from organizations where status = 'active')
  );
