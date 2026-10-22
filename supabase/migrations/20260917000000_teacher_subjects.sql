-- Which subjects a teacher is qualified to teach (set once, on hire, and
-- rarely changed) -- distinct from teaching_assignments, which is which
-- subject they're *currently* teaching in a *specific class* this term.
-- Lets the "who teaches this subject in this class" picker (SubjectsEditor)
-- surface qualified teachers first instead of requiring the admin to already
-- know every teacher's background by heart.

create table teacher_subjects (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  teacher_id uuid not null references profiles on delete cascade,
  subject_id uuid not null references subjects on delete cascade,
  unique (teacher_id, subject_id)
);
create index on teacher_subjects (subject_id);

alter table teacher_subjects enable row level security;

-- readable by anyone in the tenant (same as subjects/classes themselves),
-- writable only by a school_admin (set at hiring, same as staff_title) --
-- mirrors teaching_write's shape exactly.
create policy teacher_subjects_read on teacher_subjects for select
  using (is_super() or tenant_id = my_tenant());
create policy teacher_subjects_write on teacher_subjects for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
