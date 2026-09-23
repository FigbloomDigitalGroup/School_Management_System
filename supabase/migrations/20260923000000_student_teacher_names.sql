-- Students (and parents/drivers) can already read teaching_assignments in
-- their own tenant (teaching_read), but profile_read_self only lets staff
-- see another profile's row — so a student's class timetable can resolve
-- "which subject" but not "which teacher", since embedding profiles(full_name)
-- from a non-staff caller is silently dropped by RLS, not an error.
--
-- Rather than widen profile_read_self (which would also expose a teacher's
-- email/phone to every student), this is a narrow, security-definer lookup
-- that returns only id + full_name, only for role = 'teacher', only within
-- the caller's own tenant.
create or replace function teacher_names(teacher_ids uuid[])
returns table(id uuid, full_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name from profiles p
  where p.id = any(teacher_ids) and p.tenant_id = my_tenant() and p.role = 'teacher'
$$;

grant execute on function teacher_names(uuid[]) to authenticated;
