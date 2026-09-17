-- FIG-331 (part 2 of 2): cross-tenant "organizations" — a government body
-- (county/national), a constituency, or a private group-owner spanning
-- several otherwise-independent tenants. Each member tenant keeps its own
-- institution_type, students, staff, data — this migration only adds the
-- grouping and a new read-only cross-tenant role on top.
--
-- This is the first-ever cross-tenant access boundary for a non-Figbloom
-- role (today only super_admin, via is_super(), crosses tenant isolation).
-- RLS granting org_admin any actual cross-tenant READ access is deliberately
-- NOT part of this migration (see FIG-332) — this one only adds the schema,
-- the role, and staff-only management policies, so org_admin exists but can
-- see nothing beyond their own profile/org membership until FIG-332 lands.

create type organization_kind as enum ('government', 'county', 'constituency', 'group_owner');

create table organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  kind          organization_kind not null,
  county        text,
  contact_name  text,
  contact_email text,
  contact_phone text,
  status        text not null default 'active' check (status in ('active', 'suspended')),
  created_at    timestamptz not null default now(),
  created_by    uuid references profiles on delete set null
);
create index on organizations (kind);

alter table tenants
  add column organization_id uuid references organizations on delete set null;
create index on tenants (organization_id);

-- profiles.tenant_id was null-iff-super_admin; org_admin is the second role
-- scoped through a mapping table (organization_admins) instead of a direct
-- tenant_id, the same way a parent is scoped through guardians rather than
-- through profiles directly — revocable with a single delete, inspectable,
-- and lets one admin cover more than one organization without a schema change.
alter table profiles drop constraint tenant_required;
alter table profiles add constraint tenant_required
  check ((role in ('super_admin', 'org_admin')) = (tenant_id is null));

create table organization_admins (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references profiles on delete cascade,
  organization_id uuid not null references organizations on delete cascade,
  added_at        timestamptz not null default now(),
  added_by        uuid references profiles on delete set null,
  unique (profile_id, organization_id)
);
create index on organization_admins (organization_id);

-- Defence in depth: an organization_admins row must point at a role='org_admin'
-- profile — this can't be expressed as a plain FK, so a trigger enforces it,
-- the same shape as marks_within_paper() enforces score <= exams.out_of.
create or replace function organization_admins_role_check() returns trigger
language plpgsql as $$
begin
  if (select role from profiles where id = new.profile_id) <> 'org_admin' then
    raise exception 'organization_admins.profile_id must reference an org_admin profile';
  end if;
  return new;
end $$;
create trigger organization_admins_role_check
  before insert or update on organization_admins
  for each row execute function organization_admins_role_check();

alter table organizations       enable row level security;
alter table organization_admins enable row level security;

create policy organization_read_own on organizations for select
  using (is_super() or id in (select organization_id from organization_admins where profile_id = auth.uid()));
create policy organization_write_super on organizations for all
  using (is_super()) with check (is_super());

create policy organization_admins_read_own on organization_admins for select
  using (is_super() or profile_id = auth.uid());
create policy organization_admins_write_super on organization_admins for all
  using (is_super()) with check (is_super());

-- staff-side tenant linking: a super_admin may assign/reassign any tenant's
-- organization_id — tenant_write_super already grants super_admin full
-- write access to tenants, so no new policy is needed for this column.
