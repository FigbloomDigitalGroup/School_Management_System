-- FIG-327: course/unit enrollment for higher-ed institutions. Entirely
-- additive — no existing K-12 table (terms, classes, subjects, exams, marks,
-- timetable_slots) is touched. A higher-ed tenant's students, courses and
-- schedule live in these five new tables instead; a k12 tenant never writes
-- to them (nothing in the app writes here unless institution_type = 'higher_ed').

-- ---------------------------------------------------------------- semesters
-- Deliberately not a reuse of `terms`: terms.index is checked between 1 and 3
-- (a hardcoded Kenyan 3-term year) and consumed with that assumption baked
-- into K-12 UI copy — a parallel table means a 2-semester-plus-summer higher
-- ed calendar never has to reinterpret what "index" means for terms.
create table semesters (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  name       text not null,               -- "Semester 1, 2026"
  year       int  not null,
  index      int  not null check (index between 1 and 3),
  starts_on  date not null,
  ends_on    date not null,
  is_current boolean not null default false,
  unique (tenant_id, year, index),
  check (ends_on > starts_on)
);
create unique index one_current_semester on semesters (tenant_id) where is_current;

-- ---------------------------------------------------------------- courses
create table courses (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  code       text not null,
  name       text not null,
  credits    numeric(4,1) not null default 3.0 check (credits > 0),
  department text,
  unique (tenant_id, code)
);

-- ---------------------------------------------------------------- sections
-- One course has many sections per semester; one instructor per section
-- (same shape as classes.class_teacher_id) — a lecturer teaching many
-- sections across departments is just many course_sections rows with the
-- same instructor_id, the same way teaching_assignments already lets one
-- K-12 teacher hold many class×subject rows.
create table course_sections (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants on delete cascade,
  course_id     uuid not null references courses on delete cascade,
  semester_id   uuid not null references semesters on delete cascade,
  section_label text not null,
  instructor_id uuid references profiles on delete set null,
  room          text,
  capacity      int check (capacity > 0),
  unique (course_id, semester_id, section_label)
);
create index on course_sections (tenant_id, semester_id);
create index on course_sections (instructor_id);

-- ---------------------------------------------------------------- enrollments
-- Plays the role students.class_id plays for K-12: which sections a student
-- is on. Many rows per student per semester, unlike class_id's one-per-year.
-- status (not a hard delete on drop) keeps a transcript-relevant history.
create table enrollments (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants on delete cascade,
  student_id        uuid not null references students on delete cascade,
  course_section_id uuid not null references course_sections on delete cascade,
  status            text not null default 'enrolled' check (status in ('enrolled', 'dropped', 'completed')),
  enrolled_at       timestamptz not null default now(),
  unique (student_id, course_section_id)
);
create index on enrollments (tenant_id, course_section_id);
create index on enrollments (student_id) where status = 'enrolled';

-- ---------------------------------------------------------------- timetable
-- Mirrors timetable_slots exactly, keyed by course_section_id instead of
-- class_id — a student's combined weekly view unions across every section
-- they're enrolled in, a genuinely different query shape than K-12's
-- one-class-one-grid, so this is a new table rather than a parameter change.
create table course_section_timetable_slots (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants on delete cascade,
  course_section_id uuid not null references course_sections on delete cascade,
  day               text not null check (day in ('Mon','Tue','Wed','Thu','Fri')),
  start_time        text not null,
  label             text not null,
  room              text,
  unique (course_section_id, day, start_time)
);
create index on course_section_timetable_slots (tenant_id, course_section_id);

-- ---------------------------------------------------------------------- RLS

alter table semesters                     enable row level security;
alter table courses                       enable row level security;
alter table course_sections               enable row level security;
alter table enrollments                   enable row level security;
alter table course_section_timetable_slots enable row level security;

-- semesters, courses: read by anyone in the tenant, write by admin — same
-- shape as the existing terms/classes/subjects policy loop.
do $$
declare t text;
begin
  foreach t in array array['semesters', 'courses'] loop
    execute format($f$
      create policy %1$s_read on %1$s for select
        using (is_super() or tenant_id = my_tenant());
      create policy %1$s_write on %1$s for all
        using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
        with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
    $f$, t);
  end loop;
end $$;

create policy course_section_read on course_sections for select
  using (is_super() or tenant_id = my_tenant());
create policy course_section_write on course_sections for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

-- the enrollments this user may see: staff of the tenant, or the enrolled student themself
create or replace function my_enrollments() returns setof uuid
language sql stable security definer set search_path = public as $$
  select e.id from enrollments e
  join students s on s.id = e.student_id
  where s.tenant_id = my_tenant()
    and (is_staff() or s.profile_id = auth.uid())
$$;

create policy enrollment_read on enrollments for select
  using (is_super() or id in (select my_enrollments()));
create policy enrollment_write on enrollments for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

create policy course_section_timetable_read on course_section_timetable_slots for select
  using (is_super() or tenant_id = my_tenant());
create policy course_section_timetable_write on course_section_timetable_slots for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
