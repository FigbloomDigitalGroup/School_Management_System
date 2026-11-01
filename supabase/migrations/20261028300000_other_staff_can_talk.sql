-- Other staff (librarians, matrons, the visitor desk; 20261028100001) join
-- the staff-with-staff pairing in may_talk() (20261028200000), so they can
-- chat with and call the school office, teachers, drivers and each other,
-- and colleagues can reach them. Nothing else changes: other staff still
-- can't reach families or learners, and families can't reach them.
--
-- may_talk() and my_chat_contacts() are recreated whole with 'staff' added
-- to their staff lists; chat_pair_allowed(), may_contact_from() and
-- may_contact() read may_talk(), so chat and calls both follow.

create or replace function may_talk(p_a uuid, p_b uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_role_a   text;
  v_role_b   text;
  v_tenant_a uuid;
  v_tenant_b uuid;
  v_parent   uuid;
  v_other    uuid;
  v_role     text;
begin
  if p_a is null or p_b is null or p_a = p_b then return false; end if;
  select role::text, tenant_id into v_role_a, v_tenant_a from profiles where id = p_a;
  select role::text, tenant_id into v_role_b, v_tenant_b from profiles where id = p_b;
  if v_tenant_a is null or v_tenant_a is distinct from v_tenant_b then return false; end if;

  -- staff with staff
  if v_role_a in ('school_admin', 'teacher', 'driver', 'staff') and v_role_b in ('school_admin', 'teacher', 'driver', 'staff') then
    return true;
  end if;

  -- Every other pairing has a parent on one side.
  if v_role_a = 'parent' then
    v_parent := p_a; v_other := p_b; v_role := v_role_b;
  elsif v_role_b = 'parent' then
    v_parent := p_b; v_other := p_a; v_role := v_role_a;
  else
    return false;
  end if;

  return case v_role
    when 'school_admin' then true
    when 'student' then exists (
      select 1 from guardians g join students s on s.id = g.student_id
       where g.profile_id = v_parent and s.profile_id = v_other and s.active)
    -- chat_teaches_student() only counts a current learner
    when 'teacher' then exists (
      select 1 from guardians g where g.profile_id = v_parent and chat_teaches_student(v_other, g.student_id))
    else false
  end;
end $$;

create or replace function my_chat_contacts()
returns table (profile_id uuid, full_name text, role text, avatar_url text, detail text)
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as id, my_role()::text as role, my_tenant() as tenant_id),
  candidates as (
    -- parent: their children who have accounts
    select s.profile_id as id, 'Your child' as why
      from me join guardians g on g.profile_id = me.id join students s on s.id = g.student_id
     where me.role = 'parent' and s.profile_id is not null and s.active
    union all
    -- parent: their children's subject teachers
    select ta.teacher_id, format('%s, %s''s teacher', sub.name, split_part(trim(s.full_name), ' ', 1))
      from me join guardians g on g.profile_id = me.id join students s on s.id = g.student_id
      join teaching_assignments ta on ta.class_id = s.class_id join subjects sub on sub.id = ta.subject_id
     where me.role = 'parent' and s.active
    union all
    -- parent: their children's class teachers
    select c.class_teacher_id, format('%s''s class teacher', split_part(trim(s.full_name), ' ', 1))
      from me join guardians g on g.profile_id = me.id join students s on s.id = g.student_id
      join classes c on c.id = s.class_id
     where me.role = 'parent' and s.active and c.class_teacher_id is not null
    union all
    -- parent: their children's lecturers (higher-ed sections)
    select cs.instructor_id, format('%s, %s''s lecturer', co.name, split_part(trim(s.full_name), ' ', 1))
      from me join guardians g on g.profile_id = me.id join students s on s.id = g.student_id
      join enrollments e on e.student_id = s.id and e.status = 'enrolled'
      join course_sections cs on cs.id = e.course_section_id join courses co on co.id = cs.course_id
     where me.role = 'parent' and s.active and cs.instructor_id is not null
    union all
    -- parent: the school office
    select p.id, coalesce(p.staff_title, 'School office')
      from me join profiles p on p.tenant_id = me.tenant_id and p.role = 'school_admin'
     where me.role = 'parent'
    union all
    -- learner: their own parents
    select g.profile_id, format('Your %s', g.relationship)
      from me join students s on s.profile_id = me.id join guardians g on g.student_id = s.id
     where me.role = 'student'
    union all
    -- teacher: parents of the learners they teach
    select g.profile_id, format('Parent of %s (%s)', s.full_name, c.name)
      from me join students s on s.tenant_id = me.tenant_id and s.active
      join classes c on c.id = s.class_id
      join guardians g on g.student_id = s.id
     where me.role = 'teacher' and chat_teaches_student(me.id, s.id)
    union all
    -- office: every parent in the school
    select g.profile_id, format('Parent of %s (%s)', s.full_name, c.name)
      from me join students s on s.tenant_id = me.tenant_id and s.active
      join classes c on c.id = s.class_id
      join guardians g on g.student_id = s.id
     where me.role = 'school_admin'
    union all
    -- staff: colleagues
    select p.id, coalesce(p.staff_title, case p.role::text when 'school_admin' then 'School office' when 'driver' then 'Driver' when 'staff' then 'Staff' else 'Teacher' end)
      from me join profiles p on p.tenant_id = me.tenant_id
     where me.role in ('school_admin', 'teacher', 'driver', 'staff')
       and p.role::text in ('school_admin', 'teacher', 'driver', 'staff')
  )
  select p.id, p.full_name, p.role::text, p.avatar_url, string_agg(distinct c.why, ' · ')
    from candidates c join profiles p on p.id = c.id
   where c.id is not null and c.id <> auth.uid() and chat_pair_allowed(auth.uid(), c.id)
   group by p.id, p.full_name, p.role, p.avatar_url
   order by p.full_name
$$;
