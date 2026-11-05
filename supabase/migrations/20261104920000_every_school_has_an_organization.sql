-- Every school belongs to an organisation (Mike, 2026-11-03).
--
-- An owner of several schools creates an organisation and adds them; a single
-- school has its own, named after it (design 5.8). Until now a school could
-- have none: the staff console's onboarding made the organisation optional,
-- seeds and scripts inserted schools without one, and "Not assigned" took a
-- school out of its organisation.
--
-- Guaranteed in the database, so no path can miss it:
--
--   1. A school inserted without an organisation gets its own first: a
--      BEFORE INSERT trigger creates one with the school's name, slug and
--      county (create_school_own_organization(), the same writes as the staff
--      console's createOrganization) and points the new row at it. Every
--      creation path (self sign-up, staff onboarding, seeds, scripts, a SQL
--      insert) is covered without each one having to remember.
--   2. Every school that has none today gets its own now, the same way
--      (platform_create_school_organization(), which also takes the first
--      school admin's address as the contact). The triggers queue both for
--      the Figbloom platform, so no school waits without an organisation.
--   3. tenants.organization_id is NOT NULL, and an organisation that still
--      has schools can't be deleted (ON DELETE RESTRICT instead of SET NULL),
--      so a school can't lose its organisation later either.
--
-- Why a trigger and NOT NULL rather than NOT NULL alone: NOT NULL alone would
-- make every existing caller that doesn't pass an organisation fail (the
-- seeds, onboarding a single school). The trigger keeps them working and
-- gives each school the organisation Mike's model says it has. Moving a
-- school out of a group to stand alone is give_school_own_organization().
--
-- supabase/rls-checks/organization_suspension.sql checks it.

-- ------------------------------------------------------------ a school's own organisation
create or replace function create_school_own_organization(p_name text, p_slug text, p_county text, p_contact_email text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_slug text := p_slug;
  v_try int := 1;
  v_org uuid;
begin
  while exists (select 1 from organizations where slug = v_slug) loop
    -- at most 28 + "-school-NN": the 40-character slug limit
    v_slug := rtrim(left(p_slug, 28), '-') || '-school' || case when v_try = 1 then '' else '-' || v_try end;
    v_try := v_try + 1;
  end loop;
  insert into organizations (name, slug, kind, county, contact_email, status)
  values (p_name, v_slug, 'group_owner', p_county, p_contact_email, 'active')
  returning id into v_org;
  return v_org;
end $$;

-- The backfill's (20261104900000), now through the helper above.
create or replace function platform_create_school_organization(p_tenant_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t tenants;
  v_email text;
  v_org uuid;
begin
  select * into t from tenants where id = p_tenant_id for update;
  if not found then raise exception 'no school %', p_tenant_id using errcode = 'P0002'; end if;
  if t.organization_id is not null then return t.organization_id; end if;
  select coalesce(nullif(trim(p.email), ''), u.email) into v_email
    from profiles p left join auth.users u on u.id = p.id
   where p.tenant_id = t.id and p.role = 'school_admin'
     and coalesce(nullif(trim(p.email), ''), u.email) not like '%.figbloom.internal'
   order by p.created_at, p.id limit 1;
  v_org := create_school_own_organization(t.name, t.slug, t.county, v_email);
  update tenants set organization_id = v_org where id = t.id;
  return v_org;
end $$;

-- Staff: take a school out of its group to stand alone, in an organisation of its own.
create or replace function give_school_own_organization(p_tenant_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t tenants;
  v_org uuid;
begin
  if not is_super() then
    raise exception 'Only Figbloom staff can move a school to its own organisation.' using errcode = '42501';
  end if;
  select * into t from tenants where id = p_tenant_id for update;
  if not found then raise exception 'no school %', p_tenant_id using errcode = 'P0002'; end if;
  v_org := create_school_own_organization(t.name, t.slug, t.county, null);
  update tenants set organization_id = v_org where id = t.id;
  return v_org;
end $$;

-- ------------------------------------------------------------ 1. every new school
create or replace function tenants_own_organization() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.organization_id is null then
    new.organization_id := create_school_own_organization(new.name, new.slug, new.county, null);
  end if;
  return new;
end $$;
create trigger tenants_own_organization before insert on tenants
  for each row execute function tenants_own_organization();

revoke execute on function create_school_own_organization(text, text, text, text) from public, anon, authenticated;
grant execute on function create_school_own_organization(text, text, text, text) to service_role;
revoke execute on function platform_create_school_organization(uuid) from public, anon, authenticated;
grant execute on function platform_create_school_organization(uuid) to service_role;
revoke execute on function give_school_own_organization(uuid) from public, anon;
grant execute on function give_school_own_organization(uuid) to authenticated, service_role;
revoke execute on function tenants_own_organization() from public, anon, authenticated;

-- ------------------------------------------------------------ 2. every school today
do $$
declare r record;
begin
  for r in select id from tenants where organization_id is null order by created_at, id loop
    perform platform_create_school_organization(r.id);
  end loop;
end $$;

-- ------------------------------------------------------------ 3. and never without one again
do $$
declare con text;
begin
  select conname into con from pg_constraint
   where conrelid = 'tenants'::regclass and contype = 'f'
     and conkey = array[(select attnum from pg_attribute where attrelid = 'tenants'::regclass and attname = 'organization_id')];
  if con is not null then execute format('alter table tenants drop constraint %I', con); end if;
end $$;
alter table tenants
  add constraint tenants_organization_id_fkey foreign key (organization_id) references organizations on delete restrict,
  alter column organization_id set not null;
