-- CBE assessment: a teacher records a rubric judgement (EE/ME/AE/BE, or the
-- 8-level EE1..BE2) per learner per strand, instead of one numeric mark per
-- exam per subject.
--
-- Scoped to ONE class and ONE subject per assessment. KCSE exams are
-- tenant-wide (exams.published_at releases every subject in every class at
-- once, and any teacher can flip it); a CBE assessment is published by the
-- class's own subject teacher and releases only that class x subject.
--
-- Points always come from the rubric, computed here from level_code, so a
-- client can never store "EE" with the wrong points. rubric_points() mirrors
-- RUBRIC_REGISTRY in packages/shared/src/gradingSchemes.ts; keep them in step.

create or replace function rubric_points(p_level class_level, p_code text) returns smallint
language sql immutable as $$
  select case
    when p_level in ('pre_primary', 'primary') then
      case p_code when 'EE' then 4 when 'ME' then 3 when 'AE' then 2 when 'BE' then 1 end
    when p_level in ('junior_secondary', 'senior_school') then
      case p_code when 'EE1' then 8 when 'EE2' then 7 when 'ME1' then 6 when 'ME2' then 5
                  when 'AE1' then 4 when 'AE2' then 3 when 'BE1' then 2 when 'BE2' then 1 end
  end::smallint
$$;

create table cbe_assessments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  term_id      uuid not null references terms on delete cascade,
  class_id     uuid not null references classes on delete cascade,
  subject_id   uuid not null references subjects on delete cascade,
  title        text not null,
  kind         text not null default 'summative' check (kind in ('formative', 'summative')),
  assessed_on  date not null default current_date,
  published_at timestamptz,
  created_by   uuid references profiles on delete set null,
  created_at   timestamptz not null default now()
);
create index on cbe_assessments (class_id, subject_id, term_id);

create table cbe_results (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants on delete cascade,
  assessment_id uuid not null references cbe_assessments on delete cascade,
  student_id    uuid not null references students on delete cascade,
  strand_id     uuid not null references strands on delete cascade,
  level_code    text not null,
  points        smallint not null,
  entered_by    uuid references profiles on delete set null,
  updated_at    timestamptz not null default now(),
  unique (assessment_id, student_id, strand_id)
);
create index on cbe_results (student_id);

-- One teacher's comment per learner per assessment — what goes on the report card.
create table cbe_assessment_comments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants on delete cascade,
  assessment_id uuid not null references cbe_assessments on delete cascade,
  student_id    uuid not null references students on delete cascade,
  comment       text not null,
  updated_at    timestamptz not null default now(),
  unique (assessment_id, student_id)
);

create or replace function cbe_assessments_check() returns trigger
language plpgsql as $$
declare
  cls classes;
  subj subjects;
begin
  select * into cls from classes where id = new.class_id;
  select * into subj from subjects where id = new.subject_id;
  if cls.tenant_id <> new.tenant_id or subj.tenant_id <> new.tenant_id then
    raise exception 'Class and subject must belong to the same school as the assessment';
  end if;
  if cls.level = 'secondary' then
    raise exception '8-4-4 Form classes are graded with exam marks, not the CBE rubric';
  end if;
  if subj.learning_area_id is null then
    raise exception '% isn''t linked to a KICD learning area yet (Subjects > Add from KICD)', subj.name;
  end if;
  return new;
end $$;

create trigger cbe_assessments_check before insert or update of class_id, subject_id, tenant_id on cbe_assessments
  for each row execute function cbe_assessments_check();

create or replace function cbe_results_check() returns trigger
language plpgsql as $$
declare
  a cbe_assessments;
  cls classes;
  subj subjects;
  st strands;
begin
  select * into a from cbe_assessments where id = new.assessment_id;
  select * into cls from classes where id = a.class_id;
  select * into subj from subjects where id = a.subject_id;
  select * into st from strands where id = new.strand_id;

  if new.tenant_id <> a.tenant_id then
    raise exception 'Result belongs to a different school than its assessment';
  end if;
  new.points := rubric_points(cls.level, new.level_code);
  if new.points is null then
    raise exception '"%" is not a level on the % rubric', new.level_code, cls.level;
  end if;
  if st.learning_area_id is distinct from subj.learning_area_id or st.grade <> cls.form_level
     or (st.tenant_id is not null and st.tenant_id <> a.tenant_id) then
    raise exception 'That strand isn''t part of % for this grade', subj.name;
  end if;
  if tg_op = 'INSERT' and not exists (select 1 from students where id = new.student_id and class_id = a.class_id) then
    raise exception 'That learner isn''t in this class';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger cbe_results_check before insert or update on cbe_results
  for each row execute function cbe_results_check();

alter table cbe_assessments enable row level security;
alter table cbe_results enable row level security;
alter table cbe_assessment_comments enable row level security;

-- Teaches this class this subject (or administers the school).
create or replace function may_assess(p_tenant uuid, p_class uuid, p_subject uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select may_administer(p_tenant)
    or (p_tenant = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from teaching_assignments ta
          where ta.teacher_id = auth.uid() and ta.class_id = p_class and ta.subject_id = p_subject))
$$;

create policy cbe_assessment_read on cbe_assessments for select
  using (is_super() or may_administer(tenant_id) or (tenant_id = my_tenant() and (is_staff() or published_at is not null)));
create policy cbe_assessment_write on cbe_assessments for all
  using (may_assess(tenant_id, class_id, subject_id))
  with check (may_assess(tenant_id, class_id, subject_id));

create policy cbe_result_read on cbe_results for select
  using (
    is_super() or may_administer(tenant_id) or (tenant_id = my_tenant() and is_staff())
    or (student_id in (select my_students())
        and exists (select 1 from cbe_assessments a where a.id = cbe_results.assessment_id and a.published_at is not null))
  );
create policy cbe_result_write on cbe_results for all
  using (exists (select 1 from cbe_assessments a where a.id = cbe_results.assessment_id and may_assess(a.tenant_id, a.class_id, a.subject_id)))
  with check (exists (select 1 from cbe_assessments a where a.id = cbe_results.assessment_id and may_assess(a.tenant_id, a.class_id, a.subject_id)));

create policy cbe_comment_read on cbe_assessment_comments for select
  using (
    is_super() or may_administer(tenant_id) or (tenant_id = my_tenant() and is_staff())
    or (student_id in (select my_students())
        and exists (select 1 from cbe_assessments a where a.id = cbe_assessment_comments.assessment_id and a.published_at is not null))
  );
create policy cbe_comment_write on cbe_assessment_comments for all
  using (exists (select 1 from cbe_assessments a where a.id = cbe_assessment_comments.assessment_id and may_assess(a.tenant_id, a.class_id, a.subject_id)))
  with check (exists (select 1 from cbe_assessments a where a.id = cbe_assessment_comments.assessment_id and may_assess(a.tenant_id, a.class_id, a.subject_id)));

-- A subject teacher may add their school's own strands for a learning area
-- they teach, when the official catalogue doesn't cover the grade yet.
create policy strand_write_teacher on strands for insert
  with check (
    tenant_id is not null and tenant_id = my_tenant() and my_role() = 'teacher' and exists (
      select 1 from teaching_assignments ta join subjects s on s.id = ta.subject_id
      where ta.teacher_id = auth.uid() and s.learning_area_id = strands.learning_area_id)
  );
