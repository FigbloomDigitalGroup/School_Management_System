-- CBE catalogue: KICD's learning areas, and the strands / sub-strands under
-- each one per grade, as ONE platform-wide list Figbloom maintains. Schools
-- pick learning areas into their own `subjects` (linked by learning_area_id)
-- rather than each typing the national curriculum in by hand, and when KICD
-- revises a design it is corrected here once, not in every school.
--
-- Strands can also belong to a single school (tenant_id set): the official
-- strand lists come from KICD's curriculum-design documents and are loaded by
-- Figbloom staff over time, so a school is never blocked on a grade the
-- catalogue doesn't cover yet -- it adds its own strands and carries on.
--
-- verified_at stays null until someone has checked a row against the
-- official KICD design; the app shows unverified rows as "under review".

create table learning_areas (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  level       class_level not null,
  min_grade   int not null,
  max_grade   int not null,
  is_core     boolean not null default true,
  pathway     cbe_pathway,          -- senior school electives only
  track       text,                 -- a pathway's track, e.g. 'pure_sciences'
  sort_order  int not null default 0,
  source      text,
  verified_at timestamptz,
  created_at  timestamptz not null default now(),
  check (min_grade <= max_grade),
  check (level_year_valid(level, min_grade) and level_year_valid(level, max_grade)),
  check (pathway is null or level = 'senior_school')
);
create index on learning_areas (level, sort_order);

create table strands (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid references tenants on delete cascade,   -- null = KICD official
  learning_area_id uuid not null references learning_areas on delete cascade,
  grade            int not null,
  parent_id        uuid references strands on delete cascade,   -- set = a sub-strand
  code             text,
  name             text not null,
  sort_order       int not null default 0,
  source           text,
  verified_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index on strands (learning_area_id, grade);
create index on strands (tenant_id);
-- One strand name per area x grade x parent within the official list, and
-- within each school's own additions.
create unique index strands_unique_name on strands (
  coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  learning_area_id, grade, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)
);

-- A strand's grade must sit inside its learning area's range, and a
-- sub-strand must share its parent's area, grade and owner.
create or replace function strands_check() returns trigger
language plpgsql as $$
declare
  area learning_areas;
  parent strands;
begin
  select * into area from learning_areas where id = new.learning_area_id;
  if new.grade not between area.min_grade and area.max_grade then
    raise exception '% runs % to %; grade % is outside it', area.name, area.min_grade, area.max_grade, new.grade;
  end if;
  if new.parent_id is not null then
    select * into parent from strands where id = new.parent_id;
    if parent.parent_id is not null then
      raise exception 'Sub-strands can''t have sub-strands of their own';
    end if;
    -- A school may hang its own sub-strand under an official strand, never
    -- the other way round, and never under another school's strand.
    if parent.learning_area_id <> new.learning_area_id or parent.grade <> new.grade
       or (parent.tenant_id is not null and parent.tenant_id is distinct from new.tenant_id) then
      raise exception 'A sub-strand must match its strand''s learning area and grade';
    end if;
  end if;
  return new;
end $$;

create trigger strands_check before insert or update on strands
  for each row execute function strands_check();

alter table subjects add column learning_area_id uuid references learning_areas on delete set null;

alter table learning_areas enable row level security;
alter table strands enable row level security;

-- Everyone signed in reads the catalogue; only Figbloom staff change it.
create policy learning_area_read on learning_areas for select to authenticated using (true);
create policy learning_area_write on learning_areas for all
  using (is_super()) with check (is_super());

-- Official strands are readable by all; a school's own strands only by that
-- school (and whoever administers it).
create policy strand_read on strands for select to authenticated
  using (tenant_id is null or tenant_id = my_tenant() or may_administer(tenant_id));
create policy strand_write_official on strands for all
  using (tenant_id is null and is_super()) with check (tenant_id is null and is_super());
create policy strand_write_school on strands for all
  using (tenant_id is not null and may_administer(tenant_id))
  with check (tenant_id is not null and may_administer(tenant_id));
