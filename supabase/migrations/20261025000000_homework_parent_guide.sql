-- Homework parents can actually help with.
--
-- 1. assignments.parent_guide: what the teacher wants a parent to know about
--    one piece of homework, written for a parent rather than the learner.
--    One jsonb column rather than five text columns because it is only ever
--    read and written whole (the teacher's form, the parent's card), and an
--    item with no guide is simply null. Shape — every key optional:
--
--      { "about":   "What it's about, in plain words",
--        "needs":   ["Exercise book", "Printing", ...],  -- things the child needs
--        "help":    "How a parent can help",
--        "avoid":   "What not to do (e.g. don't do it for them)",
--        "minutes": 20 }                                  -- expected time, 1-600
--
--    packages/shared/src/homework.ts (cleanGuide/normaliseGuide) is the one
--    place that writes and reads it; keep the two in step.
--
-- 2. Tighter writes on assignments: a teacher may only set homework for a
--    class + subject they actually teach (teaching_assignments), the same
--    scoping 20260924010000 gave marks. Before this any teacher could write
--    any assignment in the school. WITH CHECK repeats USING exactly.
--
-- 3. assignment_submissions ("handed in"/"done") gets a real write rule.
--    submission_own let anyone who could see a learner (every guardian
--    included) mark any assignment done for them, for any class. Now:
--      - read: unchanged (staff, the learner, their guardians);
--      - write: only for an assignment set to the learner's own class, and only by
--          the learner themself, staff of the school (or may_administer), or
--          a guardian of a young learner — PP1-PP2 and Grade 1-3. A young
--          child often has no login and can't tick a box; an older one
--          marks their own work, so a parent can't quietly tick it for them.
--    marked_by records who ticked it, so a parent sees "You marked this
--    done" vs "Done — marked by Amani".

-- ---------------------------------------------------------------- assignments
alter table assignments add column parent_guide jsonb;

alter table assignments add constraint assignments_parent_guide_shape check (
  parent_guide is null or (
    jsonb_typeof(parent_guide) = 'object'
    and (not parent_guide ? 'needs' or jsonb_typeof(parent_guide->'needs') = 'array')
    and (not parent_guide ? 'needs' or jsonb_array_length(parent_guide->'needs') <= 20)
    and (not parent_guide ? 'about' or jsonb_typeof(parent_guide->'about') = 'string')
    and (not parent_guide ? 'help'  or jsonb_typeof(parent_guide->'help')  = 'string')
    and (not parent_guide ? 'avoid' or jsonb_typeof(parent_guide->'avoid') = 'string')
    and (
      not parent_guide ? 'minutes'
      or jsonb_typeof(parent_guide->'minutes') = 'null'
      or (jsonb_typeof(parent_guide->'minutes') = 'number' and (parent_guide->>'minutes')::numeric between 1 and 600)
    )
    and octet_length(parent_guide::text) <= 8000
  )
);

-- hand_in was free text; the apps only ever offer these three.
alter table assignments add constraint assignments_hand_in_valid
  check (hand_in in ('paper', 'in_person', 'upload'));
alter table assignments add constraint assignments_title_present
  check (char_length(btrim(title)) between 1 and 200);

-- every reader (learner, parent, teacher) asks "this class, by due date"
create index if not exists assignments_class_due_idx on assignments (class_id, due_on);

-- Who may write assignments is settled by 20261023000000_exam_marks_publication
-- (assignment_insert/update/delete: a teacher sets work for a class + subject
-- they teach and changes only their own).

-- ---------------------------------------------------------------- submissions
alter table assignment_submissions
  add column marked_by uuid references profiles on delete set null default auth.uid();

-- marked_by is whoever made the write, never what the client claims.
-- (Service-role writes — seeds — have no auth.uid() and keep what they sent.)
create or replace function submissions_stamp_marked_by() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then new.marked_by := auth.uid(); end if;
  return new;
end $$;

create trigger submissions_stamp_marked_by
  before insert or update on assignment_submissions
  for each row execute function submissions_stamp_marked_by();

-- PP1-PP2 and Grade 1-3. Mirrors isYoungLearner() in packages/shared/src/homework.ts.
create or replace function is_young_class(p_level class_level, p_year int) returns boolean
language sql immutable as $$
  select p_level = 'pre_primary' or (p_level = 'primary' and p_year <= 3)
$$;

-- Who may mark one assignment done (or undo it) for one learner — see the header.
create or replace function may_mark_submission(p_assignment_id uuid, p_student_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from assignments a
    join students s on s.id = p_student_id and s.class_id = a.class_id and s.tenant_id = a.tenant_id
    join classes c on c.id = s.class_id
    where a.id = p_assignment_id
      and (
        s.profile_id = auth.uid()
        or (s.tenant_id = my_tenant() and is_staff())
        or may_administer(s.tenant_id)
        or (is_young_class(c.level, c.form_level) and exists (
              select 1 from guardians g where g.student_id = s.id and g.profile_id = auth.uid()))
      )
  )
$$;

grant execute on function may_mark_submission(uuid, uuid) to authenticated;

drop policy submission_own on assignment_submissions;
create policy submission_read on assignment_submissions for select
  using (student_id in (select my_students()));
create policy submission_insert on assignment_submissions for insert
  with check (may_mark_submission(assignment_id, student_id));
create policy submission_update on assignment_submissions for update
  using (may_mark_submission(assignment_id, student_id))
  with check (may_mark_submission(assignment_id, student_id));
create policy submission_delete on assignment_submissions for delete
  using (may_mark_submission(assignment_id, student_id));
