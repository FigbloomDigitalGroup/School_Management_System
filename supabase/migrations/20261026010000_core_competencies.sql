-- Core competencies and values, rated once a term per learner for CBC report
-- cards.
--
-- CBC report cards carry, beside the learning areas, how a learner is doing
-- on the seven core competencies (communication and collaboration, critical
-- thinking, ...) and the national values (love, responsibility, ...). The
-- class teacher rates each on the four-level rubric (EE / ME / AE / BE).
-- The lists themselves live in packages/shared/src/competencies.ts; this
-- table only checks the shape of a code so a renamed item can't break old
-- rows.
--
-- Who: the class teacher of the learner's class, or the office
-- (may_administer), writes; staff read. Families see the ratings only on a
-- published report card (report_cards.data), not here.

create table learner_competencies (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  term_id    uuid not null references terms on delete cascade,
  student_id uuid not null references students on delete cascade,
  kind       text not null check (kind in ('competency', 'value')),
  item       text not null check (item ~ '^[a-z_]{2,40}$'),
  level_code text not null check (level_code in ('EE', 'ME', 'AE', 'BE')),
  rated_by   uuid references profiles on delete set null default auth.uid(),
  rated_at   timestamptz not null default now(),
  unique (term_id, student_id, kind, item)
);
create index on learner_competencies (tenant_id, term_id);

alter table learner_competencies enable row level security;

-- The class teacher of this learner's class (or the office).
create or replace function may_rate_competencies(p_tenant uuid, p_student uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select may_administer(p_tenant)
    or (p_tenant = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from students s join classes c on c.id = s.class_id
          where s.id = p_student and s.tenant_id = p_tenant and c.class_teacher_id = auth.uid()))
$$;
grant execute on function may_rate_competencies(uuid, uuid) to authenticated;

create policy learner_competencies_read on learner_competencies for select
  using (may_administer(tenant_id) or (tenant_id = my_tenant() and is_staff()));

create policy learner_competencies_write on learner_competencies for all
  using (may_rate_competencies(tenant_id, student_id))
  with check (may_rate_competencies(tenant_id, student_id));

create trigger learner_competencies_student_tenant before insert or update of tenant_id, student_id on learner_competencies
  for each row execute function enforce_student_tenant();

-- rated_by/rated_at say who last changed it, whatever the client sends.
create or replace function learner_competencies_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then new.rated_by := auth.uid(); end if;
  new.rated_at := now();
  if not exists (select 1 from terms where id = new.term_id and tenant_id = new.tenant_id) then
    raise exception 'That term belongs to another school.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger learner_competencies_stamp before insert or update on learner_competencies
  for each row execute function learner_competencies_stamp();
