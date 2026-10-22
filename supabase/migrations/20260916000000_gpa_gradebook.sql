-- FIG-330: credit/GPA gradebook for higher-ed, alongside the existing K-12
-- report-card model (exams/marks). Deliberately NOT built on exams/marks:
-- grading.ts's own docstring states "the same score must never render as two
-- different grades anywhere in the product" — a weighted-composite,
-- credit/GPA scheme is a different algorithm, not a parameterization of the
-- fixed KCSE scale, so this is new parallel tables + a new packages/shared
-- module (gpa.ts), never touching exams/marks/grading.ts.

create table course_assessments (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants on delete cascade,
  course_section_id uuid not null references course_sections on delete cascade,
  name              text not null,               -- "Midterm", "Assignment 3", "Final"
  weight_pct        numeric(5,2) not null check (weight_pct > 0 and weight_pct <= 100),
  out_of            int not null default 100 check (out_of > 0),
  published_at      timestamptz,
  unique (course_section_id, name)
);
create index on course_assessments (tenant_id, course_section_id);

create table course_marks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants on delete cascade,
  assessment_id uuid not null references course_assessments on delete cascade,
  student_id    uuid not null references students on delete cascade,
  score         numeric(6,2) check (score is null or score >= 0),
  entered_by    uuid not null references profiles on delete restrict,
  entered_at    timestamptz not null default now(),
  unique (assessment_id, student_id)
);
create index on course_marks (tenant_id, assessment_id);

-- Finalized per-section grade: computed and stored once a lecturer closes
-- out a section, not derived live on every read — the same reasoning as
-- fee_invoices.paid_cents being trigger-maintained rather than summed on
-- read, so a transcript doesn't silently reflow if a mark is corrected later.
create type letter_grade as enum ('A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F');

create table course_grades (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants on delete cascade,
  student_id        uuid not null references students on delete cascade,
  course_section_id uuid not null references course_sections on delete cascade,
  weighted_score     numeric(6,2),
  letter_grade      letter_grade,
  grade_points       numeric(3,2),
  finalized_at      timestamptz not null default now(),
  unique (student_id, course_section_id)
);
create index on course_grades (tenant_id, student_id);

alter table course_assessments enable row level security;
alter table course_marks       enable row level security;
alter table course_grades      enable row level security;

-- true if this profile instructs the given section (mirrors the inline
-- teaching_assignments checks in attendance_write/mark_write).
create or replace function teaches_section(section_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from course_sections cs where cs.id = section_id and cs.instructor_id = auth.uid())
$$;

-- unpublished assessments are staff-only; students/parents see them once published (same shape as exam_read)
create policy course_assessment_read on course_assessments for select
  using (is_super() or (tenant_id = my_tenant() and (is_staff() or published_at is not null)));
create policy course_assessment_write on course_assessments for all
  using (
    is_super()
    or (tenant_id = my_tenant() and my_role() = 'school_admin')
    or (tenant_id = my_tenant() and my_role() = 'teacher' and teaches_section(course_section_id))
  )
  with check (tenant_id = my_tenant() or is_super());

create policy course_mark_read on course_marks for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or (
      student_id in (select s.id from students s where s.profile_id = auth.uid())
      and exists (select 1 from course_assessments a where a.id = course_marks.assessment_id and a.published_at is not null)
    )
  );
create policy course_mark_write on course_marks for all
  using (
    is_super()
    or (tenant_id = my_tenant() and my_role() = 'school_admin')
    or (tenant_id = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from course_assessments a where a.id = course_marks.assessment_id and teaches_section(a.course_section_id)))
  )
  with check (tenant_id = my_tenant() or is_super());

-- finalized transcript record: staff (admin or the section's own instructor) write, student reads their own
create policy course_grade_read on course_grades for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or student_id in (select s.id from students s where s.profile_id = auth.uid())
  );
create policy course_grade_write on course_grades for all
  using (
    is_super()
    or (tenant_id = my_tenant() and my_role() = 'school_admin')
    or (tenant_id = my_tenant() and my_role() = 'teacher' and teaches_section(course_section_id))
  )
  with check (tenant_id = my_tenant() or is_super());
